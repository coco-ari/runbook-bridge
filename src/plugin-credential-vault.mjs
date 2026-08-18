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

function emptyEnvelope() {
  return { schemaVersion:1, entries:{} };
}

function cloneEnvelope(envelope) {
  return { ...envelope, entries:{ ...(envelope?.entries ?? {}) } };
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not available consistently on Windows.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class PluginCredentialVault {
  constructor(dataRoot, encryption) {
    this.file = path.join(dataRoot, 'credentials', 'plugins.enc.json');
    this.backupFile = path.join(dataRoot, 'credentials', 'plugins.enc.backup.json');
    this.encryption = encryption;
    this.queue = Promise.resolve();
  }

  async readEnvelopeFile(file) {
    const content = await fs.readFile(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new AppError('CREDENTIAL_STORE_INVALID', '插件凭据存储格式无效。'); }
    if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new AppError('CREDENTIAL_STORE_INVALID', '插件凭据存储格式无效。');
    }
    return parsed;
  }

  async readEnvelopeSlots() {
    const read = async (file) => {
      try { return { envelope:await this.readEnvelopeFile(file), error:null }; }
      catch (error) { return { envelope:null, error }; }
    };
    const [primary, backup] = await Promise.all([read(this.file), read(this.backupFile)]);
    return { primary, backup };
  }

  async readEnvelope() {
    const slots = await this.readEnvelopeSlots();
    if (slots.primary.envelope) return slots.primary.envelope;
    if (slots.backup.envelope) return slots.backup.envelope;
    if (slots.primary.error?.code === 'ENOENT' && slots.backup.error?.code === 'ENOENT') return emptyEnvelope();
    throw slots.primary.error ?? slots.backup.error;
  }

  enqueue(operation) {
    const current = this.queue.catch(() => undefined).then(operation);
    this.queue = current;
    return current;
  }

  async atomicWrite(file, content) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, file);
      await syncDirectoryBestEffort(path.dirname(file));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temp, { force:true }).catch(() => undefined);
      throw error;
    }
  }

  async writeEnvelopes(primaryEnvelope, backupEnvelope = primaryEnvelope) {
    const primaryContent = JSON.stringify(primaryEnvelope, null, 2);
    const backupContent = JSON.stringify(backupEnvelope, null, 2);
    // The atomic primary rename is the commit point. A primary failure leaves
    // both old slots untouched and lets the caller roll configuration back. A
    // backup failure after that point is non-fatal: throwing would roll YAML
    // back even though the authoritative credential binding already changed.
    await this.atomicWrite(this.file, primaryContent);
    await this.atomicWrite(this.backupFile, backupContent).catch(() => undefined);
  }

  async ensureBackup() {
    const slots = await this.readEnvelopeSlots();
    // Never replace an existing structurally valid backup during maintenance:
    // it may be the only slot whose ciphertext is still decryptable.
    if (slots.backup.envelope) return { backedUp:true, unchanged:true };
    if (!slots.primary.envelope) {
      const absent = slots.primary.error?.code === 'ENOENT' && slots.backup.error?.code === 'ENOENT';
      return { backedUp:false, ...(absent ? {} : {warning:true}) };
    }
    try {
      await this.atomicWrite(this.backupFile, JSON.stringify(slots.primary.envelope, null, 2));
      return { backedUp:true };
    } catch {
      return { backedUp:false, warning:true };
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
      const slots = await this.readEnvelopeSlots();
      let existing;
      try {
        existing = (await this.loadFromSlots(plugin, slots)).secrets ?? {};
      } catch (error) {
        if (error instanceof AppError && ['CREDENTIAL_BINDING_MISMATCH','CREDENTIAL_DECRYPT_FAILED'].includes(error.code)) {
          throw new AppError(
            'CREDENTIAL_REPLACEMENT_INCOMPLETE',
            '此资源标识仍保留有不可读取或属于旧目标的凭据；为避免覆盖历史字段，本次保存已取消。',
            {causeCode:error.code},
          );
        }
        throw error;
      }
      return this.saveUnlocked(plugin, this.normalizeSecrets(plugin, {...existing,...normalized}), slots);
    });
  }

  async saveUnlocked(plugin, normalized, slots = null) {
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', 'Windows 安全存储当前不可用。');
    const currentSlots = slots ?? await this.readEnvelopeSlots();
    const validBase = currentSlots.primary.envelope ?? currentSlots.backup.envelope;
    if (!validBase) {
      const bothMissing = currentSlots.primary.error?.code === 'ENOENT' && currentSlots.backup.error?.code === 'ENOENT';
      if (!bothMissing) throw currentSlots.primary.error ?? currentSlots.backup.error;
    }
    const plaintext = JSON.stringify({ schemaVersion: 1, secrets: normalized });
    const encrypted = await maybeAwait(this.encryption.encryptString(plaintext));
    const buffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    const entry = {
      pluginType: plugin.pluginType,
      bindingHash: bindingHash(plugin),
      ciphertext: buffer.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    // Preserve each slot independently. Updating plugin B must not copy a bad
    // primary entry for plugin A over A's only good backup entry.
    const primary = cloneEnvelope(currentSlots.primary.envelope ?? currentSlots.backup.envelope ?? emptyEnvelope());
    const backup = cloneEnvelope(currentSlots.backup.envelope ?? currentSlots.primary.envelope ?? emptyEnvelope());
    primary.entries[resourceKey(plugin)] = entry;
    backup.entries[resourceKey(plugin)] = entry;
    await this.writeEnvelopes(primary, backup);
    return { saved: true };
  }

  async saveMerged(previousPlugin, nextPlugin, secrets = {}) {
    // Empty/omitted fields mean "preserve", never "clear". Reading the old
    // entry must succeed before any replacement is written; a temporary DPAPI
    // or binding failure must not turn a partial form submission into data loss.
    const replacements = this.normalizeSecrets(nextPlugin, secrets);
    const previous = previousPlugin ?? nextPlugin;
    const bindingChanged = resourceKey(previous) !== resourceKey(nextPlugin)
      || bindingHash(previous) !== bindingHash(nextPlugin);
    if (!bindingChanged && Object.keys(replacements).length === 0) {
      return { saved:false, preserved:true };
    }
    return this.enqueue(async () => {
      const slots = await this.readEnvelopeSlots();
      let existing;
      try {
        existing = (await this.loadFromSlots(previous, slots)).secrets ?? {};
      } catch (error) {
        const recoverable = error instanceof AppError && ['CREDENTIAL_BINDING_MISMATCH', 'CREDENTIAL_DECRYPT_FAILED'].includes(error.code);
        if (recoverable && Object.keys(replacements).length > 0) {
          throw new AppError(
            'CREDENTIAL_REPLACEMENT_INCOMPLETE',
            '现有凭据暂时无法读取，不能确认其中是否含有未显示的历史字段；旧凭据已原样保留。',
            { causeCode:error.code },
          );
        }
        throw error;
      }
      const merged = this.normalizeSecrets(nextPlugin, { ...existing, ...replacements });
      if (!Object.keys(merged).length) return { saved: false };
      return this.saveUnlocked(nextPlugin, merged, slots);
    });
  }

  async load(plugin) {
    return (await this.loadFromSlots(plugin, await this.readEnvelopeSlots())).secrets;
  }

  async loadFromSlots(plugin, slots) {
    let structuralError = null;
    let credentialError = null;
    let merged = null;
    let selectedEnvelope = null;
    let selectedSource = null;
    for (const [source, slot] of [['primary', slots.primary], ['backup', slots.backup]]) {
      if (!slot.envelope) {
        if (slot.error?.code !== 'ENOENT' && !structuralError) structuralError = slot.error;
        continue;
      }
      try {
        const secrets = await this.loadFromEnvelope(plugin, slot.envelope);
        if (secrets !== null) {
          // Merge both matching slots so an older backup-only inactive field is
          // retained. Primary values remain authoritative on duplicate keys.
          merged = merged === null ? secrets : {...secrets,...merged};
          if (!selectedEnvelope) {
            selectedEnvelope = slot.envelope;
            selectedSource = source;
          }
        }
      } catch (error) {
        if (!credentialError) credentialError = error;
      }
    }
    if (merged !== null) return {secrets:merged,envelope:selectedEnvelope,source:selectedSource};
    if (credentialError) throw credentialError;
    if (structuralError) throw structuralError;
    return { secrets:null, envelope:slots.primary.envelope ?? slots.backup.envelope ?? emptyEnvelope(), source:null };
  }

  async loadFromEnvelope(plugin, envelope) {
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

  async hasBinding(plugin) {
    const slots = await this.readEnvelopeSlots();
    const expected = bindingHash(plugin);
    const targetKey = resourceKey(plugin);
    return [slots.primary.envelope,slots.backup.envelope].some((envelope) => {
      const entry = envelope?.entries?.[targetKey];
      return entry?.pluginType === plugin.pluginType && entry.bindingHash === expected;
    });
  }

  async hasStoredEntry(plugin) {
    const slots = await this.readEnvelopeSlots();
    const targetKey = resourceKey(plugin);
    if ([slots.primary.envelope,slots.backup.envelope].some((envelope) => Boolean(envelope?.entries?.[targetKey]))) return true;
    const uncertain = [slots.primary,slots.backup].some((slot) => !slot.envelope && slot.error?.code !== 'ENOENT');
    if (uncertain) {
      throw new AppError('CREDENTIAL_STORE_INVALID', '无法确认插件凭据存储中是否已有历史条目，本次配置保存已取消。');
    }
    return false;
  }

  async clear(plugin) {
    const slots = await this.readEnvelopeSlots();
    const preserved = Boolean(slots.primary.envelope?.entries?.[resourceKey(plugin)] || slots.backup.envelope?.entries?.[resourceKey(plugin)]);
    return { cleared:false, preserved };
  }
}

export async function importLegacySecretsIfAbsent(vault, plugin, loadLegacySecrets) {
  let existing;
  try {
    existing = await vault.load(plugin) ?? {};
  } catch {
    // Any unreadable/binding-mismatched entry is still an existing credential
    // envelope. Startup migration must never overwrite it opportunistically.
    return {imported:false,preserved:true,unreadable:true};
  }
  const secrets = await loadLegacySecrets();
  if (!secrets || !Object.values(secrets).some((value) => String(value ?? ''))) return {imported:false,preserved:false};
  const missing = Object.fromEntries(
    Object.entries(secrets).filter(([key,value]) => String(value ?? '') && !String(existing[key] ?? '')),
  );
  if (!Object.keys(missing).length) return {imported:false,preserved:true};
  await vault.save(plugin, missing);
  const verified = await vault.load(plugin) ?? {};
  const existingPreserved = Object.entries(existing).every(([key,value]) => verified[key] === value);
  const importedPresent = Object.entries(missing).every(([key,value]) => verified[key] === value);
  if (!existingPreserved || !importedPresent) {
    throw new AppError('CREDENTIAL_STORAGE_FAILED', '旧凭据导入后校验失败；原凭据仍已保留。');
  }
  return {imported:true,preserved:Object.keys(existing).length > 0};
}

export const pluginCredentialInternals = { resourceKey, bindingHash, bindingProjection };
