import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { legacyCredentialConfigForPlugin } from './credential-store.mjs';
import { CredentialUseResolver } from './credential-use-resolver.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import {
  assessEnvironmentSnapshot,
  assessPlugin,
  publicPluginAssessment,
} from './plugin-readiness-service.mjs';
import { workspaceInternals } from './workspace-store.mjs';
import { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator.mjs';

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

function transportConfigurationIssue(transport) {
  if (transport?.kind === 'serverTunnel' && !transport.serverPluginInstanceId) return '请选择要复用的 Server 隧道。';
  if (transport?.kind === 'windowsVpn' && !transport.interfaceAlias) return '请填写 Windows VPN 网卡名称。';
  return null;
}

function diagnosticConfigurationIssue(plugin) {
  if (!plugin?.target?.host) return '请填写主机地址。';
  if (plugin.pluginType === 'server') {
    if (!plugin.auth?.username) return '请填写 SSH 用户名。';
    if (plugin.auth?.type === 'privateKey' && !plugin.auth.privateKeyPath) return '请选择 SSH 私钥文件。';
    if (['socks5','http'].includes(plugin.uplink?.type) && !plugin.uplink.host) return '请填写代理地址。';
    if (plugin.uplink?.type === 'windowsVpn' && !plugin.uplink.interfaceAlias) return '请填写 Windows VPN 网卡名称。';
    return null;
  }
  if (plugin.pluginType === 'mysql' && !plugin.auth?.username) return '请填写 MySQL 用户名。';
  return transportConfigurationIssue(plugin.transport);
}

function promoteMysqlConnectionDiagnostic(plugin, scope) {
  if (plugin?.pluginType !== 'mysql' || plugin.configState === 'ready' || plugin.target?.database) {
    return {plugin,databaseSelectionPending:false};
  }
  const readinessProbe = workspaceInternals.normalizePlugin({
    ...plugin,
    target:{...plugin.target,database:'__connection_probe__'},
  },scope);
  if (readinessProbe.configState !== 'ready') return {plugin,databaseSelectionPending:false};
  return {plugin:{...plugin,configState:'ready'},databaseSelectionPending:true};
}

function nonEmptySecrets(input) {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([,value]) => String(value ?? '').length > 0),
  );
}

function credentialMutationFromPayload(payload = {}) {
  const replacements = nonEmptySecrets(payload.temporarySecrets ?? payload.secrets);
  if (Object.keys(replacements).length) return {credentialMutation:'replace',replacements};
  const intent = payload.credentialIntent;
  const mode = typeof intent === 'string'
    ? intent
    : intent?.mutation ?? intent?.mode ?? 'unchanged';
  if (mode === 'unchanged' || mode === 'none' || mode === 'replace') {
    return {credentialMutation:'none',replacements:{}};
  }
  if (mode === 'rebind-existing' || mode === 'clear-explicit') {
    return {credentialMutation:mode,replacements:{}};
  }
  throw new AppError('INVALID_ARGUMENT', '凭据更新意图无效。');
}

function assertExpectedPluginRevision(expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new AppError('INVALID_ARGUMENT', '插件更新必须提供有效的 expectedRevision。');
  }
}

function assertCredentialFreeUpdate(payload, label) {
  const unexpected = ['secrets','temporarySecrets','credentialIntent','oneTimeGrant']
    .filter((key) => Object.hasOwn(payload ?? {},key));
  if (unexpected.length) {
    throw new AppError('INVALID_ARGUMENT', `${label}更新不能携带连接凭据字段。`, {
      fields:unexpected,
    });
  }
}

const SECRET_DRAFT_FIELDS = new Set([
  'password',
  'proxypassword',
  'privatekeypassphrase',
  'tlspassphrase',
  'capem',
  'clientcertpem',
  'clientkeypem',
  'ciphertext',
  'secrets',
  'temporarysecrets',
]);

function assertSecretFreeDraft(draft) {
  const pending = [draft];
  const visited = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (visited.has(value)) continue;
    visited.add(value);
    for (const [key,item] of Object.entries(value)) {
      if (SECRET_DRAFT_FIELDS.has(key.toLocaleLowerCase('en-US'))) {
        throw new AppError('INVALID_ARGUMENT','Assessment draft 不能包含凭据或密文字段。',{field:key});
      }
      if (item && typeof item === 'object') pending.push(item);
    }
  }
}

export function registerV2Ipc(ipcMain, services) {
  const { workspaceStore: store, connectionManager, credentialVault, legacyCredentialStore, configTransactionJournal, contextManager, confirmationManager, pluginManager, mysqlRuntime } = services;
  const credentialUseResolver = services.credentialUseResolver ?? new CredentialUseResolver(credentialVault);
  const handle = (name, fn) => ipcMain.handle(`v2:${name}`, resultHandler(fn));
  const mutationCoordinator = services.mutationCoordinator ?? new WorkspaceMutationCoordinator();
  const assertProjectAvailable = (projectId) => mutationCoordinator.assertProjectAvailable(projectId);
  const enqueuePluginMutation = (projectId,environmentId,operation) => (
    mutationCoordinator.enqueueEnvironmentMutation(projectId,environmentId,operation)
  );
  const environmentAssessmentSnapshot = async (projectId,environmentId,plugins = null) => {
    if (typeof connectionManager.status === 'function') {
      return connectionManager.status(projectId,environmentId,plugins ? {plugins} : undefined);
    }
    const catalog = plugins ?? (typeof store.listPlugins === 'function'
      ? await store.listPlugins(projectId,environmentId)
      : null);
    const runtime = typeof connectionManager.snapshot === 'function'
      ? connectionManager.snapshot(projectId,environmentId)
      : {projectId,environmentId,phase:'disconnected',sequence:0,plugins:{}};
    return catalog ? assessEnvironmentSnapshot({plugins:catalog,runtimeSnapshot:runtime}) : runtime;
  };
  const pluginWithAssessment = (plugin,snapshot) => ({
    ...plugin,
    assessment:publicPluginAssessment(snapshot?.plugins?.[plugin.pluginInstanceId]),
  });
  const withConfigurationMutation = async (projectId, environmentId, changedPluginInstanceId, operation) => {
    const token = connectionManager.beginConfigurationMutation?.(projectId, environmentId, changedPluginInstanceId) ?? null;
    let restoreOnFailure = false;
    let ended = false;
    try { return await operation({restoreOnFailure:() => { restoreOnFailure = true; }}); }
    catch (error) {
      if (token !== null) {
        connectionManager.endConfigurationMutation?.(projectId, environmentId, token, {restore:restoreOnFailure});
        ended = true;
      }
      throw error;
    }
    finally {
      if (token !== null && !ended) connectionManager.endConfigurationMutation?.(projectId, environmentId, token);
    }
  };
  const preparePluginUpdate = async (payload, patchScope = null) => {
    const {
      projectId,environmentId,pluginInstanceId,patch,expectedRevision,
    } = payload;
    const {credentialMutation,replacements} = credentialMutationFromPayload(payload);
    const method = patchScope === 'metadata'
      ? store.preparePluginMetadataUpdate
      : patchScope === 'agent-policy-scope'
        ? store.preparePluginAgentConfigurationUpdate
        : patchScope === 'connection'
          ? store.preparePluginConnectionUpdate
          : null;
    let prepared;
    if (typeof method === 'function') {
      prepared = patchScope === 'connection'
        ? await method.call(store,projectId,environmentId,pluginInstanceId,patch,expectedRevision,credentialMutation)
        : await method.call(store,projectId,environmentId,pluginInstanceId,patch,expectedRevision);
    } else if (typeof store.preparePluginUpdate === 'function') {
      prepared = await store.preparePluginUpdate(
        projectId,environmentId,pluginInstanceId,patch,expectedRevision,
        {credentialMutation,patchScope},
      );
    } else {
      const before = await store.getPlugin(projectId,environmentId,pluginInstanceId);
      prepared = {before,after:null,change:{kind:'session-affecting',credentialMutation}};
    }
    if (expectedRevision !== null && expectedRevision !== undefined
      && prepared.before.revision !== expectedRevision) {
      throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置已经变化，请刷新后重试。');
    }
    return {
      ...prepared,
      change:prepared.change ?? {kind:'session-affecting',credentialMutation},
      credentialMutation,
      replacements,
    };
  };
  const commitPreparedPlugin = (prepared, payload) => {
    if (prepared.change.kind === 'none') return prepared.before;
    if (prepared.after && typeof store.commitPluginSnapshot === 'function') {
      return store.commitPluginSnapshot(prepared.after,prepared.before.revision);
    }
    return store.updatePlugin(
      payload.projectId,payload.environmentId,payload.pluginInstanceId,
      payload.patch,payload.expectedRevision,
    );
  };
  const commitAgentPluginUpdate = async (prepared, payload) => {
    const plugin = await commitPreparedPlugin(prepared,payload);
    if (prepared.change.kind !== 'none') {
      contextManager.invalidateEnvironment?.(payload.projectId,payload.environmentId);
      confirmationManager.invalidatePlugin?.(
        payload.projectId,payload.environmentId,payload.pluginInstanceId,
      );
    }
    return plugin;
  };
  const commitConnectionPluginUpdate = (prepared, payload) => withConfigurationMutation(
    payload.projectId,payload.environmentId,payload.pluginInstanceId,
    async ({restoreOnFailure}) => {
      let transaction = null;
      let journalWarning = null;
      const bindingChanged = prepared.after
        ? pluginCredentialInternals.bindingHash(prepared.before)
          !== pluginCredentialInternals.bindingHash(prepared.after)
        : true;
      const needsCredentialTransaction = bindingChanged
        || prepared.credentialMutation !== 'none';
      if (configTransactionJournal && needsCredentialTransaction) {
        try {
          transaction = await configTransactionJournal.prepare(
            prepared.before,prepared.after,
            {hasExplicitSecrets:Object.keys(prepared.replacements).length > 0},
          );
        } catch (error) {
          restoreOnFailure();
          throw error;
        }
      }
      let plugin;
      try {
        plugin = await commitPreparedPlugin(prepared,payload);
      } catch (error) {
        if (transaction) await configTransactionJournal.complete(transaction).catch(() => undefined);
        restoreOnFailure();
        throw error;
      }
      try {
        await credentialVault.saveMerged(prepared.before,plugin,prepared.replacements);
      } catch (error) {
        try {
          await store.restorePluginSnapshot(prepared.before,plugin.revision);
        } catch (rollbackError) {
          throw new AppError(
            'CONFIG_CREDENTIAL_TRANSACTION_INCOMPLETE',
            '凭据保存失败，且插件配置未能自动回滚。现有凭据仍被保留，请不要重复保存并先修复本地存储后重试。',
            {
              projectId:payload.projectId,
              environmentId:payload.environmentId,
              pluginInstanceId:payload.pluginInstanceId,
              previousRevision:prepared.before.revision,
              attemptedRevision:plugin.revision,
              credentialError:toPublicError(error),
              rollbackError:toPublicError(rollbackError),
            },
          );
        }
        if (transaction) await configTransactionJournal.complete(transaction).catch(() => undefined);
        restoreOnFailure();
        throw error;
      }
      if (transaction) {
        try { await configTransactionJournal.complete(transaction); }
        catch (error) { journalWarning = toPublicError(error); }
      }
      let runtimeWarning = null;
      try {
        const runtimeResult = await connectionManager.configurationChanged(
          payload.projectId,payload.environmentId,payload.pluginInstanceId,
        );
        runtimeWarning = runtimeResult?.runtimeWarning ?? null;
      } catch (error) {
        runtimeWarning = toPublicError(error);
      }
      contextManager.invalidateEnvironment?.(payload.projectId,payload.environmentId);
      confirmationManager.invalidatePlugin?.(
        payload.projectId,payload.environmentId,payload.pluginInstanceId,
      );
      return {
        ...plugin,
        ...(runtimeWarning ? {runtimeWarning,manualReconnectRequired:true} : {}),
        ...(journalWarning ? {persistenceWarning:journalWarning} : {}),
      };
    },
  );
  ipcMain.on('v2:network-changed', () => connectionManager.networkChanged('renderer-network-change').catch(() => undefined));

  handle('project-list', () => store.listProjects());
  handle('workspace-overview', async () => {
    const projects = typeof store.listProjectOverviews === 'function'
      ? await store.listProjectOverviews()
      : await Promise.all((await store.listProjects()).map(async (project) => ({ ...project, environments:await store.listEnvironments(project.projectId) })));
    return Promise.all(projects.map(async (project) => ({
      ...project,
      environments: await Promise.all((project.environments ?? []).map(async (environment) => {
          const runtime = await environmentAssessmentSnapshot(project.projectId, environment.environmentId);
          const previewIds = new Set((environment.resourcePreview ?? []).map((plugin) => plugin.pluginInstanceId));
          const resourcePreview = (environment.resourcePreview ?? []).map((plugin) => (
            pluginWithAssessment(plugin,runtime)
          ));
          return {
            ...environment,
            resourcePreview,
            runtime: {
              ...runtime,
              // Project overview only renders the preview resources. Keep the
              // aggregate counters/manual flags, but avoid cloning every
              // plugin's diagnostic payload into startup IPC.
              plugins: Object.fromEntries(Object.entries(runtime.plugins ?? {}).filter(([id]) => previewIds.has(id))),
              pluginsPartial: true,
              eligibleCount: environment.readyPluginCount,
              draftCount: environment.pluginCount - environment.readyPluginCount,
            },
          };
        })),
    })));
  });
  handle('project-create', async (input) => {
    const candidateId = workspaceInternals.normalizeId(input?.projectId ?? input?.name, 'project');
    assertProjectAvailable(candidateId);
    const value = await store.createProject(input);
    services.broadcast?.('v2:workspace-changed', { type:'project-created', projectId:value.projectId });
    return value;
  });
  handle('project-update', async ({ projectId, patch, expectedRevision }) => {
    assertProjectAvailable(projectId);
    const value = await store.updateProject(projectId, patch, expectedRevision);
    services.broadcast?.('v2:workspace-changed', { type:'project-updated', projectId });
    return value;
  });
  handle('project-delete', async ({ projectId }) => {
    mutationCoordinator.beginProjectDelete(projectId);
    const mutationTokens = [];
    try {
      let environments = await store.listEnvironments(projectId);
      const findActive = (values) => values.filter((environment) => {
        const runtime = connectionManager.snapshot(projectId, environment.environmentId);
        return runtime.desiredConnected || runtime.phase !== 'disconnected';
      });
      let active = findActive(environments);
      if (active.length) {
        throw new AppError('PROJECT_CONNECTED', `请先断开项目中的环境：${active.map((item) => item.name).join('、')}。`);
      }
      await mutationCoordinator.waitProjectActivity(projectId);
      // A mutation/operation that was already active when deletion began may
      // have changed environment/runtime state. Re-read before the commit.
      environments = await store.listEnvironments(projectId);
      active = findActive(environments);
      if (active.length) {
        throw new AppError('PROJECT_CONNECTED', `请先断开项目中的环境：${active.map((item) => item.name).join('、')}。`);
      }
      for (const environment of environments) {
        const token = connectionManager.beginConfigurationMutation?.(projectId, environment.environmentId, null);
        if (token !== undefined) mutationTokens.push([environment.environmentId,token]);
      }
      if (typeof connectionManager.disconnect === 'function') {
        await Promise.all(environments.map((environment) => connectionManager.disconnect(projectId, environment.environmentId, 'project-delete-cleanup')));
      }
      const value = await store.deleteProject(projectId);
      legacyCredentialStore?.invalidateProject(projectId);
      contextManager.invalidateProject(projectId);
      confirmationManager.invalidateProject?.(projectId);
      await connectionManager.forgetProject?.(projectId);
      services.broadcast?.('v2:workspace-changed', { type:'project-deleted', projectId });
      return { ...value, credentialsPreserved:true };
    } finally {
      for (const [environmentId,token] of mutationTokens) connectionManager.endConfigurationMutation?.(projectId, environmentId, token);
      mutationCoordinator.endProjectDelete(projectId);
    }
  });
  handle('environment-list', (projectId) => store.listEnvironments(projectId));
  handle('environment-create', ({ projectId, input }) => {
    assertProjectAvailable(projectId);
    return store.createEnvironment(projectId, input);
  });
  handle('environment-update', ({ projectId, environmentId, patch, expectedRevision }) => enqueuePluginMutation(projectId, environmentId, async () => {
    const value = await store.updateEnvironment(projectId, environmentId, patch, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
  }));
  handle('environment-delete', ({ projectId, environmentId }) => {
    assertProjectAvailable(projectId);
    const immediate = connectionManager.snapshot(projectId,environmentId);
    if (immediate.desiredConnected || immediate.phase !== 'disconnected') {
      throw new AppError('ENVIRONMENT_CONNECTED', '请先断开环境后再删除。');
    }
    return enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, null, async () => {
    const state = connectionManager.snapshot(projectId, environmentId);
    const runtimeActive = state.desiredConnected || state.phase !== 'disconnected';
    if (!runtimeActive && typeof connectionManager.disconnect === 'function') {
      await connectionManager.disconnect(projectId, environmentId, 'environment-delete-cleanup');
    }
    const value = await store.deleteEnvironment(projectId, environmentId, { runtimeActive });
    legacyCredentialStore?.invalidateEnvironment(projectId,environmentId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    confirmationManager.invalidateEnvironment?.(projectId, environmentId);
    await connectionManager.forgetEnvironment?.(projectId, environmentId);
    return {...value,credentialsPreserved:true};
    }));
  });
  handle('environment-reorder', ({ projectId, environmentIds, expectedRevision }) => {
    assertProjectAvailable(projectId);
    return store.reorderEnvironments(projectId, environmentIds, expectedRevision);
  });
  handle('environment-connect', ({ projectId, environmentId, expectedRevision, secretsByPlugin }) => {
    assertProjectAvailable(projectId);
    return connectionManager.connect(projectId, environmentId, { expectedRevision, secretsByPlugin });
  });
  handle('environment-retry', ({ projectId, environmentId, secretsByPlugin }) => {
    assertProjectAvailable(projectId);
    return connectionManager.retryFailed(projectId, environmentId, { secretsByPlugin });
  });
  handle('environment-disconnect', ({ projectId, environmentId }) => connectionManager.disconnect(projectId, environmentId));
  handle('environment-cancel', ({ projectId, environmentId }) => connectionManager.cancel(projectId, environmentId));
  handle('environment-status', ({ projectId, environmentId }) => environmentAssessmentSnapshot(projectId, environmentId));
  handle('plugin-connect', ({ projectId, environmentId, pluginInstanceId }) => {
    assertProjectAvailable(projectId);
    return connectionManager.connectPlugin(projectId, environmentId, pluginInstanceId);
  });
  handle('plugin-disconnect', ({ projectId, environmentId, pluginInstanceId }) => connectionManager.disconnectPlugin(projectId, environmentId, pluginInstanceId));
  handle('runbook-read', ({ projectId, environmentId }) => store.readRunbook(projectId, environmentId));
  handle('runbook-save', ({ projectId, environmentId, content, expectedRevision }) => enqueuePluginMutation(projectId, environmentId, async () => {
    const value = await store.saveRunbook(projectId, environmentId, content, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    await store.appendAudit(projectId, { type:'runbook-updated', environmentId, actor:'user', result:'success', bytes:Buffer.byteLength(String(content ?? ''),'utf8') }).catch(() => undefined);
    return value;
  }));
  handle('plugin-list', async ({ projectId, environmentId }) => {
    const plugins = await store.listPlugins(projectId,environmentId);
    const snapshot = await environmentAssessmentSnapshot(projectId,environmentId,plugins);
    return plugins.map((plugin) => pluginWithAssessment(plugin,snapshot));
  });
  handle('plugin-assess', async ({
    projectId,
    environmentId,
    pluginInstanceId,
    editSessionId = null,
    draft = null,
  }) => {
    await store.getEnvironment(projectId,environmentId);
    const plugins = await store.listPlugins(projectId,environmentId);
    const existing = plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId);
    if (!existing) throw new AppError('PLUGIN_NOT_FOUND','插件不存在。');
    if (!draft) {
      const snapshot = await environmentAssessmentSnapshot(projectId,environmentId,plugins);
      return publicPluginAssessment(snapshot.plugins?.[pluginInstanceId]);
    }
    assertSecretFreeDraft(draft);
    if (draft.pluginType && draft.pluginType !== existing.pluginType) {
      throw new AppError('INVALID_ARGUMENT','不能修改插件类型。');
    }
    const candidate = workspaceInternals.normalizePluginCandidate(
      {...draft,pluginInstanceId,pluginType:existing.pluginType},
      {projectId,environmentId},
      existing,
    );
    const environmentPlugins = plugins.map((plugin) => (
      plugin.pluginInstanceId === pluginInstanceId ? candidate : plugin
    ));
    const runtimeSnapshot = typeof connectionManager.snapshot === 'function'
      ? connectionManager.snapshot(projectId,environmentId)
      : {projectId,environmentId,phase:'disconnected',sequence:0,plugins:{}};
    return assessPlugin({
      plugin:candidate,
      environmentPlugins,
      runtimeSnapshot,
      persistenceSummary:{state:'edit-draft',dirty:true},
      editSummary:{state:'editing',editSessionId},
    });
  });
  handle('plugin-create', ({ projectId, environmentId, input, secrets }) => enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, null, async () => {
    const plugin = await store.createPlugin(projectId, environmentId, input);
    try {
      if (secrets && Object.values(secrets).some(Boolean)) await credentialVault.save(plugin, secrets);
    } catch (error) {
      try {
        await store.deletePlugin(projectId, environmentId, plugin.pluginInstanceId, {expectedRevision:plugin.revision});
      } catch (rollbackError) {
        throw new AppError(
          'CONFIG_CREDENTIAL_TRANSACTION_INCOMPLETE',
          '凭据保存失败，且新插件未能自动移除；现有凭据未被覆盖，请刷新配置后再处理残留插件。',
          {projectId,environmentId,pluginInstanceId:plugin.pluginInstanceId,credentialError:toPublicError(error),rollbackError:toPublicError(rollbackError)},
        );
      }
      throw error;
    }
    let runtimeWarning = null;
    try {
      const runtimeResult = await connectionManager.configurationChanged(projectId, environmentId, plugin.pluginInstanceId);
      runtimeWarning = runtimeResult?.runtimeWarning ?? null;
    } catch (error) { runtimeWarning = toPublicError(error); }
    contextManager.invalidateEnvironment(projectId, environmentId);
    return {...plugin,...(runtimeWarning ? {runtimeWarning,manualReconnectRequired:true} : {})};
  })));
  handle('plugin-metadata-update', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    assertCredentialFreeUpdate(payload,'插件基本信息');
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'metadata');
      return commitPreparedPlugin(prepared,payload);
    });
  });
  handle('plugin-agent-configuration-update', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    assertCredentialFreeUpdate(payload,'Agent 配置');
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'agent-policy-scope');
      return commitAgentPluginUpdate(prepared,payload);
    });
  });
  handle('plugin-connection-update', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'connection');
      if (prepared.change.kind === 'none') return prepared.before;
      return commitConnectionPluginUpdate(prepared,payload);
    });
  });
  // One-version compatibility shim. The backend still normalizes and
  // classifies the patch, then delegates to the narrow semantic path.
  handle('plugin-update', (payload) => enqueuePluginMutation(
    payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload);
      if (prepared.change.kind === 'none') return prepared.before;
      if (prepared.change.kind === 'metadata') return commitPreparedPlugin(prepared,payload);
      if (prepared.change.kind === 'agent-policy-scope') {
        return commitAgentPluginUpdate(prepared,payload);
      }
      return commitConnectionPluginUpdate(prepared,payload);
    },
  ));
  handle('plugin-delete', ({ projectId, environmentId, pluginInstanceId }) => enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, pluginInstanceId, async ({restoreOnFailure}) => {
    let plugin;
    try { ({plugin} = await store.preflightDeletePlugin(projectId, environmentId, pluginInstanceId)); }
    catch (error) { restoreOnFailure(); throw error; }
    let value;
    try { value = await store.deletePlugin(projectId, environmentId, pluginInstanceId); }
    catch (error) { restoreOnFailure(); throw error; }
    legacyCredentialStore?.invalidatePlugin(projectId,environmentId,pluginInstanceId);
    let runtimeWarning = null;
    try {
      const runtimeResult = await connectionManager.configurationChanged(projectId, environmentId, pluginInstanceId);
      runtimeWarning = runtimeResult?.runtimeWarning ?? null;
    } catch (error) { runtimeWarning = toPublicError(error); }
    if (typeof connectionManager.disconnectRuntime === 'function') {
      await connectionManager.disconnectRuntime(plugin, 'plugin-delete').catch((error) => { runtimeWarning ??= toPublicError(error); });
    } else {
      await pluginManager.disconnect(plugin, 'plugin-delete').catch((error) => { runtimeWarning ??= toPublicError(error); });
    }
    contextManager.invalidateEnvironment(projectId, environmentId);
    confirmationManager.invalidatePlugin?.(projectId, environmentId, pluginInstanceId);
    return { ...value, credentialsPreserved:true,...(runtimeWarning ? {runtimeWarning} : {}) };
  })));
  handle('plugin-credential-status', async ({ projectId, environmentId, pluginInstanceId }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const secrets = await credentialVault.load(plugin) ?? {};
    const primaryKey = plugin.pluginType === 'server' && plugin.auth?.type === 'privateKey' ? 'privateKeyPassphrase' : 'password';
    const fields = { primary: Boolean(secrets[primaryKey]), proxy: plugin.pluginType === 'server' && Boolean(secrets.proxyPassword) };
    const saved = fields.primary || fields.proxy;
    let migration = legacyCredentialStore?.migrationStatus(plugin) ?? null;
    if (migration && ['confirmation-required','import-pending'].includes(migration.status)) {
      if (legacyCredentialStore.migrationComplete(migration,secrets)) {
        legacyCredentialStore.clearMigration(plugin);
        migration = null;
      } else {
        migration = {...migration,missingFields:legacyCredentialStore.missingMigrationFields(migration,secrets)};
      }
    }
    return { saved, fields, ...(migration ? {migration} : {}) };
  });
  handle('plugin-credential-migration-confirm', ({projectId,environmentId,pluginInstanceId,expectedRevision,sourceSha256}) => (
    enqueuePluginMutation(projectId,environmentId,async () => {
      if (!legacyCredentialStore) throw new AppError('CREDENTIAL_MIGRATION_NOT_FOUND', '没有待确认的旧版凭据。');
      configTransactionJournal?.assertPluginAvailable(projectId,environmentId,pluginInstanceId);
      const plugin = await store.getPlugin(projectId,environmentId,pluginInstanceId);
      const pending = legacyCredentialStore.migrationStatus(plugin);
      if (!pending || pending.status !== 'confirmation-required') {
        throw new AppError('CREDENTIAL_MIGRATION_NOT_FOUND', '没有待确认的旧版凭据。');
      }
      if (plugin.revision !== expectedRevision || pending.expectedRevision !== expectedRevision
        || pending.sourceSha256 !== sourceSha256
        || pending.pluginBindingHash !== pluginCredentialInternals.bindingHash(plugin)) {
        throw new AppError('CREDENTIAL_MIGRATION_CHANGED', '插件目标或旧凭据文件已变化，请刷新后重新确认。');
      }
      const candidate = await legacyCredentialStore.readMigrationCandidate(
        projectId,
        legacyCredentialConfigForPlugin(plugin),
      );
      if (candidate.status !== 'confirmation-required' || candidate.sourceSha256 !== sourceSha256) {
        throw new AppError('CREDENTIAL_MIGRATION_CHANGED', '旧凭据文件已变化，本次导入已取消。');
      }
      const existing = await credentialVault.load(plugin) ?? {};
      const missing = legacyCredentialStore.missingMigrationSecrets(candidate,existing);
      if (!Object.keys(missing).length) {
        legacyCredentialStore.clearMigration(plugin);
        return {imported:false,preserved:true};
      }
      await credentialVault.save(plugin,missing);
      const verified = await credentialVault.load(plugin);
      const existingPreserved = Object.entries(existing).every(([key,value]) => verified?.[key] === value);
      const missingImported = Object.entries(missing).every(([key,value]) => verified?.[key] === value);
      if (!existingPreserved || !missingImported || !legacyCredentialStore.migrationComplete(candidate,verified)) {
        throw new AppError('CREDENTIAL_STORAGE_FAILED', '旧凭据导入后校验失败，原文件仍已保留。');
      }
      legacyCredentialStore.clearMigration(plugin);
      const auditWarning = await store.appendAudit(projectId,{
        type:'legacy-credential-migrated',environmentId,pluginInstanceId,pluginType:plugin.pluginType,
        pluginNameSnapshot:plugin.displayName,actor:'user',result:'success',sourceVersion:candidate.formatVersion,
      }).then(() => false,() => true);
      return {imported:true,preserved:true,...(auditWarning ? {auditWarning:true} : {})};
    })
  ));
  handle('plugin-credential-reveal', async ({ projectId, environmentId, pluginInstanceId, field }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const primaryKey = plugin.pluginType === 'server' && plugin.auth?.type === 'privateKey' ? 'privateKeyPassphrase' : 'password';
    const allowed = new Set(plugin.pluginType === 'server' ? [primaryKey, 'proxyPassword'] : [primaryKey]);
    if (!allowed.has(field)) throw new AppError('INVALID_ARGUMENT', '该插件不支持显示此凭据。');
    const secrets = await credentialVault.load(plugin) ?? {};
    if (!secrets[field]) throw new AppError('CREDENTIAL_NOT_FOUND', '该密码尚未保存。');
    return { value: secrets[field] };
  });
  handle('plugin-databases', ({
    projectId,
    environmentId,
    pluginInstanceId,
    input,
    secrets,
    temporarySecrets,
    credentialIntent,
    oneTimeGrant,
    editSessionId,
    draftGeneration,
  }) => (
    mutationCoordinator.runEnvironmentOperation(projectId,environmentId,async () => {
    assertProjectAvailable(projectId);
    if (pluginInstanceId) configTransactionJournal?.assertPluginAvailable(projectId,environmentId,pluginInstanceId);
    else configTransactionJournal?.assertEnvironmentAvailable(projectId,environmentId);
    await store.getEnvironment(projectId, environmentId);
    const existing = pluginInstanceId ? await store.getPlugin(projectId, environmentId, pluginInstanceId) : null;
    if (existing && existing.pluginType !== 'mysql') throw new AppError('INVALID_ARGUMENT', '只有 MySQL 插件可以查询数据库列表。');
    const transient = workspaceInternals.normalizePlugin({
      ...input,
      pluginType: 'mysql',
      pluginInstanceId: `mysql-discovery-${crypto.randomBytes(5).toString('hex')}`,
      target: { ...(input?.target ?? {}), database: '' },
    }, { projectId, environmentId });
    const resolved = await credentialUseResolver.resolve({
      committedPlugin:existing,
      draft:transient,
      credentialIntent,
      temporarySecrets:temporarySecrets ?? secrets,
      oneTimeGrant,
      editSessionId,
      draftGeneration,
      purpose:'resource-discovery',
      caller:'main',
    });
      return mysqlRuntime.listDatabases(transient,resolved.secrets);
    })
  ));
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
  ipcMain.handle('v2:plugin-test', resultHandlerWithEvent(async (event, {
    projectId,
    environmentId,
    pluginInstanceId,
    input,
    secrets,
    temporarySecrets,
    credentialIntent,
    oneTimeGrant,
    editSessionId,
    draftGeneration,
    requestId,
  }) => (
    mutationCoordinator.runEnvironmentOperation(projectId,environmentId,async () => {
    assertProjectAvailable(projectId);
    if (pluginInstanceId) configTransactionJournal?.assertPluginAvailable(projectId,environmentId,pluginInstanceId);
    else configTransactionJournal?.assertEnvironmentAvailable(projectId,environmentId);
    const startedAt = performance.now();
    const checks = [];
    const sendProgress = (check) => {
      if (event.sender.isDestroyed()) return;
      try { event.sender.send('v2:plugin-test-progress',{requestId,pluginInstanceId,check}); }
      catch { /* The diagnostic result remains valid if its window closed. */ }
    };
    const failWithDiagnostic = (error) => {
      const diagnostic = { checks,totalElapsedMs:Math.max(0,Math.round(performance.now() - startedAt)) };
      if (error instanceof AppError) throw new AppError(error.code,error.message,{...(error.details ?? {}),diagnostic});
      throw new AppError('PLUGIN_TEST_FAILED','连接检查失败。',{diagnostic});
    };
    const runCheck = async (id, label, action, describe, {
      timeoutMs = 0, timeoutError = null, onTimeout = null, onLateSuccess = null,
    } = {}) => {
      const stepStartedAt = performance.now();
      let timer;
      let timedOut = false;
      try {
        const pending = Promise.resolve().then(action);
        if (onLateSuccess) {
          void pending.then((value) => {
            if (timedOut) return onLateSuccess(value);
            return undefined;
          }).catch(() => undefined);
        }
        const value = timeoutMs > 0 ? await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              try { onTimeout?.(); } catch { /* Best-effort driver abort. */ }
              reject(timeoutError ?? new AppError('PLUGIN_TEST_TIMEOUT','连接检查超时，已停止本次检查。'));
            }, timeoutMs);
            timer.unref?.();
          }),
        ]) : await pending;
        const check = {id,label,status:'success',detail:describe(value),elapsedMs:Math.max(0,Math.round(performance.now() - stepStartedAt))};
        checks.push(check);
        sendProgress(check);
        return value;
      } catch (error) {
        const check = {id,label,status:'failure',detail:error?.message ?? '检查失败。',elapsedMs:Math.max(0,Math.round(performance.now() - stepStartedAt))};
        checks.push(check);
        sendProgress(check);
        failWithDiagnostic(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let existing = null;
    let plugin = null;
    let activeState = null;
    let mysqlDatabaseSelectionPending = false;
    let diagnosticSecrets = {};
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
      const promoted = promoteMysqlConnectionDiagnostic(plugin,{projectId,environmentId});
      plugin = promoted.plugin;
      mysqlDatabaseSelectionPending = promoted.databaseSelectionPending;
      const configurationIssue = diagnosticConfigurationIssue(plugin);
      if (configurationIssue || plugin.configState !== 'ready') {
        throw new AppError('PLUGIN_CONFIG_INCOMPLETE',configurationIssue ?? '请补齐插件连接配置。');
      }
      if (existing) {
        activeState = connectionManager.snapshot(projectId,environmentId).plugins[existing.pluginInstanceId] ?? null;
        if (['connecting','disconnecting','reconnecting','waitingDependency'].includes(activeState?.phase)) {
          throw new AppError('PLUGIN_BUSY','该插件正在切换连接状态，请等待当前操作完成后再检查。');
        }
        if (!input && activeState?.phase !== 'connected') {
          plugin = {...plugin,pluginInstanceId:`diagnostic-${crypto.randomBytes(5).toString('hex')}`};
        }
      }
      const resolved = await credentialUseResolver.resolve({
        committedPlugin:existing,
        draft:plugin,
        credentialIntent,
        temporarySecrets:temporarySecrets ?? secrets,
        oneTimeGrant,
        editSessionId,
        draftGeneration,
        purpose:'health-check',
        caller:'main',
      });
      diagnosticSecrets = resolved.secrets;
      return plugin;
    },() => mysqlDatabaseSelectionPending
      ? '基础连接配置有效；连接验证后请查询并选择固定数据库'
      : input ? '当前表单配置有效，可以开始连接' : '已保存配置有效，可以开始连接');

    let temporaryConnection = false;
    let reused = false;
    const diagnosticController = new AbortController();
    const configuredDiagnosticTimeout = Number(services.diagnosticTimeoutMs ?? plugin.limits?.timeoutMs ?? 10_000);
    const diagnosticTimeoutMs = Math.min(Math.max(configuredDiagnosticTimeout, 50), 60_000);
    const abortTemporaryDiagnostic = () => {
      diagnosticController.abort();
      if (!reused) void Promise.resolve(pluginManager.forceDisconnect?.(plugin,'diagnostic-timeout')).catch(() => undefined);
    };
    const fenceLateDiagnostic = () => Promise.resolve(
      typeof pluginManager.forceDisconnect === 'function'
        ? pluginManager.forceDisconnect(plugin,'late-diagnostic-connect')
        : pluginManager.disconnect(plugin,'late-diagnostic-connect'),
    ).catch(() => undefined);
    try {
      await runCheck('connection',plugin.pluginType === 'server' ? '网络、SSH 与认证' : plugin.pluginType === 'mysql' ? '路由、MySQL 与认证' : '路由、Redis 与认证',async () => {
        if (!input && activeState?.phase === 'connected') { reused = true; return {reused:true}; }
        await pluginManager.connect(plugin,diagnosticSecrets,{signal:diagnosticController.signal});
        temporaryConnection = true;
        return {reused:false};
      },(value) => value.reused ? '复用当前活动连接' : plugin.pluginType === 'server' ? 'TCP、SSH 握手与身份认证完成' : plugin.pluginType === 'mysql' ? '数据库路由与身份认证完成' : 'Redis 路由与身份认证完成', {
        timeoutMs:diagnosticTimeoutMs,
        timeoutError:new AppError('CONNECT_TIMEOUT','连接检查超时，请检查网络、地址与防火墙后重试。'),
        onTimeout:abortTemporaryDiagnostic,
        onLateSuccess:fenceLateDiagnostic,
      });
      const health = await runCheck('protocol',plugin.pluginType === 'server' ? 'SSH 会话确认' : plugin.pluginType === 'mysql' ? 'SELECT 1 健康检查' : 'PING 健康检查',() => pluginManager.health(plugin),() => plugin.pluginType === 'server' ? 'SSH 会话处于可用状态' : plugin.pluginType === 'mysql' ? '数据库返回有效结果' : 'Redis 返回 PONG', {
        timeoutMs:diagnosticTimeoutMs,
        timeoutError:new AppError('PLUGIN_TIMEOUT','协议健康检查超时，临时连接已关闭。'),
        onTimeout:abortTemporaryDiagnostic,
      });
      return {...health,reused,diagnosticOnly:!reused,checks,totalElapsedMs:Math.max(0,Math.round(performance.now() - startedAt))};
    } finally {
      if (temporaryConnection && plugin.pluginInstanceId.startsWith('diagnostic-')) {
        if (typeof connectionManager.disconnectRuntime === 'function') await connectionManager.disconnectRuntime(plugin,'diagnostic-complete').catch(() => undefined);
        else await pluginManager.disconnect(plugin,'diagnostic-complete').catch(() => undefined);
      }
    }
    })
  )));

  connectionManager.on('changed', (state) => services.broadcast?.('v2:environment-status-changed',state));
  confirmationManager.on('changed', (pending) => services.broadcast?.('v2:confirmations-changed', pending));
  return services;
}
