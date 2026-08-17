import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const SECRET_KEYS = Object.freeze({
  server: new Set(['password', 'privateKeyPassphrase', 'proxyPassword']),
  mysql: new Set(['password', 'tlsPassphrase', 'caPem', 'clientCertPem', 'clientKeyPem']),
  redis: new Set(['password', 'tlsPassphrase', 'caPem', 'clientCertPem', 'clientKeyPem']),
});

function resourceKey(scope) {
  return `${scope.projectId}/${scope.environmentId}/${scope.pluginInstanceId}`;
}

function bindingProjection(plugin) {
  const target = plugin.target ? {
    host: plugin.target.host,
    port: plugin.target.port,
    database: plugin.target.database,
    db: plugin.target.db,
    addressFamily: plugin.target.addressFamily,
  } : null;
  return {
    projectId: plugin.projectId,
    environmentId: plugin.environmentId,
    pluginInstanceId: plugin.pluginInstanceId,
    pluginType: plugin.pluginType,
    target,
    username: plugin.auth?.username ?? null,
    authType: plugin.auth?.type ?? null,
    transport: plugin.transport ?? null,
    uplink: plugin.uplink ?? null,
    tls: plugin.tls ?? null,
  };
}

function bindingHash(plugin) {
  return crypto.createHash('sha256').update(JSON.stringify(bindingProjection(plugin))).digest('hex');
}

async function maybeAwait(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value);
}

export class PluginCredentialVault {
  constructor(dataRoot, encryption) {
    this.file = path.join(dataRoot, 'credentials', 'plugins.enc.json');
    this.backupFile = path.join(dataRoot, 'credentials', 'plugins.enc.backup.json');
    this.encryption = encryption;
    this.queue = Promise.resolve();
  }

  async readEnvelopeFile(file) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new AppError('CREDENTIAL_STORE_INVALID', '插件凭据存储格式无效。');
    }
    return parsed;
  }

  async readEnvelope() {
    try {
      return await this.readEnvelopeFile(this.file);
    } catch (primaryError) {
      try {
        return await this.readEnvelopeFile(this.backupFile);
      } catch (backupError) {
        if (primaryError?.code === 'ENOENT' && backupError?.code === 'ENOENT') return { schemaVersion: 1, entries: {} };
        throw primaryError;
      }
    }
  }

  enqueue(operation) {
    const current = this.queue.catch(() => undefined).then(operation);
    this.queue = current;
    return current;
  }

  async atomicWrite(file, content) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force:true }).catch(() => undefined);
      throw error;
    }
  }

  async writeEnvelope(envelope) {
    const content = JSON.stringify(envelope, null, 2);
    await this.atomicWrite(this.file, content);
    await this.atomicWrite(this.backupFile, content);
  }

  async ensureBackup() {
    try {
      const envelope = await this.readEnvelopeFile(this.file);
      await this.atomicWrite(this.backupFile, JSON.stringify(envelope, null, 2));
      return { backedUp:true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { backedUp:false };
      try {
        await this.readEnvelopeFile(this.backupFile);
        return { backedUp:true, recoveredFromBackup:true };
      } catch {
        throw error;
      }
    }
  }

  normalizeSecrets(plugin, secrets) {
    const allowed = SECRET_KEYS[plugin.pluginType];
    if (!allowed) throw new AppError('INVALID_ARGUMENT', '插件类型不支持凭据。');
    const output = {};
    for (const [key, raw] of Object.entries(secrets ?? {})) {
      if (!allowed.has(key)) throw new AppError('INVALID_ARGUMENT', `不支持的凭据字段：${key}。`);
      const value = String(raw ?? '');
      if (!value) continue;
      if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new AppError('INVALID_ARGUMENT', '凭据字段过大。');
      output[key] = value;
    }
    return output;
  }

  async save(plugin, secrets) {
    const normalized = this.normalizeSecrets(plugin, secrets);
    if (!Object.keys(normalized).length) throw new AppError('INVALID_ARGUMENT', '没有可保存的凭据。');
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', 'Windows 安全存储当前不可用。');
    return this.enqueue(async () => {
      const envelope = await this.readEnvelope();
      const plaintext = JSON.stringify({ schemaVersion: 1, secrets: normalized });
      const encrypted = await maybeAwait(this.encryption.encryptString(plaintext));
      const buffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
      envelope.entries[resourceKey(plugin)] = {
        pluginType: plugin.pluginType,
        bindingHash: bindingHash(plugin),
        ciphertext: buffer.toString('base64'),
        updatedAt: new Date().toISOString(),
      };
      await this.writeEnvelope(envelope);
      return { saved: true };
    });
  }

  async saveMerged(previousPlugin, nextPlugin, secrets = {}) {
    let existing = {};
    try {
      existing = await this.load(previousPlugin ?? nextPlugin) ?? {};
    } catch (error) {
      if (!Object.values(secrets ?? {}).some((value) => String(value ?? ''))) throw error;
    }
    const merged = this.normalizeSecrets(nextPlugin, { ...existing, ...secrets });
    if (!Object.keys(merged).length) return { saved: false };
    return this.save(nextPlugin, merged);
  }

  async load(plugin) {
    const envelope = await this.readEnvelope();
    const entry = envelope.entries[resourceKey(plugin)];
    if (!entry) return null;
    if (entry.pluginType !== plugin.pluginType || entry.bindingHash !== bindingHash(plugin)) {
      throw new AppError('CREDENTIAL_BINDING_MISMATCH', '保存的凭据不再匹配当前插件目标，请重新输入。');
    }
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', 'Windows 安全存储当前不可用。');
    try {
      const decrypted = await maybeAwait(this.encryption.decryptString(Buffer.from(entry.ciphertext, 'base64')));
      const parsed = JSON.parse(String(decrypted));
      if (parsed?.schemaVersion !== 1 || !parsed.secrets || typeof parsed.secrets !== 'object') throw new Error('invalid payload');
      return this.normalizeSecrets(plugin, parsed.secrets);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CREDENTIAL_DECRYPT_FAILED', '插件凭据无法解密，请重新输入。');
    }
  }

  async has(plugin) {
    try {
      return Boolean(await this.load(plugin));
    } catch (error) {
      if (error instanceof AppError && ['CREDENTIAL_BINDING_MISMATCH', 'CREDENTIAL_DECRYPT_FAILED'].includes(error.code)) return false;
      throw error;
    }
  }

  async clear(plugin) {
    const preserved = Boolean((await this.readEnvelope()).entries[resourceKey(plugin)]);
    return { cleared:false, preserved };
  }
}

export const pluginCredentialInternals = { resourceKey, bindingHash, bindingProjection };
