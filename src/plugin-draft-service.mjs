import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, toPublicError } from './errors.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import { workspaceInternals } from './workspace-store.mjs';

function identityChanged(before,after) {
  const adapter = getPluginConnectionAdapter(after.pluginType);
  return !isDeepStrictEqual(adapter.credentialIdentity(before),adapter.credentialIdentity(after));
}

export class PluginDraftService {
  constructor({
    workspaceStore,draftStore,draftCredentialVault,credentialVault,promotionJournal,
    validationRuntime = null,failureInjector = null,now = Date.now,sessionTtlMs = 30 * 60_000,
  }) {
    this.workspaceStore = workspaceStore;
    this.draftStore = draftStore;
    this.draftCredentialVault = draftCredentialVault;
    this.credentialVault = credentialVault;
    this.promotionJournal = promotionJournal;
    this.failureInjector = failureInjector;
    this.validationRuntime = validationRuntime;
    this.now = now;
    this.sessionTtlMs = Math.max(10_000,Number(sessionTtlMs) || 30 * 60_000);
    this.sessions = new Map();
    this.validations = new Map();
  }

  save(payload) {
    return this.draftStore.save(payload);
  }

  resume(payload) {
    return this.draftStore.resume(payload);
  }

  async resumeForOwner(payload,ownerId) {
    const draft = await this.resume(payload);
    const draftSessionId = crypto.randomUUID();
    this.sessions.set(draftSessionId,{
      draftSessionId,
      ownerId:String(ownerId ?? ''),
      projectId:draft.projectId,
      environmentId:draft.environmentId,
      draftId:draft.draftId,
      draftRevision:draft.revision,
      generation:0,
      sequence:0,
      expiresAtMs:this.now() + this.sessionTtlMs,
    });
    return {...draft,draftSessionId,draftGeneration:0,sequence:0,expiresAt:new Date(this.now() + this.sessionTtlMs).toISOString()};
  }

  requireSession(draftSessionId,ownerId,scope = null) {
    const session = this.sessions.get(String(draftSessionId ?? ''));
    if (!session || session.expiresAtMs <= this.now() || session.ownerId !== String(ownerId ?? '')) {
      if (session?.expiresAtMs <= this.now()) this.endSession(session.draftSessionId);
      throw new AppError('PLUGIN_DRAFT_SESSION_STALE','草稿编辑会话已失效或不属于当前窗口。');
    }
    if (scope && ['projectId','environmentId','draftId'].some((key) => scope[key] && scope[key] !== session[key])) {
      throw new AppError('PLUGIN_DRAFT_SESSION_STALE','草稿编辑会话与当前草稿不匹配。');
    }
    session.expiresAtMs = this.now() + this.sessionTtlMs;
    return session;
  }

  endSession(draftSessionId,ownerId = undefined) {
    const session = this.sessions.get(String(draftSessionId ?? ''));
    if (!session || (ownerId !== undefined && session.ownerId !== String(ownerId ?? ''))) return false;
    for (const [key,validation] of this.validations.entries()) {
      if (validation.draftSessionId !== session.draftSessionId) continue;
      if (validation.state === 'running') {
        validation.state = 'cancelled';
        validation.controller.abort(new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。'));
      }
      this.validations.delete(key);
    }
    this.sessions.delete(session.draftSessionId);
    return true;
  }

  invalidateOwner(ownerId) {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === String(ownerId ?? '') && this.endSession(session.draftSessionId,ownerId)) count += 1;
    }
    return count;
  }

  delete(payload) {
    return this.draftStore.delete(payload);
  }

  list(projectId,environmentId) {
    return this.draftStore.list(projectId,environmentId);
  }

  async failAt(point) {
    await this.failureInjector?.(point);
  }

  async validate(payload,{ownerId,onProgress} = {}) {
    if (!this.validationRuntime) throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE','插件草稿验证服务不可用。');
    const session = this.requireSession(payload.draftSessionId,ownerId,payload);
    if (!Number.isInteger(payload.draftGeneration) || payload.draftGeneration < session.generation
      || !Number.isInteger(payload.sequence) || payload.sequence <= session.sequence) {
      throw new AppError('PLUGIN_VALIDATION_STALE','草稿验证请求的 generation 或 sequence 已过期。');
    }
    if (payload.draftGeneration > session.generation) session.generation = payload.draftGeneration;
    session.sequence = payload.sequence;
    const saved = await this.resume(session);
    if (saved.revision !== session.draftRevision) {
      throw new AppError('PLUGIN_DRAFT_SESSION_STALE','草稿已在其它窗口变化，请重新打开。');
    }
    const normalized = await this.draftStore.normalize({
      ...saved,
      sanitizedDraft:payload.draft,
      pluginType:saved.pluginType,
    },saved);
    const candidate = normalized.sanitizedDraft;
    const adapter = getPluginConnectionAdapter(candidate.pluginType);
    const configuration = adapter.assessConfiguration(candidate,payload.purpose);
    if (configuration.state !== 'complete') {
      const code = configuration.state === 'invalid' ? 'PLUGIN_CONFIGURATION_INVALID' : 'PLUGIN_CONFIGURATION_INCOMPLETE';
      throw new AppError(code,configuration.issues[0]?.message ?? '插件草稿配置不完整。',{issues:configuration.issues});
    }
    const temporarySecrets = this.draftCredentialVault.normalizeSecrets(
      candidate.pluginType,payload.temporarySecrets ?? {},
    );
    let resolvedSecrets;
    if (Object.keys(temporarySecrets).length) resolvedSecrets = temporarySecrets;
    else resolvedSecrets = await this.draftCredentialVault.loadActive(saved,candidate) ?? {};
    const configDigest = adapter.validationDigest(candidate,payload.purpose);
    const key = `${saved.projectId}/${saved.environmentId}/${saved.draftId}/${payload.purpose}`;
    const previous = this.validations.get(key);
    if (previous?.state === 'running') {
      previous.state = 'stale';
      previous.controller.abort(new AppError('PLUGIN_VALIDATION_STALE','新的验证请求已取代旧请求。'));
    }
    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    const runtimeDraft = {...candidate,pluginInstanceId:`diagnostic-edit-${operationId}`};
    const record = {
      key,state:'running',draftSessionId:session.draftSessionId,requestId:String(payload.requestId ?? ''),
      operationId,draftGeneration:payload.draftGeneration,sequence:payload.sequence,configDigest,
      purpose:payload.purpose,controller,runtimeDraft,
    };
    this.validations.set(key,record);
    const progress = (state,error = null) => onProgress?.({
      draftSessionId:record.draftSessionId,requestId:record.requestId,operationId,
      purpose:record.purpose,draftGeneration:record.draftGeneration,sequence:record.sequence,
      configDigest,state,...(error ? {error} : {}),
    });
    progress('running');
    try {
      const result = await adapter.validate({
        draft:runtimeDraft,purpose:payload.purpose,resolvedSecrets,
        runtimeFacade:this.validationRuntime,signal:controller.signal,
        editSessionId:session.draftSessionId,operationId,
        draftGeneration:payload.draftGeneration,configDigest,requestId:record.requestId,
      });
      const current = this.validations.get(key);
      const currentSession = this.sessions.get(session.draftSessionId);
      const sessionExpired = !currentSession || currentSession.expiresAtMs <= this.now();
      if (sessionExpired && currentSession) this.endSession(currentSession.draftSessionId);
      if (current !== record || record.state !== 'running' || sessionExpired || currentSession?.generation !== payload.draftGeneration
        || currentSession?.sequence !== payload.sequence) {
        throw new AppError('PLUGIN_VALIDATION_STALE','草稿验证结果已经过期。');
      }
      const latest = await this.resume(session);
      if (latest.revision !== saved.revision) throw new AppError('PLUGIN_VALIDATION_STALE','草稿已变化，验证结果已作废。');
      record.state = 'valid';
      progress('valid');
      return {
        draftSessionId:session.draftSessionId,requestId:record.requestId,operationId,
        purpose:payload.purpose,draftGeneration:payload.draftGeneration,sequence:payload.sequence,
        configDigest,state:'valid',result,
      };
    } catch (error) {
      const publicError = toPublicError(error);
      if (this.validations.get(key) === record && record.state === 'running') {
        record.state = controller.signal.aborted ? 'cancelled' : 'failed';
        progress(record.state,publicError);
      }
      if (controller.signal.aborted && !['PLUGIN_VALIDATION_CANCELLED','PLUGIN_VALIDATION_STALE'].includes(publicError.code)) {
        throw new AppError(record.state === 'stale' ? 'PLUGIN_VALIDATION_STALE' : 'PLUGIN_VALIDATION_CANCELLED','验证已取消。');
      }
      throw new AppError(publicError.code,publicError.message,{
        ...(publicError.details ?? {}),draftSessionId:session.draftSessionId,
        operationId,draftGeneration:payload.draftGeneration,sequence:payload.sequence,configDigest,
      });
    } finally {
      await Promise.resolve(this.validationRuntime.cleanup?.(runtimeDraft,'validation-complete',operationId)).catch(() => undefined);
      if (this.validations.get(key) === record) this.validations.delete(key);
    }
  }

  cancelValidation(payload,{ownerId} = {}) {
    const session = this.requireSession(payload.draftSessionId,ownerId,payload);
    const record = [...this.validations.values()].find((item) => (
      item.draftSessionId === session.draftSessionId && item.operationId === payload.operationId
    ));
    if (!record || record.state !== 'running') throw new AppError('PLUGIN_VALIDATION_STALE','验证操作已经结束。');
    record.state = 'cancelled';
    record.controller.abort(new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。'));
    return {draftSessionId:session.draftSessionId,operationId:record.operationId,state:'cancelled'};
  }

  async promotionPlan(draft,payload) {
    const assessment = getPluginConnectionAdapter(draft.pluginType)
      .assessConfiguration(draft.sanitizedDraft,'connection');
    if (assessment.state === 'invalid') {
      throw new AppError('PLUGIN_CONFIGURATION_INVALID','插件草稿包含无效配置。',{issues:assessment.issues});
    }
    if (assessment.state !== 'complete' || draft.sanitizedDraft.configState !== 'ready') {
      throw new AppError('PLUGIN_CONFIGURATION_INCOMPLETE','请先补全草稿配置后再提升。',{issues:assessment.issues});
    }
    let before = null;
    let after;
    if (draft.basePluginInstanceId) {
      before = await this.workspaceStore.getPlugin(draft.projectId,draft.environmentId,draft.basePluginInstanceId);
      const expectedBaseRevision = payload.expectedBaseRevision ?? draft.baseRevision;
      if (before.revision !== draft.baseRevision || before.revision !== expectedBaseRevision) {
        throw new AppError('CONFIG_REVISION_CONFLICT','正式插件已在草稿保存后变化，本次提升没有覆盖新配置。');
      }
      after = workspaceInternals.materializePluginCandidate(draft.sanitizedDraft,before);
    } else {
      after = workspaceInternals.sanitizePluginSnapshot(draft.sanitizedDraft);
      if (after.revision !== 1) throw new AppError('PLUGIN_DRAFT_INVALID','新插件草稿 revision 无效。');
      try {
        await this.workspaceStore.getPlugin(after.projectId,after.environmentId,after.pluginInstanceId);
        throw new AppError('PLUGIN_ALREADY_EXISTS','草稿插件标识已经存在。');
      } catch (error) {
        if (error?.code !== 'PLUGIN_NOT_FOUND') throw error;
      }
      if (await this.credentialVault.hasStoredEntry(after)) {
        throw new AppError(
          'PLUGIN_CREDENTIAL_RESOURCE_CONFLICT',
          '此插件标识仍保留有历史加密凭据。为避免覆盖旧密码，请修改草稿名称后再保存为正式配置。',
        );
      }
    }

    const draftCredentialState = await this.draftCredentialVault.state(draft,draft.sanitizedDraft);
    let credentialMode = 'preserve';
    let beforeHadCredential = false;
    if (draftCredentialState === 'stored-active') {
      credentialMode = 'copy-draft';
    } else if (draftCredentialState === 'unreadable') {
      throw new AppError('DRAFT_CREDENTIAL_UNREADABLE','草稿凭据当前不可读，已保留密文且没有提升。');
    } else if (before) {
      const productIdentityChanged = identityChanged(before,after);
      const storageBindingChanged = pluginCredentialInternals.bindingHash(before)
        !== pluginCredentialInternals.bindingHash(after);
      if (productIdentityChanged) {
        if (draft.credentialIntent !== 'rebind-existing') {
          throw new AppError('PLUGIN_CREDENTIAL_REBIND_REQUIRED','登录身份或安全路径已变化，请重新输入密码或明确重新绑定。');
        }
        credentialMode = 'rebind-active';
      } else if (storageBindingChanged) {
        // The v1 active vault binding includes MySQL database / Redis DB even
        // though product credential identity intentionally excludes them.
        credentialMode = 'rebind-active';
      }
    } else if (draftCredentialState === 'stored-inactive') {
      throw new AppError('DRAFT_CREDENTIAL_INACTIVE','保存的草稿凭据属于另一身份，不能用于当前目标。');
    }
    if (credentialMode === 'rebind-active') {
      beforeHadCredential = await this.credentialVault.hasStoredEntry(before);
      if (beforeHadCredential) await this.credentialVault.load(before);
    }
    return {before,after,credentialMode,beforeHadCredential};
  }

  async promote(payload) {
    const draft = await this.draftStore.resume(payload);
    if (payload.expectedDraftRevision !== undefined && payload.expectedDraftRevision !== null
      && draft.revision !== payload.expectedDraftRevision) {
      throw new AppError('PLUGIN_DRAFT_REVISION_CONFLICT','插件草稿已经变化，请重新打开后重试。');
    }
    const plan = await this.promotionPlan(draft,payload);
    const transaction = await this.promotionJournal.prepare(draft,plan.before,plan.after,plan);
    try {
      const plugin = await this.promotionJournal.commitConfig(transaction,plan.before);
      await this.failAt('after-config-write');
      await this.promotionJournal.commitCredential(transaction,draft);
      await this.failAt('after-vault-commit');
      await this.promotionJournal.deleteDraftIfPresent(transaction);
      await this.failAt('after-draft-cleanup');
      await this.promotionJournal.complete(transaction);
      return {...plugin,promotedDraftId:draft.draftId,afterCommit:payload.afterCommit ?? 'stay-disconnected'};
    } catch (error) {
      this.promotionJournal.markUnresolved?.(transaction);
      throw error;
    }
  }
}
