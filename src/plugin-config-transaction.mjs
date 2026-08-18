import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';
import { pluginCredentialInternals } from './plugin-credential-vault.mjs';
import { workspaceInternals } from './workspace-store.mjs';

function transactionName(plugin) {
  return `${crypto.createHash('sha256').update(`${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`).digest('hex')}.json`;
}

function scopeKey(projectId, environmentId, pluginInstanceId) {
  return `${projectId}/${environmentId}/${pluginInstanceId}`;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported consistently on Windows. The journal
    // file itself is always fsynced; this is an additional best-effort barrier.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class PluginConfigTransactionJournal {
  constructor(dataRoot, workspaceStore, credentialVault) {
    this.directory = path.join(dataRoot, 'runtime', 'plugin-config-transactions');
    this.workspaceStore = workspaceStore;
    this.credentialVault = credentialVault;
    this.blockedScopes = new Map();
    this.blockAll = false;
    this.additionalGuards = [];
  }

  addGuard(guard) {
    if (guard && !this.additionalGuards.includes(guard)) this.additionalGuards.push(guard);
    return this;
  }

  fileFor(plugin) {
    return path.join(this.directory, transactionName(plugin));
  }

  async atomicWrite(file, content) {
    await fs.mkdir(this.directory, {recursive:true});
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, {force:true}).catch(() => undefined);
      throw error;
    }
  }

  async prepare(before, after, {hasExplicitSecrets = false} = {}) {
    const file = this.fileFor(before);
    try {
      await fs.access(file);
      this.blockedScopes.set(scopeKey(before.projectId,before.environmentId,before.pluginInstanceId), {file});
      throw new AppError(
        'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
        '此插件上次配置与凭据事务尚未安全恢复，已阻止继续修改。',
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
    this.assertPluginAvailable(before.projectId,before.environmentId,before.pluginInstanceId);
    const safeBefore = workspaceInternals.sanitizePluginSnapshot(before);
    const safeAfter = workspaceInternals.sanitizePluginSnapshot(after);
    if (safeAfter.projectId !== safeBefore.projectId
      || safeAfter.environmentId !== safeBefore.environmentId
      || safeAfter.pluginInstanceId !== safeBefore.pluginInstanceId
      || safeAfter.revision !== safeBefore.revision + 1) {
      throw new AppError('INVALID_ARGUMENT', '配置事务快照无效。');
    }
    const beforeHadCredential = await this.credentialVault.hasStoredEntry(safeBefore);
    const record = {
      schemaVersion:1,
      transactionId:crypto.randomUUID(),
      projectId:safeBefore.projectId,
      environmentId:safeBefore.environmentId,
      pluginInstanceId:safeBefore.pluginInstanceId,
      previousRevision:safeBefore.revision,
      attemptedRevision:safeBefore.revision + 1,
      beforeBindingHash:pluginCredentialInternals.bindingHash(safeBefore),
      afterBindingHash:pluginCredentialInternals.bindingHash(safeAfter),
      beforeHadCredential,
      credentialWriteExpected:Boolean(hasExplicitSecrets || (beforeHadCredential
        && pluginCredentialInternals.bindingHash(safeBefore) !== pluginCredentialInternals.bindingHash(safeAfter))),
      before:safeBefore,
      after:safeAfter,
      createdAt:new Date().toISOString(),
    };
    await this.atomicWrite(file, JSON.stringify(record, null, 2));
    return {...record,file};
  }

  async complete(record) {
    const file = record?.file ?? this.fileFor(record.before);
    try { await fs.rm(file, {force:true}); }
    catch (error) {
      this.blockedScopes.set(scopeKey(record.projectId,record.environmentId,record.pluginInstanceId), {file,record,error});
      throw new AppError(
        'CONFIG_TRANSACTION_CLEANUP_PENDING',
        '配置和密码已安全保存，但提交记录暂时无法清理；将在重启后自动完成。',
        {causeCode:error?.code ?? 'IO_ERROR'},
      );
    }
    await syncDirectory(this.directory);
    this.blockedScopes.delete(scopeKey(record.projectId,record.environmentId,record.pluginInstanceId));
    return {completed:true};
  }

  validate(record) {
    try {
      const safeBefore = workspaceInternals.sanitizePluginSnapshot(record.before);
      const safeAfter = workspaceInternals.sanitizePluginSnapshot(record.after);
      return record?.schemaVersion === 1
        && /^[0-9a-f-]{36}$/iu.test(String(record.transactionId ?? ''))
        && record.before?.projectId === record.projectId
        && record.before?.environmentId === record.environmentId
        && record.before?.pluginInstanceId === record.pluginInstanceId
        && record.before?.revision === record.previousRevision
        && record.after?.projectId === record.projectId
        && record.after?.environmentId === record.environmentId
        && record.after?.pluginInstanceId === record.pluginInstanceId
        && record.after?.revision === record.attemptedRevision
        && isDeepStrictEqual(safeBefore,record.before)
        && isDeepStrictEqual(safeAfter,record.after)
        && /^[a-f0-9]{64}$/u.test(record.beforeBindingHash)
        && /^[a-f0-9]{64}$/u.test(record.afterBindingHash)
        && pluginCredentialInternals.bindingHash(safeBefore) === record.beforeBindingHash
        && pluginCredentialInternals.bindingHash(safeAfter) === record.afterBindingHash
        && typeof record.beforeHadCredential === 'boolean'
        && typeof record.credentialWriteExpected === 'boolean'
        && record.attemptedRevision === record.previousRevision + 1;
    } catch {
      return false;
    }
  }

  assertPluginAvailable(projectId, environmentId, pluginInstanceId) {
    const key = scopeKey(projectId,environmentId,pluginInstanceId);
    if (this.blockAll || this.blockedScopes.has(key)) {
      throw new AppError(
        'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
        '插件配置与凭据的上次提交状态无法安全确定，已隔离该资源以保留原始凭据。',
      );
    }
    for (const guard of this.additionalGuards) guard.assertPluginAvailable?.(projectId,environmentId,pluginInstanceId);
  }

  assertEnvironmentAvailable(projectId, environmentId) {
    if (this.blockAll || [...this.blockedScopes.keys()].some((key) => key.startsWith(`${projectId}/${environmentId}/`))) {
      throw new AppError(
        'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
        '环境中存在尚未安全恢复的配置与凭据事务，已阻止连接。',
      );
    }
    for (const guard of this.additionalGuards) guard.assertEnvironmentAvailable?.(projectId,environmentId);
  }

  hasUnresolved() {
    return this.blockAll || this.blockedScopes.size > 0
      || this.additionalGuards.some((guard) => guard.hasUnresolved?.());
  }

  async credentialRead(plugin) {
    try {
      const secrets = await this.credentialVault.load(plugin);
      return {state:secrets === null ? 'absent' : 'readable'};
    } catch (error) {
      return {state:'unreadable',error};
    }
  }

  async recoverAll() {
    this.blockedScopes.clear();
    this.blockAll = false;
    const entries = await fs.readdir(this.directory, {withFileTypes:true}).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      let record;
      try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) {
        this.blockAll = true;
        results.push({file,recovered:false,action:'invalid-journal',error});
        continue;
      }
      if (!this.validate(record) || entry.name !== transactionName(record.before)) {
        this.blockAll = true;
        results.push({file,recovered:false,action:'invalid-journal',error:new Error('invalid plugin transaction journal')});
        continue;
      }
      const key = scopeKey(record.projectId,record.environmentId,record.pluginInstanceId);
      try {
        const current = await this.workspaceStore.getPlugin(record.projectId, record.environmentId, record.pluginInstanceId);
        if (current.revision !== record.previousRevision && current.revision !== record.attemptedRevision) {
          this.blockedScopes.set(key,{file,record});
          results.push({file,recovered:false,action:'newer-or-unknown-config'});
          continue;
        }
        const currentBindingHash = pluginCredentialInternals.bindingHash(current);
        const expectedCurrentBinding = current.revision === record.previousRevision
          ? record.beforeBindingHash
          : record.afterBindingHash;
        if (currentBindingHash !== expectedCurrentBinding) {
          this.blockedScopes.set(key,{file,record});
          results.push({file,recovered:false,action:'same-revision-config-diverged'});
          continue;
        }

        const bindingUnchanged = record.beforeBindingHash === record.afterBindingHash;
        // With an unchanged binding either YAML snapshot is compatible with
        // both vault slots. Keep the durable YAML version rather than guessing
        // whether a non-secret metadata edit reached disk before the crash.
        if (bindingUnchanged) {
          await this.complete({...record,file});
          results.push({file,recovered:true,action:'same-binding-commit-preserved'});
          continue;
        }

        const afterCredential = await this.credentialRead(record.after);
        const beforeCredential = await this.credentialRead(record.before);
        if (afterCredential.state === 'readable') {
          if (current.revision === record.previousRevision) {
            await this.workspaceStore.commitPluginSnapshot(record.after, record.previousRevision);
          }
          await this.complete({...record,file});
          results.push({file,recovered:true,action:'committed-config-preserved'});
          continue;
        }
        if (!record.beforeHadCredential && afterCredential.state === 'absent' && !record.credentialWriteExpected) {
          // No credential existed before the transaction and none was durably
          // committed. Preserve the YAML version that survived the crash.
          await this.complete({...record,file});
          results.push({file,recovered:true,action:'credentialless-config-preserved'});
          continue;
        }
        if (!record.beforeHadCredential && record.credentialWriteExpected
          && afterCredential.state === 'absent' && beforeCredential.state === 'absent') {
          if (current.revision === record.attemptedRevision) {
            await this.workspaceStore.restorePluginSnapshot(record.before, record.attemptedRevision);
          }
          await this.complete({...record,file});
          results.push({file,recovered:true,action:'missing-new-credential-rolled-back'});
          continue;
        }
        if (beforeCredential.state === 'readable') {
          if (current.revision === record.attemptedRevision) {
            await this.workspaceStore.restorePluginSnapshot(record.before, record.attemptedRevision);
          }
          await this.complete({...record,file});
          results.push({file,recovered:true,action:'config-rolled-back'});
          continue;
        }

        // Ambiguous DPAPI/decrypt state is not evidence that either slot may
        // be discarded. Preserve YAML, ciphertext slots and journal verbatim.
        this.blockedScopes.set(key,{file,record,afterCredential,beforeCredential});
        results.push({file,recovered:false,action:'credential-state-unresolved'});
      } catch (error) {
        this.blockedScopes.set(key,{file,record,error});
        results.push({file,recovered:false,action:'recovery-failed',error});
      }
    }
    return results;
  }
}
