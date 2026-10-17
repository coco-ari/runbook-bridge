import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { mysqlCredentialIdentity } from './mysql-connection-profile.mjs';

const SECRET_KEYS = Object.freeze({
  server: new Set(['password', 'privateKeyPassphrase', 'proxyPassword', 'privateKeyPem']),
  mysql: new Set(['password', 'tlsPassphrase', 'caPem', 'clientCertPem', 'clientKeyPem']),
  redis: new Set(['password', 'tlsPassphrase', 'caPem', 'clientCertPem', 'clientKeyPem']),
});

function resourceKey(scope) {
  scope = mysqlCredentialIdentity(scope);
  return `${scope.projectId}/${scope.environmentId}/${scope.pluginInstanceId}`;
}

function bindingProjection(plugin) {
  plugin = mysqlCredentialIdentity(plugin);
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
    ...(plugin.auth?.privateKeySource === 'vault' ? {privateKeySource:'vault'} : {}),
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
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用。');
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

  async saveUnlocked(plugin, normalized, slots = null, { removeResourceKeys = [] } = {}) {
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用。');
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
    for (const key of new Set(removeResourceKeys.map((value) => String(value)))) {
      if (key === resourceKey(plugin)) continue;
      delete primary.entries[key];
      delete backup.entries[key];
    }
    primary.entries[resourceKey(plugin)] = entry;
    backup.entries[resourceKey(plugin)] = entry;
    await this.writeEnvelopes(primary, backup);
    return { saved: true };
  }

  // 只准备内存中的凭据，不提前落盘；单插件和整组事务使用相同的替换规则。
  async prepareSecretsUpdate(previousPlugin, nextPlugin, secrets = {}, {forceCredentialReplacement = false, slots = null} = {}) {
    const replacements = this.normalizeSecrets(nextPlugin, secrets);
    if (forceCredentialReplacement) {
      if (!Object.keys(replacements).length) throw new AppError('INVALID_ARGUMENT', '强制替换凭据必须提供至少一个新的凭据字段。');
      if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用。');
    }
    let existingSecrets = null;
    let discardedCause = null;
    try {
      existingSecrets = (await this.loadFromSlots(previousPlugin ?? nextPlugin, slots ?? await this.readEnvelopeSlots())).secrets ?? {};
    } catch (error) {
      const recoverable = error instanceof AppError && ['CREDENTIAL_BINDING_MISMATCH', 'CREDENTIAL_DECRYPT_FAILED'].includes(error.code);
      if (!recoverable || !Object.keys(replacements).length) throw error;
      if (!forceCredentialReplacement) {
        throw new AppError('CREDENTIAL_REPLACEMENT_INCOMPLETE',
          '现有凭据暂时无法读取，不能确认其中是否含有未显示的历史字段；旧凭据已原样保留。', {causeCode:error.code});
      }
      discardedCause = error.code;
    }
    // 确认后如果原凭据已恢复可读，仍须合并历史字段，不能按过期的错误状态清空。
    return {secrets:this.normalizeSecrets(nextPlugin, {...existingSecrets, ...replacements}),existingSecrets,discardedCause};
  }

  async saveMerged(previousPlugin, nextPlugin, secrets = {}) {
    // 空值表示保留；无法读取旧凭据时先要求确认，不能把部分输入当作完整替换。
    const replacements = this.normalizeSecrets(nextPlugin, secrets);
    const previous = previousPlugin ?? nextPlugin;
    const bindingChanged = resourceKey(previous) !== resourceKey(nextPlugin)
      || bindingHash(previous) !== bindingHash(nextPlugin);
    if (!bindingChanged && Object.keys(replacements).length === 0) {
      return { saved:false, preserved:true };
    }
    return this.enqueue(async () => {
      const slots = await this.readEnvelopeSlots();
      const {secrets:merged} = await this.prepareSecretsUpdate(previous,nextPlugin,replacements,{slots});
      if (!Object.keys(merged).length) return { saved: false };
      return this.saveUnlocked(nextPlugin, merged, slots);
    });
  }

  async replaceUnreadable(previousPlugin, nextPlugin, secrets = {}) {
    // 调用方必须先尝试无损合并，再取得用户对丢弃不可读字段的明确确认。
    const replacements = this.normalizeSecrets(nextPlugin, secrets);
    if (!Object.keys(replacements).length) {
      throw new AppError('INVALID_ARGUMENT', '强制替换凭据必须提供至少一个新的凭据字段。');
    }
    if (!this.encryption?.isEncryptionAvailable?.()) {
      throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用。');
    }
    const previous = previousPlugin ?? nextPlugin;
    return this.enqueue(async () => {
      const slots = await this.readEnvelopeSlots();
      const {secrets:merged,discardedCause} = await this.prepareSecretsUpdate(previous,nextPlugin,replacements,{forceCredentialReplacement:true,slots});
      const result = await this.saveUnlocked(nextPlugin, merged, slots, {
        removeResourceKeys:[resourceKey(previous)],
      });
      return {
        ...result,forcedReplacement:true,
        discardedUnreadable:Boolean(discardedCause),
        ...(discardedCause ? {causeCode:discardedCause} : {}),
      };
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
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '系统安全存储当前不可用。');
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

  async captureProjectEntries(projectId) {
    const slots = await this.readEnvelopeSlots();
    const select = envelope => Object.fromEntries(Object.entries(envelope?.entries ?? {}).filter(([key]) => key.startsWith(`${projectId}/`)));
    for (const slot of [slots.primary,slots.backup]) {
      if (!slot.envelope && slot.error?.code !== 'ENOENT') throw new AppError('CREDENTIAL_STORE_INVALID','凭据库无法完整备份，已停止云配置导入。');
    }
    return {primary:select(slots.primary.envelope),backup:select(slots.backup.envelope)};
  }

  async encryptProjectEntries(plugins) {
    if (!this.encryption?.isEncryptionAvailable?.()) throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE','系统安全存储当前不可用。');
    const entries = {};
    for (const {plugin,secrets} of plugins) {
      const normalized = this.normalizeSecrets(plugin,secrets);
      if (!Object.keys(normalized).length) continue;
      const encrypted = await maybeAwait(this.encryption.encryptString(JSON.stringify({schemaVersion:1,secrets:normalized})));
      entries[resourceKey(plugin)] = {pluginType:plugin.pluginType,bindingHash:bindingHash(plugin),ciphertext:Buffer.from(encrypted).toString('base64'),updatedAt:new Date().toISOString()};
    }
    return {primary:entries,backup:structuredClone(entries)};
  }

  async capturePluginEntries(projectId,environmentId,pluginIds) {
    const entries = await this.captureProjectEntries(projectId);
    const keys = new Set(pluginIds.map(id => resourceKey({projectId,environmentId,pluginInstanceId:id})));
    return Object.fromEntries(['primary','backup'].map(slot => [slot,Object.fromEntries(Object.entries(entries[slot]).filter(([key]) => keys.has(key)))]));
  }

  async restorePluginEntries(projectId,environmentId,pluginIds,saved) {
    return this.enqueue(async () => {
      const keys = new Set(pluginIds.map(id => resourceKey({projectId,environmentId,pluginInstanceId:id})));
      const slots = await this.readEnvelopeSlots();
      const values = {};
      for (const slot of ['primary','backup']) {
        if (!slots[slot].envelope && slots[slot].error?.code !== 'ENOENT') throw new AppError('CREDENTIAL_STORE_INVALID','凭据库无法安全更新。');
        const envelope = cloneEnvelope(slots[slot].envelope ?? slots[slot === 'primary' ? 'backup' : 'primary'].envelope ?? emptyEnvelope());
        for (const key of keys) delete envelope.entries[key];
        for (const [key,entry] of Object.entries(saved[slot])) {
          if (!keys.has(key)) throw new AppError('SCOPE_MISMATCH','凭据备份不属于本次插件组。');
          envelope.entries[key] = entry;
        }
        values[slot] = envelope;
      }
      // 只替换当前批次条目，其他环境并发保存的凭据必须保留。
      await this.atomicWrite(this.file,JSON.stringify(values.primary));
      await this.atomicWrite(this.backupFile,JSON.stringify(values.backup));
    });
  }

  async restoreProjectEntries(projectId, saved) {
    return this.enqueue(async () => {
      const slots = await this.readEnvelopeSlots();
      const replace = (slot, fallback, entries) => {
        if (!slot.envelope && slot.error?.code !== 'ENOENT') throw new AppError('CREDENTIAL_STORE_INVALID','凭据库无法安全更新。');
        const result = cloneEnvelope(slot.envelope ?? fallback.envelope ?? emptyEnvelope());
        for (const key of Object.keys(result.entries)) if (key.startsWith(`${projectId}/`)) delete result.entries[key];
        for (const [key,value] of Object.entries(entries)) {
          if (!key.startsWith(`${projectId}/`)) throw new AppError('SCOPE_MISMATCH','凭据备份不属于当前项目。');
          result.entries[key] = value;
        }
        return result;
      };
      const primary = replace(slots.primary,slots.backup,saved.primary);
      const backup = replace(slots.backup,slots.primary,saved.backup);
      // 两个槽位都必须成功写入，否则项目事务负责恢复原始配置与凭据。
      await this.atomicWrite(this.file,JSON.stringify(primary));
      await this.atomicWrite(this.backupFile,JSON.stringify(backup));
    });
  }

  async clear(plugin) {
    const slots = await this.readEnvelopeSlots();
    const preserved = Boolean(slots.primary.envelope?.entries?.[resourceKey(plugin)] || slots.backup.envelope?.entries?.[resourceKey(plugin)]);
    return { cleared:false, preserved };
  }
}

export const pluginCredentialInternals = { resourceKey, bindingHash, bindingProjection };
