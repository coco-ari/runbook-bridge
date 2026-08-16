import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { workspaceInternals } from './workspace-store.mjs';

function resultHandler(handler) {
  return async (_event, ...args) => {
    try { return { ok: true, data: await handler(...args) }; }
    catch (error) { return { ok: false, error: toPublicError(error) }; }
  };
}

export function registerV2Ipc(ipcMain, services) {
  const { workspaceStore: store, connectionManager, credentialVault, contextManager, confirmationManager, pluginManager, mysqlRuntime } = services;
  const handle = (name, fn) => ipcMain.handle(`v2:${name}`, resultHandler(fn));
  ipcMain.on('v2:network-changed', () => connectionManager.networkChanged('renderer-network-change').catch(() => undefined));

  handle('project-list', () => store.listProjects());
  handle('project-create', (input) => store.createProject(input));
  handle('project-update', ({ projectId, patch, expectedRevision }) => store.updateProject(projectId, patch, expectedRevision));
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
  handle('environment-status', ({ projectId, environmentId }) => connectionManager.snapshot(projectId, environmentId));
  handle('runbook-read', ({ projectId, environmentId }) => store.readRunbook(projectId, environmentId));
  handle('runbook-save', async ({ projectId, environmentId, content, expectedRevision }) => {
    const value = await store.saveRunbook(projectId, environmentId, content, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
  });
  handle('plugin-list', ({ projectId, environmentId }) => store.listPlugins(projectId, environmentId));
  handle('plugin-create', async ({ projectId, environmentId, input, secrets }) => {
    const plugin = await store.createPlugin(projectId, environmentId, input);
    if (secrets && Object.values(secrets).some(Boolean)) await credentialVault.save(plugin, secrets);
    await connectionManager.configurationChanged(projectId, environmentId, plugin.pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return plugin;
  });
  handle('plugin-update', async ({ projectId, environmentId, pluginInstanceId, patch, expectedRevision, secrets }) => {
    const before = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    if (connectionManager.snapshot(projectId, environmentId).plugins[pluginInstanceId]?.phase === 'connected') await pluginManager.disconnect(before, 'configuration-change');
    const plugin = await store.updatePlugin(projectId, environmentId, pluginInstanceId, patch, expectedRevision);
    if (secrets && Object.values(secrets).some(Boolean)) await credentialVault.save(plugin, secrets);
    await connectionManager.configurationChanged(projectId, environmentId, plugin.pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return plugin;
  });
  handle('plugin-delete', async ({ projectId, environmentId, pluginInstanceId }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    await pluginManager.disconnect(plugin, 'plugin-delete').catch(() => undefined);
    await credentialVault.clear(plugin).catch(() => undefined);
    const value = await store.deletePlugin(projectId, environmentId, pluginInstanceId);
    await connectionManager.configurationChanged(projectId, environmentId, pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
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
  handle('plugin-policy', async ({ projectId, environmentId, pluginInstanceId, policy, expectedRevision }) => {
    const value = await store.updatePlugin(projectId, environmentId, pluginInstanceId, { policy }, expectedRevision);
    await connectionManager.configurationChanged(projectId, environmentId, pluginInstanceId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
  });
  handle('audit-list', ({ projectId, ...filters }) => store.listAudit(projectId, filters));
  handle('confirmation-list', () => confirmationManager.list());
  handle('confirmation-approve', (requestId) => confirmationManager.approve(requestId));
  handle('confirmation-reject', (requestId) => confirmationManager.reject(requestId));
  handle('plugin-test', async ({ projectId, environmentId, pluginInstanceId, secrets }) => {
    const state = connectionManager.snapshot(projectId, environmentId).plugins[pluginInstanceId];
    if (state?.phase === 'connected') return { connected: true, reused: true };
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const result = await pluginManager.connect(plugin, secrets ?? {});
    await pluginManager.disconnect(plugin, 'diagnostic-complete');
    return { ...result, diagnosticOnly: true };
  });

  connectionManager.on('changed', (state) => services.broadcast?.('v2:environment-status-changed', state));
  confirmationManager.on('changed', (pending) => services.broadcast?.('v2:confirmations-changed', pending));
  return services;
}
