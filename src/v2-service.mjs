import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { pluginWithRunbookSources } from './runbook-sources.mjs';

const MAX_RUNBOOK_BYTES = 64 * 1024;
const AGENT_PLUGIN_FIELDS = {
  server: new Set(['host','port','username','addressFamily','authType','privateKeyPath','uplinkType','proxyHost','proxyPort','proxyUsername','vpnInterfaceAlias']),
  mysql: new Set(['host','port','username','database','addressFamily','connectionMode','serverPluginInstanceId','vpnInterfaceAlias','tlsMode']),
  redis: new Set(['host','port','username','logicalDb','addressFamily','connectionMode','serverPluginInstanceId','vpnInterfaceAlias','tlsMode']),
};

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
    clientInstanceId: String(params.clientInstanceId ?? 'unknown').slice(0, 128),
  };
}

function operationSummary(plugin, capability, args) {
  if (plugin.pluginType === 'mysql') return `${capability}: ${String(args.sql ?? args.table ?? '').slice(0, 240)}`;
  if (plugin.pluginType === 'redis') return `${capability}: ${String(args.key ?? args.patternId ?? '').slice(0, 240)}`;
  return `${capability}: ${String(args.actionId ?? args.sourceId ?? '').slice(0, 240)}`;
}

function auditSummary(plugin, capability, args) {
  if (plugin.pluginType === 'mysql') return `${capability} · 固定数据库 ${plugin.target.database}`;
  if (plugin.pluginType === 'redis') return `${capability} · 固定 DB ${plugin.target.db}`;
  return `${capability} · ${String(args.actionId ?? args.sourceId ?? '已登记资源').slice(0, 120)}`;
}

function definedEntries(value) {
  return Object.fromEntries(Object.entries(value).filter(([,item]) => item !== undefined));
}

function agentPluginInput(params) {
  const pluginType = String(params.pluginType ?? '');
  const allowed = AGENT_PLUGIN_FIELDS[pluginType];
  if (!allowed) throw new AppError('INVALID_ARGUMENT', '插件类型必须是 Server、MySQL 或 Redis。');
  const configuration = params.configuration && typeof params.configuration === 'object' && !Array.isArray(params.configuration) ? params.configuration : {};
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AppError('INVALID_ARGUMENT', `当前插件类型不支持这些配置项：${unknown.join('、')}。`);
  const target = definedEntries({
    host:configuration.host,
    port:configuration.port,
    addressFamily:configuration.addressFamily,
    ...(pluginType === 'mysql' ? { database:configuration.database } : {}),
    ...(pluginType === 'redis' ? { db:configuration.logicalDb } : {}),
  });
  const input = {
    pluginType,
    displayName:params.displayName,
    target,
    auth:definedEntries({ username:configuration.username }),
  };
  if (pluginType === 'server') {
    input.auth = definedEntries({ username:configuration.username, type:configuration.authType, privateKeyPath:configuration.privateKeyPath });
    input.uplink = definedEntries({
      type:configuration.uplinkType,
      host:configuration.proxyHost,
      port:configuration.proxyPort,
      username:configuration.proxyUsername,
      interfaceAlias:configuration.vpnInterfaceAlias,
    });
  } else {
    input.transport = definedEntries({
      kind:configuration.connectionMode,
      serverPluginInstanceId:configuration.serverPluginInstanceId,
      interfaceAlias:configuration.vpnInterfaceAlias,
    });
    input.tls = definedEntries({ mode:configuration.tlsMode });
  }
  return input;
}

export class V2Service {
  constructor({ workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault, workspaceChanged = null }) {
    Object.assign(this, { workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault, workspaceChanged });
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
    const runbook = await this.workspaceStore.readRunbook(params.projectId, params.environmentId);
    const boundedRunbook = takeUtf8(runbook.content, MAX_RUNBOOK_BYTES);
    if (boundedRunbook.truncated) {
      throw new AppError('RUNBOOK_TOO_LARGE', '当前环境运维说明超过 64 KiB，请精简后再让 Agent 打开环境。', { maxBytes: MAX_RUNBOOK_BYTES });
    }
    const opened = await this.contextManager.open(params.projectId, params.environmentId, params.clientInstanceId);
    const openedRunbook = takeUtf8(opened.runbook.content, MAX_RUNBOOK_BYTES);
    if (openedRunbook.truncated) {
      this.contextManager.invalidateEnvironment(params.projectId, params.environmentId);
      throw new AppError('RUNBOOK_TOO_LARGE', '当前环境运维说明超过 64 KiB，请精简后再让 Agent 打开环境。', { maxBytes: MAX_RUNBOOK_BYTES });
    }
    return {
      projectId: params.projectId,
      environment: { environmentId: opened.environment.environmentId, name: opened.environment.name },
      runbook: { content: openedRunbook.content, hash: opened.runbook.hash, empty: opened.runbook.empty, truncated: false },
      plugins: opened.plugins.map((plugin) => this.workspaceStore.publicPlugin(plugin)),
      contextToken: opened.contextToken,
      expiresAt: opened.expiresAt,
      connection: await this.connectionManager.status(params.projectId, params.environmentId),
    };
  }

  async listEnvironmentPlugins(params) {
    const plugins = await this.workspaceStore.listPlugins(params.projectId, params.environmentId);
    return { plugins: plugins.map((plugin) => this.workspaceStore.publicPlugin(plugin)), connection: await this.connectionManager.status(params.projectId, params.environmentId) };
  }

  async addPlugin(params) {
    const verified = await this.contextManager.verifyEnvironment(params.projectId, params.environmentId, params.contextToken, params.clientInstanceId);
    const input = agentPluginInput(params);
    const plugin = await this.workspaceStore.createPlugin(params.projectId, params.environmentId, input, { expectedEnvironmentRevision:verified.environment.revision });
    await this.connectionManager.configurationChanged(params.projectId, params.environmentId, plugin.pluginInstanceId);
    this.contextManager.invalidateEnvironment(params.projectId, params.environmentId);
    const auditWarning = await this.workspaceStore.appendAudit(params.projectId, {
      type:'plugin-added', environmentId:params.environmentId, pluginInstanceId:plugin.pluginInstanceId,
      pluginType:plugin.pluginType, pluginNameSnapshot:plugin.displayName, actor:'agent', result:'success',
      configState:plugin.configState, operationSummary:plugin.configState === 'ready' ? '已填写非敏感连接配置，保持断开' : '已创建待配置插件草稿',
    }).then(() => false, () => true);
    this.workspaceChanged?.({ type:'plugin-added', projectId:params.projectId, environmentId:params.environmentId, pluginInstanceId:plugin.pluginInstanceId, pluginName:plugin.displayName });
    return {
      plugin:this.workspaceStore.publicPlugin(plugin),
      connection:'disconnected',
      contextStale:true,
      message:plugin.configState === 'ready' ? '插件已配置并保持断开，请人工点击连接。' : '插件草稿已创建，请人工补齐配置后连接。',
      ...(auditWarning ? { auditWarning:true } : {}),
    };
  }

  readRunbook(params) {
    return this.workspaceStore.readRunbook(params.projectId, params.environmentId);
  }

  confirmationSummary(plugin, capability, args) {
    if (plugin.pluginType !== 'server') return operationSummary(plugin, capability, args);
    if (args.fileId) {
      const file = this.serverOperations.describeFile(plugin, args.fileId);
      return `${capability === 'download' ? '下载' : capability === 'config' ? '读取配置' : '读取日志'}：${file.relativePath}（${file.size} 字节）`;
    }
    if (Array.isArray(args.fileIds)) {
      const files = args.fileIds.map((fileId) => this.serverOperations.describeFile(plugin, fileId));
      const needle = String(args.contains ?? '').replace(/[\r\n]/g, ' ').slice(0, 80);
      return `搜索 ${files.length} 个日志文件：${needle}`;
    }
    return operationSummary(plugin, capability, args);
  }

  async serverDescriptors(params, kind) {
    const verified = await this.contextManager.verify(params.projectId, params.environmentId, params.pluginInstanceId, params.contextToken, params.clientInstanceId);
    if (verified.plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', '目标不是 Server 插件。');
    const plugin = pluginWithRunbookSources(verified.plugin, verified.runbook.content);
    return kind === 'actions'
      ? { actions: this.serverOperations.listActions(plugin) }
      : { sources: this.serverOperations.listSources(plugin) };
  }

  async requireCallable(params, capability, args) {
    const scope = scopeOf(params);
    const verified = await this.contextManager.verify(scope.projectId, scope.environmentId, scope.pluginInstanceId, params.contextToken, scope.clientInstanceId);
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
        const summary = this.confirmationSummary(verified.plugin, capability, args);
        const project = await this.workspaceStore.getProject(scope.projectId);
        const pending = this.confirmationManager.request(scope, capability, args, summary, {
          projectNameSnapshot:project.name,
          environmentNameSnapshot:verified.environment.name,
          pluginNameSnapshot:verified.plugin.displayName,
        });
        throw new AppError('CONFIRMATION_REQUIRED', '该操作需要在桌面端确认。', { requestId: pending.requestId, summary });
      }
    }
    return pluginWithRunbookSources(verified.plugin, verified.runbook.content);
  }

  async invoke(params, capability, args = {}) {
    const requestId = String(params.requestId ?? crypto.randomUUID()).slice(0, 128);
    let plugin;
    try {
      plugin = await this.requireCallable(params, capability, args);
    } catch (error) {
      const value = toPublicError(error);
      const attempted = await this.workspaceStore.getPlugin(params.projectId, params.environmentId, params.pluginInstanceId).catch(() => null);
      await this.workspaceStore.appendAudit(params.projectId, {
        type:'plugin-operation-decision', requestId, environmentId:params.environmentId,
        pluginInstanceId:params.pluginInstanceId, pluginType:attempted?.pluginType,
        pluginNameSnapshot:attempted?.displayName, actor:'agent', capability,
        operationSummary:attempted ? auditSummary(attempted, capability, args) : String(capability),
        result:value.code === 'CONFIRMATION_REQUIRED' ? 'pending-confirmation' : 'blocked', errorCode:value.code,
      }).catch(() => undefined);
      throw error;
    }
    const started = Date.now();
    await this.workspaceStore.appendAudit(plugin.projectId, {
      type: 'plugin-operation-started', requestId, environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, capability,
      pluginNameSnapshot: plugin.displayName, actor: 'agent', operationSummary: auditSummary(plugin, capability, args), result: 'started',
    });
    try {
      let result;
      if (plugin.pluginType === 'server') result = await this.invokeServer(plugin, capability, args);
      else result = await this.pluginManager.invoke(plugin, capability, { ...args, policyApproved: true });
      const auditFailed = await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, pluginNameSnapshot: plugin.displayName, actor: 'agent', capability, operationSummary: auditSummary(plugin, capability, args), result: 'success', durationMs: Date.now() - started }).then(() => false, () => true);
      return auditFailed && result && typeof result === 'object' ? { ...result, auditWarning:true } : result;
    } catch (error) {
      await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, pluginNameSnapshot: plugin.displayName, actor: 'agent', capability, operationSummary: auditSummary(plugin, capability, args), result: 'error', errorCode: toPublicError(error).code, durationMs: Date.now() - started }).catch(() => undefined);
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
