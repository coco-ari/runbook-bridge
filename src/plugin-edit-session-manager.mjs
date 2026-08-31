import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { workspaceInternals } from './workspace-store.mjs';

const VALIDATION_PURPOSES = new Set([
  'tls-probe','server-auth','resource-discovery','resource-access','health-check',
]);
const CREDENTIAL_INTENTS = new Set(['unchanged','none','replace','rebind-existing','clear-explicit']);

function credentialIntentMode(value) {
  const mode = typeof value === 'string' ? value : value?.mutation ?? value?.mode ?? 'unchanged';
  if (!CREDENTIAL_INTENTS.has(mode)) throw new AppError('INVALID_ARGUMENT','凭据使用意图无效。');
  return mode === 'none' ? 'unchanged' : mode;
}

function publicValidation(value) {
  if (!value) return null;
  return {
    state:value.state,
    operationId:value.operationId,
    requestId:value.requestId,
    draftGeneration:value.draftGeneration,
    configDigest:value.configDigest,
    startedAt:value.startedAt,
    completedAt:value.completedAt ?? null,
    error:value.error ? structuredClone(value.error) : null,
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left,right) => left.localeCompare(right,'en'));
}

function dependencyClosure(plugins,pluginInstanceId) {
  const affected = new Set([pluginInstanceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      if (!affected.has(plugin.transport?.serverPluginInstanceId) || affected.has(plugin.pluginInstanceId)) continue;
      affected.add(plugin.pluginInstanceId);
      changed = true;
    }
  }
  return sortedUnique(affected);
}

function previewFingerprint(preview) {
  return JSON.stringify({
    baseRecordRevision:preview.baseRecordRevision,
    baseConnectionFingerprint:preview.baseConnectionFingerprint,
    affectedIds:preview.affectedIds,
  });
}

function nonEmptySecrets(values = {}) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .map(([key,value]) => [key,String(value ?? '')])
      .filter(([,value]) => value.length > 0),
  );
}

function emitValidationProgress(record,purpose,state,error = null) {
  try {
    record.onProgress?.({
      editSessionId:record.editSessionId,
      requestId:record.requestId,
      operationId:record.operationId,
      purpose,
      draftGeneration:record.draftGeneration,
      configDigest:record.configDigest,
      state,
      ...(error ? {error:structuredClone(error)} : {}),
    });
  } catch {
    // A closed renderer cannot affect validation ownership or cleanup.
  }
}

export class PluginEditSessionManager {
  constructor({
    workspaceStore,
    connectionManager,
    mutationCoordinator,
    credentialUseResolver,
    validationRuntime,
    now = Date.now,
    prepareTtlMs = 60_000,
    sessionTtlMs = 30 * 60_000,
    drainTimeoutMs = 10_000,
  } = {}) {
    Object.assign(this,{
      workspaceStore,connectionManager,mutationCoordinator,credentialUseResolver,validationRuntime,now,
    });
    this.prepareTtlMs = Math.max(1_000,Number(prepareTtlMs) || 60_000);
    this.sessionTtlMs = Math.max(10_000,Number(sessionTtlMs) || 30 * 60_000);
    this.drainTimeoutMs = Math.max(1,Number(drainTimeoutMs) || 10_000);
    this.preparations = new Map();
    this.sessions = new Map();
  }

  async impactPreview({projectId,environmentId,pluginInstanceId,expectedRevision = null} = {}) {
    const plugins = await this.workspaceStore.listPlugins(projectId,environmentId);
    const plugin = plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
    if (!plugin) throw new AppError('PLUGIN_NOT_FOUND','插件不存在。');
    if (expectedRevision !== null && expectedRevision !== undefined && plugin.revision !== expectedRevision) {
      throw new AppError('CONFIG_REVISION_CONFLICT','插件配置已经变化，请刷新后重试。');
    }
    const affectedIds = dependencyClosure(plugins,pluginInstanceId);
    const runtime = this.connectionManager.snapshot(projectId,environmentId);
    const preEditConnectedSet = affectedIds.filter((id) => runtime.plugins?.[id]?.phase === 'connected');
    const connectionOperations = this.connectionManager.activeConnectionOperations?.(
      projectId,environmentId,affectedIds,
    ) ?? [];
    const workspaceActivity = this.mutationCoordinator.environmentActivitySnapshot(projectId,environmentId);
    return {
      scope:{projectId,environmentId,pluginInstanceId},
      plugin,
      baseRecordRevision:plugin.revision,
      baseConnectionFingerprint:pluginConnectionFingerprint(plugin),
      affectedIds,
      preEditConnectedSet,
      activeOperations:{connection:connectionOperations,workspace:workspaceActivity},
    };
  }

  async preparePluginConnectionEdit(payload) {
    this.pruneExpired();
    if (!Number.isInteger(payload?.expectedRevision) || payload.expectedRevision < 1) {
      throw new AppError('INVALID_ARGUMENT','连接配置编辑必须提供有效的 expectedRevision。');
    }
    const preview = await this.impactPreview(payload);
    const prepareToken = crypto.randomUUID();
    const expiresAtMs = this.now() + this.prepareTtlMs;
    this.preparations.set(prepareToken,{
      ...preview,
      prepareToken,
      previewFingerprint:previewFingerprint(preview),
      expiresAtMs,
      controller:new AbortController(),
      ownerId:String(payload.ownerId ?? ''),
      phase:'prepared',
    });
    return {
      prepareToken,
      affectedIds:preview.affectedIds,
      preEditConnectedSet:preview.preEditConnectedSet,
      activeOperations:preview.activeOperations,
      expiresAt:new Date(expiresAtMs).toISOString(),
      baseRecordRevision:preview.baseRecordRevision,
      baseConnectionFingerprint:preview.baseConnectionFingerprint,
    };
  }

  async beginPluginConnectionEdit({prepareToken,ownerId} = {}) {
    this.pruneExpired();
    const preparation = this.preparations.get(prepareToken);
    if (!preparation || preparation.expiresAtMs <= this.now() || preparation.phase !== 'prepared') {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑影响预览已经过期，请重新确认。');
    }
    if (preparation.ownerId !== String(ownerId ?? '')) {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑准备不属于当前窗口。');
    }
    preparation.phase = 'beginning';
    const editSessionId = crypto.randomUUID();
    const {projectId,environmentId,pluginInstanceId} = preparation.scope;
    this.mutationCoordinator.installEnvironmentEditFence(
      projectId,environmentId,editSessionId,preparation.affectedIds,
    );
    try {
      let current = await this.impactPreview({projectId,environmentId,pluginInstanceId});
      if (previewFingerprint(current) !== preparation.previewFingerprint) {
        throw new AppError('PLUGIN_EDIT_SESSION_STALE','插件配置或依赖关系已经变化，请重新确认影响范围。',{
          preview:this.publicPreview(current),
        });
      }
      await Promise.all([
        this.mutationCoordinator.waitEnvironmentDrain(projectId,environmentId,{
          timeoutMs:this.drainTimeoutMs,signal:preparation.controller.signal,
        }),
        this.connectionManager.waitForConnectionOperations?.(
          projectId,environmentId,preparation.affectedIds,
          {timeoutMs:this.drainTimeoutMs,signal:preparation.controller.signal},
        ) ?? Promise.resolve(),
      ]);
      current = await this.impactPreview({projectId,environmentId,pluginInstanceId});
      if (previewFingerprint(current) !== preparation.previewFingerprint) {
        throw new AppError('PLUGIN_EDIT_SESSION_STALE','等待期间插件配置或依赖关系已经变化，请重新确认。',{
          preview:this.publicPreview(current),
        });
      }
      const disconnected = await this.connectionManager.disconnectForConfigurationEdit(
        projectId,environmentId,current.affectedIds,{ownerId:editSessionId},
      );
      const expiresAtMs = this.now() + this.sessionTtlMs;
      const session = {
        editSessionId,
        ownerId:preparation.ownerId,
        scope:current.scope,
        basePlugin:structuredClone(current.plugin),
        baseRecordRevision:current.baseRecordRevision,
        baseConnectionFingerprint:current.baseConnectionFingerprint,
        dependencyClosure:[...current.affectedIds],
        preEditConnectedSet:sortedUnique(disconnected.connectedBefore ?? current.preEditConnectedSet),
        draftGeneration:0,
        credentialIntent:'unchanged',
        temporarySecrets:{},
        oneTimeCredentialGrant:null,
        temporaryHostKey:null,
        validationsByPurpose:{},
        phase:'editing',
        expiresAtMs,
      };
      this.sessions.set(editSessionId,session);
      this.preparations.delete(prepareToken);
      const snapshot = this.connectionManager.snapshot(projectId,environmentId);
      return {
        editSessionId,
        plugin:structuredClone(current.plugin),
        assessment:structuredClone(snapshot.plugins?.[pluginInstanceId]?.assessment ?? null),
        affectedIds:[...session.dependencyClosure],
        preEditConnectedSet:[...session.preEditConnectedSet],
        draftGeneration:session.draftGeneration,
        expiresAt:new Date(expiresAtMs).toISOString(),
      };
    } catch (error) {
      preparation.controller.abort(error);
      this.mutationCoordinator.releaseEnvironmentFence(editSessionId);
      this.preparations.delete(prepareToken);
      throw error;
    }
  }

  cancelPreparation(prepareToken,{ownerId = undefined} = {}) {
    const preparation = this.preparations.get(prepareToken);
    if (!preparation) return {cancelled:false};
    if (ownerId !== undefined && preparation.ownerId !== String(ownerId ?? '')) {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑准备不属于当前窗口。');
    }
    preparation.controller.abort(new AppError('PLUGIN_EDIT_DRAIN_CANCELLED','已取消等待正在进行的操作。'));
    preparation.phase = 'cancelled';
    return {cancelled:true};
  }

  publicPreview(preview) {
    return {
      scope:structuredClone(preview.scope),
      baseRecordRevision:preview.baseRecordRevision,
      baseConnectionFingerprint:preview.baseConnectionFingerprint,
      affectedIds:[...preview.affectedIds],
      preEditConnectedSet:[...preview.preEditConnectedSet],
      activeOperations:structuredClone(preview.activeOperations),
    };
  }

  requireSession(editSessionId,{phases = ['editing','saving'],ownerId = undefined} = {}) {
    this.pruneExpired();
    const session = this.sessions.get(String(editSessionId ?? ''));
    if (!session || !phases.includes(session.phase)) {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑会话已经结束、过期或不属于当前请求。');
    }
    if (ownerId !== undefined && session.ownerId !== String(ownerId ?? '')) {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑会话不属于当前窗口。');
    }
    const fence = this.mutationCoordinator.environmentFence(session.scope.projectId,session.scope.environmentId);
    if (fence?.ownerId !== session.editSessionId || fence.kind !== 'edit') {
      throw new AppError('PLUGIN_EDIT_SESSION_STALE','编辑会话已经失去连接门禁所有权。');
    }
    return session;
  }

  sessionSummary(editSessionId) {
    const session = this.sessions.get(String(editSessionId ?? ''));
    if (!session) return null;
    return {
      editSessionId:session.editSessionId,
      scope:structuredClone(session.scope),
      baseRecordRevision:session.baseRecordRevision,
      baseConnectionFingerprint:session.baseConnectionFingerprint,
      dependencyClosure:[...session.dependencyClosure],
      preEditConnectedSet:[...session.preEditConnectedSet],
      draftGeneration:session.draftGeneration,
      credentialIntent:session.credentialIntent,
      hasTemporarySecrets:Object.keys(session.temporarySecrets).length > 0,
      temporaryHostKey:session.temporaryHostKey ? structuredClone(session.temporaryHostKey) : null,
      validationsByPurpose:Object.fromEntries(
        Object.entries(session.validationsByPurpose).map(([purpose,value]) => [purpose,publicValidation(value)]),
      ),
      phase:session.phase,
      expiresAt:new Date(session.expiresAtMs).toISOString(),
    };
  }

  captureCredentialIntent(editSessionId,{
    credentialIntent = 'unchanged',temporarySecrets = {},discardTemporarySecrets = false,
    ownerId = undefined,
  } = {}) {
    const session = this.requireSession(editSessionId,{ownerId});
    if (discardTemporarySecrets) {
      this.clearSensitiveSessionState(session);
      session.credentialIntent = 'unchanged';
    }
    const replacements = nonEmptySecrets(temporarySecrets);
    if (Object.keys(replacements).length) {
      session.temporarySecrets = {...session.temporarySecrets,...replacements};
      session.credentialIntent = 'replace';
    } else {
      const mode = credentialIntentMode(credentialIntent);
      if (mode !== 'unchanged') session.credentialIntent = mode;
    }
    session.expiresAtMs = this.now() + this.sessionTtlMs;
    return this.sessionSummary(editSessionId);
  }

  normalizedDraft(session,draft) {
    const input = {
      ...session.basePlugin,
      ...(draft ?? {}),
      pluginInstanceId:session.scope.pluginInstanceId,
      pluginType:session.basePlugin.pluginType,
    };
    return workspaceInternals.normalizePluginCandidate(input,{
      projectId:session.scope.projectId,
      environmentId:session.scope.environmentId,
    },session.basePlugin);
  }

  invalidateOlderValidations(session,nextGeneration) {
    for (const validation of Object.values(session.validationsByPurpose)) {
      if (validation.state === 'running') {
        validation.state = 'stale';
        validation.completedAt = new Date(this.now()).toISOString();
        validation.controller.abort(new AppError('PLUGIN_VALIDATION_STALE','草稿已经变化。'));
        void Promise.resolve(this.validationRuntime.cleanup?.(validation.runtimeDraft,'validation-stale',validation.operationId)).catch(() => undefined);
      }
    }
    session.temporaryHostKey = null;
    session.draftGeneration = nextGeneration;
  }

  async validatePluginDraft(payload) {
    const session = this.requireSession(payload.editSessionId,{phases:['editing'],ownerId:payload.ownerId});
    if (!VALIDATION_PURPOSES.has(payload.purpose) || !Number.isInteger(payload.draftGeneration) || payload.draftGeneration < 0) {
      throw new AppError('INVALID_ARGUMENT','验证用途或草稿代次无效。');
    }
    if (payload.draftGeneration < session.draftGeneration) {
      throw new AppError('PLUGIN_VALIDATION_STALE','验证请求属于旧草稿代次。');
    }
    if (payload.draftGeneration > session.draftGeneration) {
      this.invalidateOlderValidations(session,payload.draftGeneration);
    }
    this.captureCredentialIntent(session.editSessionId,payload);
    const candidate = this.normalizedDraft(session,payload.draft);
    const adapter = getPluginConnectionAdapter(candidate.pluginType);
    const configuration = adapter.assessConfiguration(candidate,payload.purpose);
    if (configuration.state !== 'complete') {
      const code = configuration.state === 'invalid' ? 'PLUGIN_CONFIGURATION_INVALID' : 'PLUGIN_CONFIGURATION_INCOMPLETE';
      throw new AppError(code,configuration.issues[0]?.message ?? '插件配置不完整。',{
        field:configuration.issues[0]?.field ?? null,
        issues:configuration.issues,
      });
    }
    const configDigest = adapter.validationDigest(candidate,payload.purpose);
    const previous = session.validationsByPurpose[payload.purpose];
    if (previous?.draftGeneration === payload.draftGeneration && previous.configDigest !== configDigest) {
      throw new AppError('PLUGIN_VALIDATION_STALE','草稿内容已变化但代次未更新。');
    }
    if (previous?.state === 'running') {
      previous.state = 'stale';
      previous.controller.abort(new AppError('PLUGIN_VALIDATION_STALE','新的验证请求已取代旧请求。'));
    }
    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    const runtimeDraft = {
      ...candidate,
      pluginInstanceId:`diagnostic-edit-${operationId}`,
    };
    const record = {
      state:'running',operationId,requestId:String(payload.requestId ?? ''),
      draftGeneration:payload.draftGeneration,configDigest,
      startedAt:new Date(this.now()).toISOString(),completedAt:null,error:null,
      controller,runtimeDraft,
      editSessionId:session.editSessionId,
      onProgress:typeof payload.onProgress === 'function' ? payload.onProgress : null,
    };
    session.validationsByPurpose[payload.purpose] = record;
    emitValidationProgress(record,payload.purpose,'running');
    try {
      const resolved = await this.credentialUseResolver.resolve({
        committedPlugin:session.basePlugin,
        draft:candidate,
        credentialIntent:session.credentialIntent,
        temporarySecrets:session.temporarySecrets,
        oneTimeGrant:payload.oneTimeGrant ?? session.oneTimeCredentialGrant,
        editSessionId:session.editSessionId,
        draftGeneration:payload.draftGeneration,
        purpose:payload.purpose,
        caller:'main',
      });
      const result = await adapter.validate({
        draft:runtimeDraft,
        purpose:payload.purpose,
        resolvedSecrets:resolved.secrets,
        runtimeFacade:this.validationRuntime,
        signal:controller.signal,
        editSessionId:session.editSessionId,
        operationId,
        draftGeneration:payload.draftGeneration,
        configDigest,
        requestId:record.requestId,
      });
      const currentSession = this.sessions.get(session.editSessionId);
      const current = currentSession?.validationsByPurpose?.[payload.purpose];
      if (!currentSession || current?.operationId !== operationId
        || current.state !== 'running'
        || currentSession.draftGeneration !== payload.draftGeneration
        || current.configDigest !== configDigest) {
        const code = current?.state === 'cancelled' ? 'PLUGIN_VALIDATION_CANCELLED' : 'PLUGIN_VALIDATION_STALE';
        throw new AppError(code,code === 'PLUGIN_VALIDATION_CANCELLED' ? '验证已取消。' : '验证结果已经过期。');
      }
      current.state = 'valid';
      current.completedAt = new Date(this.now()).toISOString();
      emitValidationProgress(current,payload.purpose,'valid');
      return {
        editSessionId:session.editSessionId,
        requestId:record.requestId,
        operationId,
        purpose:payload.purpose,
        draftGeneration:payload.draftGeneration,
        configDigest,
        state:'valid',
        result,
      };
    } catch (error) {
      const current = this.sessions.get(session.editSessionId)?.validationsByPurpose?.[payload.purpose];
      const publicError = toPublicError(error);
      if (publicError.details?.fingerprint
        && current?.operationId === operationId && current.state === 'running'
        && !controller.signal.aborted && session.draftGeneration === payload.draftGeneration) {
        session.temporaryHostKey = {
          fingerprint:publicError.details.fingerprint,
          host:candidate.target?.host ?? null,
          port:candidate.target?.port ?? null,
          configDigest,
          draftGeneration:payload.draftGeneration,
        };
      }
      if (current?.operationId === operationId && current.state === 'running') {
        current.state = controller.signal.aborted ? 'cancelled' : 'failed';
        current.completedAt = new Date(this.now()).toISOString();
        current.error = toPublicError(error);
        emitValidationProgress(current,payload.purpose,current.state,current.error);
      }
      if (controller.signal.aborted && !(error instanceof AppError && ['PLUGIN_VALIDATION_CANCELLED','PLUGIN_VALIDATION_STALE'].includes(error.code))) {
        throw new AppError(current?.state === 'stale' ? 'PLUGIN_VALIDATION_STALE' : 'PLUGIN_VALIDATION_CANCELLED','验证已取消。');
      }
      throw new AppError(publicError.code,publicError.message,{
        ...(publicError.details ?? {}),
        editSessionId:session.editSessionId,
        operationId,
        purpose:payload.purpose,
        draftGeneration:payload.draftGeneration,
        configDigest,
      });
    } finally {
      await Promise.resolve(this.validationRuntime.cleanup?.(runtimeDraft,'validation-complete',operationId)).catch(() => undefined);
    }
  }

  cancelPluginValidation({editSessionId,operationId,ownerId} = {}) {
    const session = this.requireSession(editSessionId,{phases:['editing','saving'],ownerId});
    const match = Object.values(session.validationsByPurpose)
      .find((validation) => validation.operationId === operationId);
    if (!match || match.state !== 'running') {
      throw new AppError('PLUGIN_VALIDATION_STALE','验证操作已经结束或不属于当前编辑会话。');
    }
    match.state = 'cancelled';
    match.completedAt = new Date(this.now()).toISOString();
    match.controller.abort(new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。'));
    const purpose = Object.entries(session.validationsByPurpose)
      .find(([,validation]) => validation === match)?.[0] ?? 'health-check';
    emitValidationProgress(match,purpose,'cancelled');
    void Promise.resolve(this.validationRuntime.cleanup?.(match.runtimeDraft,'validation-cancelled',operationId)).catch(() => undefined);
    return publicValidation(match);
  }

  cancelRunningValidations(session,reason = 'validation-session-ending') {
    for (const validation of Object.values(session.validationsByPurpose)) {
      if (validation.state !== 'running') continue;
      validation.state = 'cancelled';
      validation.completedAt = new Date(this.now()).toISOString();
      validation.controller.abort(new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。'));
      void Promise.resolve(this.validationRuntime.cleanup?.(validation.runtimeDraft,reason,validation.operationId)).catch(() => undefined);
    }
  }

  beginSave(editSessionId,{ownerId} = {}) {
    const session = this.requireSession(editSessionId,{phases:['editing'],ownerId});
    this.cancelRunningValidations(session,'validation-save');
    session.phase = 'saving';
    return this.sessionSummary(editSessionId);
  }

  saveFailed(editSessionId) {
    const session = this.requireSession(editSessionId,{phases:['saving']});
    session.phase = 'editing';
    session.expiresAtMs = this.now() + this.sessionTtlMs;
    return this.sessionSummary(editSessionId);
  }

  commitMaterial(editSessionId,{ownerId = undefined} = {}) {
    const session = this.requireSession(editSessionId,{phases:['saving'],ownerId});
    return {
      scope:structuredClone(session.scope),
      baseRecordRevision:session.baseRecordRevision,
      credentialIntent:session.credentialIntent,
      temporarySecrets:{...session.temporarySecrets},
    };
  }

  async finishSession(session,{connectIds = [],source}) {
    this.cancelRunningValidations(session,'validation-session-ending');
    this.credentialUseResolver.revokeSession?.(session.editSessionId);
    if (!connectIds.length) {
      this.mutationCoordinator.releaseEnvironmentFence(session.editSessionId);
      this.sessions.delete(session.editSessionId);
      this.clearSensitiveSessionState(session);
      return null;
    }
    const planId = crypto.randomUUID();
    this.mutationCoordinator.handoffEnvironmentEditFence(session.editSessionId,planId);
    this.sessions.delete(session.editSessionId);
    this.clearSensitiveSessionState(session);
    try {
      return await this.connectionManager.requestConnectionIntent({
        requestId:crypto.randomUUID(),
        planId,
        projectId:session.scope.projectId,
        environmentId:session.scope.environmentId,
        pluginInstanceIds:[...connectIds],
        intent:'connect',
        source,
        fenceOwnerId:planId,
        onPlanStarted:() => this.mutationCoordinator.releaseEnvironmentFence(planId),
      });
    } catch (error) {
      this.mutationCoordinator.releaseEnvironmentFence(planId);
      throw error;
    }
  }

  async cancelPluginConnectionEdit({editSessionId,restorePreEditConnections = true,ownerId} = {}) {
    const session = this.requireSession(editSessionId,{phases:['editing'],ownerId});
    session.phase = 'restoring';
    const connectionPlan = await this.finishSession(session,{
      connectIds:restorePreEditConnections ? session.preEditConnectedSet : [],
      source:'edit-cancel-restore',
    });
    return {cancelled:true,connectionPlan};
  }

  async completeSave(editSessionId,{afterCommit = 'stay-disconnected',ownerId} = {}) {
    const session = this.requireSession(editSessionId,{phases:['saving'],ownerId});
    const connectIds = afterCommit === 'restore-pre-edit-set'
      ? session.preEditConnectedSet
      : afterCommit === 'connect-current' ? [session.scope.pluginInstanceId] : [];
    session.phase = connectIds.length ? 'restoring' : 'completed';
    return this.finishSession(session,{connectIds,source:'edit-save-restore'});
  }

  clearSensitiveSessionState(session) {
    for (const key of Object.keys(session.temporarySecrets)) session.temporarySecrets[key] = '';
    session.temporarySecrets = {};
    session.oneTimeCredentialGrant = null;
    session.temporaryHostKey = null;
  }

  invalidateSession(editSessionId,{allowSaving = false} = {}) {
    const session = this.sessions.get(String(editSessionId ?? ''));
    if (!session) return false;
    if (session.phase === 'saving' && !allowSaving) return false;
    this.cancelRunningValidations(session);
    this.credentialUseResolver.revokeSession?.(session.editSessionId);
    this.mutationCoordinator.releaseEnvironmentFence(session.editSessionId);
    this.sessions.delete(session.editSessionId);
    this.clearSensitiveSessionState(session);
    return true;
  }

  invalidateEnvironment(projectId,environmentId) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.scope.projectId === projectId && session.scope.environmentId === environmentId
        && this.invalidateSession(session.editSessionId)) count += 1;
    }
    return count;
  }

  invalidatePlugin(projectId,environmentId,pluginInstanceId) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.scope.projectId === projectId
        && session.scope.environmentId === environmentId
        && session.scope.pluginInstanceId === pluginInstanceId
        && this.invalidateSession(session.editSessionId)) count += 1;
    }
    return count;
  }

  invalidateProject(projectId) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.scope.projectId === projectId && this.invalidateSession(session.editSessionId)) count += 1;
    }
    return count;
  }

  invalidateOwner(ownerId) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === String(ownerId ?? '') && this.invalidateSession(session.editSessionId)) count += 1;
    }
    for (const [token,preparation] of this.preparations) {
      if (preparation.ownerId !== String(ownerId ?? '')) continue;
      preparation.controller.abort();
      this.preparations.delete(token);
      count += 1;
    }
    return count;
  }

  invalidateAll({allowSaving = false} = {}) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (this.invalidateSession(session.editSessionId,{allowSaving})) count += 1;
    }
    for (const [token,preparation] of this.preparations) {
      preparation.controller.abort();
      this.preparations.delete(token);
      count += 1;
    }
    return count;
  }

  pruneExpired() {
    const timestamp = this.now();
    for (const [token,preparation] of this.preparations) {
      if (preparation.expiresAtMs > timestamp) continue;
      preparation.controller.abort();
      this.preparations.delete(token);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAtMs <= timestamp) this.invalidateSession(session.editSessionId);
    }
  }
}
