import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, toPublicError } from './errors.mjs';

const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const TERMINAL_ERRORS = new Set([
  'AUTHENTICATION_FAILED', 'SSH_AUTH_FAILED', 'SSH_HOST_KEY_CHANGED', 'SSH_HOST_KEY_CONFIRM_REQUIRED',
  'TLS_IDENTITY_FAILED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_BINDING_MISMATCH',
  'PLUGIN_CONFIG_INCOMPLETE', 'MANUAL_RECONNECT_REQUIRED',
]);

function scopeKey(projectId, environmentId) {
  return `${projectId}/${environmentId}`;
}

function emptyState(projectId, environmentId) {
  return {
    projectId,
    environmentId,
    desiredConnected: false,
    intentGeneration: 0,
    networkEpoch: 0,
    connectAttemptId: null,
    phase: 'disconnected',
    eligibleCount: 0,
    connectedCount: 0,
    errorCount: 0,
    blockedCount: 0,
    draftCount: 0,
    plugins: {},
    updatedAt: new Date().toISOString(),
  };
}

function pluginState(plugin, phase = 'disconnected', extra = {}) {
  return {
    pluginInstanceId: plugin.pluginInstanceId,
    pluginType: plugin.pluginType,
    displayName: plugin.displayName,
    phase,
    reason: null,
    retryable: false,
    attempt: 0,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function isRetryable(error) {
  return !TERMINAL_ERRORS.has(error?.code);
}

export class EnvironmentConnectionManager extends EventEmitter {
  constructor(workspaceStore, pluginManager, { retryDelays = RETRY_DELAYS } = {}) {
    super();
    this.workspaceStore = workspaceStore;
    this.pluginManager = pluginManager;
    this.states = new Map();
    this.queues = new Map();
    this.retryDelays = [...retryDelays];
    this.retryTimers = new Map();
    this.networkEpoch = 0;
  }

  key(projectId, environmentId) {
    return scopeKey(projectId, environmentId);
  }

  state(projectId, environmentId) {
    return this.states.get(this.key(projectId, environmentId)) ?? emptyState(projectId, environmentId);
  }

  snapshot(projectId, environmentId) {
    return structuredClone(this.state(projectId, environmentId));
  }

  listStates() {
    return Object.fromEntries([...this.states.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  enqueue(projectId, environmentId, operation) {
    const key = this.key(projectId, environmentId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  publish(state) {
    state.updatedAt = new Date().toISOString();
    this.states.set(this.key(state.projectId, state.environmentId), state);
    this.emit('changed', structuredClone(state));
  }

  aggregate(state, plugins) {
    const ready = plugins.filter((plugin) => plugin.configState === 'ready');
    state.eligibleCount = ready.length;
    state.draftCount = plugins.length - ready.length;
    state.connectedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'connected').length;
    state.errorCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'error').length;
    state.blockedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'blocked').length;
    if (!ready.length) state.phase = 'disconnected';
    else if (state.connectedCount === ready.length) state.phase = 'connected';
    else if (state.connectedCount > 0) state.phase = 'partial';
    else state.phase = 'failed';
  }

  async prepare(projectId, environmentId, expectedRevision = null) {
    const environment = await this.workspaceStore.getEnvironment(projectId, environmentId);
    if (expectedRevision !== null && environment.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境配置已经变化，请刷新后重试。');
    const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
    const ready = plugins.filter((plugin) => plugin.configState === 'ready');
    if (!ready.length) throw new AppError('NO_CONNECTABLE_PLUGIN', '当前环境没有配置完整的插件。');
    const byId = new Map(plugins.map((plugin) => [plugin.pluginInstanceId, plugin]));
    for (const plugin of ready) {
      if (plugin.transport?.kind !== 'serverTunnel') continue;
      const provider = byId.get(plugin.transport.serverPluginInstanceId);
      if (!provider || provider.pluginType !== 'server' || provider.configState !== 'ready') throw new AppError('INVALID_PLUGIN_REFERENCE', `插件 ${plugin.displayName} 的 Server 隧道依赖不可用。`);
    }
    return { environment, plugins, byId };
  }

  connect(projectId, environmentId, options = {}) {
    return this.enqueue(projectId, environmentId, () => this.connectPrepared(projectId, environmentId, options));
  }

  async connectPrepared(projectId, environmentId, { expectedRevision = null, secretsByPlugin = {}, retryOnly = false, retryableOnly = false, preserveIntent = false } = {}) {
    const prepared = await this.prepare(projectId, environmentId, expectedRevision);
    let state = this.state(projectId, environmentId);
    if (!preserveIntent) {
      state = emptyState(projectId, environmentId);
      state.desiredConnected = true;
      state.intentGeneration += (this.state(projectId, environmentId).intentGeneration + 1);
    } else {
      state = structuredClone(state);
      state.desiredConnected = true;
    }
    state.networkEpoch = this.networkEpoch;
    state.connectAttemptId = crypto.randomUUID();
    state.phase = retryOnly ? 'reconnecting' : 'connecting';
    state.eligibleCount = prepared.plugins.filter((plugin) => plugin.configState === 'ready').length;
    state.draftCount = prepared.plugins.length - state.eligibleCount;
    state.connectedCount = prepared.plugins.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'connected').length;
    const attemptId = state.connectAttemptId;
    for (const plugin of prepared.plugins) {
      const current = state.plugins[plugin.pluginInstanceId];
      if (plugin.configState !== 'ready') state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason: 'PLUGIN_CONFIG_INCOMPLETE' });
      else if (retryOnly && retryableOnly && current?.phase === 'error' && !current.retryable) state.plugins[plugin.pluginInstanceId] = current;
      else if (!retryOnly || current?.phase !== 'connected') state.plugins[plugin.pluginInstanceId] = pluginState(plugin, plugin.transport?.kind === 'serverTunnel' ? 'waitingDependency' : 'connecting', { attempt: (current?.attempt ?? 0) + 1 });
    }
    this.publish(state);

    const promises = new Map();
    const connectOne = (plugin) => {
      if (state.plugins[plugin.pluginInstanceId]?.phase === 'connected') return Promise.resolve(true);
      if (retryOnly && retryableOnly && state.plugins[plugin.pluginInstanceId]?.phase === 'error' && !state.plugins[plugin.pluginInstanceId]?.retryable) return Promise.resolve(false);
      if (promises.has(plugin.pluginInstanceId)) return promises.get(plugin.pluginInstanceId);
      const promise = (async () => {
        if (plugin.transport?.kind === 'serverTunnel') {
          const provider = prepared.byId.get(plugin.transport.serverPluginInstanceId);
          const providerOk = await connectOne(provider);
          if (!providerOk) {
            if (state.connectAttemptId !== attemptId || !state.desiredConnected) return false;
            state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'blocked', { reason: 'TUNNEL_PROVIDER_UNAVAILABLE', retryable: true });
            this.publish(state);
            return false;
          }
        }
        if (state.connectAttemptId !== attemptId || !state.desiredConnected) return false;
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'connecting', { attempt: (state.plugins[plugin.pluginInstanceId]?.attempt ?? 0) + 1 });
        this.publish(state);
        try {
          const result = await this.pluginManager.connect(plugin, secretsByPlugin[plugin.pluginInstanceId] ?? {});
          if (state.connectAttemptId !== attemptId || !state.desiredConnected) {
            await this.pluginManager.disconnect(plugin, 'stale-connect-result');
            return false;
          }
          const latest = await this.workspaceStore.getPlugin(projectId, environmentId, plugin.pluginInstanceId);
          if (latest.revision !== plugin.revision) {
            await this.pluginManager.disconnect(plugin, 'plugin-revision-changed');
            state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'error', { reason: 'MANUAL_RECONNECT_REQUIRED', retryable: false });
            this.publish(state);
            return false;
          }
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'connected', { connectedAt: result.connectedAt, routeGeneration: result.routeGeneration ?? result.generation ?? 0 });
          this.publish(state);
          return true;
        } catch (error) {
          if (state.connectAttemptId !== attemptId || !state.desiredConnected) return false;
          const publicError = toPublicError(error);
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'error', { reason: publicError.code, retryable: isRetryable(error), error: publicError });
          this.publish(state);
          return false;
        }
      })();
      promises.set(plugin.pluginInstanceId, promise);
      return promise;
    };

    await Promise.all(prepared.plugins.filter((plugin) => plugin.configState === 'ready').map(connectOne));
    if (state.connectAttemptId !== attemptId || !state.desiredConnected) return this.snapshot(projectId, environmentId);
    this.aggregate(state, prepared.plugins);
    this.publish(state);
    await this.workspaceStore.appendAudit(projectId, {
      type: `environment-${state.phase}`,
      projectId,
      environmentId,
      result: state.phase,
      connectedCount: state.connectedCount,
      eligibleCount: state.eligibleCount,
    }).catch(() => undefined);
    return structuredClone(state);
  }

  retryFailed(projectId, environmentId, options = {}) {
    const current = this.state(projectId, environmentId);
    if (!current.desiredConnected) throw new AppError('ENVIRONMENT_NOT_CONNECTED', '环境没有保持连接意图。');
    return this.enqueue(projectId, environmentId, () => this.connectPrepared(projectId, environmentId, { ...options, retryOnly: true, preserveIntent: true }));
  }

  cancel(projectId, environmentId) {
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      if (state.phase !== 'connecting') return state;
      state.desiredConnected = false;
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      this.clearRetry(projectId, environmentId);
      this.publish(state);
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const ordered = [...plugins.filter((plugin) => plugin.pluginType !== 'server'), ...plugins.filter((plugin) => plugin.pluginType === 'server')];
      for (const plugin of ordered) await this.pluginManager.disconnect(plugin, 'user-cancel').catch(() => undefined);
      for (const plugin of plugins) state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected');
      state.phase = 'disconnected';
      state.connectedCount = 0;
      state.errorCount = 0;
      state.blockedCount = 0;
      this.publish(state);
      return structuredClone(state);
    });
  }

  configurationChanged(projectId, environmentId, changedPluginInstanceId = null) {
    return this.enqueue(projectId, environmentId, async () => {
      const key = this.key(projectId, environmentId);
      if (!this.states.has(key)) return this.snapshot(projectId, environmentId);
      const state = structuredClone(this.state(projectId, environmentId));
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const ids = new Set(plugins.map((plugin) => plugin.pluginInstanceId));
      for (const id of Object.keys(state.plugins)) if (!ids.has(id)) delete state.plugins[id];
      const affected = new Set(changedPluginInstanceId ? [changedPluginInstanceId] : []);
      for (const plugin of plugins) if (plugin.transport?.serverPluginInstanceId === changedPluginInstanceId) affected.add(plugin.pluginInstanceId);
      for (const plugin of plugins) {
        if (!state.plugins[plugin.pluginInstanceId]) {
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason: state.desiredConnected ? 'MANUAL_RECONNECT_REQUIRED' : null });
        } else if (affected.has(plugin.pluginInstanceId)) {
          await this.pluginManager.disconnect(plugin, 'configuration-change').catch(() => undefined);
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, state.desiredConnected ? 'error' : 'disconnected', { reason: 'MANUAL_RECONNECT_REQUIRED', retryable: false });
        }
      }
      this.aggregate(state, plugins);
      this.publish(state);
      return structuredClone(state);
    });
  }

  disconnect(projectId, environmentId, reason = 'user') {
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      state.desiredConnected = false;
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      state.phase = 'disconnecting';
      this.clearRetry(projectId, environmentId);
      this.publish(state);
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const ordered = [...plugins.filter((plugin) => plugin.pluginType !== 'server'), ...plugins.filter((plugin) => plugin.pluginType === 'server')];
      for (const plugin of ordered) {
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnecting');
        this.publish(state);
        await this.pluginManager.disconnect(plugin, reason).catch(() => undefined);
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected');
      }
      state.phase = 'disconnected';
      state.connectedCount = 0;
      state.errorCount = 0;
      state.blockedCount = 0;
      this.publish(state);
      await this.workspaceStore.appendAudit(projectId, { type: 'environment-disconnected', projectId, environmentId, result: 'success', reason }).catch(() => undefined);
      return structuredClone(state);
    });
  }

  clearRetry(projectId, environmentId) {
    const key = this.key(projectId, environmentId);
    const timer = this.retryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(key);
  }

  scheduleReconnect(projectId, environmentId, attempt = 0) {
    const state = this.state(projectId, environmentId);
    if (!state.desiredConnected || attempt >= this.retryDelays.length) return;
    const key = this.key(projectId, environmentId);
    if (this.retryTimers.has(key)) return;
    const timer = setTimeout(async () => {
      this.retryTimers.delete(key);
      const current = this.state(projectId, environmentId);
      if (!current.desiredConnected) return;
      try {
        const result = await this.retryFailed(projectId, environmentId, { retryableOnly: true });
        if (!['connected', 'partial'].includes(result.phase) || result.errorCount + result.blockedCount > 0) this.scheduleReconnect(projectId, environmentId, attempt + 1);
      } catch {
        this.scheduleReconnect(projectId, environmentId, attempt + 1);
      }
    }, this.retryDelays[attempt]);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  async networkChanged(reason = 'network-change') {
    this.networkEpoch += 1;
    const active = [...this.states.values()].filter((state) => state.desiredConnected);
    await Promise.all(active.map(async (state) => {
      await this.disconnectForReconnect(state.projectId, state.environmentId, reason);
      this.scheduleReconnect(state.projectId, state.environmentId, 0);
    }));
  }

  async disconnectForReconnect(projectId, environmentId, reason) {
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      if (!state.desiredConnected) return state;
      state.phase = 'reconnecting';
      state.connectAttemptId = crypto.randomUUID();
      state.networkEpoch = this.networkEpoch;
      this.publish(state);
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const ordered = [...plugins.filter((plugin) => plugin.pluginType !== 'server'), ...plugins.filter((plugin) => plugin.pluginType === 'server')];
      for (const plugin of ordered) {
        if (state.plugins[plugin.pluginInstanceId]?.reason === 'MANUAL_RECONNECT_REQUIRED') continue;
        await this.pluginManager.disconnect(plugin, reason).catch(() => undefined);
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'reconnecting', { reason: 'NETWORK_RECONNECTING', retryable: true });
      }
      this.publish(state);
      return state;
    });
  }

  async closeAll() {
    const active = [...this.states.values()].filter((state) => state.desiredConnected || state.phase !== 'disconnected');
    await Promise.all(active.map((state) => this.disconnect(state.projectId, state.environmentId, 'app-exit')));
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await this.pluginManager.closeAll();
  }
}

export const environmentConnectionInternals = { scopeKey, emptyState, pluginState, isRetryable };
