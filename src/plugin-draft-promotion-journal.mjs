import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';
import { workspaceInternals } from './workspace-store.mjs';

function transactionName(scope) {
  return `${crypto.createHash('sha256').update(`${scope.projectId}/${scope.environmentId}/${scope.draftId}`).digest('hex')}.json`;
}

function scopeKey(projectId,environmentId,pluginInstanceId = '') {
  return `${projectId}/${environmentId}/${pluginInstanceId}`;
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await fs.open(directory,'r');
    await handle.sync();
  } catch {
    // Directory fsync is not consistently available on Windows.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function samePlugin(left,right) {
  return Boolean(left && right && isDeepStrictEqual(
    workspaceInternals.sanitizePluginSnapshot(left),
    workspaceInternals.sanitizePluginSnapshot(right),
  ));
}

function containsForbiddenCredentialKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenCredentialKey);
  return Object.entries(value).some(([key,nested]) => (
    /(password|passphrase|secret|ciphertext|privatekeypem|clientkeypem|capem|clientcertpem)/iu.test(key)
      || containsForbiddenCredentialKey(nested)
  ));
}

export class PluginDraftPromotionJournal {
  constructor(dataRoot,workspaceStore,draftStore,draftCredentialVault,credentialVault) {
    this.directory = path.join(dataRoot,'runtime','plugin-draft-promotions');
    this.workspaceStore = workspaceStore;
    this.draftStore = draftStore;
    this.draftCredentialVault = draftCredentialVault;
    this.credentialVault = credentialVault;
    this.blockedScopes = new Map();
    this.blockAll = false;
  }

  fileFor(scope) {
    return path.join(this.directory,transactionName(scope));
  }

  async atomicWrite(file,content) {
    await fs.mkdir(this.directory,{recursive:true});
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary,'wx',0o600);
      await handle.writeFile(content,'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary,file);
      await syncDirectoryBestEffort(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary,{force:true}).catch(() => undefined);
      throw error;
    }
  }

  async prepare(draft,before,after,{credentialMode = 'preserve',beforeHadCredential = false} = {}) {
    const file = this.fileFor(draft);
    try {
      await fs.access(file);
      throw new AppError('DRAFT_PROMOTION_RECOVERY_REQUIRED','此草稿上次提升事务尚未恢复，已阻止重复提升。');
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!['preserve','copy-draft','rebind-active'].includes(credentialMode)) {
      throw new AppError('INVALID_ARGUMENT','草稿提升凭据模式无效。');
    }
    const safeBefore = before ? workspaceInternals.sanitizePluginSnapshot(before) : null;
    const safeAfter = workspaceInternals.sanitizePluginSnapshot(after);
    const record = {
      schemaVersion:1,
      transactionId:crypto.randomUUID(),
      projectId:draft.projectId,
      environmentId:draft.environmentId,
      draftId:draft.draftId,
      draftRevision:draft.revision,
      pluginInstanceId:safeAfter.pluginInstanceId,
      kind:safeBefore ? 'update' : 'create',
      credentialMode,
      beforeHadCredential:Boolean(beforeHadCredential),
      before:safeBefore,
      after:safeAfter,
      createdAt:new Date().toISOString(),
    };
    await this.atomicWrite(file,JSON.stringify(record,null,2));
    return {...record,file};
  }

  validate(record) {
    try {
      const safeAfter = workspaceInternals.sanitizePluginSnapshot(record.after);
      const safeBefore = record.before ? workspaceInternals.sanitizePluginSnapshot(record.before) : null;
      return record?.schemaVersion === 1
        && !containsForbiddenCredentialKey(record)
        && /^[0-9a-f-]{36}$/iu.test(String(record.transactionId ?? ''))
        && record.projectId === safeAfter.projectId
        && record.environmentId === safeAfter.environmentId
        && record.pluginInstanceId === safeAfter.pluginInstanceId
        && /^draft-[0-9a-f-]{36}$/iu.test(record.draftId)
        && Number.isInteger(record.draftRevision) && record.draftRevision >= 1
        && ['create','update'].includes(record.kind)
        && ['preserve','copy-draft','rebind-active'].includes(record.credentialMode)
        && typeof record.beforeHadCredential === 'boolean'
        && isDeepStrictEqual(record.after,safeAfter)
        && ((record.kind === 'create' && record.before === null && safeAfter.revision === 1)
          || (record.kind === 'update' && safeBefore && isDeepStrictEqual(record.before,safeBefore)
            && safeAfter.revision === safeBefore.revision + 1));
    } catch {
      return false;
    }
  }

  async complete(record) {
    const file = record.file ?? this.fileFor(record);
    await fs.rm(file,{force:true});
    await syncDirectoryBestEffort(this.directory);
    this.blockedScopes.delete(scopeKey(record.projectId,record.environmentId,record.pluginInstanceId));
    return {completed:true};
  }

  markUnresolved(record,action = 'promotion-interrupted') {
    this.blockedScopes.set(
      scopeKey(record.projectId,record.environmentId,record.pluginInstanceId),
      {record,file:record.file ?? this.fileFor(record),result:{recovered:false,action}},
    );
  }

  async currentPlugin(record) {
    try {
      return await this.workspaceStore.getPlugin(record.projectId,record.environmentId,record.pluginInstanceId);
    } catch (error) {
      if (error?.code === 'PLUGIN_NOT_FOUND') return null;
      throw error;
    }
  }

  async activeCredentialState(record) {
    if (record.credentialMode === 'preserve') return 'not-required';
    try {
      const secrets = await this.credentialVault.load(record.after);
      if (secrets && Object.keys(secrets).length) return 'readable';
      if (record.credentialMode === 'rebind-active' && !record.beforeHadCredential) return 'not-required';
      return 'absent';
    } catch (error) {
      if (['CREDENTIAL_BINDING_MISMATCH'].includes(error?.code)) return 'absent';
      return 'unreadable';
    }
  }

  async draftCopyRecoveryState(record) {
    let draft;
    try { draft = await this.draftStore.resume(record); }
    catch (error) {
      if (error?.code === 'PLUGIN_DRAFT_NOT_FOUND') return {state:'draft-missing'};
      return {state:'unreadable',error};
    }
    let desired;
    try { desired = await this.draftCredentialVault.loadActive(draft,draft.sanitizedDraft); }
    catch (error) { return {state:'unreadable',error}; }
    if (!desired || !Object.keys(desired).length) return {state:'unavailable'};
    let active;
    try { active = await this.credentialVault.load(record.after); }
    catch (error) {
      if (error?.code === 'CREDENTIAL_BINDING_MISMATCH') return {state:'needs-copy',draft};
      return {state:'unreadable',error};
    }
    const committed = Object.entries(desired).every(([key,value]) => active?.[key] === value);
    return {state:committed ? 'committed' : 'needs-copy',draft};
  }

  async commitCredential(record,draft = null) {
    if (record.credentialMode === 'preserve') return {saved:false,preserved:true};
    if (record.credentialMode === 'copy-draft') {
      const source = draft ?? await this.draftStore.resume(record);
      const secrets = await this.draftCredentialVault.loadActive(source,source.sanitizedDraft);
      if (!secrets || !Object.keys(secrets).length) {
        throw new AppError('DRAFT_CREDENTIAL_NOT_FOUND','草稿没有可提升的当前身份凭据。');
      }
      if (record.kind === 'create') await this.credentialVault.save(record.after,secrets);
      else await this.credentialVault.saveMerged(record.before,record.after,secrets);
    } else {
      if (record.kind !== 'update') throw new AppError('DRAFT_CREDENTIAL_REBIND_REQUIRED','新插件不能重新绑定正式凭据。');
      await this.credentialVault.saveMerged(record.before,record.after,{});
    }
    const state = await this.activeCredentialState(record);
    if (!['readable','not-required'].includes(state)) {
      throw new AppError('DRAFT_PROMOTION_CREDENTIAL_VERIFY_FAILED','草稿凭据复制后校验失败，事务记录已保留。',{state});
    }
    return {saved:true};
  }

  async deleteDraftIfPresent(record) {
    try { return await this.draftStore.delete(record); }
    catch (error) {
      if (error?.code === 'PLUGIN_DRAFT_NOT_FOUND') return {deleted:false,alreadyMissing:true,credentialsPreserved:true};
      throw error;
    }
  }

  async commitConfig(record,current) {
    if (samePlugin(current,record.after)) {
      if (record.kind === 'create') await this.workspaceStore.ensurePluginIndexed(record.after);
      return record.after;
    }
    if (record.kind === 'create') {
      if (current) throw new AppError('DRAFT_PROMOTION_CONFIG_DIVERGED','草稿目标插件标识已被其它配置占用。');
      return this.workspaceStore.commitNewPluginSnapshot(record.after);
    }
    if (!samePlugin(current,record.before)) {
      throw new AppError('DRAFT_PROMOTION_CONFIG_DIVERGED','正式插件在草稿提升期间发生了其它变化。');
    }
    return this.workspaceStore.commitPluginSnapshot(record.after,record.before.revision);
  }

  async recoverRecord(record,file) {
    let current = await this.currentPlugin(record);
    let credentialState = await this.activeCredentialState(record);
    if (samePlugin(current,record.after)) {
      if (record.kind === 'create') current = await this.commitConfig(record,current);
    } else {
      if (record.kind === 'create' && current) return {recovered:false,action:'config-diverged'};
      if (record.kind === 'update' && !samePlugin(current,record.before)) return {recovered:false,action:'config-diverged'};
      if (credentialState === 'unreadable') return {recovered:false,action:'credential-state-unresolved'};
      current = await this.commitConfig(record,current);
    }
    if (record.credentialMode === 'copy-draft') {
      const copyState = await this.draftCopyRecoveryState(record);
      if (copyState.state === 'needs-copy') {
        try { await this.commitCredential(record,copyState.draft); }
        catch (error) { return {recovered:false,action:'draft-credential-unavailable',error}; }
      } else if (copyState.state === 'draft-missing') {
        credentialState = await this.activeCredentialState(record);
        if (credentialState !== 'readable') {
          return {recovered:false,action:credentialState === 'unreadable' ? 'credential-state-unresolved' : 'draft-credential-unavailable'};
        }
      } else if (copyState.state !== 'committed') {
        return {
          recovered:false,
          action:copyState.state === 'unreadable' ? 'credential-state-unresolved' : 'draft-credential-unavailable',
          ...(copyState.error ? {error:copyState.error} : {}),
        };
      }
    } else {
      credentialState = await this.activeCredentialState(record);
      if (!['readable','not-required'].includes(credentialState)) {
        if (credentialState === 'unreadable') return {recovered:false,action:'credential-state-unresolved'};
        try { await this.commitCredential(record); }
        catch (error) {
          return {recovered:false,action:'draft-credential-unavailable',error};
        }
      }
    }
    await this.deleteDraftIfPresent(record);
    await this.complete({...record,file});
    return {recovered:true,action:'promotion-completed'};
  }

  async recoverAll() {
    this.blockedScopes.clear();
    this.blockAll = false;
    const entries = await fs.readdir(this.directory,{withFileTypes:true}).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      const file = path.join(this.directory,entry.name);
      let record;
      try { record = JSON.parse(await fs.readFile(file,'utf8')); }
      catch (error) {
        this.blockAll = true;
        results.push({file,recovered:false,action:'invalid-journal',error});
        continue;
      }
      if (!this.validate(record) || transactionName(record) !== entry.name) {
        this.blockAll = true;
        results.push({file,recovered:false,action:'invalid-journal'});
        continue;
      }
      let result;
      try { result = await this.recoverRecord(record,file); }
      catch (error) { result = {recovered:false,action:'recovery-failed',error}; }
      if (!result.recovered) {
        this.blockedScopes.set(scopeKey(record.projectId,record.environmentId,record.pluginInstanceId),{record,file,result});
      }
      results.push({file,...result});
    }
    return results;
  }

  hasUnresolved() {
    return this.blockAll || this.blockedScopes.size > 0;
  }

  assertPluginAvailable(projectId,environmentId,pluginInstanceId) {
    if (this.blockAll || this.blockedScopes.has(scopeKey(projectId,environmentId,pluginInstanceId))) {
      throw new AppError('DRAFT_PROMOTION_RECOVERY_REQUIRED','草稿提升状态尚未安全恢复，已隔离该插件以保留配置和凭据。');
    }
  }

  assertEnvironmentAvailable(projectId,environmentId) {
    if (this.blockAll || [...this.blockedScopes.keys()].some((key) => key.startsWith(`${projectId}/${environmentId}/`))) {
      throw new AppError('DRAFT_PROMOTION_RECOVERY_REQUIRED','环境中存在尚未安全恢复的草稿提升事务，已阻止连接。');
    }
  }
}
