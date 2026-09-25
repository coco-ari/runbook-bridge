import { registerRedisEditIpc } from './redis-edit-ipc.mjs';
import { PLUGIN_IPC_CHANNELS } from './plugin-ipc-contract.mjs';
import { createPluginConfigurationService } from './plugin-configuration-service.mjs';
import crypto from 'node:crypto';
import { registerCloudConfigIpc } from './cloud-config-ipc.mjs';
import { registerServerWorkspaceIpc } from './server-workspace-ipc.mjs';
import { registerMysqlEditIpc } from './mysql-edit-ipc.mjs';
import { registerRedisWorkspaceIpc } from './redis-workspace-ipc.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { legacyCredentialConfigForPlugin } from './credential-store.mjs';
import { CredentialUseResolver } from './credential-use-resolver.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import {
  assessEnvironmentSnapshot,
  assessPlugin,
  publicPluginAssessment,
} from './plugin-readiness-service.mjs';
import { normalizePluginCandidate, normalizeId, normalizePlugin } from './plugin-config-model.mjs';
import { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator.mjs';
import {
  getPluginConnectionAdapter,
} from './plugin-connection-adapters.mjs';
import { buildQuickQuestionCopyText } from './quick-questions.mjs';

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

function assertExpectedPluginRevision(expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new AppError('INVALID_ARGUMENT', '插件更新必须提供有效的 expectedRevision。');
  }
}

function assertCredentialFreeUpdate(payload, label) {
  const unexpected = ['secrets','temporarySecrets','credentialIntent','oneTimeGrant','forceCredentialReplacement']
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
  'privatekeypem',
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

function scopeNameKey(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

async function assertQuickQuestionScopeNamesUnique(store, projectName, environmentName) {
  const projectKey = scopeNameKey(projectName);
  const environmentKey = scopeNameKey(environmentName);
  const overviews = typeof store.listProjectOverviews === 'function'
    ? await store.listProjectOverviews()
    : await Promise.all((await store.listProjects()).map(async (project) => ({
      ...project,
      environments:await store.listEnvironments(project.projectId),
    })));
  let matches = 0;
  for (const project of overviews) {
    if (scopeNameKey(project.name) !== projectKey || project.configurationError) continue;
    for (const environment of project.environments ?? []) {
      if (scopeNameKey(environment.name) === environmentKey) matches += 1;
      if (matches > 1) {
        throw new AppError(
          'AMBIGUOUS_QUICK_QUESTION_SCOPE',
          '存在同名的项目和环境组合，无法生成不含内部标识的精确提问。请先重命名项目或环境。',
        );
      }
    }
  }
}

function assertExactQuickQuestionPayload(payload, allowedFields, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('INVALID_ARGUMENT', `${label}请求无效。`);
  }
  const unexpected = Object.keys(payload).filter((field) => !allowedFields.has(field));
  if (unexpected.length) {
    throw new AppError('INVALID_ARGUMENT', `${label}请求包含不允许的字段。`,{fields:unexpected});
  }
}

export function registerV2Ipc(ipcMain, services) {
  registerServerWorkspaceIpc(ipcMain, services);
  registerCloudConfigIpc(ipcMain, services);
  registerRedisWorkspaceIpc(ipcMain, services);
  registerRedisEditIpc(ipcMain, services);
  registerMysqlEditIpc(ipcMain, services);
  const { workspaceStore: store, connectionManager, credentialVault, legacyCredentialStore, configTransactionJournal, contextManager, confirmationManager, pluginManager, mysqlRuntime, pluginEditSessionManager, pluginProbeManager } = services;
  const credentialUseResolver = services.credentialUseResolver ?? new CredentialUseResolver(credentialVault);
  const handle = (name, fn) => ipcMain.handle(`v2:${name}`, resultHandler(fn));
  const handleWithEvent = (name, fn) => ipcMain.handle(`v2:${name}`, resultHandlerWithEvent(fn));
  const handlePlugin = (method, fn) => ipcMain.handle(PLUGIN_IPC_CHANNELS[method], resultHandler(fn));
  const handlePluginWithEvent = (method, fn) => ipcMain.handle(PLUGIN_IPC_CHANNELS[method], resultHandlerWithEvent(fn));
  const mutationCoordinator = services.mutationCoordinator ?? new WorkspaceMutationCoordinator();
  const rendererCleanupInstalled = new WeakSet();
  const rendererOwner = (event) => {
    const sender = event?.sender;
    const ownerId = `renderer:${String(sender?.id ?? 'unknown')}`;
    if (sender && typeof sender === 'object' && !rendererCleanupInstalled.has(sender)) {
      rendererCleanupInstalled.add(sender);
      sender.once?.('destroyed',() => {
        pluginEditSessionManager?.invalidateOwner?.(ownerId);
        pluginProbeManager?.invalidateOwner?.(ownerId);
      });
    }
    return ownerId;
  };
  const assertProjectAvailable = (projectId) => mutationCoordinator.assertProjectAvailable(projectId);
  const requestConnectionIntent = (payload) => {
    if (!payload || !['connect','disconnect','retry','cancel'].includes(payload.intent)) {
      throw new AppError('CONNECTION_INTENT_INVALID','连接意图无效。');
    }
    assertProjectAvailable(payload.projectId);
    if (typeof connectionManager.requestConnectionIntent === 'function') {
      return connectionManager.requestConnectionIntent(payload);
    }
    if (payload.intent === 'connect' && payload.pluginInstanceId) {
      return Promise.resolve(connectionManager.connectPlugin(payload.projectId,payload.environmentId,payload.pluginInstanceId))
        .then((snapshot) => ({outcome:'started',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot}));
    }
    if (payload.intent === 'connect') {
      return Promise.resolve(connectionManager.connect(payload.projectId,payload.environmentId,payload))
        .then((snapshot) => ({outcome:'started',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot}));
    }
    if (payload.intent === 'retry') {
      return Promise.resolve(connectionManager.retryFailed(payload.projectId,payload.environmentId,payload))
        .then((snapshot) => ({outcome:'started',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot}));
    }
    if (payload.intent === 'disconnect' && payload.pluginInstanceId) {
      return Promise.resolve(connectionManager.disconnectPlugin(payload.projectId,payload.environmentId,payload.pluginInstanceId))
        .then((snapshot) => ({outcome:'started',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot}));
    }
    if (payload.intent === 'disconnect') {
      return Promise.resolve(connectionManager.disconnect(payload.projectId,payload.environmentId))
        .then((snapshot) => ({outcome:'started',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot}));
    }
    const snapshot = connectionManager.cancel(payload.projectId,payload.environmentId);
    return {outcome:'cancelled',planId:payload.planId ?? null,operationId:payload.operationId ?? null,actions:[],snapshot};
  };
  const legacyConnectionSnapshot = async (payload) => (await requestConnectionIntent(payload)).snapshot;
  const enqueuePluginMutation = (projectId,environmentId,operation,ownerId = null) => (
    mutationCoordinator.enqueueEnvironmentMutation(projectId,environmentId,operation,{ownerId})
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
  const pluginConfigurationService = services.pluginConfigurationService ?? createPluginConfigurationService({
    ...services, mutationCoordinator,
  });
  const {preparePluginUpdate, commitPreparedPlugin, commitAgentPluginUpdate, commitConnectionPluginUpdate,
    withConfigurationMutation, invalidateServerWorkspace, recordPluginChange, restoreRuntimeWarning} = pluginConfigurationService;

  ipcMain.on('v2:network-changed', () => connectionManager.networkChanged('renderer-network-change').catch(() => undefined));

  const requirePluginEditSessionManager = () => {
    if (!pluginEditSessionManager) {
      throw new AppError('PLUGIN_EDIT_SESSION_UNAVAILABLE','插件连接配置编辑服务不可用。');
    }
    return pluginEditSessionManager;
  };
  const requirePluginProbeManager = () => {
    if (!pluginProbeManager) {
      throw new AppError('PLUGIN_PROBE_UNAVAILABLE','插件临时探针服务不可用。');
    }
    return pluginProbeManager;
  };
  handlePluginWithEvent('preparePluginConnectionEdit',(event,payload) => (
    requirePluginEditSessionManager().preparePluginConnectionEdit({
      ...payload,ownerId:rendererOwner(event),
    })
  ));
  handlePluginWithEvent('beginPluginConnectionEdit',(event,payload) => (
    requirePluginEditSessionManager().beginPluginConnectionEdit({
      ...payload,ownerId:rendererOwner(event),
    })
  ));
  handlePluginWithEvent('validatePluginDraft',(event,payload) => {
    const ownerId = rendererOwner(event);
    return requirePluginEditSessionManager().validatePluginDraft({
      ...payload,
      ownerId,
      onProgress:(progress) => {
        if (event.sender.isDestroyed?.()) return;
        event.sender.send?.('v2:plugin-validation-progress',progress);
      },
    });
  });
  handlePluginWithEvent('cancelPluginValidation',(event,payload) => (
    requirePluginEditSessionManager().cancelPluginValidation({
      ...payload,ownerId:rendererOwner(event),
    })
  ));
  handlePluginWithEvent('probePluginDraft',(event,payload) => (
    requirePluginProbeManager().probePluginDraft(payload,{
      ownerId:rendererOwner(event),
      onProgress:(progress) => {
        if (event.sender.isDestroyed?.()) return;
        event.sender.send?.('v2:plugin-probe-progress',progress);
      },
    })
  ));
  handlePluginWithEvent('cancelPluginProbe',(event,payload) => (
    requirePluginProbeManager().cancelPluginProbe(payload,{ownerId:rendererOwner(event)})
  ));
  handlePluginWithEvent('cancelPluginConnectionEdit',(event,payload) => {
    const ownerId = rendererOwner(event);
    const manager = requirePluginEditSessionManager();
    if (payload?.prepareToken && !payload?.editSessionId) {
      return manager.cancelPreparation(payload.prepareToken,{ownerId});
    }
    return manager.cancelPluginConnectionEdit({...payload,ownerId});
  });
  handlePluginWithEvent('savePluginConnectionEdit', (event, payload = {}) => (
    pluginConfigurationService.savePluginConnectionEdit(payload, {ownerId:rendererOwner(event)})
  ));

  handle('project-list', () => store.listProjects());
  handle('workspace-overview', async () => {
    const projects = typeof store.listProjectOverviews === 'function'
      ? await store.listProjectOverviews()
      : await Promise.all((await store.listProjects()).map(async (project) => ({ ...project, environments:await store.listEnvironments(project.projectId) })));
    return Promise.all(projects.map(async (project) => {
      const environments = await Promise.all((project.environments ?? []).map(async (rawEnvironment) => {
          const environment = rawEnvironment;
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
              draftCount: environment.draftCount ?? (environment.pluginCount - environment.readyPluginCount),
            },
          };
        }));
      return {
        ...project,
        environments,
        pluginCount:environments.reduce((sum,environment) => sum + Number(environment.pluginCount ?? 0),0),
      };
    }));
  });
  handle('project-create', async (input) => {
    const candidateId = normalizeId(input?.projectId ?? input?.name, 'project');
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
      const assertRecoveryAvailable = (values) => {
        for (const environment of values) {
          (configTransactionJournal ?? connectionManager.configurationJournal)
            ?.assertEnvironmentAvailable?.(projectId, environment.environmentId);
        }
      };
      assertRecoveryAvailable(environments);
      await mutationCoordinator.waitProjectActivity(projectId);
      // A mutation/operation that was already active when deletion began may
      // have changed environment/runtime state. Re-read before the commit.
      environments = await store.listEnvironments(projectId);
      active = findActive(environments);
      if (active.length) {
        throw new AppError('PROJECT_CONNECTED', `请先断开项目中的环境：${active.map((item) => item.name).join('、')}。`);
      }
      // The project deletion fence already excludes all new operations and
      // has drained earlier work. A normal configuration mutation would
      // reject its own project fence; retain only the recovery preflight.
      assertRecoveryAvailable(environments);
      pluginEditSessionManager?.invalidateProject?.(projectId);
      if (typeof connectionManager.disconnect === 'function') {
        await Promise.all(environments.map((environment) => connectionManager.disconnect(projectId, environment.environmentId, 'project-delete-cleanup')));
      }
      invalidateServerWorkspace({ projectId });
      const value = await store.deleteProject(projectId);
      legacyCredentialStore?.invalidateProject(projectId);
      contextManager.invalidateProject(projectId);
      confirmationManager.invalidateProject?.(projectId);
      await connectionManager.forgetProject?.(projectId);
      services.broadcast?.('v2:workspace-changed', { type:'project-deleted', projectId });
      return { ...value, credentialsPreserved:true };
    } finally {
      mutationCoordinator.endProjectDelete(projectId);
    }
  });
  handle('environment-list', (projectId) => store.listEnvironments(projectId));
  handle('quick-question-opening-get', () => store.getQuickQuestionOpening());
  handle('quick-question-opening-save', async (payload) => {
    assertExactQuickQuestionPayload(
      payload,new Set(['text','expectedRevision']),'保存快捷提问开场白',
    );
    const value = await store.saveQuickQuestionOpening(payload.text,payload.expectedRevision);
    services.broadcast?.('v2:workspace-changed',{type:'quick-question-opening-updated'});
    return value;
  });
  handle('quick-question-list', ({ projectId, environmentId }) => (
    mutationCoordinator.runEnvironmentOperation(
      projectId,environmentId,() => store.listQuickQuestions(projectId,environmentId),
    )
  ));
  handle('quick-question-save', ({ projectId, environmentId, questionId = null, text, expectedRevision }) => (
    enqueuePluginMutation(projectId,environmentId,async () => {
    const value = await store.saveQuickQuestion(
      projectId,environmentId,{questionId,text},expectedRevision,
    );
    services.broadcast?.('v2:workspace-changed',{type:'quick-questions-updated',projectId,environmentId});
    return value;
    })
  ));
  handle('quick-question-delete', ({ projectId, environmentId, questionId, expectedRevision }) => (
    enqueuePluginMutation(projectId,environmentId,async () => {
    const value = await store.deleteQuickQuestion(
      projectId,environmentId,questionId,expectedRevision,
    );
    services.broadcast?.('v2:workspace-changed',{type:'quick-questions-updated',projectId,environmentId});
    return value;
    })
  ));
  handle('quick-question-copy', async (payload = {}) => {
    assertExactQuickQuestionPayload(
      payload,new Set(['projectId','environmentId','text','discoveredDate','expectedOpeningRevision']),'复制快捷提问',
    );
    const { projectId, environmentId, expectedOpeningRevision } = payload;
    return mutationCoordinator.runEnvironmentOperation(projectId,environmentId,async () => {
      const project = await store.getProject(projectId);
      const environment = await store.getEnvironment(projectId,environmentId);
      await assertQuickQuestionScopeNamesUnique(store,project.name,environment.name);
      const clipboardAdapter = services.quickQuestionClipboard;
      if (!clipboardAdapter || typeof clipboardAdapter.writeText !== 'function') {
        throw new AppError('CLIPBOARD_UNAVAILABLE', '系统剪贴板当前不可用。');
      }
      return store.useQuickQuestionOpening(expectedOpeningRevision,async (opening) => {
        const text = buildQuickQuestionCopyText({
          openingText:opening.text,
          projectName:project.name,
          environmentName:environment.name,
          question:payload.text,
          discoveredDate:payload.discoveredDate,
        });
        await clipboardAdapter.writeText(text);
        return {copied:true};
      });
    });
  });
  handle('environment-create', ({ projectId, input }) => {
    assertProjectAvailable(projectId);
    return store.createEnvironment(projectId, input);
  });
  handle('environment-update', ({ projectId, environmentId, patch, expectedRevision }) => enqueuePluginMutation(projectId, environmentId, async () => {
    const value = await store.updateEnvironment(projectId, environmentId, patch, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    return value;
  }));
  handle('environment-delete', async ({ projectId, environmentId }) => {
    assertProjectAvailable(projectId);
    const immediate = connectionManager.snapshot(projectId,environmentId);
    if (immediate.desiredConnected || immediate.phase !== 'disconnected') {
      throw new AppError('ENVIRONMENT_CONNECTED', '请先断开环境后再删除。');
    }
    await store.preflightDeleteEnvironment?.(projectId,environmentId);
    pluginEditSessionManager?.invalidateEnvironment?.(projectId,environmentId);
    return enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, null, async () => {
    const state = connectionManager.snapshot(projectId, environmentId);
    const runtimeActive = state.desiredConnected || state.phase !== 'disconnected';
    if (!runtimeActive && typeof connectionManager.disconnect === 'function') {
      await connectionManager.disconnect(projectId, environmentId, 'environment-delete-cleanup');
    }
    if (!runtimeActive) invalidateServerWorkspace({ projectId, environmentId });
    const value = await store.deleteEnvironment(projectId, environmentId, { runtimeActive });
    legacyCredentialStore?.invalidateEnvironment(projectId,environmentId);
    contextManager.invalidateEnvironment(projectId, environmentId);
    confirmationManager.invalidateEnvironment?.(projectId, environmentId);
    await connectionManager.forgetEnvironment?.(projectId, environmentId);
    services.broadcast?.('v2:workspace-changed', { type:'environment-deleted', projectId, environmentId });
    return {...value,credentialsPreserved:true};
    }));
  });
  handle('environment-reorder', ({ projectId, environmentIds, expectedRevision }) => {
    assertProjectAvailable(projectId);
    return store.reorderEnvironments(projectId, environmentIds, expectedRevision);
  });
  handle('connection-intent', (payload) => requestConnectionIntent(payload));
  handle('connection-challenge-confirm', async (payload = {}) => {
    if (typeof connectionManager.validateConnectionChallenge !== 'function'
      || typeof connectionManager.resumeConnectionChallenge !== 'function') {
      throw new AppError('CONNECTION_CHALLENGE_UNAVAILABLE','连接确认服务不可用。');
    }
    const initial = await connectionManager.validateConnectionChallenge(payload);
    assertProjectAvailable(initial.projectId);
    return enqueuePluginMutation(initial.projectId,initial.environmentId,async () => {
      const challenge = await connectionManager.validateConnectionChallenge(payload);
      const before = await store.getPlugin?.(
        challenge.projectId,challenge.environmentId,challenge.pluginInstanceId,
      );
      const target = before?.target ?? {host:challenge.host,port:challenge.port};
      const trustPayload = {
        projectId:challenge.projectId,
        environmentId:challenge.environmentId,
        pluginInstanceId:challenge.pluginInstanceId,
        expectedRevision:challenge.expectedRevision,
        patch:{target:{...target,hostKeyFingerprint:challenge.fingerprint}},
        credentialIntent:'rebind-existing',
      };
      const prepared = await preparePluginUpdate(trustPayload,'connection');
      if (prepared.before.pluginType !== 'server'
        || prepared.before.target?.host !== challenge.host
        || Number(prepared.before.target?.port) !== challenge.port) {
        throw new AppError('CONNECTION_CHALLENGE_STALE','连接目标已经变化，请重新连接。');
      }

      let persistenceWarning = null;
      let runtimeWarning = null;
      let plugin;
      const committed = await commitConnectionPluginUpdate(prepared,trustPayload,{recordChange:false});
      ({persistenceWarning = null,runtimeWarning = null,...plugin} = committed);
      await Promise.resolve(store.appendAudit?.(challenge.projectId,{
        type:'server-host-key-trusted',
        projectId:challenge.projectId,
        environmentId:challenge.environmentId,
        pluginInstanceId:challenge.pluginInstanceId,
        pluginNameSnapshot:plugin.displayName,
        planId:challenge.planId,
        operationId:challenge.operationId,
        algorithm:challenge.algorithm,
        fingerprint:challenge.fingerprint,
        actor:'user',
        result:'success',
      })).catch((error) => { persistenceWarning ??= toPublicError(error); });

      let connectionPlan = null;
      try {
        connectionPlan = await connectionManager.resumeConnectionChallenge(payload,{plugin});
        runtimeWarning ??= restoreRuntimeWarning(connectionPlan);
      } catch (error) {
        const value = toPublicError(error);
        runtimeWarning ??= {
          code:value.code,
          message:`配置和密码已保存，但连接失败。 ${value.message}`,
        };
      }
      return {
        committed:true,
        plugin:typeof store.publicPlugin === 'function' ? store.publicPlugin(plugin) : plugin,
        persistenceWarning,
        connectionPlan,
        runtimeWarning,
      };
    });
  });
  handle('environment-connect', ({ projectId, environmentId, expectedRevision, secretsByPlugin }) => legacyConnectionSnapshot({
    requestId:crypto.randomUUID(),projectId,environmentId,expectedRevision,secretsByPlugin,
    intent:'connect',source:'legacy-environment',
  }));
  handle('environment-retry', ({ projectId, environmentId, secretsByPlugin }) => legacyConnectionSnapshot({
    requestId:crypto.randomUUID(),projectId,environmentId,secretsByPlugin,
    intent:'retry',source:'legacy-environment',
  }));
  handle('environment-disconnect', ({ projectId, environmentId }) => legacyConnectionSnapshot({
    requestId:crypto.randomUUID(),projectId,environmentId,intent:'disconnect',source:'legacy-environment',
  }));
  handle('environment-cancel', ({ projectId, environmentId }) => legacyConnectionSnapshot({
    requestId:crypto.randomUUID(),projectId,environmentId,intent:'cancel',source:'legacy-environment',legacyScope:true,
  }));
  handle('environment-status', ({ projectId, environmentId }) => environmentAssessmentSnapshot(projectId, environmentId));
  handle('plugin-connect', ({ projectId, environmentId, pluginInstanceId }) => {
    return legacyConnectionSnapshot({
      requestId:crypto.randomUUID(),projectId,environmentId,pluginInstanceId,
      intent:'connect',source:'legacy-plugin',
    });
  });
  handle('plugin-disconnect', ({ projectId, environmentId, pluginInstanceId }) => legacyConnectionSnapshot({
    requestId:crypto.randomUUID(),projectId,environmentId,pluginInstanceId,
    intent:'disconnect',source:'legacy-plugin',
  }));
  handle('runbook-read', ({ projectId, environmentId }) => store.readRunbook(projectId, environmentId));
  handle('runbook-save', ({ projectId, environmentId, content, expectedRevision }) => enqueuePluginMutation(projectId, environmentId, async () => {
    const value = await store.saveRunbook(projectId, environmentId, content, expectedRevision);
    contextManager.invalidateEnvironment(projectId, environmentId);
    await store.appendAudit(projectId, { type:'runbook-updated', environmentId, actor:'user', result:'success', bytes:Buffer.byteLength(String(content ?? ''),'utf8') }).catch(() => undefined);
    return value;
  }));
  handlePlugin('listPlugins', async ({ projectId, environmentId }) => {
    const plugins = await store.listPlugins(projectId,environmentId);
    const snapshot = await environmentAssessmentSnapshot(projectId,environmentId,plugins);
    return plugins.map((plugin) => pluginWithAssessment(plugin,snapshot));
  });
  handlePlugin('assessPlugin', async ({
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
    const candidate = normalizePluginCandidate(
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
  handlePlugin('createPlugin', pluginConfigurationService.createPlugin);
  handlePlugin('updatePluginMetadata', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    assertCredentialFreeUpdate(payload,'插件基本信息');
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'metadata');
      return commitPreparedPlugin(prepared,payload);
    });
  });
  handlePlugin('updatePluginAgentConfiguration', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    assertCredentialFreeUpdate(payload,'Agent 配置');
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'agent-policy-scope');
      return commitAgentPluginUpdate(prepared,payload);
    });
  });
  handlePlugin('updatePluginConnection', (payload) => {
    assertExpectedPluginRevision(payload?.expectedRevision);
    return enqueuePluginMutation(payload.projectId,payload.environmentId,async () => {
      const prepared = await preparePluginUpdate(payload,'connection');
      if (prepared.change.kind === 'none') return prepared.before;
      return commitConnectionPluginUpdate(prepared,payload);
    });
  });
  // One-version compatibility shim. The backend still normalizes and
  // classifies the patch, then delegates to the narrow semantic path.
  handlePlugin('updatePlugin', (payload) => enqueuePluginMutation(
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
  handlePlugin('deletePlugin', async ({ projectId, environmentId, pluginInstanceId }) => {
    // Reject impossible deletes before discarding the user's edit session.
    // Recheck inside the mutation below because dependencies may change while
    // this initial read is in flight.
    await store.preflightDeletePlugin(projectId, environmentId, pluginInstanceId);
    pluginEditSessionManager?.invalidatePlugin?.(projectId,environmentId,pluginInstanceId);
    return enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, pluginInstanceId, async ({restoreOnFailure}) => {
    let plugin;
    try { ({plugin} = await store.preflightDeletePlugin(projectId, environmentId, pluginInstanceId)); }
    catch (error) { restoreOnFailure(); throw error; }
    let value;
    invalidateServerWorkspace({ projectId, environmentId, pluginInstanceId });
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
    await recordPluginChange(plugin,'plugin-deleted');
    services.broadcast?.('v2:workspace-changed', { type:'plugin-deleted', projectId, environmentId, pluginInstanceId });
    return { ...value, credentialsPreserved:true,...(runtimeWarning ? {runtimeWarning} : {}) };
    }));
  });
  handle('plugin-credential-status', async ({ projectId, environmentId, pluginInstanceId }) => {
    const plugin = await store.getPlugin(projectId, environmentId, pluginInstanceId);
    const secrets = await credentialVault.load(plugin) ?? {};
    const primaryKey = plugin.pluginType === 'server' && plugin.auth?.type === 'privateKey' ? 'privateKeyPassphrase' : 'password';
    const fields = { primary: Boolean(secrets[primaryKey]), proxy: plugin.pluginType === 'server' && Boolean(secrets.proxyPassword) };
    const saved = fields.primary || fields.proxy || Boolean(plugin.auth?.privateKeySource === 'vault' && secrets.privateKeyPem);
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
    const transient = normalizePlugin({
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
  for (const [channel, operation] of [
    ['mysql-list-tables', 'listTables'],
    ['mysql-describe-table', 'describeTable'],
    ['mysql-preview-table', 'previewTable'],
    ['mysql-query-readonly', 'queryReadonly'],
  ]) {
    handle(channel, (payload) => services.v2Service.invokeDesktopMysql(payload, operation));
  }
  store.onAuditChanged = change => services.broadcast?.('v2:workspace-changed',change);
  confirmationManager.statuses?.on('status', id => {
    const value = confirmationManager.statuses.entries.get(id)?.value;
    if (!value || !['expired','invalidated'].includes(value.status)) return;
    void store.appendAudit(value.projectId,{
      type:'confirmation-' + value.status, environmentId:value.environmentId, pluginInstanceId:value.pluginInstanceId,
      actor:'system', capability:value.capability, confirmationId:id, result:value.status,
    }).catch(() => undefined);
  });
  handle('audit-list', ({ projectId, ...filters }) => store.listAudit(projectId, filters));
  handle('audit-clear', ({ projectId, environmentId, pluginInstanceId = null }) => store.clearAudit(projectId, { environmentId, pluginInstanceId }));
  handle('confirmation-list', () => confirmationManager.list());
  handle('confirmation-approve', async (requestId) => {
    const pending = confirmationManager.list().find((item) => item.requestId === requestId);
    const result = confirmationManager.approve(requestId);
    if (pending) await store.appendAudit(pending.projectId, { type:'confirmation-approved', environmentId:pending.environmentId, pluginInstanceId:pending.pluginInstanceId, pluginNameSnapshot:pending.pluginNameSnapshot, actor:'user', capability:pending.capability, auditAction:pending.auditAction, auditTarget:pending.auditTarget, pluginType:pending.pluginType, confirmationId:requestId, expiresAt:result.expiresAt, result:'success' }).catch(() => undefined);
    return result;
  });
  handle('confirmation-reject', async (requestId) => {
    const pending = confirmationManager.list().find((item) => item.requestId === requestId);
    const result = confirmationManager.reject(requestId);
    if (pending) await store.appendAudit(pending.projectId, { type:'confirmation-rejected', environmentId:pending.environmentId, pluginInstanceId:pending.pluginInstanceId, pluginNameSnapshot:pending.pluginNameSnapshot, actor:'user', capability:pending.capability, auditAction:pending.auditAction, auditTarget:pending.auditTarget, pluginType:pending.pluginType, confirmationId:requestId, result:'blocked' }).catch(() => undefined);
    return result;
  });
  connectionManager.on('changed', (state) => services.broadcast?.('v2:environment-status-changed',state));
  confirmationManager.on('changed', (pending) => services.broadcast?.('v2:confirmations-changed', pending));
  return services;
}
