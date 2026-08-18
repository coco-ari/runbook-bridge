import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { pluginAgentFingerprint, pluginConnectionFingerprint } from './plugin-change-classifier.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class EnvironmentContextManager {
  constructor(workspaceStore, { ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.workspaceStore = workspaceStore;
    this.ttlMs = ttlMs;
    this.now = now;
    this.contexts = new Map();
  }

  pruneExpired(current = this.now()) {
    for (const [token, context] of this.contexts) {
      if (context.expiresAt <= current) this.contexts.delete(token);
    }
  }

  async digest(projectId, environmentId) {
    const [environment, runbook, plugins] = await Promise.all([
      this.workspaceStore.getEnvironment(projectId, environmentId),
      this.workspaceStore.readRunbook(projectId, environmentId),
      this.workspaceStore.listPlugins(projectId, environmentId),
    ]);
    const pluginBindings = Object.fromEntries(plugins.map((plugin) => [
      plugin.pluginInstanceId,
      {
        connectionFingerprint:pluginConnectionFingerprint(plugin),
        agentFingerprint:pluginAgentFingerprint(plugin),
        resourceScope:getPluginConnectionAdapter(plugin.pluginType).resourceScope(plugin),
      },
    ]));
    const bindingHash = crypto.createHash('sha256').update(JSON.stringify({
      projectId,
      environmentId,
      runbookHash: runbook.hash,
      pluginBindings,
    })).digest('hex');
    return { environment, runbook, plugins, pluginBindings, bindingHash };
  }

  async open(projectId, environmentId, clientInstanceId = 'unknown') {
    this.pruneExpired();
    const value = await this.digest(projectId, environmentId);
    const contextToken = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.contexts.set(contextToken, {
      projectId,
      environmentId,
      clientInstanceId: String(clientInstanceId).slice(0, 128),
      bindingHash: value.bindingHash,
      pluginBindings: value.pluginBindings,
      runbookHash: value.runbook.hash,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
    return { contextToken, expiresAt: new Date(createdAt + this.ttlMs).toISOString(), ...value };
  }

  async verifyEnvironment(projectId, environmentId, contextToken, clientInstanceId = 'unknown') {
    const currentTime = this.now();
    this.pruneExpired(currentTime);
    const context = this.contexts.get(String(contextToken ?? ''));
    if (!context) {
      throw new AppError('CONTEXT_REQUIRED', '请重新打开当前环境后再操作。');
    }
    if (context.projectId !== projectId || context.environmentId !== environmentId) {
      throw new AppError('SCOPE_MISMATCH', '操作目标不属于已打开的环境。');
    }
    if (context.clientInstanceId !== String(clientInstanceId).slice(0, 128)) {
      throw new AppError('CLIENT_CONTEXT_MISMATCH', '当前环境上下文属于另一个 Agent 会话，请重新打开环境。');
    }
    const current = await this.digest(projectId, environmentId);
    if (current.bindingHash !== context.bindingHash) {
      this.contexts.delete(contextToken);
      throw new AppError('CONTEXT_STALE', '环境说明或插件配置已变化，请重新打开环境。', {
        runbookChanged: current.runbook.hash !== context.runbookHash,
      });
    }
    return { context, runbook: current.runbook, environment: current.environment, plugins:current.plugins, pluginBindings:current.pluginBindings };
  }

  async verify(projectId, environmentId, pluginInstanceId, contextToken, clientInstanceId = 'unknown') {
    const current = await this.verifyEnvironment(projectId, environmentId, contextToken, clientInstanceId);
    const plugin = current.plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
    if (!plugin) {
      throw new AppError('CAPABILITY_NOT_GRANTED', '该插件不在当前环境上下文中。');
    }
    if (JSON.stringify(current.context.pluginBindings[pluginInstanceId]) !== JSON.stringify(current.pluginBindings[pluginInstanceId])) {
      throw new AppError('CONTEXT_STALE', '目标插件连接配置已变化，请重新打开环境。', { pluginInstanceId });
    }
    return { context:current.context, plugin, runbook:current.runbook, environment:current.environment };
  }

  invalidateEnvironment(projectId, environmentId) {
    this.pruneExpired();
    for (const [token, context] of this.contexts) {
      if (context.projectId === projectId && context.environmentId === environmentId) this.contexts.delete(token);
    }
  }

  invalidateProject(projectId) {
    this.pruneExpired();
    for (const [token, context] of this.contexts) {
      if (context.projectId === projectId) this.contexts.delete(token);
    }
  }

  clear() {
    this.contexts.clear();
  }
}
