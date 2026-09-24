import { isolateNewPluginIdentity } from './plugin-creation-identity.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import { normalizePlugin, normalizePluginCandidate } from './plugin-config-model.mjs';
import { assertPluginConfigurationReady, getPluginConnectionAdapter, isCredentialFreeServerAgent } from './plugin-connection-adapters.mjs';

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


// 应用服务拥有保存事务；调用方只提供经过身份绑定的请求和界面通知。
export function createPluginConfigurationService(services) {
  const {workspaceStore:store, connectionManager, credentialVault, configTransactionJournal,
    contextManager, confirmationManager, pluginEditSessionManager, mutationCoordinator} = services;
  const enqueuePluginMutation = (projectId, environmentId, operation, ownerId = null) => (
    mutationCoordinator.enqueueEnvironmentMutation(projectId, environmentId, operation, {ownerId})
  );
  const requirePluginEditSessionManager = () => {
    if (!pluginEditSessionManager) throw new AppError('PLUGIN_EDIT_SESSION_UNAVAILABLE', '插件连接配置编辑服务不可用。');
    return pluginEditSessionManager;
  };
  const withConfigurationMutation = async (projectId, environmentId, changedPluginInstanceId, operation, ownerId = null) => {
    const token = connectionManager.beginConfigurationMutation?.(
      projectId, environmentId, changedPluginInstanceId, {ownerId},
    ) ?? null;
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
  const createPlugin = ({ projectId, environmentId, input, secrets }) => enqueuePluginMutation(projectId, environmentId, () => withConfigurationMutation(projectId, environmentId, null, async () => {
    let candidate = normalizePlugin(input,{projectId,environmentId});
    assertPluginConfigurationReady(candidate);
    candidate = await isolateNewPluginIdentity(candidate,{
      workspaceStore:store,credentialVault,explicitIdentity:input.pluginInstanceId !== undefined,
    });
    const plugin = await store.createPlugin(projectId, environmentId, candidate);
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
    await recordPluginChange(plugin,'plugin-added');
    return {...plugin,...(runtimeWarning ? {runtimeWarning,manualReconnectRequired:true} : {})};
  }));

  const preparePluginUpdate = async (payload, patchScope = null) => {
    const {
      projectId,environmentId,pluginInstanceId,patch,expectedRevision,
    } = payload;
    const {credentialMutation,replacements} = credentialMutationFromPayload(payload);
    if (Object.hasOwn(payload,'forceCredentialReplacement')
      && typeof payload.forceCredentialReplacement !== 'boolean') {
      throw new AppError('INVALID_ARGUMENT', '强制替换凭据标志无效。');
    }
    const forceCredentialReplacement = payload.forceCredentialReplacement === true;
    if (forceCredentialReplacement && !Object.keys(replacements).length) {
      throw new AppError('INVALID_ARGUMENT', '强制替换凭据必须提供至少一个新的凭据字段。');
    }
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
    const result = {
      ...prepared,
      change:prepared.change ?? {kind:'session-affecting',credentialMutation},
      credentialMutation,
      forceCredentialReplacement,
      replacements,
    };
    const connectionSave = patchScope === 'connection'
      || (patchScope === null && ['session-affecting','dependency-affecting'].includes(result.change.kind));
    if (connectionSave) {
      const candidate = result.after ?? result.candidate ?? normalizePluginCandidate(
        {...(patch ?? {}),pluginInstanceId,pluginType:result.before.pluginType},
        {projectId,environmentId},
        result.before,
      );
      assertPluginConfigurationReady(candidate);
    }
    return result;
  };
  const invalidateServerWorkspace = (scope) => {
    services.serverDocker?.closeScope(scope);
    services.serverWorkspaceManager?.closeScope(scope, 'configuration-changed');
    services.serverWorkspaceFiles?.closeScope(scope);
  };
  const recordPluginChange = async (plugin, type) => {
    if (typeof store.appendAudit !== 'function') return;
    await store.appendAudit(plugin.projectId,{
      type,environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,pluginType:plugin.pluginType,
      pluginNameSnapshot:plugin.displayName,actor:'user',result:'success',
    }).catch(() => undefined);
  };
  const commitPreparedPlugin = async (prepared, payload) => {
    if (prepared.change.kind === 'none') return prepared.before;
    if (['session-affecting', 'dependency-affecting'].includes(prepared.change.kind)) invalidateServerWorkspace(payload);
    const plugin = prepared.after && typeof store.commitPluginSnapshot === 'function'
      ? await store.commitPluginSnapshot(prepared.after,prepared.before.revision)
      : await store.updatePlugin(payload.projectId,payload.environmentId,payload.pluginInstanceId,payload.patch,payload.expectedRevision);
    if (prepared.change.kind === 'metadata') await recordPluginChange(plugin,'plugin-metadata-updated');
    return plugin;
  };
  const commitAgentPluginUpdate = async (prepared, payload) => {
    const plugin = await commitPreparedPlugin(prepared,payload);
    if (prepared.change.kind !== 'none') {
      contextManager.invalidateEnvironment?.(payload.projectId,payload.environmentId);
      confirmationManager.invalidatePlugin?.(
        payload.projectId,payload.environmentId,payload.pluginInstanceId,
      );
      await recordPluginChange(plugin,'plugin-agent-updated');
    }
    return plugin;
  };
  const commitConnectionPluginUpdate = (prepared, payload, {ownerId = null, recordChange = true} = {}) => withConfigurationMutation(
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
        if (prepared.forceCredentialReplacement) {
          await credentialVault.replaceUnreadable(prepared.before,plugin,prepared.replacements);
        } else {
          await credentialVault.saveMerged(prepared.before,plugin,prepared.replacements);
        }
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
      if (recordChange) await recordPluginChange(plugin,'plugin-connection-updated');
      return {
        ...plugin,
        ...(runtimeWarning ? {runtimeWarning,manualReconnectRequired:true} : {}),
        ...(journalWarning ? {persistenceWarning:journalWarning} : {}),
      };
    },ownerId,
  );

  const restoreRuntimeWarning = (connectionPlan) => {
    if (!connectionPlan || (connectionPlan.outcome !== 'needs-action' && !connectionPlan.actions?.length)) return null;
    const first = connectionPlan.actions?.[0];
    return {
      code:first?.code ?? 'CONNECTION_FAILED_AFTER_SAVE',
      message:`配置和密码已保存，但连接失败。${first?.message ? ` ${first.message}` : ''}`,
      details:{planId:connectionPlan.planId ?? null},
    };
  };


  const savePluginConnectionEdit = async (payload = {}, {ownerId} = {}) => {
    const manager = requirePluginEditSessionManager();
    manager.captureCredentialIntent?.(payload.editSessionId,{...payload,ownerId});
    manager.beginSave(payload.editSessionId,{ownerId});
    const material = manager.commitMaterial(payload.editSessionId,{ownerId});
    const {projectId,environmentId,pluginInstanceId} = material.scope;
    const scopedPayload = {
      ...payload,
      projectId,environmentId,pluginInstanceId,
      credentialIntent:material.credentialIntent,
      temporarySecrets:material.temporarySecrets,
    };
    let committed = false;
    try {
      return await enqueuePluginMutation(projectId,environmentId,async () => {
        if (payload.expectedRevision !== material.baseRecordRevision) {
          throw new AppError('CONFIG_REVISION_CONFLICT','插件配置已经变化，请刷新后重试。');
        }
        const prepared = await preparePluginUpdate(scopedPayload,'connection');
        const adapter = getPluginConnectionAdapter(prepared.before.pluginType);
        const identityChanged = JSON.stringify(adapter.credentialIdentity(prepared.before))
          !== JSON.stringify(adapter.credentialIdentity(prepared.after ?? prepared.before));
        if (identityChanged && prepared.credentialMutation === 'none'
          && !isCredentialFreeServerAgent(prepared.after ?? prepared.before)) {
          throw new AppError(
            'PLUGIN_CREDENTIAL_REBIND_REQUIRED',
            '认证目标或安全路径已经变化，请输入新凭据或明确沿用已保存凭据。',
          );
        }

        let plugin = prepared.before;
        let persistenceWarning = null;
        let runtimeWarning = null;
        if (prepared.change.kind !== 'none') {
          const value = await commitConnectionPluginUpdate(prepared,scopedPayload,{ownerId:payload.editSessionId});
          ({persistenceWarning = null,runtimeWarning = null,...plugin} = value);
        }
        committed = true;

        let connectionPlan = null;
        try {
          connectionPlan = await manager.completeSave(payload.editSessionId,{
            afterCommit:payload.afterCommit ?? 'stay-disconnected',ownerId,
          });
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
          changed:prepared.change.kind !== 'none',
          changeKind:prepared.change.kind,
          plugin:typeof store.publicPlugin === 'function' ? store.publicPlugin(plugin) : plugin,
          persistenceWarning,
          connectionPlan,
          runtimeWarning,
        };
      },payload.editSessionId);
    } catch (error) {
      if (!committed) {
        try { manager.saveFailed(payload.editSessionId); }
        catch { /* 保留原始存储或版本冲突错误。 */ }
      }
      throw error;
    }
  };

  return Object.freeze({
    createPlugin, preparePluginUpdate, commitPreparedPlugin, commitAgentPluginUpdate, commitConnectionPluginUpdate,
    withConfigurationMutation, invalidateServerWorkspace, recordPluginChange,
    restoreRuntimeWarning, savePluginConnectionEdit,
  });
}
