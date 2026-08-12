import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
import { AppError } from './errors.mjs';
import { evaluateCommandPolicy } from './command-policy.mjs';
import { createProxySocket } from './proxy.mjs';

const MAX_COMMAND_OUTPUT = 512 * 1024;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXTS_PER_PROJECT = 32;
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const { Client } = ssh2;

function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function collect(stream, limit, onLimit) {
  const chunks = [];
  let size = 0;
  stream.on('data', (chunk) => {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size <= limit) chunks.push(buffer);
    else onLimit();
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

function execOnClient(client, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (error, channel) => {
      if (error) {
        reject(new AppError('SSH_EXEC_FAILED', '无法在服务器上执行命令。'));
        return;
      }
      let ended = false;
      let exitCode = null;
      let signal = null;
      const abortForOutput = () => {
        if (ended) return;
        ended = true;
        channel.close();
        clearTimeout(timer);
        reject(new AppError('COMMAND_OUTPUT_TOO_LARGE', '命令的标准输出或错误输出超过 512 KB 限制，请改为下载日志文件。'));
      };
      const stdout = collect(channel, MAX_COMMAND_OUTPUT, abortForOutput);
      const stderr = collect(channel.stderr, MAX_COMMAND_OUTPUT, abortForOutput);
      channel.on('exit', (code, sig) => {
        exitCode = typeof code === 'number' ? code : null;
        signal = sig || null;
      });
      const timer = setTimeout(() => {
        if (ended) return;
        ended = true;
        channel.close();
        reject(new AppError('COMMAND_TIMEOUT', '服务器命令执行超时。'));
      }, timeoutMs);
      channel.on('close', () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        resolve({ exitCode, signal, stdout: stdout(), stderr: stderr() });
      });
      channel.on('error', () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        reject(new AppError('SSH_EXEC_FAILED', '服务器命令通道异常关闭。'));
      });
    });
  });
}

function withSftp(client, action) {
  return new Promise((resolve, reject) => {
    client.sftp(async (error, sftp) => {
      if (error) {
        reject(new AppError('SFTP_UNAVAILABLE', '无法建立 SFTP 文件传输通道。'));
        return;
      }
      try {
        resolve(await action(sftp));
      } catch (cause) {
        reject(cause instanceof AppError ? cause : new AppError('TRANSFER_FAILED', '文件传输失败。'));
      } finally {
        sftp.end();
      }
    });
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function sftpRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
  });
}

function sftpUnlink(sftp, target) {
  return new Promise((resolve) => sftp.unlink(target, () => resolve()));
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
  });
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function sameFileSnapshot(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

function redactCommand(command) {
  const value = String(command);
  if (/(password|passwd|token|secret|authorization|api[_-]?key)/i.test(value)) {
    return '<sensitive command redacted>';
  }
  return value.slice(0, 4096);
}

export class SshBroker {
  constructor(projectStore, { reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS } = {}) {
    this.store = projectStore;
    this.sessions = new Map();
    this.generations = new Map();
    this.contexts = new Map();
    this.pendingConnections = new Map();
    this.connectionOperations = new Map();
    this.autoReconnectProjects = new Set();
    this.reconnectStates = new Map();
    this.reconnectHandler = null;
    this.reconnectDelaysMs = reconnectDelaysMs.length ? [...reconnectDelaysMs] : [1_000];
    this.shuttingDown = false;
  }

  status(projectId) {
    const session = this.sessions.get(projectId);
    const reconnect = this.reconnectStates.get(projectId);
    return {
      connected: Boolean(session),
      connecting: this.pendingConnections.has(projectId),
      reconnecting: Boolean(reconnect),
      reconnectAttempt: reconnect?.attempt ?? 0,
      nextReconnectAt: reconnect?.nextRetryAt ?? null,
      reconnectErrorCode: reconnect?.lastErrorCode ?? null,
      autoReconnectEnabled: this.autoReconnectProjects.has(projectId),
      generation: session?.generation ?? this.generations.get(projectId) ?? 0,
      connectedAt: session?.connectedAt ?? null,
    };
  }

  listStatuses() {
    const projectIds = new Set([
      ...this.sessions.keys(),
      ...this.pendingConnections.keys(),
      ...this.reconnectStates.keys(),
    ]);
    return Object.fromEntries([...projectIds].map((id) => [id, this.status(id)]));
  }

  setReconnectHandler(handler) {
    this.reconnectHandler = handler;
  }

  enableAutoReconnect(projectId) {
    if (this.shuttingDown) return;
    this.autoReconnectProjects.add(projectId);
    if (!this.sessions.has(projectId) && !this.pendingConnections.has(projectId)) {
      this.scheduleAutoReconnect(projectId, 'enabled-after-connection-loss');
    }
  }

  stopAutoReconnect(projectId) {
    this.autoReconnectProjects.delete(projectId);
    const state = this.reconnectStates.get(projectId);
    if (state?.timer) clearTimeout(state.timer);
    this.reconnectStates.delete(projectId);
  }

  clearReconnectState(projectId) {
    const state = this.reconnectStates.get(projectId);
    if (state?.timer) clearTimeout(state.timer);
    this.reconnectStates.delete(projectId);
  }

  scheduleAutoReconnect(projectId, reason) {
    if (
      this.shuttingDown ||
      !this.autoReconnectProjects.has(projectId) ||
      !this.reconnectHandler ||
      this.sessions.has(projectId)
    ) return;
    const current = this.reconnectStates.get(projectId);
    if (current?.timer || current?.inProgress) return;
    const attempt = (current?.attempt ?? 0) + 1;
    const delayMs = this.reconnectDelaysMs[Math.min(attempt - 1, this.reconnectDelaysMs.length - 1)];
    const state = {
      attempt,
      reason,
      inProgress: false,
      lastErrorCode: current?.lastErrorCode ?? null,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      timer: null,
    };
    state.timer = setTimeout(() => this.runAutoReconnect(projectId, state), delayMs);
    state.timer.unref?.();
    this.reconnectStates.set(projectId, state);
  }

  async runAutoReconnect(projectId, state) {
    if (this.reconnectStates.get(projectId) !== state) return;
    state.timer = null;
    state.inProgress = true;
    state.nextRetryAt = null;
    try {
      await this.reconnectHandler(projectId);
      if (!this.autoReconnectProjects.has(projectId)) return;
      this.clearReconnectState(projectId);
      await this.store.appendAudit(projectId, {
        type: 'auto-reconnect',
        result: 'success',
        attempt: state.attempt,
      }).catch(() => undefined);
    } catch (error) {
      if (!this.autoReconnectProjects.has(projectId) || this.shuttingDown) {
        this.clearReconnectState(projectId);
        return;
      }
      state.inProgress = false;
      state.lastErrorCode = error?.code ?? 'SSH_CONNECTION_FAILED';
      await this.store.appendAudit(projectId, {
        type: 'auto-reconnect',
        result: 'failed',
        attempt: state.attempt,
        errorCode: state.lastErrorCode,
      }).catch(() => undefined);
      this.scheduleAutoReconnect(projectId, 'retry');
    }
  }

  connectAutomatically(projectId, secrets = {}) {
    return this.runConnectionOperation(projectId, async () => {
      if (!this.autoReconnectProjects.has(projectId) || this.shuttingDown) {
        throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 自动重连已取消。');
      }
      return this.connectUnlocked(projectId, secrets);
    });
  }

  runConnectionOperation(projectId, operation) {
    const previous = this.connectionOperations.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.connectionOperations.set(projectId, current);
    return current.finally(() => {
      if (this.connectionOperations.get(projectId) === current) {
        this.connectionOperations.delete(projectId);
      }
    });
  }

  connect(projectId, secrets = {}) {
    return this.runConnectionOperation(projectId, () => this.connectUnlocked(projectId, secrets));
  }

  async connectUnlocked(projectId, secrets = {}) {
    const config = await this.store.get(projectId);
    await this.disconnectUnlocked(projectId, 'reconnect');
    const attempt = {
      id: crypto.randomUUID(),
      cancelled: false,
      failed: false,
      client: null,
      sock: null,
    };
    this.pendingConnections.set(projectId, attempt);
    let sock;
    let client;
    let observedFingerprint = null;
    let settled = false;
    let privateKey;
    let publishedRecord;
    try {
      if (config.auth.type === 'privateKey') {
        if (!config.auth.privateKeyPath) {
          throw new AppError('SSH_IDENTITY_UNAVAILABLE', '项目没有配置私钥文件。');
        }
        try {
          privateKey = await fsp.readFile(config.auth.privateKeyPath);
        } catch {
          throw new AppError('SSH_IDENTITY_UNAVAILABLE', '无法读取配置的 SSH 私钥文件。');
        }
        const parsedKey = ssh2.utils.parseKey(
          privateKey,
          secrets.privateKeyPassphrase ? String(secrets.privateKeyPassphrase) : undefined,
        );
        if (parsedKey instanceof Error) {
          throw new AppError(
            'SSH_IDENTITY_UNAVAILABLE',
            'SSH 私钥格式不受支持，或私钥口令不正确。',
          );
        }
      }
      this.assertPendingConnection(projectId, attempt);
      sock = await createProxySocket(
        config.proxy,
        { host: config.ssh.host, port: config.ssh.port },
        secrets,
      );
      attempt.sock = sock;
      this.assertPendingConnection(projectId, attempt);
      client = new Client();
      attempt.client = client;
      const connectionConfig = {
        host: config.ssh.host,
        port: config.ssh.port,
        username: config.ssh.username,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        ...(sock ? { sock } : {}),
        ...(config.auth.type === 'password' ? { password: String(secrets.password ?? '') } : {}),
        ...(config.auth.type === 'privateKey'
          ? {
              privateKey,
              ...(secrets.privateKeyPassphrase
                ? { passphrase: String(secrets.privateKeyPassphrase) }
                : {}),
            }
          : {}),
        ...(config.auth.type === 'agent'
          ? {
              agent:
                config.auth.agentSocket ||
                process.env.SSH_AUTH_SOCK ||
                (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined),
            }
          : {}),
        hostVerifier: (key) => {
          observedFingerprint = fingerprint(key);
          if (config.ssh.hostKeyFingerprint) {
            return observedFingerprint === config.ssh.hostKeyFingerprint;
          }
          return observedFingerprint === secrets.acceptHostKey;
        },
      };
      const session = await new Promise((resolve, reject) => {
        const fail = () => {
          attempt.failed = true;
          if (settled) return;
          settled = true;
          client.end();
          sock?.destroy();
          if (attempt.cancelled) {
            reject(new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。'));
          } else if (observedFingerprint && !config.ssh.hostKeyFingerprint && secrets.acceptHostKey !== observedFingerprint) {
            reject(new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED', '首次连接需要确认服务器指纹。', { fingerprint: observedFingerprint }));
          } else if (
            observedFingerprint &&
            config.ssh.hostKeyFingerprint &&
            observedFingerprint !== config.ssh.hostKeyFingerprint
          ) {
            reject(new AppError('SSH_HOST_KEY_CHANGED', '服务器 SSH 指纹与项目记录不一致。', { fingerprint: observedFingerprint }));
          } else {
            reject(new AppError('SSH_CONNECTION_FAILED', 'SSH 连接或认证失败。'));
          }
        };
        // Keep this listener for the full client lifetime. Once the initial
        // connection has settled it becomes a no-op, but it still prevents a
        // later TCP reset from surfacing as an uncaught EventEmitter error.
        client.on('error', fail);
        client.once('ready', () => {
          if (settled) return;
          settled = true;
          resolve({ client, observedFingerprint });
        });
        client.connect(connectionConfig);
      });
      this.assertPendingConnection(projectId, attempt);
      if (!config.ssh.hostKeyFingerprint && session.observedFingerprint) {
        await this.store.update(projectId, {
          ssh: { hostKeyFingerprint: session.observedFingerprint },
        });
      }
      this.assertPendingConnection(projectId, attempt);
      const generation = (this.generations.get(projectId) ?? 0) + 1;
      this.generations.set(projectId, generation);
      const record = { client: session.client, generation, connectedAt: new Date().toISOString() };
      publishedRecord = record;
      this.sessions.set(projectId, record);
      this.clearReconnectState(projectId);
      const clearInterruptedSession = (reason) => {
        if (this.sessions.get(projectId) === record) {
          this.sessions.delete(projectId);
          this.invalidateProjectContexts(projectId);
          this.store
            .appendAudit(projectId, { type: 'disconnect', reason, result: 'connection-lost' })
            .catch(() => undefined);
          this.scheduleAutoReconnect(projectId, reason);
        }
      };
      session.client.on('error', () => clearInterruptedSession('connection-error'));
      session.client.on('close', () => clearInterruptedSession('connection-closed'));
      let auditWarning = false;
      try {
        await this.store.appendAudit(projectId, { type: 'connect', result: 'success' });
      } catch {
        auditWarning = true;
      }
      if (this.pendingConnections.get(projectId) === attempt) {
        this.pendingConnections.delete(projectId);
      }
      return { ...this.status(projectId), fingerprint: session.observedFingerprint, auditWarning };
    } catch (error) {
      if (publishedRecord && this.sessions.get(projectId) === publishedRecord) {
        this.sessions.delete(projectId);
        this.invalidateProjectContexts(projectId);
      }
      client?.end();
      sock?.destroy();
      throw error;
    } finally {
      privateKey?.fill(0);
      if (this.pendingConnections.get(projectId) === attempt) {
        this.pendingConnections.delete(projectId);
      }
    }
  }

  assertPendingConnection(projectId, attempt) {
    if (
      attempt.cancelled ||
      attempt.failed ||
      this.pendingConnections.get(projectId) !== attempt
    ) {
      throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。');
    }
  }

  cancelPendingConnection(projectId) {
    const pending = this.pendingConnections.get(projectId);
    if (!pending) return;
    pending.cancelled = true;
    this.pendingConnections.delete(projectId);
    pending.client?.end();
    pending.sock?.destroy();
  }

  disconnect(projectId, reason = 'user') {
    if (reason !== 'reconnect') this.stopAutoReconnect(projectId);
    this.cancelPendingConnection(projectId);
    return this.runConnectionOperation(projectId, () => this.disconnectUnlocked(projectId, reason));
  }

  async disconnectUnlocked(projectId, reason = 'user') {
    const session = this.sessions.get(projectId);
    if (!session) return { connected: false };
    this.sessions.delete(projectId);
    this.generations.set(projectId, session.generation + 1);
    this.invalidateProjectContexts(projectId);
    const closed = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      session.client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    session.client.end();
    await closed;
    let auditWarning = false;
    try {
      await this.store.appendAudit(projectId, { type: 'disconnect', reason, result: 'success' });
    } catch {
      auditWarning = true;
    }
    return { connected: false, auditWarning };
  }

  async closeAll() {
    this.shuttingDown = true;
    const projectIds = new Set([
      ...this.sessions.keys(),
      ...this.pendingConnections.keys(),
      ...this.connectionOperations.keys(),
      ...this.autoReconnectProjects.keys(),
      ...this.reconnectStates.keys(),
    ]);
    await Promise.all([...projectIds].map((id) => this.disconnect(id, 'app-exit')));
  }

  invalidateProjectContexts(projectId) {
    for (const [token, context] of this.contexts) {
      if (context.projectId === projectId) this.contexts.delete(token);
    }
  }

  async openContext(projectId, expectedDocsHash) {
    const session = this.requireSession(projectId);
    const { docsHash, truncated } = await this.store.readContext(projectId);
    if (truncated) {
      throw new AppError('PROJECT_DOCUMENTS_TRUNCATED', '项目文档总量超过读取限制，不能执行服务器操作。');
    }
    if (!expectedDocsHash || docsHash !== expectedDocsHash) {
      throw new AppError('PROJECT_CONTEXT_CHANGED', '项目文档在读取期间发生变化，请重新打开项目。');
    }
    const now = Date.now();
    for (const [existingToken, context] of this.contexts) {
      if (now - context.createdAt > CONTEXT_TTL_MS) this.contexts.delete(existingToken);
    }
    const sameProject = [...this.contexts.entries()]
      .filter(([, context]) => context.projectId === projectId)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (sameProject.length >= MAX_CONTEXTS_PER_PROJECT) {
      this.contexts.delete(sameProject.shift()[0]);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    this.contexts.set(token, {
      projectId,
      docsHash,
      generation: session.generation,
      createdAt: now,
    });
    return { contextToken: token, generation: session.generation };
  }

  requireSession(projectId) {
    const session = this.sessions.get(projectId);
    if (!session) throw new AppError('SSH_NOT_CONNECTED', '项目当前未连接，请先在桌面工具中点击连接。');
    return session;
  }

  async requireContext(projectId, contextToken) {
    const session = this.requireSession(projectId);
    const context = this.contexts.get(String(contextToken ?? ''));
    if (!context || context.projectId !== projectId || context.generation !== session.generation) {
      throw new AppError('PROJECT_CONTEXT_REQUIRED', '项目文档尚未读取或连接已经变化，请重新打开项目。');
    }
    if (Date.now() - context.createdAt > CONTEXT_TTL_MS) {
      this.contexts.delete(contextToken);
      throw new AppError('PROJECT_CONTEXT_REQUIRED', '项目操作授权已经过期，请重新打开项目。');
    }
    const { docsHash } = await this.store.readContext(projectId);
    if (docsHash !== context.docsHash) {
      this.contexts.delete(contextToken);
      throw new AppError('PROJECT_CONTEXT_REQUIRED', '项目文档已经更新，请重新打开项目。');
    }
    return session;
  }

  async appendAuditSafe(projectId, entry) {
    try {
      await this.store.appendAudit(projectId, entry);
      return false;
    } catch {
      return true;
    }
  }

  async execute(projectId, contextToken, command, workingDirectory) {
    const session = await this.requireContext(projectId, contextToken);
    const config = await this.store.get(projectId);
    const raw = String(command ?? '').trim();
    if (!raw) throw new AppError('INVALID_ARGUMENT', '命令不能为空。');
    if (raw.length > 16_384) throw new AppError('INVALID_ARGUMENT', '命令过长。');
    const policyDecision = evaluateCommandPolicy(raw, config.commandPolicy);
    if (!policyDecision.allowed) {
      const auditWarning = await this.appendAuditSafe(projectId, {
        type: 'execute-blocked',
        result: 'denied',
        ruleId: policyDecision.ruleId,
        reason: policyDecision.reason,
        policyVersion: policyDecision.policyVersion,
        commandSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        workingDirectory: workingDirectory || null,
      });
      throw new AppError(
        'COMMAND_BLOCKED',
        `命令已被安全策略拦截：${policyDecision.reason}`,
        {
          ruleId: policyDecision.ruleId,
          reason: policyDecision.reason,
          policyVersion: policyDecision.policyVersion,
          auditWarning,
        },
      );
    }
    const finalCommand = workingDirectory
      ? `cd -- ${quotePosix(workingDirectory)} && ${raw}`
      : raw;
    const started = Date.now();
    const result = await execOnClient(
      session.client,
      finalCommand,
      Math.max(1, Number(config.limits.commandTimeoutSeconds ?? 180)) * 1000,
    );
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'execute',
      command: redactCommand(raw),
      commandSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      workingDirectory: workingDirectory || null,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
    });
    return { ...result, auditWarning };
  }

  async upload(projectId, contextToken, localPath, remotePath) {
    const session = await this.requireContext(projectId, contextToken);
    const config = await this.store.get(projectId);
    const source = path.resolve(String(localPath ?? ''));
    const target = String(remotePath ?? '').trim();
    if (!target || target.includes('\0')) throw new AppError('PATH_INVALID', '远程路径无效。');
    const stats = await fsp.lstat(source).catch(() => {
      throw new AppError('PATH_INVALID', '本地产物不存在。');
    });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new AppError('PATH_INVALID', '只能上传非符号链接的普通文件。');
    }
    const maxBytes = Number(config.limits.maxUploadMB ?? 500) * 1024 * 1024;
    if (stats.size > maxBytes) throw new AppError('FILE_TOO_LARGE', '上传文件超过项目限制。');
    const hash = await hashFile(source);
    const afterHash = await fsp.lstat(source);
    if (!sameFileSnapshot(stats, afterHash)) {
      throw new AppError('LOCAL_FILE_CHANGED', '本地产物在校验期间发生变化，请重新上传。');
    }
    const temp = `${target}.part-${crypto.randomBytes(6).toString('hex')}`;
    await withSftp(session.client, async (sftp) => {
      try {
        await sftpFastPut(sftp, source, temp);
        const [remoteStats, afterUpload] = await Promise.all([
          sftpStat(sftp, temp),
          fsp.lstat(source),
        ]);
        if (remoteStats.size !== stats.size || !sameFileSnapshot(stats, afterUpload)) {
          throw new AppError('TRANSFER_INTEGRITY_FAILED', '上传期间文件发生变化或远端大小不一致。');
        }
        await sftpRename(sftp, temp, target);
      } catch (error) {
        await sftpUnlink(sftp, temp);
        throw error;
      }
    });
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'upload',
      localName: path.basename(source),
      remotePath: target,
      sizeBytes: stats.size,
      sha256: hash,
    });
    return { localPath: source, remotePath: target, sizeBytes: stats.size, sha256: hash, auditWarning };
  }

  async download(projectId, contextToken, remotePath) {
    const session = await this.requireContext(projectId, contextToken);
    const config = await this.store.get(projectId);
    const source = String(remotePath ?? '').trim();
    if (!source || source.includes('\0')) throw new AppError('PATH_INVALID', '远程路径无效。');
    const downloadsDir = this.store.downloadsDir(projectId);
    await fsp.mkdir(downloadsDir, { recursive: true });
    const base = path.posix.basename(source).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'download.log';
    const operationId = crypto.randomBytes(8).toString('hex');
    const finalPath = path.join(downloadsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${operationId}-${base}`);
    const tempPath = `${finalPath}.part`;
    let sizeBytes = 0;
    try {
      await withSftp(session.client, async (sftp) => {
        const stats = await sftpStat(sftp, source).catch(() => {
          throw new AppError('PATH_INVALID', '远程文件不存在或无权读取。');
        });
        if (!stats.isFile()) throw new AppError('PATH_INVALID', '只能下载普通文件。');
        sizeBytes = stats.size;
        const maxBytes = Number(config.limits.maxDownloadMB ?? 100) * 1024 * 1024;
        if (sizeBytes > maxBytes) throw new AppError('FILE_TOO_LARGE', '下载文件超过项目限制。');
        await sftpFastGet(sftp, source, tempPath);
      });
      const downloadedStats = await fsp.stat(tempPath);
      const maxBytes = Number(config.limits.maxDownloadMB ?? 100) * 1024 * 1024;
      if (downloadedStats.size > maxBytes) {
        throw new AppError('FILE_TOO_LARGE', '下载文件在传输期间超过项目限制。');
      }
      sizeBytes = downloadedStats.size;
      await fsp.rename(tempPath, finalPath);
    } catch (error) {
      await fsp.rm(tempPath, { force: true });
      throw error;
    }
    const hash = await hashFile(finalPath);
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'download',
      remotePath: source,
      localName: path.basename(finalPath),
      sizeBytes,
      sha256: hash,
    });
    return { remotePath: source, localPath: finalPath, sizeBytes, sha256: hash, auditWarning };
  }
}
