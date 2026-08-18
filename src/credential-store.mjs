import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const SECRET_KEYS = ['password', 'privateKeyPassphrase', 'proxyPassword'];
const ENVELOPE_VERSION = 2;
const SAFE_MIGRATION_STATUSES = new Set([
  'confirmation-required',
  'unreadable',
  'unsupported',
  'import-pending',
]);
const BINDING_CHANGE_KEYS = [
  'host','port','username','authType','privateKeyPath','proxyType','proxyHost','proxyPort','proxyUsername',
];

function cleanSecrets(input = {}) {
  return Object.fromEntries(
    SECRET_KEYS.flatMap((key) => {
      const value = String(input[key] ?? '');
      return value ? [[key, value]] : [];
    }),
  );
}

function cleanMigrationSecrets(value) {
  if (!strictObject(value, new Set(SECRET_KEYS))) return null;
  const output = {};
  for (const key of SECRET_KEYS) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'string' || Buffer.byteLength(value[key], 'utf8') > 1024 * 1024) return null;
    if (value[key]) output[key] = value[key];
  }
  return output;
}

function secretFieldPresence(input = {}) {
  return Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(String(input[key] ?? ''))]));
}

function missingSecretFields(fields = {}, existing = {}) {
  return Object.fromEntries(
    SECRET_KEYS.map((key) => [key, Boolean(fields[key]) && !String(existing[key] ?? '')]),
  );
}

function missingSecretValues(candidate = {}, existing = {}) {
  return Object.fromEntries(
    SECRET_KEYS.flatMap((key) => {
      const value = String(candidate[key] ?? '');
      return value && !String(existing[key] ?? '') ? [[key, value]] : [];
    }),
  );
}

function hasAnyField(fields = {}) {
  return SECRET_KEYS.some((key) => Boolean(fields[key]));
}

function strictObject(value, allowed) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function strictText(value, { maxBytes = 1024, allowEmpty = true } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) return null;
  if (Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function strictPort(value, { allowZero = false } = {}) {
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535 ? value : null;
}

function normalizeStoredBinding(value) {
  const rootKeys = new Set(['ssh', 'proxy']);
  const sshKeys = new Set(['host', 'port', 'username', 'authType', 'privateKeyPath']);
  const proxyKeys = new Set(['type', 'host', 'port', 'username']);
  if (!strictObject(value, rootKeys) || !strictObject(value.ssh, sshKeys) || !strictObject(value.proxy, proxyKeys)) return null;
  const host = strictText(value.ssh.host, { maxBytes: 1024, allowEmpty: false });
  const port = strictPort(value.ssh.port);
  const username = strictText(value.ssh.username, { maxBytes: 1024, allowEmpty: false });
  const authType = ['password', 'privateKey', 'agent'].includes(value.ssh.authType) ? value.ssh.authType : null;
  const privateKeyPath = strictText(value.ssh.privateKeyPath, { maxBytes: 4096 });
  const proxyType = ['direct', 'socks5', 'http'].includes(value.proxy.type) ? value.proxy.type : null;
  const proxyHost = strictText(value.proxy.host, { maxBytes: 1024 });
  const proxyPort = strictPort(value.proxy.port, { allowZero: true });
  const proxyUsername = strictText(value.proxy.username, { maxBytes: 1024 });
  if (host === null || port === null || username === null || authType === null || privateKeyPath === null
    || proxyType === null || proxyHost === null || proxyPort === null || proxyUsername === null) return null;
  if (proxyType === 'direct' && (proxyHost !== '' || proxyPort !== 0 || proxyUsername !== '')) return null;
  if (proxyType !== 'direct' && (!proxyHost || proxyPort === 0)) return null;
  return {
    ssh: { host, port, username, authType, privateKeyPath },
    proxy: { type:proxyType, host:proxyHost, port:proxyPort, username:proxyUsername },
  };
}

function bindingSummary(binding) {
  return {
    host: binding.ssh.host,
    port: binding.ssh.port,
    username: binding.ssh.username,
    authType: binding.ssh.authType,
    privateKeyPathConfigured:Boolean(binding.ssh.privateKeyPath),
    proxyType: binding.proxy.type,
    proxyHost:binding.proxy.host,
    proxyPort:binding.proxy.port,
    proxyUsername:binding.proxy.username,
  };
}

function bindingChanges(source, current) {
  return {
    host:source.ssh.host !== current.ssh.host,
    port:source.ssh.port !== current.ssh.port,
    username:source.ssh.username !== current.ssh.username,
    authType:source.ssh.authType !== current.ssh.authType,
    privateKeyPath:source.ssh.privateKeyPath !== current.ssh.privateKeyPath,
    proxyType:source.proxy.type !== current.proxy.type,
    proxyHost:source.proxy.host !== current.proxy.host,
    proxyPort:source.proxy.port !== current.proxy.port,
    proxyUsername:source.proxy.username !== current.proxy.username,
  };
}

function safeBindingSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const host = strictText(value.host, {maxBytes:1024,allowEmpty:false});
  const port = strictPort(value.port);
  const username = strictText(value.username, {maxBytes:1024,allowEmpty:false});
  const authType = ['password','privateKey','agent'].includes(value.authType) ? value.authType : null;
  const proxyType = ['direct','socks5','http','windowsVpn'].includes(value.proxyType) ? value.proxyType : null;
  const proxyHost = strictText(value.proxyHost, {maxBytes:1024});
  const proxyPort = strictPort(value.proxyPort, {allowZero:true});
  const proxyUsername = strictText(value.proxyUsername, {maxBytes:1024});
  if (host === null || port === null || username === null || authType === null || proxyType === null
    || proxyHost === null || proxyPort === null || proxyUsername === null) return null;
  return {
    host,port,username,authType,privateKeyPathConfigured:Boolean(value.privateKeyPathConfigured),
    proxyType,proxyHost,proxyPort,proxyUsername,
  };
}

export function credentialBinding(config) {
  return {
    ssh: {
      host: String(config.ssh.host),
      port: Number(config.ssh.port),
      username: String(config.ssh.username),
      authType: String(config.auth.type),
      privateKeyPath:
        config.auth.type === 'privateKey' ? String(config.auth.privateKeyPath ?? '') : '',
    },
    proxy: {
      type: String(config.proxy.type),
      host: config.proxy.type === 'direct' ? '' : String(config.proxy.host ?? ''),
      port: config.proxy.type === 'direct' ? 0 : Number(config.proxy.port),
      username: config.proxy.type === 'direct' ? '' : String(config.proxy.username ?? ''),
    },
  };
}

export function legacyCredentialConfigForPlugin(plugin) {
  if (plugin?.pluginType !== 'server') throw new AppError('INVALID_ARGUMENT', '旧版项目凭据只能迁移到服务器插件。');
  return {
    ssh: {
      host:String(plugin.target?.host ?? ''),
      port:Number(plugin.target?.port ?? 22),
      username:String(plugin.auth?.username ?? ''),
    },
    auth: {
      type:String(plugin.auth?.type ?? 'password'),
      privateKeyPath:String(plugin.auth?.privateKeyPath ?? ''),
    },
    proxy: {
      type:String(plugin.uplink?.type ?? 'direct'),
      host:String(plugin.uplink?.host ?? ''),
      port:Number(plugin.uplink?.port ?? 0),
      username:String(plugin.uplink?.username ?? ''),
    },
  };
}

export function sameCredentialBinding(left, right) {
  return JSON.stringify(credentialBinding(left)) === JSON.stringify(credentialBinding(right));
}

export async function migrateLegacyCredentialForPlugin({ legacyCredentialStore, credentialVault, plugin, pluginBindingHash }) {
  let existing;
  try { existing = await credentialVault.load(plugin) ?? {}; }
  catch {
    // An unreadable active envelope is still authoritative. Never let startup
    // migration infer that it is empty or replace it with legacy material.
    return {status:'active-vault-unreadable',preserved:true};
  }
  const candidate = await legacyCredentialStore.readMigrationCandidate(
    plugin.projectId,
    legacyCredentialConfigForPlugin(plugin),
  );
  const metadata = {
    expectedRevision:plugin.revision,
    pluginBindingHash,
  };
  if (candidate.status === 'verified') {
    const missing = legacyCredentialStore.missingMigrationSecrets(candidate,existing);
    try {
      if (Object.keys(missing).length) await credentialVault.save(plugin,missing);
      const saved = await credentialVault.load(plugin) ?? {};
      const existingPreserved = Object.entries(existing).every(([key,value]) => saved[key] === value);
      const missingImported = Object.entries(missing).every(([key,value]) => saved[key] === value);
      if (!existingPreserved || !missingImported || !legacyCredentialStore.migrationComplete(candidate,saved)) {
        throw new Error('credential migration verification failed');
      }
      legacyCredentialStore.clearMigration(plugin);
      return {status:Object.keys(missing).length ? 'imported' : 'already-complete',preserved:true};
    } catch {
      legacyCredentialStore.rememberMigration(plugin,{...candidate,status:'import-pending'},metadata);
      return {status:'import-pending',preserved:true};
    }
  }
  if (candidate.status === 'confirmation-required' && legacyCredentialStore.migrationComplete(candidate,existing)) {
    legacyCredentialStore.clearMigration(plugin);
    return {status:'already-complete',preserved:true};
  }
  if (candidate.status !== 'absent') legacyCredentialStore.rememberMigration(plugin,candidate,metadata);
  return {status:candidate.status,preserved:true};
}

export class CredentialStore {
  constructor(projectStore, encryption) {
    this.projectStore = projectStore;
    this.encryption = encryption;
    this.pendingMigrations = new Map();
  }

  filePath(projectId) {
    return path.join(this.projectStore.projectDir(projectId), 'credentials.enc.json');
  }

  async has(projectId) {
    try {
      await fs.access(this.filePath(projectId));
      return true;
    } catch {
      return false;
    }
  }

  migrationKey(scope) {
    return `${scope.projectId}/${scope.environmentId}/${scope.pluginInstanceId}`;
  }

  rememberMigration(scope, candidate, metadata = {}) {
    if (!SAFE_MIGRATION_STATUSES.has(candidate.status)) return null;
    const fields = candidate.secrets
      ? secretFieldPresence(candidate.secrets)
      : Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(candidate.fields?.[key])]));
    const value = {
      status:candidate.status,
      formatVersion:candidate.formatVersion ?? null,
      sourceSha256:/^[a-f0-9]{64}$/u.test(String(candidate.sourceSha256 ?? '')) ? candidate.sourceSha256 : null,
      sourceBinding:safeBindingSummary(candidate.sourceBinding),
      currentBinding:safeBindingSummary(candidate.currentBinding),
      changedFields:Object.fromEntries(BINDING_CHANGE_KEYS.map((key) => [key,Boolean(candidate.changedFields?.[key])])),
      fields,
      errorCode:typeof candidate.errorCode === 'string' ? candidate.errorCode : null,
      expectedRevision:Number.isInteger(metadata.expectedRevision) ? metadata.expectedRevision : null,
      pluginBindingHash:/^[a-f0-9]{64}$/u.test(String(metadata.pluginBindingHash ?? '')) ? metadata.pluginBindingHash : null,
    };
    this.pendingMigrations.set(this.migrationKey(scope),value);
    return structuredClone(value);
  }

  migrationStatus(scope) {
    const value = this.pendingMigrations.get(this.migrationKey(scope));
    return value ? structuredClone(value) : null;
  }

  missingMigrationFields(candidateOrStatus, existing = {}) {
    const fields = candidateOrStatus?.fields
      ? Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(candidateOrStatus.fields[key])]))
      : secretFieldPresence(candidateOrStatus?.secrets);
    return missingSecretFields(fields, existing);
  }

  missingMigrationSecrets(candidate, existing = {}) {
    return missingSecretValues(candidate?.secrets, existing);
  }

  migrationComplete(candidateOrStatus, existing = {}) {
    return !hasAnyField(this.missingMigrationFields(candidateOrStatus, existing));
  }

  clearMigration(scope) {
    return this.pendingMigrations.delete(this.migrationKey(scope));
  }

  invalidatePlugin(projectId,environmentId,pluginInstanceId) {
    return this.pendingMigrations.delete(this.migrationKey({projectId,environmentId,pluginInstanceId}));
  }

  invalidateEnvironment(projectId,environmentId) {
    const prefix = `${projectId}/${environmentId}/`;
    let removed = 0;
    for (const key of this.pendingMigrations.keys()) {
      if (key.startsWith(prefix) && this.pendingMigrations.delete(key)) removed += 1;
    }
    return removed;
  }

  invalidateProject(projectId) {
    const prefix = `${projectId}/`;
    let removed = 0;
    for (const key of this.pendingMigrations.keys()) {
      if (key.startsWith(prefix) && this.pendingMigrations.delete(key)) removed += 1;
    }
    return removed;
  }

  async readMigrationCandidate(projectId, currentConfig) {
    let source;
    try { source = await fs.readFile(this.filePath(projectId)); }
    catch (error) {
      if (error?.code === 'ENOENT') return {status:'absent'};
      return {status:'unreadable',errorCode:'CREDENTIAL_STORAGE_FAILED'};
    }
    const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
    let envelope;
    try { envelope = JSON.parse(source.toString('utf8')); }
    catch { return {status:'unreadable',sourceSha256,errorCode:'CREDENTIAL_STORAGE_FAILED'}; }
    const formatVersion = Number(envelope?.version);
    if (![1,2].includes(formatVersion) || typeof envelope?.ciphertext !== 'string') {
      return {status:'unsupported',formatVersion:Number.isFinite(formatVersion) ? formatVersion : null,sourceSha256};
    }
    if (!this.encryption?.isEncryptionAvailable?.()) {
      return {status:'unreadable',formatVersion,sourceSha256,errorCode:'CREDENTIAL_STORAGE_UNAVAILABLE'};
    }
    let payload;
    try {
      const plaintext = this.encryption.decryptString(Buffer.from(envelope.ciphertext,'base64'));
      payload = JSON.parse(String(plaintext));
    } catch {
      return {status:'unreadable',formatVersion,sourceSha256,errorCode:'CREDENTIAL_STORAGE_FAILED'};
    }
    const payloadShapeValid = formatVersion === 1
      ? strictObject(payload,new Set(SECRET_KEYS))
      : strictObject(payload,new Set(['binding','secrets']));
    const secrets = payloadShapeValid
      ? cleanMigrationSecrets(formatVersion === 1 ? payload : payload.secrets)
      : null;
    if (!secrets) {
      return {status:'unreadable',formatVersion,sourceSha256,errorCode:'CREDENTIAL_STORAGE_FAILED'};
    }
    if (!Object.keys(secrets).length) {
      return {status:'unreadable',formatVersion,sourceSha256,errorCode:'CREDENTIAL_NOT_FOUND'};
    }
    const currentBinding = credentialBinding(currentConfig);
    const currentBindingSummary = bindingSummary(currentBinding);
    if (formatVersion === 1) {
      // V1 stored the envelope inside the project directory and had no binding
      // field. Migration preserves that original directory-as-scope contract.
      return {status:'verified',verification:'legacy-project-directory',formatVersion,sourceSha256,currentBinding:currentBindingSummary,secrets};
    }
    const sourceBinding = normalizeStoredBinding(payload?.binding);
    if (!sourceBinding) {
      return {status:'unreadable',formatVersion,sourceSha256,errorCode:'CREDENTIAL_STORAGE_FAILED'};
    }
    if (JSON.stringify(sourceBinding) === JSON.stringify(currentBinding)) {
      return {
        status:'verified',verification:'exact-binding',formatVersion,sourceSha256,
        sourceBinding:bindingSummary(sourceBinding),currentBinding:currentBindingSummary,secrets,
      };
    }
    return {
      status:'confirmation-required',formatVersion,sourceSha256,
      sourceBinding:bindingSummary(sourceBinding),currentBinding:currentBindingSummary,
      changedFields:bindingChanges(sourceBinding,currentBinding),secrets,
    };
  }

  async load(projectId, config) {
    let envelope;
    try {
      envelope = JSON.parse(await fs.readFile(this.filePath(projectId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new AppError('CREDENTIAL_STORAGE_FAILED', '无法读取已保存的登录凭据。');
    }
    try {
      if (envelope.version !== ENVELOPE_VERSION || typeof envelope.ciphertext !== 'string') {
        throw new AppError(
          'CREDENTIAL_REENTRY_REQUIRED',
          '保存的凭据来自旧版本，请重新输入一次以完成安全升级。',
        );
      }
      const plaintext = this.encryption.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
      const payload = JSON.parse(plaintext);
      if (
        !payload ||
        typeof payload !== 'object' ||
        !payload.binding ||
        JSON.stringify(payload.binding) !== JSON.stringify(credentialBinding(config))
      ) {
        throw new AppError(
          'CREDENTIAL_SCOPE_CHANGED',
          '服务器、账号、认证方式或代理已经变化，请重新输入登录凭据。',
        );
      }
      return cleanSecrets(payload.secrets);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CREDENTIAL_STORAGE_FAILED', '已保存的登录凭据无法解密，请重新输入。');
    }
  }

  async save(projectId, secrets, config) {
    const clean = cleanSecrets(secrets);
    if (Object.keys(clean).length === 0) {
      return { saved:false, preserved:await this.has(projectId) };
    }
    if (!this.encryption.isEncryptionAvailable()) {
      throw new AppError('CREDENTIAL_STORAGE_UNAVAILABLE', 'Windows 安全存储当前不可用。');
    }
    let encrypted;
    try {
      encrypted = this.encryption.encryptString(
        JSON.stringify({ binding: credentialBinding(config), secrets: clean }),
      );
    } catch {
      throw new AppError('CREDENTIAL_STORAGE_FAILED', '无法使用 Windows 安全存储加密登录凭据。');
    }
    const target = this.filePath(projectId);
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const envelope = JSON.stringify({ version: ENVELOPE_VERSION, ciphertext: encrypted.toString('base64') });
    try {
      await fs.writeFile(temp, envelope, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async hasUsable(projectId, config) {
    if (!(await this.has(projectId))) return false;
    try {
      await this.load(projectId, config);
      return true;
    } catch {
      return false;
    }
  }

  async clear(projectId) {
    return { cleared:false, preserved:await this.has(projectId) };
  }
}
