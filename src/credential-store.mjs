import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const SECRET_KEYS = ['password', 'privateKeyPassphrase', 'proxyPassword'];
const ENVELOPE_VERSION = 2;

function cleanSecrets(input = {}) {
  return Object.fromEntries(
    SECRET_KEYS.flatMap((key) => {
      const value = String(input[key] ?? '');
      return value ? [[key, value]] : [];
    }),
  );
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

export function sameCredentialBinding(left, right) {
  return JSON.stringify(credentialBinding(left)) === JSON.stringify(credentialBinding(right));
}

export class CredentialStore {
  constructor(projectStore, encryption) {
    this.projectStore = projectStore;
    this.encryption = encryption;
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
