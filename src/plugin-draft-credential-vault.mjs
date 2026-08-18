import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';

const SECRET_KEYS = Object.freeze({
  server:new Set(['password','privateKeyPassphrase','proxyPassword']),
  mysql:new Set(['password','tlsPassphrase','caPem','clientCertPem','clientKeyPem']),
  redis:new Set(['password','tlsPassphrase','caPem','clientCertPem','clientKeyPem']),
});

function emptyEnvelope() {
  return {schemaVersion:1,entries:{}};
}

function cloneEnvelope(envelope) {
  return {...envelope,entries:{...(envelope?.entries ?? {})}};
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key,canonicalize(value[key])]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function maybeAwait(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value);
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

export class PluginDraftCredentialVault {
  constructor(dataRoot,encryption) {
    this.file = path.join(dataRoot,'credentials','plugin-drafts.enc.json');
    this.backupFile = path.join(dataRoot,'credentials','plugin-drafts.enc.backup.json');
    this.encryption = encryption;
    this.queue = Promise.resolve();
  }

  resourceKey(scope) {
    return `${scope.projectId}/${scope.environmentId}/${scope.draftId}`;
  }

  credentialIdentity(draft) {
    return getPluginConnectionAdapter(draft.pluginType).credentialIdentity(draft);
  }

  identityHash(draft) {
    return sha256(this.credentialIdentity(draft));
  }

  identityComplete(draft) {
    const adapter = getPluginConnectionAdapter(draft.pluginType);
    const purpose = draft.pluginType === 'mysql' ? 'resource-discovery' : 'connection';
    return adapter.assessConfiguration(draft,purpose).state === 'complete';
  }

  normalizeSecrets(pluginType,secrets) {
    const allowed = SECRET_KEYS[pluginType];
    if (!allowed) throw new AppError('INVALID_ARGUMENT','插件类型不支持草稿凭据。');
    const output = {};
    for (const [key,raw] of Object.entries(secrets ?? {})) {
      if (!allowed.has(key)) throw new AppError('INVALID_ARGUMENT',`不支持的草稿凭据字段：${key}。`);
      const value = String(raw ?? '');
      if (!value) continue;
      if (Buffer.byteLength(value,'utf8') > 1024 * 1024) throw new AppError('INVALID_ARGUMENT','草稿凭据字段过大。');
      output[key] = value;
    }
    return output;
  }

  enqueue(operation) {
    const current = this.queue.catch(() => undefined).then(operation);
    this.queue = current;
    return current;
  }

  async readEnvelopeFile(file) {
    const content = await fs.readFile(file,'utf8');
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new AppError('DRAFT_CREDENTIAL_STORE_INVALID','草稿凭据存储格式无效。'); }
    if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new AppError('DRAFT_CREDENTIAL_STORE_INVALID','草稿凭据存储格式无效。');
    }
    return parsed;
  }

  async readEnvelopeSlots() {
    const read = async (file) => {
      try { return {envelope:await this.readEnvelopeFile(file),error:null}; }
      catch (error) { return {envelope:null,error}; }
    };
    const [primary,backup] = await Promise.all([read(this.file),read(this.backupFile)]);
    return {primary,backup};
  }

  async readEnvelope() {
    const slots = await this.readEnvelopeSlots();
    if (slots.primary.envelope) return slots.primary.envelope;
    if (slots.backup.envelope) return slots.backup.envelope;
    if (slots.primary.error?.code === 'ENOENT' && slots.backup.error?.code === 'ENOENT') return emptyEnvelope();
    throw slots.primary.error ?? slots.backup.error;
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

  async writeEnvelopes(primaryEnvelope,backupEnvelope = primaryEnvelope) {
    await this.atomicWrite(this.file,JSON.stringify(primaryEnvelope,null,2));
    await this.atomicWrite(this.backupFile,JSON.stringify(backupEnvelope,null,2)).catch(() => undefined);
  }

  candidateFromEnvelope(envelope,record,draft) {
    const entry = envelope?.entries?.[this.resourceKey(record)];
    if (!entry || entry.pluginType !== draft.pluginType || !entry.candidates || typeof entry.candidates !== 'object') return null;
    return entry.candidates[this.identityHash(draft)] ?? null;
  }

  hasAnyCandidate(slots,record) {
    return [slots.primary.envelope,slots.backup.envelope].some((envelope) => {
      const entry = envelope?.entries?.[this.resourceKey(record)];
      return Boolean(entry && Object.keys(entry.candidates ?? {}).length);
    });
  }

  async decryptCandidate(pluginType,candidate) {
    if (!this.encryption?.isEncryptionAvailable?.()) {
      throw new AppError('DRAFT_CREDENTIAL_ENCRYPTION_UNAVAILABLE','Windows 安全存储当前不可用。');
    }
    try {
      const decrypted = await maybeAwait(this.encryption.decryptString(Buffer.from(candidate.ciphertext,'base64')));
      const parsed = JSON.parse(String(decrypted));
      if (parsed?.schemaVersion !== 1 || !parsed.secrets || typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets)) {
        throw new Error('invalid payload');
      }
      return this.normalizeSecrets(pluginType,parsed.secrets);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DRAFT_CREDENTIAL_UNREADABLE','草稿凭据当前无法解密，已保留原始密文。');
    }
  }

  async loadFromSlots(record,draft,slots) {
    if (!this.identityComplete(draft)) {
      throw new AppError('DRAFT_CREDENTIAL_INACTIVE','草稿登录身份尚未完整，保存的凭据不会用于连接。');
    }
    const merged = await this.loadMatchingFromSlots(record,draft,slots);
    if (merged !== null) return merged;
    if (this.hasAnyCandidate(slots,record)) {
      throw new AppError('DRAFT_CREDENTIAL_INACTIVE','保存的草稿凭据属于另一登录身份，不会发送到当前目标。');
    }
    return null;
  }

  async loadMatchingFromSlots(record,draft,slots) {
    let unreadable = null;
    let merged = null;
    for (const slot of [slots.primary,slots.backup]) {
      if (!slot.envelope) continue;
      const candidate = this.candidateFromEnvelope(slot.envelope,record,draft);
      if (!candidate) continue;
      try {
        const secrets = await this.decryptCandidate(draft.pluginType,candidate);
        merged = merged === null ? secrets : {...secrets,...merged};
      } catch (error) {
        unreadable ??= error;
      }
    }
    if (merged !== null) return merged;
    if (unreadable) throw unreadable;
    return null;
  }

  async loadActive(record,draft) {
    return this.loadFromSlots(record,draft,await this.readEnvelopeSlots());
  }

  async state(record,draft) {
    const slots = await this.readEnvelopeSlots();
    try {
      const secrets = await this.loadFromSlots(record,draft,slots);
      return secrets && Object.keys(secrets).length ? 'stored-active' : 'absent';
    } catch (error) {
      if (error instanceof AppError && error.code === 'DRAFT_CREDENTIAL_INACTIVE') return 'stored-inactive';
      if (error instanceof AppError && ['DRAFT_CREDENTIAL_UNREADABLE','DRAFT_CREDENTIAL_ENCRYPTION_UNAVAILABLE'].includes(error.code)) return 'unreadable';
      throw error;
    }
  }

  async saveCandidate(record,draft,secrets) {
    const replacements = this.normalizeSecrets(draft.pluginType,secrets);
    if (!Object.keys(replacements).length) return {saved:false,state:await this.state(record,draft)};
    if (!this.encryption?.isEncryptionAvailable?.()) {
      throw new AppError('DRAFT_CREDENTIAL_ENCRYPTION_UNAVAILABLE','Windows 安全存储当前不可用。');
    }
    return this.enqueue(async () => {
      const slots = await this.readEnvelopeSlots();
      const validBase = slots.primary.envelope ?? slots.backup.envelope;
      if (!validBase) {
        const bothMissing = slots.primary.error?.code === 'ENOENT' && slots.backup.error?.code === 'ENOENT';
        if (!bothMissing) throw slots.primary.error ?? slots.backup.error;
      }
      let existing = {};
      const matchingCandidateExists = [slots.primary.envelope,slots.backup.envelope]
        .some((envelope) => Boolean(this.candidateFromEnvelope(envelope,record,draft)));
      if (matchingCandidateExists) {
        try { existing = await this.loadMatchingFromSlots(record,draft,slots) ?? {}; }
        catch (error) {
          if (error instanceof AppError && ['DRAFT_CREDENTIAL_UNREADABLE','DRAFT_CREDENTIAL_ENCRYPTION_UNAVAILABLE'].includes(error.code)) {
            throw new AppError(
              'DRAFT_CREDENTIAL_REPLACEMENT_INCOMPLETE',
              '现有草稿凭据暂时无法读取，不能安全合并新字段；旧密文已原样保留。',
              {causeCode:error.code},
            );
          }
          throw error;
        }
      }
      const normalized = this.normalizeSecrets(draft.pluginType,{...existing,...replacements});
      const plaintext = JSON.stringify({schemaVersion:1,secrets:normalized});
      const encrypted = await maybeAwait(this.encryption.encryptString(plaintext));
      const ciphertext = (Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted)).toString('base64');
      const identityHash = this.identityHash(draft);
      const key = this.resourceKey(record);
      const makeNext = (source) => {
        const envelope = cloneEnvelope(source ?? validBase ?? emptyEnvelope());
        const current = envelope.entries[key];
        envelope.entries[key] = {
          pluginType:draft.pluginType,
          candidates:{...(current?.candidates ?? {}),[identityHash]:{ciphertext,updatedAt:new Date().toISOString()}},
          updatedAt:new Date().toISOString(),
        };
        return envelope;
      };
      await this.writeEnvelopes(
        makeNext(slots.primary.envelope ?? slots.backup.envelope),
        makeNext(slots.backup.envelope ?? slots.primary.envelope),
      );
      return {saved:true,state:this.identityComplete(draft) ? 'stored-active' : 'stored-inactive'};
    });
  }
}
