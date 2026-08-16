import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class EnvironmentContextManager {
  constructor(workspaceStore, { ttlMs = DEFAULT_TTL_MS } = {}) {
    this.workspaceStore = workspaceStore;
    this.ttlMs = ttlMs;
    this.contexts = new Map();
  }

  async digest(projectId, environmentId) {
    const [environment, runbook, plugins] = await Promise.all([
      this.workspaceStore.getEnvironment(projectId, environmentId),
      this.workspaceStore.readRunbook(projectId, environmentId),
      this.workspaceStore.listPlugins(projectId, environmentId),
    ]);
    const pluginBindings = Object.fromEntries(plugins.map((plugin) => [
      plugin.pluginInstanceId,
      this.workspaceStore.pluginBindingHash(plugin),
    ]));
    const bindingHash = crypto.createHash('sha256').update(JSON.stringify({
      projectId,
      environmentId,
      environmentRevision: environment.revision,
      runbookHash: runbook.hash,
    })).digest('hex');
    return { environment, runbook, plugins, pluginBindings, bindingHash };
  }

  async open(projectId, environmentId, clientInstanceId = 'unknown') {
    const value = await this.digest(projectId, environmentId);
    const contextToken = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
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

  async verify(projectId, environmentId, pluginInstanceId, contextToken) {
    const context = this.contexts.get(String(contextToken ?? ''));
    if (!context || context.expiresAt <= Date.now()) {
      if (context) this.contexts.delete(contextToken);
      throw new AppError('CONTEXT_REQUIRED', '请重新打开当前环境后再操作。');
    }
    if (context.projectId !== projectId || context.environmentId !== environmentId) {
      throw new AppError('SCOPE_MISMATCH', '操作目标不属于已打开的环境。');
    }
    const current = await this.digest(projectId, environmentId);
    if (current.bindingHash !== context.bindingHash) {
      this.contexts.delete(contextToken);
      throw new AppError('CONTEXT_STALE', '环境说明或插件配置已变化，请重新打开环境。', {
        runbookChanged: current.runbook.hash !== context.runbookHash,
      });
    }
    const plugin = current.plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
    if (!plugin) {
      throw new AppError('CAPABILITY_NOT_GRANTED', '该插件不在当前环境上下文中。');
    }
    if (context.pluginBindings[pluginInstanceId] !== current.pluginBindings[pluginInstanceId]) {
      throw new AppError('CONTEXT_STALE', '目标插件配置或操作规则已变化，请重新打开环境。', { pluginInstanceId });
    }
    return { context, plugin, runbook: current.runbook, environment: current.environment };
  }

  invalidateEnvironment(projectId, environmentId) {
    for (const [token, context] of this.contexts) {
      if (context.projectId === projectId && context.environmentId === environmentId) this.contexts.delete(token);
    }
  }

  clear() {
    this.contexts.clear();
  }
}
