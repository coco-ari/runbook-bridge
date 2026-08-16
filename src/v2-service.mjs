import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { pluginWithRunbookSources } from './runbook-sources.mjs';

const MAX_RUNBOOK_BYTES = 64 * 1024;

function takeUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { content: buffer.toString('utf8'), truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

function scopeOf(params) {
  return {
    projectId: String(params.projectId ?? ''),
    environmentId: String(params.environmentId ?? ''),
    pluginInstanceId: String(params.pluginInstanceId ?? ''),
  };
}

function operationSummary(plugin, capability, args) {
  if (plugin.pluginType === 'mysql') return `${capability}: ${String(args.sql ?? args.table ?? '').slice(0, 240)}`;
  if (plugin.pluginType === 'redis') return `${capability}: ${String(args.key ?? args.patternId ?? '').slice(0, 240)}`;
  return `${capability}: ${String(args.actionId ?? args.sourceId ?? '').slice(0, 240)}`;
}

export class V2Service {
  constructor({ workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault }) {
    Object.assign(this, { workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault });
  }

  async listProjects() {
    const projects = await this.workspaceStore.listProjects();
    return { projects: projects.slice(0, 200), truncated: projects.length > 200 };
  }

  async listEnvironments(params) {
    const environments = await this.workspaceStore.listEnvironments(params.projectId);
    return { environments: environments.slice(0, 100), truncated: environments.length > 100 };
  }

  async openEnvironment(params) {
    const opened = await this.contextManager.open(params.projectId, params.environmentId, params.clientInstanceId);
    const boundedRunbook = takeUtf8(opened.runbook.content, MAX_RUNBOOK_BYTES);
    return {
      projectId: params.projectId,
      environment: { environmentId: opened.environment.environmentId, name: opened.environment.name },
      runbook: { content: boundedRunbook.content, hash: opened.runbook.hash, empty: opened.runbook.empty, truncated: boundedRunbook.truncated },
      plugins: opened.plugins.map((plugin) => this.workspaceStore.publicPlugin(plugin)),
      contextToken: opened.contextToken,
      expiresAt: opened.expiresAt,
      connection: this.connectionManager.snapshot(params.projectId, params.environmentId),
    };
  }

  async listEnvironmentPlugins(params) {
    const plugins = await this.workspaceStore.listPlugins(params.projectId, params.environmentId);
    return { plugins: plugins.map((plugin) => this.workspaceStore.publicPlugin(plugin)), connection: this.connectionManager.snapshot(params.projectId, params.environmentId) };
  }

  readRunbook(params) {
    return this.workspaceStore.readRunbook(params.projectId, params.environmentId);
  }

  async serverDescriptors(params, kind) {
    const verified = await this.contextManager.verify(params.projectId, params.environmentId, params.pluginInstanceId, params.contextToken);
    if (verified.plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', '目标不是 Server 插件。');
    const plugin = pluginWithRunbookSources(verified.plugin, verified.runbook.content);
    return kind === 'actions'
      ? { actions: this.serverOperations.listActions(plugin) }
      : { sources: this.serverOperations.listSources(plugin) };
  }

  async requireCallable(params, capability, args) {
    const scope = scopeOf(params);
    const verified = await this.contextManager.verify(scope.projectId, scope.environmentId, scope.pluginInstanceId, params.contextToken);
    const runtime = this.connectionManager.snapshot(scope.projectId, scope.environmentId).plugins[scope.pluginInstanceId];
    if (runtime?.phase !== 'connected') {
      const code = runtime?.phase === 'reconnecting' ? 'PLUGIN_RECONNECTING' : runtime?.phase === 'blocked' || runtime?.phase === 'error' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_NOT_CONNECTED';
      throw new AppError(code, runtime?.error?.message ?? '目标插件当前不可用。', { phase: runtime?.phase ?? 'disconnected', reason: runtime?.reason ?? null });
    }
    const mode = verified.plugin.policy?.[capability];
    if (!mode || mode === 'deny') throw new AppError('POLICY_DENIED', '该操作已被插件规则禁止。');
    if (mode === 'confirm') {
      const approved = params.approvalToken
        ? this.confirmationManager.consume(params.approvalToken, scope, capability, args)
        : this.confirmationManager.consumeMatching(scope, capability, args);
      if (!approved) {
        const pending = this.confirmationManager.request(scope, capability, args);
        throw new AppError('CONFIRMATION_REQUIRED', '该操作需要在桌面端确认。', { requestId: pending.requestId, summary: operationSummary(verified.plugin, capability, args) });
      }
    }
    return pluginWithRunbookSources(verified.plugin, verified.runbook.content);
  }

  async invoke(params, capability, args = {}) {
    const plugin = await this.requireCallable(params, capability, args);
    const requestId = String(params.requestId ?? crypto.randomUUID()).slice(0, 128);
    const started = Date.now();
    await this.workspaceStore.appendAudit(plugin.projectId, {
      type: 'plugin-operation-started', requestId, environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, capability,
      result: 'started',
    });
    try {
      let result;
      if (plugin.pluginType === 'server') result = await this.invokeServer(plugin, capability, args);
      else result = await this.pluginManager.invoke(plugin, capability, { ...args, policyApproved: true });
      await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, capability, result: 'success', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, capability, result: 'error', errorCode: toPublicError(error).code, durationMs: Date.now() - started }).catch(() => undefined);
      throw error;
    }
  }

  invokeServer(plugin, capability, args) {
    if (capability === 'status' || capability === 'diagnostics') return this.serverOperations.runAction(plugin, args.actionId, args.parameters ?? {});
    if (capability === 'logs') {
      if (args.operation === 'list') return this.serverOperations.listFiles(plugin, args);
      if (args.operation === 'search') return this.serverOperations.searchLogs(plugin, args);
      return this.serverOperations.readLog(plugin, args);
    }
    if (capability === 'config') return this.serverOperations.readConfig(plugin, args);
    if (capability === 'download') return this.serverOperations.download(plugin, args);
    throw new AppError('CAPABILITY_NOT_IMPLEMENTED', 'Server 操作尚未实现。');
  }
}
