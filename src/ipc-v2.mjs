import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import { workspaceInternals } from './workspace-store.mjs';

function resultHandler(handler) {
  return async (_event, ...args) => {
    try { return { ok: true, data: await handler(...args) }; }
    catch (error) { return { ok: false, error: toPublicError(error) }; }
  };
}

function resultHandlerWithEvent(handler) {
  return async (event, ...args) => {
    try { return { ok:true, data:await handler(event,...args) }; }
    catch (error) { return { ok:false, error:toPublicError(error) }; }
  };
}

export function registerV2Ipc(ipcMain, services) {
  const { workspaceStore: store, connectionManager, credentialVault, contextManager, confirmationManager, pluginManager, mysqlRuntime } = services;
  const handle = (name, fn) => ipcMain.handle(`v2:${name}`, resultHandler(fn));
  ipcMain.on('v2:network-changed', () => connectionManager.networkChanged('renderer-network-change').catch(() => undefined));

  handle('project-list', () => store.listProjects());
  handle('workspace-overview', async () => {
    const projects = await store.listProjects();
    return Promise.all(projects.map(async (project) => {
      const environments = await store.listEnvironments(project.projectId);
      return {
        ...project,
        environments: environments.map((environment) => {
          const runtime = connectionManager.snapshot(project.projectId, environment.environmentId);
          return {
            ...environment,
            runtime: {
              ...runtime,
              eligibleCount: environment.readyPluginCount,
              draftCount: environment.pluginCount - environment.readyPluginCount,
            },
          };
        }),
      };
    }));
  });
  handle('project-create', async (input) => {
    const value = await store.createProject(input);
    services.broadcast?.('v2:workspace-changed', { type:'project-created', projectId:value.projectId });
    return value;
  });
  handle('project-update', async ({ projectId, patch, expectedRevision }) => {
    const value = await store.updateProject(projectId, patch, expectedRevision);
    services.broadcast?.('v2:workspace-changed', { type:'project-updated', projectId });
    return value;
  });
  handle('project-delete', async ({ projectId }) => {
    const environments = await store.listEnvironments(projectId);
    const active = environments.filter((environment) => {
      const runtime = connectionManager.snapshot(projectId, environment.environmentId);
      return runtime.desiredConnected || runtime.phase !== 'disconnected';
    });
    if (active.length) {
      throw new AppError('PROJECT_CONNECTED', `请先断开项目中的环境：${active.map((item) => item.name).join('、')}。`);
    }
    const value = await store.deleteProject(projectId);
    contextManager.invalidateProject(projectId);
    connectionManager.forgetProject(projectId);
    services.broadcast?.('v2:workspace-changed', { type:'project-deleted', projectId });
    return { ...value, credentialsPreserved:true };
  });
  handle('environment-list', (projectId) => store.listEnvironments(projectId));
  handle('environment-create', ({ projectId, input }) => store.createEnvironment(projectId, input));
  handle('environment-update', async ({ projectId, environmentId, patch, expectedRevision }) => {
    const value = await store.updateEnvironment(projectId, environmentId, patch, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
  });
  handle('environment-delete', ({ projectId, environmentId }) => {
    const state = connectionManager.snapshot(projectId, environmentId);
    return store.deleteEnvironment(projectId, environmentId, { runtimeActive: state.desiredConnected || state.phase !== 'disconnected' });
  });
  handle('environment-reorder', ({ projectId, environmentIds, expectedRevision }) => store.reorderEnvironments(projectId, environmentIds, expectedRevision));
  handle('environment-connect', ({ projectId, environmentId, expectedRevision, secretsByPlugin }) => connectionManager.connect(projectId, environmentId, { expectedRevision, secretsByPlugin }));
  handle('environment-retry', ({ projectId, environmentId, secretsByPlugin }) => connectionManager.retryFailed(projectId, environmentId, { secretsByPlugin }));
  handle('environment-disconnect', ({ projectId, environmentId }) => connectionManager.disconnect(projectId, environmentId));
  handle('environment-cancel', ({ projectId, environmentId }) => connectionManager.cancel(projectId, environmentId));
  handle('environment-status', ({ projectId, environmentId }) => connectionManager.status(projectId, environmentId));
  handle('plugin-connect', ({ projectId, environmentId, pluginInstanceId }) => connectionManager.connectPlugin(projectId, environmentId, pluginInstanceId));
  handle('plugin-disconnect', ({ projectId, environmentId, pluginInstanceId }) => connectionManager.disconnectPlugin(projectId, environmentId, pluginInstanceId));
  handle('runbook-read', ({ projectId, environmentId }) => store.readRunbook(projectId, environmentId));
  handle('runbook-save', async ({ projectId, environmentId, content, expectedRevision }) => {
    const value = await store.saveRunbook(projectId, environmentId, content, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    await store.appendAudit(projectId, { type:'runbook-updated', environmentId, actor:'user', result:'success', bytes:Buffer.byteLength(String(content ?? ''),'utf8') }).catch(() => undefined);
    return value;
  });
  handle('plugin-list', ({ projectId, environmentId }) => store.listPlugins(projectId, environmentId));
  handle('plugin-create', async ({ projectId, environmentId, input, secrets }) => {
    const plugin = await store.createPlugin(projectId, environmentId, input);
    try {
      if (secrets && Object.values(secrets).some(Boolean)) await credentialVault.save(plugin, secrets);
    } catch (error) {
      await store.deletePlugin(projectId, environmentId, plugin.pluginInstanceId).catch(() => undefined);
      throw error;
    }
    await connectionManager.configurationChanged(projectId, environmentId, plugin.pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return plugin;
  });
  handle('plugin-update', async ({ projectId, environmentId, pluginInstanceId, patch, expectedRevision, secrets }) => {
    const before = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const plugin = await store.updatePlugin(projectId, environmentId, pluginInstanceId, patch, expectedRevision);
    try {
      await credentialVault.saveMerged(before, plugin, secrets ?? {});
    } catch (error) {
      await store.restorePluginSnapshot(before).catch(() => undefined);
      throw error;
    }
    if (connectionManager.snapshot(projectId, environmentId).plugins[pluginInstanceId]?.phase === 'connected') await pluginManager.disconnect(before, 'configuration-change');
    await connectionManager.configurationChanged(projectId, environmentId, plugin.pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return plugin;
  });
  handle('plugin-delete', async ({ projectId, environmentId, pluginInstanceId }) => {
    const { plugin } = await store.preflightDeletePlugin(projectId, environmentId, pluginInstanceId);
    const value = await store.deletePlugin(projectId, environmentId, pluginInstanceId);
    await pluginManager.disconnect(plugin, 'plugin-delete').catch(() => undefined);
    await connectionManager.configurationChanged(projectId, environmentId, pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return { ...value, credentialsPreserved:true };
  });
  handle('plugin-credential-status', async ({ projectId, environmentId, pluginInstanceId }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    if (!(await credentialVault.has(plugin))) return { saved: false, fields: { primary: false, proxy: false } };
    const secrets = await credentialVault.load(plugin) ?? {};
    const primaryKey = plugin.pluginType === 'server' && plugin.auth?.type === 'privateKey' ? 'privateKeyPassphrase' : 'password';
    const fields = { primary: Boolean(secrets[primaryKey]), proxy: plugin.pluginType === 'server' && Boolean(secrets.proxyPassword) };
    return { saved: fields.primary || fields.proxy, fields };
  });
  handle('plugin-credential-reveal', async ({ projectId, environmentId, pluginInstanceId, field }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const primaryKey = plugin.pluginType === 'server' && plugin.auth?.type === 'privateKey' ? 'privateKeyPassphrase' : 'password';
    const allowed = new Set(plugin.pluginType === 'server' ? [primaryKey, 'proxyPassword'] : [primaryKey]);
    if (!allowed.has(field)) throw new AppError('INVALID_ARGUMENT', '该插件不支持显示此凭据。');
    const secrets = await credentialVault.load(plugin) ?? {};
    if (!secrets[field]) throw new AppError('CREDENTIAL_NOT_FOUND', '该密码尚未保存。');
    return { value: secrets[field] };
  });
  handle('plugin-databases', async ({ projectId, environmentId, pluginInstanceId, input, secrets }) => {
    await store.getEnvironment(projectId, environmentId);
    const existing = pluginInstanceId ? await store.getPlugin(projectId, environmentId, pluginInstanceId) : null;
    if (existing && existing.pluginType !== 'mysql') throw new AppError('INVALID_ARGUMENT', '只有 MySQL 插件可以查询数据库列表。');
    const providedSecrets = secrets ?? {};
    let savedSecrets = {};
    if (existing) {
      try { savedSecrets = await credentialVault.load(existing) ?? {}; }
      catch (error) {
        if (!providedSecrets.password) throw error;
      }
    }
    const transient = workspaceInternals.normalizePlugin({
      ...input,
      pluginType: 'mysql',
      pluginInstanceId: `mysql-discovery-${crypto.randomBytes(5).toString('hex')}`,
      target: { ...(input?.target ?? {}), database: '' },
    }, { projectId, environmentId });
    return mysqlRuntime.listDatabases(transient, { ...savedSecrets, ...providedSecrets });
  });
  handle('audit-list', ({ projectId, ...filters }) => store.listAudit(projectId, filters));
  handle('audit-clear', ({ projectId, environmentId, pluginInstanceId = null }) => store.clearAudit(projectId, { environmentId, pluginInstanceId }));
  handle('confirmation-list', () => confirmationManager.list());
  handle('confirmation-approve', async (requestId) => {
    const pending = confirmationManager.list().find((item) => item.requestId === requestId);
    const result = confirmationManager.approve(requestId);
    if (pending) await store.appendAudit(pending.projectId, { type:'confirmation-approved', environmentId:pending.environmentId, pluginInstanceId:pending.pluginInstanceId, pluginNameSnapshot:pending.pluginNameSnapshot, actor:'user', capability:pending.capability, operationSummary:pending.summary, confirmationId:requestId, result:'success' }).catch(() => undefined);
    return result;
  });
  handle('confirmation-reject', async (requestId) => {
    const pending = confirmationManager.list().find((item) => item.requestId === requestId);
    const result = confirmationManager.reject(requestId);
    if (pending) await store.appendAudit(pending.projectId, { type:'confirmation-rejected', environmentId:pending.environmentId, pluginInstanceId:pending.pluginInstanceId, pluginNameSnapshot:pending.pluginNameSnapshot, actor:'user', capability:pending.capability, operationSummary:pending.summary, confirmationId:requestId, result:'blocked' }).catch(() => undefined);
    return result;
  });
  ipcMain.handle('v2:plugin-test', resultHandlerWithEvent(async (event, { projectId, environmentId, pluginInstanceId, input, secrets, requestId }) => {
    const startedAt = performance.now();
    const checks = [];
    const sendProgress = (check) => {
      if (!event.sender.isDestroyed()) event.sender.send('v2:plugin-test-progress',{requestId,pluginInstanceId,check});
    };
    const failWithDiagnostic = (error) => {
      const diagnostic = { checks,totalElapsedMs:Math.max(0,Math.round(performance.now() - startedAt)) };
      if (error instanceof AppError) throw new AppError(error.code,error.message,{...(error.details ?? {}),diagnostic});
      throw new AppError('PLUGIN_TEST_FAILED','连接检查失败。',{diagnostic});
    };
    const runCheck = async (id, label, action, describe) => {
      const stepStartedAt = performance.now();
      try {
        const value = await action();
        const check = {id,label,status:'success',detail:describe(value),elapsedMs:Math.max(0,Math.round(performance.now() - stepStartedAt))};
        checks.push(check);
        sendProgress(check);
        return value;
      } catch (error) {
        const check = {id,label,status:'failure',detail:error?.message ?? '检查失败。',elapsedMs:Math.max(0,Math.round(performance.now() - stepStartedAt))};
        checks.push(check);
        sendProgress(check);
        failWithDiagnostic(error);
      }
    };

    let existing = null;
    let plugin = null;
    let diagnosticSecrets = {...(secrets ?? {})};
    await runCheck('configuration','配置与依赖',async () => {
      await store.getEnvironment(projectId,environmentId);
      if (pluginInstanceId) existing = await store.getPlugin(projectId,environmentId,pluginInstanceId);
      if (input) {
        if (existing && input.pluginType && input.pluginType !== existing.pluginType) throw new AppError('INVALID_ARGUMENT','不能修改插件类型。');
        const diagnosticId = `diagnostic-${crypto.randomBytes(5).toString('hex')}`;
        const baseline = existing ? {...existing,pluginInstanceId:diagnosticId} : null;
        plugin = workspaceInternals.normalizePlugin({...input,pluginInstanceId:diagnosticId},{projectId,environmentId},baseline);
      } else plugin = existing;
      if (!plugin) throw new AppError('PLUGIN_NOT_FOUND','找不到要检查的插件。');
      if (plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE','请先补齐插件必填配置。');
      if (existing) {
        const rebound = {...plugin,pluginInstanceId:existing.pluginInstanceId};
        if (pluginCredentialInternals.bindingHash(existing) === pluginCredentialInternals.bindingHash(rebound)) {
          diagnosticSecrets = {...(await credentialVault.load(existing) ?? {}),...diagnosticSecrets};
        }
      }
      return plugin;
    },() => input ? '当前表单配置有效，可以开始连接' : '已保存配置有效，可以开始连接');

    const activeState = !input && existing ? connectionManager.snapshot(projectId,environmentId).plugins[existing.pluginInstanceId] : null;
    let temporaryConnection = false;
    let reused = false;
    try {
      await runCheck('connection',plugin.pluginType === 'server' ? '网络、SSH 与认证' : plugin.pluginType === 'mysql' ? '路由、MySQL 与认证' : '路由、Redis 与认证',async () => {
        if (activeState?.phase === 'connected') { reused = true; return {reused:true}; }
        await pluginManager.connect(plugin,diagnosticSecrets);
        temporaryConnection = true;
        return {reused:false};
      },(value) => value.reused ? '复用当前活动连接' : plugin.pluginType === 'server' ? 'TCP、SSH 握手与身份认证完成' : plugin.pluginType === 'mysql' ? '数据库路由与身份认证完成' : 'Redis 路由与身份认证完成');
      const health = await runCheck('protocol',plugin.pluginType === 'server' ? 'SSH 会话确认' : plugin.pluginType === 'mysql' ? 'SELECT 1 健康检查' : 'PING 健康检查',() => pluginManager.health(plugin),() => plugin.pluginType === 'server' ? 'SSH 会话处于可用状态' : plugin.pluginType === 'mysql' ? '数据库返回有效结果' : 'Redis 返回 PONG');
      return {...health,reused,diagnosticOnly:!reused,checks,totalElapsedMs:Math.max(0,Math.round(performance.now() - startedAt))};
    } finally {
      if (temporaryConnection) await pluginManager.disconnect(plugin,'diagnostic-complete').catch(() => undefined);
    }
  }));

  connectionManager.on('changed', (state) => services.broadcast?.('v2:environment-status-changed', state));
  confirmationManager.on('changed', (pending) => services.broadcast?.('v2:confirmations-changed', pending));
  return services;
}
