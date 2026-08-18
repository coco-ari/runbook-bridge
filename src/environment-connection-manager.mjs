import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, toPublicError } from './errors.mjs';
import { assessEnvironmentSnapshot } from './plugin-readiness-service.mjs';

const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_CONNECT_DEADLINE_MS = 65_000;
const DEFAULT_DISCONNECT_DEADLINE_MS = 5_000;
const DEFAULT_CLOSE_DEADLINE_MS = 12_000;
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
    sequence: 0,
    phase: 'disconnected',
    eligibleCount: 0,
    connectedCount: 0,
    errorCount: 0,
    blockedCount: 0,
    draftCount: 0,
    manualDisconnected: {},
    plugins: {},
    updatedAt: new Date().toISOString(),
  };
}

function pluginState(plugin, phase = 'disconnected', extra = {}) {
  return {
    pluginInstanceId: plugin.pluginInstanceId,
    pluginType: plugin.pluginType,
    displayName: plugin.displayName,
    providerPluginInstanceId: plugin.transport?.kind === 'serverTunnel' ? plugin.transport.serverPluginInstanceId : null,
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
  constructor(workspaceStore, pluginManager, {
    retryDelays = RETRY_DELAYS,
    maxConcurrency = 4,
    connectDeadlineMs = null,
    disconnectDeadlineMs = DEFAULT_DISCONNECT_DEADLINE_MS,
    closeDeadlineMs = DEFAULT_CLOSE_DEADLINE_MS,
    networkDebounceMs = 100,
    configurationJournal = null,
  } = {}) {
    super();
    this.workspaceStore = workspaceStore;
    this.pluginManager = pluginManager;
    this.states = new Map();
    this.idleStates = new Map();
    this.queues = new Map();
    this.retryDelays = [...retryDelays];
    this.retryTimers = new Map();
    this.networkEpoch = 0;
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 4);
    this.connectDeadlineMs = Number.isFinite(connectDeadlineMs) && connectDeadlineMs > 0 ? connectDeadlineMs : null;
    this.disconnectDeadlineMs = Math.max(100, Number(disconnectDeadlineMs) || DEFAULT_DISCONNECT_DEADLINE_MS);
    this.closeDeadlineMs = Math.max(this.disconnectDeadlineMs, Number(closeDeadlineMs) || DEFAULT_CLOSE_DEADLINE_MS);
    this.networkDebounceMs = Math.max(0, Number(networkDebounceMs) || 0);
    this.activeConnects = 0;
    this.connectWaiters = [];
    this.connectControllers = new Map();
    this.networkChangePromise = null;
    this.pendingNetworkReason = null;
    this.networkBatchPhase = null;
    this.networkRerunRequested = false;
    this.publishSequence = 0;
    this.cancelCleanups = new Map();
    this.runtimeConnectSequence = 0;
    this.runtimeConnectAttempts = new Map();
    this.configurationMutations = new Map();
    this.configurationJournal = configurationJournal;
    this.pluginCatalogs = new Map();
  }

  async withConnectPermit(operation, { signal = null } = {}) {
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    let release;
    if (this.activeConnects < this.maxConcurrency) {
      this.activeConnects += 1;
      release = () => this.releaseConnectPermit();
    } else {
      release = await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort:null };
        waiter.onAbort = () => {
          const index = this.connectWaiters.indexOf(waiter);
          if (index >= 0) this.connectWaiters.splice(index, 1);
          reject(new AppError('CONNECT_CANCELLED', '连接已取消。'));
        };
        signal?.addEventListener('abort', waiter.onAbort, { once:true });
        this.connectWaiters.push(waiter);
      });
    }
    try { return await operation(); }
    finally { release(); }
  }

  releaseConnectPermit() {
    while (this.connectWaiters.length) {
      const waiter = this.connectWaiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      // Transfer the occupied slot directly to the waiter. activeConnects does
      // not briefly drop, so a new caller cannot jump the FIFO queue.
      waiter.resolve(() => this.releaseConnectPermit());
      return;
    }
    this.activeConnects = Math.max(0, this.activeConnects - 1);
  }

  beginConnectAttempt(projectId, environmentId) {
    const key = this.key(projectId, environmentId);
    this.connectControllers.get(key)?.abort();
    const controller = new AbortController();
    this.connectControllers.set(key, controller);
    return controller;
  }

  finishConnectAttempt(projectId, environmentId, controller) {
    const key = this.key(projectId, environmentId);
    if (this.connectControllers.get(key) === controller) this.connectControllers.delete(key);
  }

  abortConnectAttempt(projectId, environmentId) {
    const key = this.key(projectId, environmentId);
    const controller = this.connectControllers.get(key);
    if (controller) controller.abort();
    this.connectControllers.delete(key);
  }

  async connectRuntime(plugin, secrets = {}, { signal = null } = {}) {
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const configured = Number(plugin.limits?.timeoutMs ?? 10_000);
    const deadlineMs = this.connectDeadlineMs ?? Math.min(Math.max(configured + 5_000, 5_000), MAX_CONNECT_DEADLINE_MS);
    const attemptKey = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
    const attemptToken = ++this.runtimeConnectSequence;
    this.runtimeConnectAttempts.set(attemptKey, attemptToken);
    const runtimeController = new AbortController();
    let timer = null;
    let interrupted = false;
    let abortListener = null;
    const pending = Promise.resolve().then(() => this.pluginManager.connect(plugin, secrets, {
      signal:runtimeController.signal,
      attemptToken,
    }));
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            interrupted = true;
            runtimeController.abort(new AppError('CONNECT_TIMEOUT', '连接尝试已超时。'));
            reject(new AppError('CONNECT_TIMEOUT', `连接 ${plugin.displayName} 超时，请检查网络后重试。`));
          }, deadlineMs);
          timer.unref?.();
        }),
        ...(signal ? [new Promise((_, reject) => {
          abortListener = () => {
            interrupted = true;
            runtimeController.abort(signal.reason);
            reject(new AppError('CONNECT_CANCELLED', '连接已取消。'));
          };
          signal.addEventListener('abort', abortListener, { once:true });
          if (signal.aborted) abortListener();
        })] : []),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      if (interrupted) {
        // The child signal owns immediate low-level cleanup. A driver may still
        // ignore it and succeed later, but that completion may clean up only if
        // no newer attempt has started for the same plugin key.
        void pending.then(
          () => {
            if (this.runtimeConnectAttempts.get(attemptKey) !== attemptToken) return undefined;
            return typeof this.pluginManager.forceDisconnect === 'function'
              ? this.pluginManager.forceDisconnect(plugin, 'late-connect-timeout', {attemptToken})
              : this.pluginManager.disconnect(plugin, 'late-connect-timeout');
          },
          () => undefined,
        ).catch(() => undefined).finally(() => {
          if (this.runtimeConnectAttempts.get(attemptKey) === attemptToken) this.runtimeConnectAttempts.delete(attemptKey);
        });
      } else if (this.runtimeConnectAttempts.get(attemptKey) === attemptToken) {
        this.runtimeConnectAttempts.delete(attemptKey);
      }
    }
  }

  async disconnectRuntime(plugin, reason) {
    let timer;
    const pending = Promise.resolve().then(() => this.pluginManager.disconnect(plugin, reason));
    try {
      return await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ connected:false, forced:true }), this.disconnectDeadlineMs);
          timer.unref?.();
        }),
      ]).then((result) => {
        if (result?.forced) void Promise.resolve(this.pluginManager.forceDisconnect?.(plugin, `${reason}-deadline`)).catch(() => undefined);
        return result;
      });
    } finally {
      if (timer) clearTimeout(timer);
      pending.catch(() => undefined);
    }
  }

  async disconnectPluginsInDependencyOrder(plugins, reason, predicate = () => true) {
    const groups = [
      plugins.filter((plugin) => plugin.pluginType !== 'server' && predicate(plugin)),
      plugins.filter((plugin) => plugin.pluginType === 'server' && predicate(plugin)),
    ];
    for (const group of groups) {
      for (let offset = 0; offset < group.length; offset += this.maxConcurrency) {
        const batch = group.slice(offset, offset + this.maxConcurrency);
        await Promise.all(batch.map((plugin) => this.disconnectRuntime(plugin, reason).catch(() => undefined)));
      }
    }
  }

  key(projectId, environmentId) {
    return scopeKey(projectId, environmentId);
  }

  state(projectId, environmentId) {
    const key = this.key(projectId,environmentId);
    if (this.states.has(key)) return this.states.get(key);
    if (!this.idleStates.has(key)) this.idleStates.set(key,emptyState(projectId,environmentId));
    return this.idleStates.get(key);
  }

  rememberPlugins(projectId, environmentId, plugins) {
    this.pluginCatalogs.set(this.key(projectId,environmentId),plugins.map((plugin) => structuredClone(plugin)));
    return plugins;
  }

  assessedState(projectId, environmentId, state = this.state(projectId,environmentId), plugins = null) {
    const catalog = plugins ?? this.pluginCatalogs.get(this.key(projectId,environmentId));
    const snapshot = structuredClone(state);
    if (!catalog) return snapshot;
    const assessed = assessEnvironmentSnapshot({plugins:catalog,runtimeSnapshot:snapshot});
    // Stage 3 adds a derived response only. Connection eligibility remains on
    // the legacy committed configState until the intent coordinator lands.
    const ready = catalog.filter((plugin) => plugin.configState === 'ready');
    assessed.eligibleCount = ready.length;
    assessed.draftCount = catalog.length - ready.length;
    assessed.connectedCount = ready.filter((plugin) => assessed.plugins[plugin.pluginInstanceId]?.phase === 'connected').length;
    assessed.errorCount = ready.filter((plugin) => assessed.plugins[plugin.pluginInstanceId]?.phase === 'error').length;
    assessed.blockedCount = ready.filter((plugin) => assessed.plugins[plugin.pluginInstanceId]?.phase === 'blocked').length;
    if (!assessed.desiredConnected && assessed.connectedCount === 0) assessed.phase = 'disconnected';
    return assessed;
  }

  beginConfigurationMutation(projectId, environmentId, changedPluginInstanceId = null) {
    this.configurationJournal?.assertEnvironmentAvailable(projectId, environmentId);
    const key = this.key(projectId, environmentId);
    if (this.configurationMutations.has(key)) throw new AppError('CONFIGURATION_UPDATING', '环境配置正在保存，请稍后重试连接。');
    const token = crypto.randomUUID();
    const previous = structuredClone(this.state(projectId, environmentId));
    this.configurationMutations.set(key, {token,previous,fencedSequence:null});
    const fenced = this.fenceConfigurationChange(projectId, environmentId, changedPluginInstanceId);
    const record = this.configurationMutations.get(key);
    if (record?.token === token) record.fencedSequence = fenced.sequence;
    return token;
  }

  endConfigurationMutation(projectId, environmentId, token, {restore = false} = {}) {
    const key = this.key(projectId, environmentId);
    const record = this.configurationMutations.get(key);
    if (record?.token !== token) return false;
    this.configurationMutations.delete(key);
    if (!restore || this.state(projectId, environmentId).sequence !== record.fencedSequence) return false;
    const transitional = Object.values(record.previous.plugins ?? {}).some((item) => ['connecting','disconnecting','reconnecting','waitingDependency'].includes(item.phase));
    if (transitional) return false;
    this.publish(structuredClone(record.previous));
    return true;
  }

  assertConfigurationStable(projectId, environmentId) {
    this.configurationJournal?.assertEnvironmentAvailable(projectId, environmentId);
    if (this.configurationMutations.has(this.key(projectId, environmentId))) {
      throw new AppError('CONFIGURATION_UPDATING', '环境配置正在保存，请等待完成后再连接。');
    }
  }

  snapshot(projectId, environmentId) {
    return this.assessedState(projectId,environmentId);
  }

  async status(projectId, environmentId, {plugins:providedPlugins = null} = {}) {
    const plugins = this.rememberPlugins(
      projectId,
      environmentId,
      providedPlugins ?? await this.workspaceStore.listPlugins(projectId, environmentId),
    );
    const state = structuredClone(this.state(projectId, environmentId));
    const pluginIds = new Set(plugins.map((plugin) => plugin.pluginInstanceId));
    for (const id of Object.keys(state.plugins)) if (!pluginIds.has(id)) delete state.plugins[id];
    for (const plugin of plugins) {
      if (!state.plugins[plugin.pluginInstanceId]) {
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', {
          reason: plugin.configState === 'ready' ? null : 'PLUGIN_CONFIG_INCOMPLETE',
          updatedAt:state.updatedAt,
        });
      }
    }
    const ready = plugins.filter((plugin) => plugin.configState === 'ready');
    state.eligibleCount = ready.length;
    state.draftCount = plugins.length - ready.length;
    state.connectedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'connected').length;
    state.errorCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'error').length;
    state.blockedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'blocked').length;
    if (!state.desiredConnected && state.connectedCount === 0) state.phase = 'disconnected';
    return this.assessedState(projectId,environmentId,state,plugins);
  }

  listStates() {
    return Object.fromEntries([...this.states.entries()].map(([key, value]) => {
      const [projectId,environmentId] = key.split('/');
      return [key,this.assessedState(projectId,environmentId,value)];
    }));
  }

  async forgetProject(projectId) {
    const prefix = `${projectId}/`;
    for (const [key, controller] of this.connectControllers) {
      if (key.startsWith(prefix)) controller.abort();
    }
    await Promise.allSettled([...this.queues.entries()].filter(([key]) => key.startsWith(prefix)).map(([,pending]) => pending));
    for (const key of this.states.keys()) if (key.startsWith(prefix)) this.states.delete(key);
    for (const key of this.retryTimers.keys()) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.delete(key);
    }
    for (const [key, controller] of this.connectControllers) {
      if (!key.startsWith(prefix)) continue;
      controller.abort();
      this.connectControllers.delete(key);
    }
    for (const key of this.cancelCleanups.keys()) if (key.startsWith(prefix)) this.cancelCleanups.delete(key);
    for (const key of this.runtimeConnectAttempts.keys()) if (key.startsWith(prefix)) this.runtimeConnectAttempts.delete(key);
    for (const key of this.configurationMutations.keys()) if (key.startsWith(prefix)) this.configurationMutations.delete(key);
    for (const key of this.pluginCatalogs.keys()) if (key.startsWith(prefix)) this.pluginCatalogs.delete(key);
    for (const key of this.idleStates.keys()) if (key.startsWith(prefix)) this.idleStates.delete(key);
  }

  async forgetEnvironment(projectId, environmentId) {
    const key = this.key(projectId, environmentId);
    this.abortConnectAttempt(projectId, environmentId);
    this.clearRetry(projectId, environmentId);
    const pending = this.queues.get(key);
    if (pending) await Promise.resolve(pending).catch(() => undefined);
    this.states.delete(key);
    for (const cleanupKey of this.cancelCleanups.keys()) {
      if (cleanupKey.startsWith(`${key}\u0000`)) this.cancelCleanups.delete(cleanupKey);
    }
    for (const attemptKey of this.runtimeConnectAttempts.keys()) {
      if (attemptKey.startsWith(`${key}/`)) this.runtimeConnectAttempts.delete(attemptKey);
    }
    this.configurationMutations.delete(key);
    this.pluginCatalogs.delete(key);
    this.idleStates.delete(key);
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
    this.publishSequence += 1;
    state.sequence = this.publishSequence;
    state.updatedAt = new Date().toISOString();
    this.idleStates.delete(this.key(state.projectId,state.environmentId));
    this.states.set(this.key(state.projectId, state.environmentId), state);
    this.emit('changed', this.assessedState(state.projectId,state.environmentId,state));
  }

  aggregate(state, plugins) {
    const ready = plugins.filter((plugin) => plugin.configState === 'ready');
    state.eligibleCount = ready.length;
    state.draftCount = plugins.length - ready.length;
    state.connectedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'connected').length;
    state.errorCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'error').length;
    state.blockedCount = ready.filter((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'blocked').length;
    if (!state.desiredConnected && state.connectedCount === 0) state.phase = 'disconnected';
    else if (!ready.length) state.phase = 'disconnected';
    else if (state.connectedCount === ready.length) state.phase = 'connected';
    else if (state.connectedCount > 0) state.phase = state.errorCount + state.blockedCount > 0 ? 'partial' : 'connected';
    else state.phase = 'failed';
  }

  async prepare(projectId, environmentId, expectedRevision = null) {
    const environment = await this.workspaceStore.getEnvironment(projectId, environmentId);
    if (expectedRevision !== null && environment.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境配置已经变化，请刷新后重试。');
    const plugins = this.rememberPlugins(
      projectId,
      environmentId,
      await this.workspaceStore.listPlugins(projectId, environmentId),
    );
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

  async connectPrepared(projectId, environmentId, { expectedRevision = null, secretsByPlugin = {}, retryOnly = false, retryableOnly = false, preserveIntent = false, actor = 'user' } = {}) {
    this.assertConfigurationStable(projectId, environmentId);
    const prepared = await this.prepare(projectId, environmentId, expectedRevision);
    this.assertConfigurationStable(projectId, environmentId);
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
    const connectController = this.beginConnectAttempt(projectId, environmentId);
    for (const plugin of prepared.plugins) {
      const current = state.plugins[plugin.pluginInstanceId];
      if (plugin.configState !== 'ready') state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason: 'PLUGIN_CONFIG_INCOMPLETE' });
      else if (preserveIntent && state.manualDisconnected?.[plugin.pluginInstanceId]) state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason: 'USER_DISCONNECTED' });
      else if (retryOnly && retryableOnly && current?.phase === 'error' && !current.retryable) state.plugins[plugin.pluginInstanceId] = current;
      else if (!retryOnly || current?.phase !== 'connected') state.plugins[plugin.pluginInstanceId] = pluginState(plugin, plugin.transport?.kind === 'serverTunnel' ? 'waitingDependency' : 'connecting', { attempt: (current?.attempt ?? 0) + 1 });
    }
    this.publish(state);

    const promises = new Map();
    const connectOne = (plugin) => {
      if (state.manualDisconnected?.[plugin.pluginInstanceId]) return Promise.resolve(false);
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
          const result = await this.withConnectPermit(
            () => this.connectRuntime(plugin, secretsByPlugin[plugin.pluginInstanceId] ?? {}, { signal:connectController.signal }),
            { signal:connectController.signal },
          );
          if (state.connectAttemptId !== attemptId || !state.desiredConnected) {
            await this.disconnectRuntime(plugin, 'stale-connect-result');
            return false;
          }
          const latest = await this.workspaceStore.getPlugin(projectId, environmentId, plugin.pluginInstanceId);
          if (latest.revision !== plugin.revision) {
            await this.disconnectRuntime(plugin, 'plugin-revision-changed');
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
    this.finishConnectAttempt(projectId, environmentId, connectController);
    if (state.connectAttemptId !== attemptId || !state.desiredConnected) return this.snapshot(projectId, environmentId);
    this.aggregate(state, prepared.plugins);
    this.publish(state);
    await this.workspaceStore.appendAudit(projectId, {
      type: `environment-${state.phase}`,
      projectId,
      environmentId,
      result: state.phase,
      actor,
      connectedCount: state.connectedCount,
      eligibleCount: state.eligibleCount,
    }).catch(() => undefined);
    return structuredClone(state);
  }

  connectPlugin(projectId, environmentId, pluginInstanceId) {
    return this.enqueue(projectId, environmentId, async () => {
      this.assertConfigurationStable(projectId, environmentId);
      const prepared = await this.prepare(projectId, environmentId);
      this.assertConfigurationStable(projectId, environmentId);
      const target = prepared.byId.get(pluginInstanceId);
      if (!target || target.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', '请先完成该插件配置。');
      const previous = this.state(projectId, environmentId);
      const state = previous.desiredConnected ? structuredClone(previous) : emptyState(projectId, environmentId);
      if (!previous.desiredConnected) {
        for (const plugin of prepared.plugins.filter((item) => item.configState === 'ready' && item.pluginInstanceId !== pluginInstanceId)) {
          state.manualDisconnected[plugin.pluginInstanceId] = true;
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason:'USER_DISCONNECTED' });
        }
      }
      state.desiredConnected = true;
      state.intentGeneration = previous.intentGeneration + 1;
      state.connectAttemptId = crypto.randomUUID();
      const attemptId = state.connectAttemptId;
      const connectController = this.beginConnectAttempt(projectId, environmentId);
      state.phase = 'connecting';
      const connectIds = [];
      if (target.transport?.kind === 'serverTunnel') connectIds.push(target.transport.serverPluginInstanceId);
      connectIds.push(target.pluginInstanceId);
      for (const id of connectIds) delete state.manualDisconnected[id];
      this.publish(state);
      for (const id of connectIds) {
        const plugin = prepared.byId.get(id);
        if (state.plugins[id]?.phase === 'connected') continue;
        state.plugins[id] = pluginState(plugin, 'connecting', { attempt:(state.plugins[id]?.attempt ?? 0) + 1 });
        this.publish(state);
        try {
          const result = await this.withConnectPermit(
            () => this.connectRuntime(plugin, {}, { signal:connectController.signal }),
            { signal:connectController.signal },
          );
          if (connectController.signal.aborted || state.connectAttemptId !== attemptId || !state.desiredConnected) {
            await this.disconnectRuntime(plugin, 'stale-connect-result');
            break;
          }
          const latest = await this.workspaceStore.getPlugin(projectId, environmentId, plugin.pluginInstanceId);
          if (latest.revision !== plugin.revision) {
            await this.disconnectRuntime(plugin, 'plugin-revision-changed');
            state.plugins[id] = pluginState(plugin, 'error', { reason:'MANUAL_RECONNECT_REQUIRED', retryable:false });
            break;
          }
          state.plugins[id] = pluginState(plugin, 'connected', { connectedAt:result.connectedAt, routeGeneration:result.routeGeneration ?? result.generation ?? 0 });
        } catch (error) {
          if (connectController.signal.aborted || state.connectAttemptId !== attemptId || !state.desiredConnected) break;
          const value = toPublicError(error);
          state.plugins[id] = pluginState(plugin, 'error', { reason:value.code, retryable:isRetryable(error), error:value });
          if (id !== target.pluginInstanceId) state.plugins[target.pluginInstanceId] = pluginState(target, 'blocked', { reason:'TUNNEL_PROVIDER_UNAVAILABLE', retryable:true });
          break;
        }
        this.publish(state);
      }
      this.aggregate(state, prepared.plugins);
      this.publish(state);
      this.finishConnectAttempt(projectId, environmentId, connectController);
      await this.workspaceStore.appendAudit(projectId, { type:'plugin-connected', projectId, environmentId, pluginInstanceId, pluginNameSnapshot:target.displayName, actor:'user', result:state.plugins[pluginInstanceId]?.phase === 'connected' ? 'success' : 'error' }).catch(() => undefined);
      return structuredClone(state);
    });
  }

  disconnectPlugin(projectId, environmentId, pluginInstanceId) {
    this.abortConnectAttempt(projectId, environmentId);
    return this.enqueue(projectId, environmentId, async () => {
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const target = plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId);
      if (!target) throw new AppError('PLUGIN_NOT_FOUND', '插件不存在。');
      const state = structuredClone(this.state(projectId, environmentId));
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      const affected = target.pluginType === 'server'
        ? [...plugins.filter((plugin) => plugin.transport?.serverPluginInstanceId === pluginInstanceId), target]
        : [target];
      for (const plugin of affected) {
        state.manualDisconnected[plugin.pluginInstanceId] = true;
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnecting');
        this.publish(state);
        await this.disconnectRuntime(plugin, 'user-plugin-disconnect').catch(() => undefined);
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason:'USER_DISCONNECTED' });
      }
      this.aggregate(state, plugins);
      if (!plugins.some((plugin) => state.plugins[plugin.pluginInstanceId]?.phase === 'connected')) {
        state.desiredConnected = false;
        state.phase = 'disconnected';
      }
      this.publish(state);
      await this.workspaceStore.appendAudit(projectId, { type:'plugin-disconnected', projectId, environmentId, pluginInstanceId, pluginNameSnapshot:target.displayName, actor:'user', result:'success' }).catch(() => undefined);
      return structuredClone(state);
    });
  }

  pluginLost(projectId, environmentId, pluginInstanceId, error = null) {
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      if (!state.desiredConnected || state.manualDisconnected?.[pluginInstanceId]) return state;
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const plugin = plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
      if (!plugin) return state;
      const value = toPublicError(error ?? new AppError('ROUTE_UNAVAILABLE', '连接意外中断。'));
      state.plugins[pluginInstanceId] = pluginState(plugin, 'error', { reason:value.code, retryable:isRetryable(error), error:value });
      for (const dependent of plugins.filter((item) => item.transport?.serverPluginInstanceId === pluginInstanceId)) {
        await this.disconnectRuntime(dependent, 'provider-lost').catch(() => undefined);
        state.plugins[dependent.pluginInstanceId] = pluginState(dependent, 'blocked', { reason:'TUNNEL_PROVIDER_UNAVAILABLE', retryable:true });
      }
      this.aggregate(state, plugins);
      this.publish(state);
      if (isRetryable(error)) this.scheduleReconnect(projectId, environmentId, 0);
      return structuredClone(state);
    });
  }

  retryFailed(projectId, environmentId, options = {}) {
    const current = this.state(projectId, environmentId);
    if (!current.desiredConnected) throw new AppError('ENVIRONMENT_NOT_CONNECTED', '环境没有保持连接意图。');
    return this.enqueue(projectId, environmentId, () => this.connectPrepared(projectId, environmentId, { ...options, retryOnly: true, preserveIntent: true }));
  }

  async cleanupCancelled(projectId, environmentId) {
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      await this.disconnectPluginsInDependencyOrder(plugins, 'user-cancel');
      const state = structuredClone(this.state(projectId, environmentId));
      if (state.desiredConnected) return state;
      for (const plugin of plugins) state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected');
      state.phase = 'disconnected';
      state.connectedCount = 0;
      state.errorCount = 0;
      state.blockedCount = 0;
      this.publish(state);
      return structuredClone(state);
  }

  ensureCancelledCleanup(projectId, environmentId, cancelledAttemptId) {
    // Scope single-flight to the cancelled attempt, not just the environment.
    // The queued cleanup may finish before its audit write. A reconnect can
    // therefore start (and be cancelled again) while the previous audit is
    // still pending; that second attempt still needs its own cleanup fence.
    const key = `${this.key(projectId, environmentId)}\u0000${cancelledAttemptId}`;
    const existing = this.cancelCleanups.get(key);
    if (existing) return existing;
    const cleanup = (async () => {
      try {
        // Queue exactly once behind the aborted connect. Any immediate user
        // reconnect is enqueued after this fence, so stale cleanup cannot tear
        // down the newly established session.
        return await this.enqueue(projectId, environmentId, () => this.cleanupCancelled(projectId, environmentId));
      } finally {
        await Promise.resolve(this.workspaceStore.appendAudit?.(projectId, {
          type:'environment-connect-cancelled', projectId, environmentId,
          connectAttemptId:cancelledAttemptId, actor:'user', result:'cancelled',
        })).catch(() => undefined);
      }
    })()
      .finally(() => {
        if (this.cancelCleanups.get(key) === cleanup) this.cancelCleanups.delete(key);
      });
    this.cancelCleanups.set(key, cleanup);
    return cleanup;
  }

  cancel(projectId, environmentId) {
    const current = this.state(projectId, environmentId);
    if (!['connecting', 'reconnecting'].includes(current.phase)) return structuredClone(current);
    const cancelledAttemptId = current.connectAttemptId;
    current.desiredConnected = false;
    current.intentGeneration += 1;
    current.connectAttemptId = crypto.randomUUID();
    current.phase = 'disconnecting';
    this.abortConnectAttempt(projectId, environmentId);
    this.clearRetry(projectId, environmentId);
    this.publish(current);
    // One immediate dependency-ordered cleanup is sufficient. Late drivers are
    // still fenced by connectRuntime's pending-result handler.
    this.ensureCancelledCleanup(projectId, environmentId, cancelledAttemptId).catch(() => undefined);
    return structuredClone(current);
  }

  fenceConfigurationChange(projectId, environmentId, changedPluginInstanceId = null) {
    this.abortConnectAttempt(projectId, environmentId);
    const key = this.key(projectId, environmentId);
    if (changedPluginInstanceId && this.states.has(key)) {
      // Fence the known resource synchronously before any storage I/O or
      // graceful disconnect. Agent operations can no longer reuse an old
      // session after the new config/credential transaction has committed.
      const fenced = structuredClone(this.state(projectId, environmentId));
      if (fenced.plugins[changedPluginInstanceId]) {
        fenced.intentGeneration += 1;
        fenced.connectAttemptId = crypto.randomUUID();
        const affectedIds = Object.values(fenced.plugins)
          .filter((item) => item.pluginInstanceId === changedPluginInstanceId || item.providerPluginInstanceId === changedPluginInstanceId)
          .map((item) => item.pluginInstanceId);
        for (const id of affectedIds) {
          fenced.plugins[id] = {
            ...fenced.plugins[id],phase:'error',reason:'MANUAL_RECONNECT_REQUIRED',retryable:false,updatedAt:new Date().toISOString(),
          };
        }
        const values = Object.values(fenced.plugins);
        fenced.connectedCount = values.filter((item) => item.phase === 'connected').length;
        fenced.errorCount = values.filter((item) => item.phase === 'error').length;
        fenced.blockedCount = values.filter((item) => item.phase === 'blocked').length;
        if (fenced.desiredConnected) fenced.phase = fenced.connectedCount > 0 ? 'partial' : 'failed';
        this.publish(fenced);
      }
    }
    return this.snapshot(projectId, environmentId);
  }

  configurationChanged(projectId, environmentId, changedPluginInstanceId = null) {
    this.fenceConfigurationChange(projectId, environmentId, changedPluginInstanceId);
    const key = this.key(projectId, environmentId);
    return this.enqueue(projectId, environmentId, async () => {
      if (!this.states.has(key)) return this.snapshot(projectId, environmentId);
      const state = structuredClone(this.state(projectId, environmentId));
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      let plugins;
      try { plugins = await this.workspaceStore.listPlugins(projectId, environmentId); }
      catch (error) { return {...structuredClone(state),runtimeWarning:toPublicError(error)}; }
      const ids = new Set(plugins.map((plugin) => plugin.pluginInstanceId));
      for (const id of Object.keys(state.plugins)) if (!ids.has(id)) delete state.plugins[id];
      const affected = new Set(changedPluginInstanceId ? [changedPluginInstanceId] : []);
      for (const plugin of plugins) if (plugin.transport?.serverPluginInstanceId === changedPluginInstanceId) affected.add(plugin.pluginInstanceId);
      const disconnecting = [];
      for (const plugin of plugins) {
        if (!state.plugins[plugin.pluginInstanceId]) {
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected', { reason: state.desiredConnected ? 'MANUAL_RECONNECT_REQUIRED' : null });
        } else if (affected.has(plugin.pluginInstanceId)) {
          state.plugins[plugin.pluginInstanceId] = pluginState(plugin, state.desiredConnected ? 'error' : 'disconnected', { reason: 'MANUAL_RECONNECT_REQUIRED', retryable: false });
          disconnecting.push(this.disconnectRuntime(plugin, 'configuration-change').catch(() => undefined));
        }
      }
      this.aggregate(state, plugins);
      this.publish(state);
      await Promise.all(disconnecting);
      return structuredClone(state);
    });
  }

  disconnect(projectId, environmentId, reason = 'user') {
    this.abortConnectAttempt(projectId, environmentId);
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      state.desiredConnected = false;
      state.intentGeneration += 1;
      state.connectAttemptId = crypto.randomUUID();
      state.phase = 'disconnecting';
      state.manualDisconnected = {};
      this.clearRetry(projectId, environmentId);
      this.publish(state);
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      for (const plugin of plugins) {
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnecting');
      }
      this.publish(state);
      await this.disconnectPluginsInDependencyOrder(plugins, reason);
      for (const plugin of plugins) {
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'disconnected');
      }
      state.phase = 'disconnected';
      state.connectedCount = 0;
      state.errorCount = 0;
      state.blockedCount = 0;
      this.publish(state);
      await this.workspaceStore.appendAudit(projectId, { type: 'environment-disconnected', projectId, environmentId, result: 'success', reason, actor: reason === 'user' ? 'user' : 'system' }).catch(() => undefined);
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
        const result = await this.retryFailed(projectId, environmentId, { retryableOnly: true, actor: 'system' });
        if (!['connected', 'partial'].includes(result.phase) || result.errorCount + result.blockedCount > 0) this.scheduleReconnect(projectId, environmentId, attempt + 1);
      } catch {
        this.scheduleReconnect(projectId, environmentId, attempt + 1);
      }
    }, this.retryDelays[attempt]);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  networkChanged(reason = 'network-change') {
    this.pendingNetworkReason = reason;
    if (this.networkChangePromise) {
      if (this.networkBatchPhase === 'processing') this.networkRerunRequested = true;
      return this.networkChangePromise;
    }
    this.networkChangePromise = (async () => {
      for (let round = 0; round < 2; round += 1) {
        this.networkBatchPhase = 'debouncing';
        if (this.networkDebounceMs > 0) await new Promise((resolve) => setTimeout(resolve, this.networkDebounceMs));
        const currentReason = this.pendingNetworkReason;
        this.pendingNetworkReason = null;
        this.networkRerunRequested = false;
        if (!currentReason) return;
        this.networkBatchPhase = 'processing';
        this.networkEpoch += 1;
        const active = [...this.states.values()].filter((state) => state.desiredConnected);
        await Promise.all(active.map(async (state) => {
          await this.disconnectForReconnect(state.projectId, state.environmentId, currentReason);
          this.scheduleReconnect(state.projectId, state.environmentId, 0);
        }));
        if (!this.networkRerunRequested) break;
      }
    })().finally(() => {
      this.pendingNetworkReason = null;
      this.networkRerunRequested = false;
      this.networkBatchPhase = null;
      this.networkChangePromise = null;
    });
    return this.networkChangePromise;
  }

  async disconnectForReconnect(projectId, environmentId, reason) {
    this.abortConnectAttempt(projectId, environmentId);
    return this.enqueue(projectId, environmentId, async () => {
      const state = structuredClone(this.state(projectId, environmentId));
      if (!state.desiredConnected) return state;
      state.phase = 'reconnecting';
      state.connectAttemptId = crypto.randomUUID();
      state.networkEpoch = this.networkEpoch;
      this.publish(state);
      const plugins = await this.workspaceStore.listPlugins(projectId, environmentId);
      const reconnectable = (plugin) => !state.manualDisconnected?.[plugin.pluginInstanceId]
        && state.plugins[plugin.pluginInstanceId]?.reason !== 'MANUAL_RECONNECT_REQUIRED';
      await this.disconnectPluginsInDependencyOrder(plugins, reason, reconnectable);
      for (const plugin of plugins.filter(reconnectable)) {
        state.plugins[plugin.pluginInstanceId] = pluginState(plugin, 'reconnecting', { reason: 'NETWORK_RECONNECTING', retryable: true });
      }
      this.publish(state);
      return state;
    });
  }

  async closeAll() {
    for (const controller of this.connectControllers.values()) controller.abort();
    this.connectControllers.clear();
    const active = [...this.states.values()].filter((state) => state.desiredConnected || state.phase !== 'disconnected');
    let timer;
    const closeEnvironments = Promise.allSettled(active.map((state) => this.disconnect(state.projectId, state.environmentId, 'app-exit')));
    await Promise.race([
      closeEnvironments,
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.closeDeadlineMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    closeEnvironments.catch(() => undefined);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    let runtimeTimer;
    const closeRuntimes = Promise.resolve().then(() => this.pluginManager.closeAll()).catch(() => undefined);
    await Promise.race([
      closeRuntimes,
      new Promise((resolve) => {
        runtimeTimer = setTimeout(resolve, this.closeDeadlineMs);
        runtimeTimer.unref?.();
      }),
    ]);
    if (runtimeTimer) clearTimeout(runtimeTimer);
  }
}

export const environmentConnectionInternals = { scopeKey, emptyState, pluginState, isRetryable };
