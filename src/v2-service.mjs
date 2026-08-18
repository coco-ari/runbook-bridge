import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { OperationGate, capabilityRule } from './operation-gate.mjs';
import { assessEnvironmentSnapshot, publicPluginAssessment } from './plugin-readiness-service.mjs';
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
  return `${capability}: ${String(args.path ?? args.remotePath ?? args.sourcePath ?? args.unit ?? args.actionId ?? args.sourceId ?? '').slice(0, 240)}`;
}

function auditSummary(plugin, capability, args) {
  if (plugin.pluginType === 'mysql') return `${capability} · 固定数据库 ${plugin.target.database}`;
  if (plugin.pluginType === 'redis') return `${capability} · 固定 DB ${plugin.target.db}`;
  return `${capability} · ${String(args.path ?? args.remotePath ?? args.sourcePath ?? args.unit ?? args.actionId ?? args.sourceId ?? '服务器').slice(0, 120)}`;
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
  constructor({ workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, operationGate = null, serverOperations, credentialVault, mutationCoordinator = null, workspaceChanged = null }) {
    Object.assign(this, { workspaceStore, connectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault, mutationCoordinator, workspaceChanged });
    this.operationGate = operationGate ?? new OperationGate(confirmationManager);
  }

  async assessedConnection(projectId,environmentId,plugins) {
    if (typeof this.connectionManager?.status === 'function') {
      return this.connectionManager.status(projectId,environmentId,{plugins});
    }
    const runtimeSnapshot = typeof this.connectionManager?.snapshot === 'function'
      ? this.connectionManager.snapshot(projectId,environmentId)
      : {projectId,environmentId,phase:'disconnected',sequence:0,plugins:{}};
    return assessEnvironmentSnapshot({plugins,runtimeSnapshot});
  }

  publicPluginsWithAssessments(plugins,connection) {
    return plugins.map((plugin) => ({
      ...this.workspaceStore.publicPlugin(plugin),
      assessment:publicPluginAssessment(connection?.plugins?.[plugin.pluginInstanceId]),
    }));
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
    this.mutationCoordinator?.assertEnvironmentAvailable(params.projectId,params.environmentId);
    const runbook = await this.workspaceStore.readRunbook(params.projectId, params.environmentId);
    const boundedRunbook = takeUtf8(runbook.content, MAX_RUNBOOK_BYTES);
    if (boundedRunbook.truncated) {
      throw new AppError('RUNBOOK_TOO_LARGE', '当前环境运维说明超过 64 KiB，请精简后再让 Agent 打开环境。', { maxBytes: MAX_RUNBOOK_BYTES });
    }
    this.mutationCoordinator?.assertEnvironmentAvailable(params.projectId,params.environmentId);
    const opened = await this.contextManager.open(params.projectId, params.environmentId, params.clientInstanceId);
    const openedRunbook = takeUtf8(opened.runbook.content, MAX_RUNBOOK_BYTES);
    if (openedRunbook.truncated) {
      this.contextManager.invalidateEnvironment(params.projectId, params.environmentId);
      throw new AppError('RUNBOOK_TOO_LARGE', '当前环境运维说明超过 64 KiB，请精简后再让 Agent 打开环境。', { maxBytes: MAX_RUNBOOK_BYTES });
    }
    const connection = await this.assessedConnection(
      params.projectId,
      params.environmentId,
      opened.plugins,
    );
    return {
      projectId: params.projectId,
      environment: { environmentId: opened.environment.environmentId, name: opened.environment.name },
      runbook: { content: openedRunbook.content, hash: opened.runbook.hash, empty: opened.runbook.empty, truncated: false },
      plugins:this.publicPluginsWithAssessments(opened.plugins,connection),
      contextToken: opened.contextToken,
      expiresAt: opened.expiresAt,
      connection,
    };
  }

  async listEnvironmentPlugins(params) {
    const plugins = await this.workspaceStore.listPlugins(params.projectId, params.environmentId);
    const connection = await this.assessedConnection(params.projectId,params.environmentId,plugins);
    return {plugins:this.publicPluginsWithAssessments(plugins,connection),connection};
  }

  async addPlugin(params) {
    const operation = () => this.addPluginUnlocked(params);
    return this.mutationCoordinator
      ? this.mutationCoordinator.enqueueEnvironmentMutation(params.projectId,params.environmentId,operation)
      : operation();
  }

  async addPluginUnlocked(params) {
    const verified = await this.contextManager.verifyEnvironment(params.projectId, params.environmentId, params.contextToken, params.clientInstanceId);
    const input = agentPluginInput(params);
    const mutationToken = this.connectionManager.beginConfigurationMutation?.(params.projectId,params.environmentId,null) ?? null;
    let plugin;
    try {
      plugin = await this.workspaceStore.createPlugin(params.projectId, params.environmentId, input, { expectedEnvironmentRevision:verified.environment.revision });
    } catch (error) {
      if (mutationToken !== null) this.connectionManager.endConfigurationMutation?.(params.projectId,params.environmentId,mutationToken,{restore:true});
      throw error;
    }
    let runtimeWarning = null;
    try {
      const result = await this.connectionManager.configurationChanged(params.projectId, params.environmentId, plugin.pluginInstanceId);
      runtimeWarning = result?.runtimeWarning ?? null;
    } catch (error) { runtimeWarning = toPublicError(error); }
    finally {
      if (mutationToken !== null) this.connectionManager.endConfigurationMutation?.(params.projectId,params.environmentId,mutationToken);
    }
    this.contextManager.invalidateEnvironment(params.projectId, params.environmentId);
    const auditWarning = await this.workspaceStore.appendAudit(params.projectId, {
      type:'plugin-added', environmentId:params.environmentId, pluginInstanceId:plugin.pluginInstanceId,
      pluginType:plugin.pluginType, pluginNameSnapshot:plugin.displayName, actor:'agent', result:'success',
      configState:plugin.configState, operationSummary:plugin.configState === 'ready' ? '已填写非敏感连接配置，保持断开' : '已创建待配置插件草稿',
    }).then(() => false, () => true);
    this.workspaceChanged?.({ type:'plugin-added', projectId:params.projectId, environmentId:params.environmentId, pluginInstanceId:plugin.pluginInstanceId, pluginName:plugin.displayName });
    const catalog = typeof this.workspaceStore.listPlugins === 'function'
      ? await this.workspaceStore.listPlugins(params.projectId,params.environmentId)
      : [plugin];
    const connection = await this.assessedConnection(params.projectId,params.environmentId,catalog);
    return {
      plugin:{
        ...this.workspaceStore.publicPlugin(plugin),
        assessment:publicPluginAssessment(connection.plugins?.[plugin.pluginInstanceId]),
      },
      connection:'disconnected',
      contextStale:true,
      message:plugin.configState === 'ready' ? '插件已配置并保持断开，请人工点击连接。' : '插件草稿已创建，请人工补齐配置后连接。',
      ...(auditWarning ? { auditWarning:true } : {}),
      ...(runtimeWarning ? {runtimeWarning,manualReconnectRequired:true} : {}),
    };
  }

  readRunbook(params) {
    return this.workspaceStore.readRunbook(params.projectId, params.environmentId);
  }

  confirmationSummary(plugin, capability, args) {
    if (plugin.pluginType !== 'server') return operationSummary(plugin, capability, args);
    if (capability === 'fs.upload') return `上传 ${args._precondition.local.size} 字节（SHA-256 ${args._precondition.local.sha256.slice(0, 12)}…）：${args.localPath} → ${args.remotePath}${args.overwrite ? '（覆盖）' : ''}`;
    if (capability === 'fs.write') return `写入 ${args._precondition.bytes} 字节（SHA-256 ${args._precondition.newSha256.slice(0, 12)}…）：${args.path}${args.overwrite ? '（覆盖）' : ''}`;
    if (capability === 'fs.move') return `移动或重命名：${args.sourcePath} → ${args.destinationPath}${args.overwrite ? '（覆盖）' : ''}`;
    if (capability === 'fs.delete') return `删除 ${args._precondition.remote.type}：${args.path}`;
    if (capability === 'service.control') return `${args.action} systemd 服务：${args.unit}`;
    if (capability === 'shell.execute') return `执行 Shell：${args.command}${args.workingDirectory ? `（目录 ${args.workingDirectory}）` : ''}`;
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

  confirmationPresentation(plugin, capability, args) {
    const base = { kind:'operation', target:plugin.displayName };
    if (plugin.pluginType !== 'server') return base;
    if (capability === 'fs.upload') return {
      ...base, kind:'file-transfer', source:args.localPath, destination:args.remotePath,
      bytes:args._precondition.local.size, sha256:args._precondition.local.sha256, overwrite:Boolean(args.overwrite),
    };
    if (capability === 'fs.write') return {
      ...base, kind:'file-write', destination:args.path, bytes:args._precondition.bytes,
      sha256:args._precondition.newSha256, overwrite:Boolean(args.overwrite),
    };
    if (capability === 'fs.move') return {
      ...base, kind:'path-move', source:args.sourcePath, destination:args.destinationPath, overwrite:Boolean(args.overwrite),
    };
    if (capability === 'fs.delete') return {
      ...base, kind:'path-delete', destination:args.path, remoteType:args._precondition?.remote?.type ?? '路径',
    };
    if (capability === 'service.control') return {
      ...base, kind:'service-control', action:args.action, unit:args.unit,
    };
    if (capability === 'shell.execute') return {
      ...base, kind:'shell', command:args.command, workingDirectory:args.workingDirectory ?? null,
    };
    return base;
  }

  async serverDescriptors(params, kind) {
    const verified = await this.contextManager.verify(params.projectId, params.environmentId, params.pluginInstanceId, params.contextToken, params.clientInstanceId);
    if (verified.plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', '目标不是 Server 插件。');
    const plugin = pluginWithRunbookSources(verified.plugin, verified.runbook.content);
    return kind === 'actions'
      ? { actions: this.serverOperations.listActions(plugin) }
      : { sources: this.serverOperations.listSources(plugin) };
  }

  async requireCallable(params) {
    const scope = scopeOf(params);
    const verified = await this.contextManager.verify(scope.projectId, scope.environmentId, scope.pluginInstanceId, params.contextToken, scope.clientInstanceId);
    const runtime = this.connectionManager.snapshot(scope.projectId, scope.environmentId).plugins[scope.pluginInstanceId];
    if (runtime?.phase !== 'connected') {
      const code = runtime?.phase === 'reconnecting' ? 'PLUGIN_RECONNECTING' : runtime?.phase === 'blocked' || runtime?.phase === 'error' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_NOT_CONNECTED';
      throw new AppError(code, runtime?.error?.message ?? '目标插件当前不可用。', { phase: runtime?.phase ?? 'disconnected', reason: runtime?.reason ?? null });
    }
    return { plugin:pluginWithRunbookSources(verified.plugin, verified.runbook.content), environment:verified.environment };
  }

  async invoke(params, capability, args = {}) {
    const operation = async () => {
      this.connectionManager.assertConfigurationStable?.(params.projectId,params.environmentId);
      return this.invokeUnlocked(params,capability,args);
    };
    return this.mutationCoordinator
      ? this.mutationCoordinator.runEnvironmentOperation(params.projectId,params.environmentId,operation)
      : operation();
  }

  async invokeUnlocked(params, capability, args = {}) {
    const requestId = String(params.requestId ?? crypto.randomUUID()).slice(0, 128);
    let plugin;
    let operationArgs = args;
    let confirmationId = null;
    try {
      const callable = await this.requireCallable(params);
      plugin = callable.plugin;
      if (plugin.pluginType === 'server' && capabilityRule('server', capability).decision === 'confirm') {
        operationArgs = await this.serverOperations.prepareMutation(plugin, capability, args);
      }
      const rule = capabilityRule(plugin.pluginType, capability);
      const metadata = {};
      if (rule.decision === 'confirm') {
        const project = await this.workspaceStore.getProject(params.projectId);
        Object.assign(metadata, {
          projectNameSnapshot:project.name,
          environmentNameSnapshot:callable.environment.name,
          pluginNameSnapshot:plugin.displayName,
        });
      }
      const authorization = this.operationGate.authorize({
        scope:scopeOf(params), plugin, capability, args:operationArgs, approvalToken:params.approvalToken,
        summary:this.confirmationSummary(plugin, capability, operationArgs),
        metadata:{...metadata,presentation:this.confirmationPresentation(plugin, capability, operationArgs)},
      });
      confirmationId = authorization.confirmationId ?? null;
    } catch (error) {
      const value = toPublicError(error);
      const attempted = await this.workspaceStore.getPlugin(params.projectId, params.environmentId, params.pluginInstanceId).catch(() => null);
      const repeatedPendingConfirmation = value.code === 'CONFIRMATION_REQUIRED' && value.details?.confirmationCreated === false;
      if (!repeatedPendingConfirmation) {
        await this.workspaceStore.appendAudit(params.projectId, {
          type:'plugin-operation-decision', requestId, environmentId:params.environmentId,
          pluginInstanceId:params.pluginInstanceId, pluginType:attempted?.pluginType,
          pluginNameSnapshot:attempted?.displayName, actor:'agent', capability,
          operationSummary:attempted ? auditSummary(attempted, capability, operationArgs) : String(capability),
          result:value.code === 'CONFIRMATION_REQUIRED' ? 'pending-confirmation' : 'blocked', errorCode:value.code,
          confirmationId:value.code === 'CONFIRMATION_REQUIRED' ? value.details?.requestId ?? null : null,
        }).catch(() => undefined);
      }
      throw error;
    }
    const started = Date.now();
    await this.workspaceStore.appendAudit(plugin.projectId, {
      type: 'plugin-operation-started', requestId, environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, capability,
      pluginNameSnapshot: plugin.displayName, actor: 'agent', operationSummary: auditSummary(plugin, capability, operationArgs), result: 'started', confirmationId,
    });
    if (confirmationId) this.workspaceChanged?.({ type:'confirmation-execution', status:'running', confirmationId, projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId });
    try {
      let result;
      if (plugin.pluginType === 'server') result = await this.invokeServer(plugin, capability, operationArgs);
      else result = await this.pluginManager.invoke(plugin, capability, { ...operationArgs, policyApproved: true });
      const durationMs = Date.now() - started;
      const auditFailed = await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, pluginNameSnapshot: plugin.displayName, actor: 'agent', capability, operationSummary: auditSummary(plugin, capability, operationArgs), result: 'success', durationMs, confirmationId }).then(() => false, () => true);
      if (confirmationId) this.workspaceChanged?.({ type:'confirmation-execution', status:'success', confirmationId, projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, durationMs });
      return auditFailed && result && typeof result === 'object' ? { ...result, auditWarning:true } : result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const errorCode = toPublicError(error).code;
      await this.workspaceStore.appendAudit(plugin.projectId, { type: 'plugin-operation', requestId, environmentId: plugin.environmentId, pluginInstanceId: plugin.pluginInstanceId, pluginType: plugin.pluginType, pluginNameSnapshot: plugin.displayName, actor: 'agent', capability, operationSummary: auditSummary(plugin, capability, operationArgs), result: 'error', errorCode, durationMs, confirmationId }).catch(() => undefined);
      if (confirmationId) this.workspaceChanged?.({ type:'confirmation-execution', status:'error', confirmationId, projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, durationMs, errorCode });
      throw error;
    }
  }

  invokeServer(plugin, capability, args) {
    if (capability === 'status' || capability === 'diagnostics') return this.serverOperations.runAction(plugin, args.actionId, args.parameters ?? {});
    if (capability === 'service.inspect') return this.serverOperations.inspectService(plugin, args);
    if (capability === 'journal.read') return this.serverOperations.queryJournal(plugin, args);
    if (capability === 'container.inspect') return this.serverOperations.inspectContainer(plugin, args);
    if (capability === 'logs') {
      if (args.operation === 'list') return this.serverOperations.listFiles(plugin, args);
      if (args.operation === 'search') return this.serverOperations.searchLogs(plugin, args);
      return this.serverOperations.readLog(plugin, args);
    }
    if (capability === 'config') return this.serverOperations.readConfig(plugin, args);
    if (capability === 'download') return this.serverOperations.download(plugin, args);
    if (capability === 'fs.stat') return this.serverOperations.statPath(plugin, args);
    if (capability === 'fs.list') return this.serverOperations.listDirectory(plugin, args);
    if (capability === 'fs.find') return this.serverOperations.findFiles(plugin, args);
    if (capability === 'fs.read') return this.serverOperations.readFile(plugin, args);
    if (capability === 'fs.search') return this.serverOperations.searchFiles(plugin, args);
    if (capability === 'fs.download') return this.serverOperations.downloadPath(plugin, args);
    if (capabilityRule('server', capability).decision === 'confirm') return this.serverOperations.mutate(plugin, capability, args);
    throw new AppError('CAPABILITY_NOT_IMPLEMENTED', 'Server 操作尚未实现。');
  }
}
