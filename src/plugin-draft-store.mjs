import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { workspaceInternals } from './workspace-store.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const FORBIDDEN_KEY_RE = /(password|passphrase|secret|ciphertext|privatekeypem|clientkeypem|capem|clientcertpem)/iu;

function assertId(value,label) {
  const id = String(value ?? '');
  if (!ID_RE.test(id)) throw new AppError('INVALID_ARGUMENT',`${label}无效。`);
  return id;
}

function assertSecretFree(value,pathParts = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item,index) => assertSecretFree(item,[...pathParts,String(index)]));
    return;
  }
  for (const [key,nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) {
      throw new AppError('INVALID_ARGUMENT',`草稿配置不能包含凭据字段：${[...pathParts,key].join('.')}。`);
    }
    assertSecretFree(nested,[...pathParts,key]);
  }
}

function publicRecord(record,credentialState) {
  return {
    ...record,
    credentialState,
    validationState:'stale',
  };
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

export class PluginDraftStore {
  constructor(workspaceStore,draftCredentialVault) {
    this.workspaceStore = workspaceStore;
    this.draftCredentialVault = draftCredentialVault;
    this.queues = new Map();
  }

  directoryFor(scope) {
    return path.join(this.workspaceStore.environmentDir(
      assertId(scope.projectId,'项目标识'),
      assertId(scope.environmentId,'环境标识'),
    ),'plugin-drafts');
  }

  fileFor(scope) {
    return path.join(this.directoryFor(scope),`${assertId(scope.draftId,'草稿标识')}.json`);
  }

  enqueue(scope,operation) {
    const key = `${scope.projectId}/${scope.environmentId}/${scope.draftId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key,current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  async atomicWrite(file,content) {
    const directory = path.dirname(file);
    await fs.mkdir(directory,{recursive:true});
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary,'wx',0o600);
      await handle.writeFile(content,'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary,file);
      await syncDirectoryBestEffort(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary,{force:true}).catch(() => undefined);
      throw error;
    }
  }

  async read(scope) {
    let record;
    try { record = JSON.parse(await fs.readFile(this.fileFor(scope),'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new AppError('PLUGIN_DRAFT_NOT_FOUND','插件草稿不存在。');
      if (error instanceof SyntaxError) throw new AppError('PLUGIN_DRAFT_INVALID','插件草稿文件损坏。');
      throw error;
    }
    if (record?.schemaVersion !== 1
      || record.projectId !== scope.projectId
      || record.environmentId !== scope.environmentId
      || record.draftId !== scope.draftId
      || !Number.isInteger(record.revision)
      || record.revision < 1
      || !['server','mysql','redis'].includes(record.pluginType)
      || !record.sanitizedDraft
      || typeof record.sanitizedDraft !== 'object') {
      throw new AppError('PLUGIN_DRAFT_INVALID','插件草稿文件损坏。');
    }
    assertSecretFree(record);
    return record;
  }

  async normalize(payload,existingRecord = null) {
    const projectId = assertId(payload.projectId,'项目标识');
    const environmentId = assertId(payload.environmentId,'环境标识');
    await this.workspaceStore.getEnvironment(projectId,environmentId);
    const pluginType = payload.pluginType ?? existingRecord?.pluginType;
    if (!['server','mysql','redis'].includes(pluginType)) throw new AppError('INVALID_ARGUMENT','插件类型无效。');
    if (existingRecord && existingRecord.pluginType !== pluginType) throw new AppError('INVALID_ARGUMENT','不能修改草稿插件类型。');
    assertSecretFree(payload.sanitizedDraft);

    let basePlugin = null;
    const basePluginInstanceId = payload.basePluginInstanceId ?? existingRecord?.basePluginInstanceId ?? null;
    const baseRevision = payload.baseRevision ?? existingRecord?.baseRevision ?? null;
    if (basePluginInstanceId) {
      basePlugin = await this.workspaceStore.getPlugin(projectId,environmentId,basePluginInstanceId);
      if (basePlugin.pluginType !== pluginType) throw new AppError('INVALID_ARGUMENT','草稿类型与正式插件不匹配。');
      if (!Number.isInteger(baseRevision) || baseRevision < 1) throw new AppError('INVALID_ARGUMENT','草稿基础 revision 无效。');
      if (basePlugin.revision !== baseRevision) {
        throw new AppError('CONFIG_REVISION_CONFLICT','正式插件已经变化，请重新打开后再保存草稿。');
      }
    }

    const raw = {
      ...(payload.sanitizedDraft ?? {}),
      pluginType,
      ...(basePlugin ? {pluginInstanceId:basePlugin.pluginInstanceId} : {}),
      ...(!basePlugin && existingRecord?.sanitizedDraft?.pluginInstanceId
        ? {pluginInstanceId:existingRecord.sanitizedDraft.pluginInstanceId}
        : {}),
    };
    const assessment = getPluginConnectionAdapter(pluginType).assessConfiguration(
      raw,
      pluginType === 'mysql' ? 'resource-discovery' : 'connection',
    );
    if (assessment.state === 'invalid') {
      throw new AppError('PLUGIN_CONFIGURATION_INVALID','插件草稿包含无效字段。',{issues:assessment.issues});
    }
    let sanitizedDraft;
    try {
      sanitizedDraft = basePlugin
        ? workspaceInternals.normalizePluginCandidate(raw,{projectId,environmentId},basePlugin)
        : workspaceInternals.normalizePlugin(raw,{projectId,environmentId});
      if (!basePlugin && existingRecord?.sanitizedDraft) {
        sanitizedDraft = {
          ...sanitizedDraft,
          revision:existingRecord.sanitizedDraft.revision,
          updatedAt:existingRecord.sanitizedDraft.updatedAt,
        };
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError('PLUGIN_CONFIGURATION_INVALID',error.message,{causeCode:error.code});
      }
      throw error;
    }
    assertSecretFree(sanitizedDraft);
    return {projectId,environmentId,pluginType,basePluginInstanceId,baseRevision,sanitizedDraft};
  }

  async save(payload) {
    const draftId = payload.draftId ? assertId(payload.draftId,'草稿标识') : `draft-${crypto.randomUUID()}`;
    const scope = {
      projectId:assertId(payload.projectId,'项目标识'),
      environmentId:assertId(payload.environmentId,'环境标识'),
      draftId,
    };
    return this.enqueue(scope,async () => {
      let existing = null;
      try { existing = await this.read(scope); }
      catch (error) { if (error?.code !== 'PLUGIN_DRAFT_NOT_FOUND') throw error; }
      if (existing && payload.expectedDraftRevision !== existing.revision) {
        throw new AppError('PLUGIN_DRAFT_REVISION_CONFLICT','插件草稿已经变化，请重新打开后重试。');
      }
      if (!existing && payload.expectedDraftRevision !== undefined && payload.expectedDraftRevision !== null) {
        throw new AppError('PLUGIN_DRAFT_REVISION_CONFLICT','插件草稿已经不存在或已经变化。');
      }
      const normalized = await this.normalize(payload,existing);
      const normalizedTemporarySecrets = this.draftCredentialVault.normalizeSecrets(
        normalized.pluginType,payload.temporarySecrets ?? {},
      );
      let intent = payload.credentialIntent ?? 'unchanged';
      if (!['unchanged','replace','rebind-existing'].includes(intent)) {
        throw new AppError('INVALID_ARGUMENT','草稿凭据意图无效。');
      }
      if (intent === 'replace' && !Object.keys(normalizedTemporarySecrets).length) intent = 'unchanged';
      if (intent === 'rebind-existing' && !normalized.basePluginInstanceId) {
        throw new AppError('DRAFT_CREDENTIAL_REBIND_REQUIRED','新插件草稿没有可重新绑定的正式凭据，请输入新密码。');
      }
      const configUnchanged = existing
        && existing.pluginType === normalized.pluginType
        && existing.basePluginInstanceId === (normalized.basePluginInstanceId ?? undefined)
        && existing.baseRevision === (normalized.baseRevision ?? undefined)
        && isDeepStrictEqual(existing.sanitizedDraft,normalized.sanitizedDraft);
      const credentialUnchanged = !Object.keys(normalizedTemporarySecrets).length
        && (intent === 'unchanged' || intent === existing?.credentialIntent);
      if (configUnchanged && credentialUnchanged) {
        return publicRecord(existing,existing.credentialState ?? 'absent');
      }
      const now = new Date().toISOString();
      const record = {
        schemaVersion:1,
        draftId,
        projectId:scope.projectId,
        environmentId:scope.environmentId,
        pluginType:normalized.pluginType,
        ...(normalized.basePluginInstanceId ? {basePluginInstanceId:normalized.basePluginInstanceId,baseRevision:normalized.baseRevision} : {}),
        revision:(existing?.revision ?? 0) + 1,
        sanitizedDraft:normalized.sanitizedDraft,
        createdAt:existing?.createdAt ?? now,
        updatedAt:now,
      };
      let credentialState;
      if (intent === 'replace') {
        const result = await this.draftCredentialVault.saveCandidate(record,record.sanitizedDraft,normalizedTemporarySecrets);
        credentialState = result.state;
      } else {
        if (Object.keys(normalizedTemporarySecrets).length) throw new AppError('INVALID_ARGUMENT','未选择更换密码时不能提交新草稿凭据。');
        credentialState = await this.draftCredentialVault.state(record,record.sanitizedDraft);
      }
      record.credentialIntent = intent;
      record.credentialState = credentialState;
      await this.atomicWrite(this.fileFor(record),JSON.stringify(record,null,2));
      return publicRecord(record,credentialState);
    });
  }

  async resume(scope) {
    const record = await this.read({
      projectId:assertId(scope.projectId,'项目标识'),
      environmentId:assertId(scope.environmentId,'环境标识'),
      draftId:assertId(scope.draftId,'草稿标识'),
    });
    await this.workspaceStore.getEnvironment(record.projectId,record.environmentId);
    const credentialState = await this.draftCredentialVault.state(record,record.sanitizedDraft);
    return publicRecord(record,credentialState);
  }

  async delete(scope) {
    const normalized = {
      projectId:assertId(scope.projectId,'项目标识'),
      environmentId:assertId(scope.environmentId,'环境标识'),
      draftId:assertId(scope.draftId,'草稿标识'),
    };
    return this.enqueue(normalized,async () => {
      const record = await this.read(normalized);
      await fs.rm(this.fileFor(record));
      await syncDirectoryBestEffort(this.directoryFor(record));
      return {deleted:true,...normalized,credentialsPreserved:true};
    });
  }

  async list(projectId,environmentId) {
    const scope = {projectId:assertId(projectId,'项目标识'),environmentId:assertId(environmentId,'环境标识')};
    await this.workspaceStore.getEnvironment(scope.projectId,scope.environmentId);
    const directory = this.directoryFor(scope);
    const entries = await fs.readdir(directory,{withFileTypes:true}).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const drafts = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^draft-[a-f0-9-]{36}\.json$/iu.test(entry.name)) continue;
      const draftId = entry.name.slice(0,-5);
      drafts.push(await this.resume({...scope,draftId}));
    }
    return drafts.sort((left,right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async count(projectId,environmentId) {
    const scope = {projectId:assertId(projectId,'项目标识'),environmentId:assertId(environmentId,'环境标识')};
    await this.workspaceStore.getEnvironment(scope.projectId,scope.environmentId);
    const entries = await fs.readdir(this.directoryFor(scope),{withFileTypes:true}).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    return entries.filter((entry) => entry.isFile() && /^draft-[a-f0-9-]{36}\.json$/iu.test(entry.name)).length;
  }
}
