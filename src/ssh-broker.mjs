import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
import { AppError } from './errors.mjs';
import { evaluateCommandPolicy } from './command-policy.mjs';
import { LogSearchCursorStore, searchLogSnapshots } from './log-search.mjs';
import { createProxySocket } from './proxy.mjs';

const MAX_COMMAND_OUTPUT = 512 * 1024;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXTS_PER_PROJECT = 32;
const CONTEXT_REUSE_MIN_REMAINING_MS = 60 * 1000;
const SFTP_CLEANUP_GRACE_MS = 1_000;
const SFTP_READ_INACTIVITY_MS = 30_000;
const SFTP_READ_SESSION_TIMEOUT_MS = 120_000;
const SFTP_READ_CHUNK_BYTES = 64 * 1024;
const SFTP_METADATA_CONCURRENCY = 16;
const NON_RETRYABLE_RECONNECT_ERRORS = new Set([
  'SSH_AUTH_FAILED',
  'SSH_IDENTITY_UNAVAILABLE',
  'SSH_HOST_KEY_CONFIRM_REQUIRED',
  'SSH_HOST_KEY_CHANGED',
  'CREDENTIAL_STORAGE_FAILED',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'PROXY_CONFIG_INVALID',
  'PROJECT_NOT_FOUND',
]);
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const { Client } = ssh2;

function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function mapLimit(values, limit, operation) {
  const items = Array.from(values);
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
        reject(new AppError(
          'COMMAND_OUTPUT_TOO_LARGE',
          '命令的标准输出或错误输出超过 512 KB 限制，请改用结构化日志搜索或下载日志文件。',
          { outputLimitBytes: MAX_COMMAND_OUTPUT, truncated: true },
        ));
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

function isSftpInterruptedError(error) {
  if (!error) return false;
  if (error instanceof AppError && error.code === 'TRANSFER_INTERRUPTED') return true;
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT'].includes(error.code)) return true;
  if (['client-socket', 'client-timeout'].includes(error.level)) return true;
  return /no response from server|channel.*(?:closed|ended)|connection.*(?:closed|lost|reset)|socket.*(?:closed|ended)/i.test(
    String(error.message ?? ''),
  );
}

function transferError(error) {
  if (error instanceof AppError) return error;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (code === '2' || code === 'ENOENT' || /no such file|not found/i.test(message)) {
    return new AppError('SOURCE_NOT_FOUND', '服务器上的日志或配置路径不存在。');
  }
  if (code === '3' || code === 'EACCES' || code === 'EPERM' || /permission denied|access denied/i.test(message)) {
    return new AppError('SOURCE_ACCESS_DENIED', '当前 SSH 用户无权读取该日志或配置路径。');
  }
  if (isSftpInterruptedError(error)) {
    return new AppError('TRANSFER_INTERRUPTED', 'SSH/SFTP 连接在文件操作完成前中断，请重新连接后确认结果。');
  }
  return new AppError('TRANSFER_FAILED', '文件传输失败。');
}

function withSftp(client, action, { timeoutMs = 0, timeoutCode = 'TRANSFER_TIMEOUT', timeoutMessage = '文件传输超时。' } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let sftp = null;
    let settled = false;
    let closing = false;
    let timeoutTimer = null;
    let forceCloseTimer = null;

    const safeEnd = () => {
      if (!sftp || closing) return;
      closing = true;
      try {
        sftp.end();
      } catch {
        // A closed channel needs no further cleanup. Runtime errors remain
        // observed by onSftpError until the channel emits close.
      }
    };
    const abort = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
      if (!forceCloseTimer) {
        forceCloseTimer = setTimeout(() => {
          safeEnd();
          finish(
            controller.signal.reason
              ?? new AppError('TRANSFER_INTERRUPTED', 'SSH/SFTP 文件操作未能完成。'),
          );
        }, SFTP_CLEANUP_GRACE_MS);
        forceCloseTimer.unref?.();
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceCloseTimer);
      safeEnd();
      if (error) reject(transferError(error));
      else resolve(value);
    };
    const onSftpError = (error) => abort(transferError(error));
    const onSftpEnd = () => {
      if (!settled) {
        abort(new AppError('TRANSFER_INTERRUPTED', 'SSH/SFTP 通道在文件操作完成前关闭。'));
      }
    };
    const onSftpClose = () => {
      onSftpEnd();
      sftp?.removeListener('error', onSftpError);
      sftp?.removeListener('end', onSftpEnd);
      sftp?.removeListener('close', onSftpClose);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(
        () => abort(new AppError(timeoutCode, timeoutMessage)),
        timeoutMs,
      );
      timeoutTimer.unref?.();
    }

    try {
      client.sftp((error, openedSftp) => {
        if (error) {
          if (!settled) {
            finish(
              controller.signal.reason
                ?? new AppError('SFTP_UNAVAILABLE', '无法建立 SFTP 文件传输通道。'),
            );
          }
          return;
        }
        sftp = openedSftp;
        sftp.on('error', onSftpError);
        sftp.on('end', onSftpEnd);
        sftp.on('close', onSftpClose);
        if (settled || controller.signal.aborted) {
          safeEnd();
          if (!settled) finish(controller.signal.reason);
          return;
        }
        Promise.resolve()
          .then(() => action(sftp, { signal: controller.signal, abort }))
          .then(
            (value) => finish(controller.signal.reason ?? null, value),
            (error) => finish(controller.signal.reason ?? error),
          );
      });
    } catch (error) {
      finish(new AppError('SFTP_UNAVAILABLE', '无法建立 SFTP 文件传输通道。'));
    }
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function sftpLstat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, entries) => (error ? reject(error) : resolve(entries)));
  });
}

function sftpRealpath(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
}

function sftpOpen(sftp, remotePath, flags = 'r') {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, flags, (error, handle) => (error ? reject(error) : resolve(handle)));
  });
}

function sftpRead(sftp, handle, buffer, position) {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, buffer.length, position, (error, bytesRead) =>
      (error ? reject(error) : resolve(bytesRead)));
  });
}

function sftpCloseHandle(sftp, handle) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()));
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new AppError('TRANSFER_INTERRUPTED', 'SSH/SFTP 文件操作已中止。');
}

async function sftpReadRange(sftp, remotePath, start, maxBytes, { signal, abort } = {}) {
  if (maxBytes <= 0) return Buffer.alloc(0);
  throwIfAborted(signal);
  const handle = await sftpOpen(sftp, remotePath);
  const chunks = [];
  let total = 0;
  let primaryError = null;
  try {
    while (total < maxBytes) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(SFTP_READ_CHUNK_BYTES, maxBytes - total));
      let inactivityTimer;
      const read = sftpRead(sftp, handle, buffer, start + total);
      const inactivity = new Promise((_, reject) => {
        inactivityTimer = setTimeout(() => {
          const error = new AppError('LOG_SCAN_TIMEOUT', '读取服务器日志超时。');
          abort?.(error);
          reject(error);
        }, SFTP_READ_INACTIVITY_MS);
        inactivityTimer.unref?.();
      });
      let bytesRead;
      try {
        bytesRead = await Promise.race([read, inactivity]);
      } finally {
        clearTimeout(inactivityTimer);
      }
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
  } catch (error) {
    primaryError = error;
  }
  if (!signal?.aborted) {
    try {
      await sftpCloseHandle(sftp, handle);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  throwIfAborted(signal);
  return Buffer.concat(chunks, total);
}

function sftpRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
  });
}

function sftpUnlink(sftp, target) {
  return new Promise((resolve) => sftp.unlink(target, () => resolve()));
}

function sftpUnlinkStrict(sftp, target) {
  return new Promise((resolve, reject) => sftp.unlink(target, (error) => (error ? reject(error) : resolve())));
}

function sftpRmdir(sftp, target) {
  return new Promise((resolve, reject) => sftp.rmdir(target, (error) => (error ? reject(error) : resolve())));
}

function sftpWriteFile(sftp, target, content) {
  return new Promise((resolve, reject) => sftp.writeFile(target, content, (error) => (error ? reject(error) : resolve())));
}

function sftpChmod(sftp, target, mode) {
  return new Promise((resolve, reject) => sftp.chmod(target, mode, (error) => (error ? reject(error) : resolve())));
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

function normalizeRemoteLogPath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text || text.length > 4096 || text.includes('\0') || !text.startsWith('/')) {
    throw new AppError('PATH_INVALID', '日志文件必须是服务器上的绝对路径。');
  }
  return path.posix.normalize(text);
}

function normalizeAbsoluteRemotePath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text || text.length > 4096 || text.includes('\0') || !text.startsWith('/')) {
    throw new AppError('PATH_INVALID', '服务器文件必须使用绝对路径。');
  }
  return path.posix.normalize(text);
}

function remoteType(stats) {
  if (stats.isSymbolicLink?.()) return 'symlink';
  if (stats.isDirectory?.()) return 'directory';
  if (stats.isFile?.()) return 'file';
  return 'special';
}

function remoteSnapshot(remotePath, stats, canonicalPath = null) {
  return {
    exists:true,
    path:remotePath,
    canonicalPath,
    type:remoteType(stats),
    size:Number(stats.size ?? 0),
    mtime:Number(stats.mtime ?? 0),
    mode:Number(stats.mode ?? 0),
  };
}

function snapshotMatches(actual, expected) {
  return Boolean(actual?.exists) === Boolean(expected?.exists)
    && (!actual?.exists || (actual.type === expected.type && actual.size === expected.size && actual.mtime === expected.mtime && actual.mode === expected.mode));
}

async function readRemoteSnapshot(sftp, remotePath) {
  try {
    const stats = await sftpLstat(sftp, remotePath);
    let canonicalPath = null;
    try { canonicalPath = await sftpRealpath(sftp, remotePath); } catch { /* Broken symlink. */ }
    return remoteSnapshot(remotePath, stats, canonicalPath);
  } catch (error) {
    const mapped = transferError(error);
    if (mapped.code === 'SOURCE_NOT_FOUND') return { exists:false, path:remotePath };
    throw mapped;
  }
}

async function listRemoteDirectoryOnSftp(sftp, remotePath, { offset = 0, limit = 10_000, sortByName = false } = {}) {
  const normalized = normalizeAbsoluteRemotePath(remotePath);
  const canonicalRoot = await sftpRealpath(sftp, normalized);
  const entries = await sftpReaddir(sftp, canonicalRoot);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 10_000);
  const ordered = sortByName ? [...entries].sort((left, right) => left.filename.localeCompare(right.filename)) : entries;
  const available = ordered.slice(0, 10_000);
  const bounded = available.slice(safeOffset, safeOffset + safeLimit);
  const result = await mapLimit(bounded, SFTP_METADATA_CONCURRENCY, async (entry) => {
    const candidate = path.posix.join(canonicalRoot, entry.filename);
    let canonical = candidate;
    if (entry.attrs?.isSymbolicLink?.()) {
      try { canonical = await sftpRealpath(sftp, candidate); }
      catch { canonical = null; /* Broken symlink. */ }
    }
    return {
      name: entry.filename,
      canonicalPath: canonical,
      size: Number(entry.attrs?.size ?? 0),
      mtime: Number(entry.attrs?.mtime ?? 0),
      mode: Number(entry.attrs?.mode ?? 0),
      isFile: Boolean(entry.attrs?.isFile?.()),
      isDirectory: Boolean(entry.attrs?.isDirectory?.()),
      isSymbolicLink: Boolean(entry.attrs?.isSymbolicLink?.()),
    };
  });
  result.pageOffset = safeOffset;
  result.totalEntries = entries.length;
  result.hasMoreWithinCap = safeOffset + bounded.length < available.length;
  result.sourceTruncated = entries.length > available.length;
  result.truncated = result.hasMoreWithinCap || result.sourceTruncated;
  return result;
}

async function readRemoteRangeOnSftp(sftp, remotePath, start = 0, maxBytes = 262_144, lifecycle = {}) {
  const normalized = normalizeAbsoluteRemotePath(remotePath);
  const canonical = await sftpRealpath(sftp, normalized);
  const stats = await sftpStat(sftp, canonical);
  if (!stats.isFile()) throw new AppError('SOURCE_NOT_ALLOWED', '目标不是普通文件。');
  const offset = Math.min(Math.max(Number(start) || 0, 0), Number(stats.size));
  const limit = Math.min(Math.max(Number(maxBytes) || 1, 1), 1024 * 1024);
  const buffer = await sftpReadRange(
    sftp,
    canonical,
    offset,
    Math.min(limit, Number(stats.size) - offset),
    lifecycle,
  );
  return {
    canonicalPath: canonical,
    content: buffer.toString('utf8'),
    startByte: offset,
    endByte: offset + buffer.length,
    size: Number(stats.size),
    truncated: offset + buffer.length < Number(stats.size),
    mtime: Number(stats.mtime ?? 0),
  };
}

async function requireRemoteSnapshot(sftp, remotePath, expected) {
  const actual = await readRemoteSnapshot(sftp, remotePath);
  if (!snapshotMatches(actual, expected)) throw new AppError('REMOTE_CHANGED', '服务器目标在确认后发生变化，需要重新确认。', { path:remotePath });
  return actual;
}

function clampInteger(value, fallback, minimum, maximum, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new AppError('INVALID_ARGUMENT', `${name} 超出允许范围。`);
  }
  return resolved;
}

function truncateUtf8(value, maxBytes = 8 * 1024) {
  const text = String(value ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  return {
    text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    bytes,
    truncated: true,
  };
}

function boundLogContexts(contexts) {
  const items = [];
  let outputTruncated = false;
  for (const context of contexts) {
    let lines = [];
    let estimatedBytes = 0;
    const flush = () => {
      if (!lines.length) return;
      const matchLineNumbers = lines.filter((line) => line.isMatch).map((line) => line.lineNumber);
      const selectedMatchLineNumbers = lines
        .filter((line) => line.selectedMatch)
        .map((line) => line.lineNumber);
      items.push({
        snapshotIndex: context.snapshotIndex,
        path: context.path,
        originalStartLine: context.startLine,
        originalEndLine: context.endLine,
        startLine: lines[0].lineNumber,
        endLine: lines.at(-1).lineNumber,
        matchLineNumbers,
        selectedMatchLineNumbers,
        continued: lines[0].lineNumber !== context.startLine || lines.at(-1).lineNumber !== context.endLine,
        lines,
      });
      lines = [];
      estimatedBytes = 0;
    };
    for (const sourceLine of context.lines) {
      const boundedText = truncateUtf8(sourceLine.text);
      outputTruncated ||= boundedText.truncated;
      const line = {
        ...sourceLine,
        text: boundedText.text,
        ...(boundedText.truncated
          ? { textTruncated: true, originalTextBytes: boundedText.bytes }
          : {}),
      };
      const lineBytes = Buffer.byteLength(JSON.stringify(line), 'utf8');
      if (lines.length && (lines.length >= 200 || estimatedBytes + lineBytes > 256 * 1024)) flush();
      lines.push(line);
      estimatedBytes += lineBytes;
    }
    flush();
  }
  return { contexts: items, outputTruncated };
}

function summarizeMatchDescriptor(descriptor) {
  if (!descriptor) return null;
  const { text: _text, ...summary } = descriptor;
  return summary;
}

function boundLogSearchSummary(summary) {
  return {
    ...summary,
    firstMatch: summarizeMatchDescriptor(summary.firstMatch),
    lastMatch: summarizeMatchDescriptor(summary.lastMatch),
    snapshots: summary.snapshots.map((snapshot) => ({
      ...snapshot,
      firstMatch: summarizeMatchDescriptor(snapshot.firstMatch),
      lastMatch: summarizeMatchDescriptor(snapshot.lastMatch),
    })),
    matchTextIncludedInSummary: false,
  };
}

export class SshBroker {
  constructor(projectStore, {
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
    clientFactory = () => new Client(),
  } = {}) {
    this.store = projectStore;
    this.sessions = new Map();
    this.generations = new Map();
    this.generationSequence = 0;
    this.contexts = new Map();
    this.logSearchCursors = new LogSearchCursorStore();
    this.activeLogSearchProjects = new Set();
    this.activeLogSearchCount = 0;
    this.pendingConnections = new Map();
    this.connectionOperations = new Map();
    this.autoReconnectProjects = new Set();
    this.reconnectStates = new Map();
    this.reconnectHandler = null;
    this.lifecycleHandler = null;
    this.reconnectDelaysMs = reconnectDelaysMs.length ? [...reconnectDelaysMs] : [1_000];
    this.clientFactory = clientFactory;
    this.shuttingDown = false;
  }

  status(projectId) {
    const session = this.sessions.get(projectId);
    const reconnect = this.reconnectStates.get(projectId);
    return {
      connected: Boolean(session),
      connecting: this.pendingConnections.has(projectId),
      reconnecting: Boolean(reconnect && !reconnect.stopped),
      reconnectStopped: Boolean(reconnect?.stopped),
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

  setLifecycleHandler(handler) {
    this.lifecycleHandler = typeof handler === 'function' ? handler : null;
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
        stopped: false,
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
      const retryable = !NON_RETRYABLE_RECONNECT_ERRORS.has(state.lastErrorCode);
      await this.store.appendAudit(projectId, {
        type: 'auto-reconnect',
        result: retryable ? 'failed' : 'stopped',
        attempt: state.attempt,
        errorCode: state.lastErrorCode,
        retryable,
      }).catch(() => undefined);
      if (!retryable) {
        this.autoReconnectProjects.delete(projectId);
        state.stopped = true;
        state.nextRetryAt = null;
        return;
      }
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

  runConnectionOperation(projectId, operation, { signal = null } = {}) {
    const previous = this.connectionOperations.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (signal?.aborted) {
        throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。');
      }
      return operation();
    });
    this.connectionOperations.set(projectId, current);
    return current.finally(() => {
      if (this.connectionOperations.get(projectId) === current) {
        this.connectionOperations.delete(projectId);
      }
    });
  }

  connect(projectId, secrets = {}, runtimeOptions = {}) {
    return this.runConnectionOperation(
      projectId,
      () => this.connectUnlocked(projectId, secrets, runtimeOptions),
      { signal: runtimeOptions.signal },
    );
  }

  async connectUnlocked(projectId, secrets = {}, runtimeOptions = {}) {
    if (runtimeOptions.signal?.aborted) {
      throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。');
    }
    const config = await this.store.get(projectId);
    if (runtimeOptions.signal?.aborted) {
      throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。');
    }
    await this.disconnectUnlocked(projectId, 'reconnect');
    if (runtimeOptions.signal?.aborted) {
      throw new AppError('SSH_CONNECTION_CANCELLED', 'SSH 连接已取消。');
    }
    const attempt = {
      id: crypto.randomUUID(),
      cancelled: false,
      failed: false,
      client: null,
      sock: null,
    };
    this.pendingConnections.set(projectId, attempt);
    const abortPendingConnection = () => {
      if (this.pendingConnections.get(projectId) === attempt) {
        this.cancelPendingConnection(projectId);
      }
    };
    runtimeOptions.signal?.addEventListener('abort', abortPendingConnection, { once:true });
    if (runtimeOptions.signal?.aborted) abortPendingConnection();
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
      sock = runtimeOptions.sock ?? await createProxySocket(
        config.proxy,
        { host: config.ssh.host, port: config.ssh.port },
        secrets,
      );
      attempt.sock = sock;
      this.assertPendingConnection(projectId, attempt);
      client = this.clientFactory();
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
        const fail = (cause) => {
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
          } else if (cause?.level === 'client-authentication') {
            reject(new AppError('SSH_AUTH_FAILED', 'SSH 账号、密码、私钥或私钥口令认证失败。'));
          } else {
            reject(new AppError('SSH_CONNECTION_FAILED', 'SSH 连接或认证失败。'));
          }
        };
        // Keep this listener for the full client lifetime. Once the initial
        // connection has settled it becomes a no-op, but it still prevents a
        // later TCP reset from surfacing as an uncaught EventEmitter error.
        client.on('error', fail);
        client.once('close', () => fail(new Error('SSH connection closed before ready.')));
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
      const generation = ++this.generationSequence;
      this.generations.set(projectId, generation);
      const record = {
        client: session.client,
        generation,
        connectedAt: new Date().toISOString(),
      };
      publishedRecord = record;
      this.sessions.set(projectId, record);
      this.lifecycleHandler?.({ projectId, type: 'connected', generation });
      this.clearReconnectState(projectId);
      const clearInterruptedSession = (reason) => {
        if (this.sessions.get(projectId) === record) {
          this.sessions.delete(projectId);
          if (this.generations.get(projectId) === record.generation) this.generations.delete(projectId);
          this.lifecycleHandler?.({ projectId, type: 'lost', generation: record.generation, reason });
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
        await this.store.appendAudit(projectId, {
          type: 'connect',
          result: 'success',
        });
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
      runtimeOptions.signal?.removeEventListener('abort', abortPendingConnection);
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
    this.lifecycleHandler?.({ projectId, type: 'disconnected', generation: session.generation, reason });
    if (this.generations.get(projectId) === session.generation) this.generations.delete(projectId);
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
    this.generations.clear();
  }

  invalidateProjectContexts(projectId) {
    for (const [token, context] of this.contexts) {
      if (context.projectId === projectId) this.contexts.delete(token);
    }
    this.logSearchCursors.clearProject(projectId);
  }

  async openContext(projectId, expectedDocsHash, clientInstanceId = null, expectedSecurityConfigHash = null) {
    const session = this.requireSession(projectId);
    const { config, docsHash, truncated } = await this.store.readContext(projectId);
    const securityConfigHash = this.store.securityConfigHash(config);
    if (truncated) {
      throw new AppError('PROJECT_DOCUMENTS_TRUNCATED', '项目文档总量超过读取限制，不能执行服务器操作。');
    }
    if (!expectedDocsHash || docsHash !== expectedDocsHash) {
      throw new AppError('PROJECT_CONTEXT_CHANGED', '项目文档在读取期间发生变化，请重新打开项目。');
    }
    if (expectedSecurityConfigHash && securityConfigHash !== expectedSecurityConfigHash) {
      throw new AppError('PROJECT_CONTEXT_CHANGED', '项目安全配置在读取期间发生变化，请重新打开项目。');
    }
    const now = Date.now();
    for (const [existingToken, context] of this.contexts) {
      if (now - context.createdAt > CONTEXT_TTL_MS) this.contexts.delete(existingToken);
    }
    const normalizedClientId = /^[0-9a-f]{32}$/.test(String(clientInstanceId ?? ''))
      ? String(clientInstanceId)
      : null;
    if (normalizedClientId) {
      const reusable = [...this.contexts.entries()].find(([, context]) =>
        context.projectId === projectId &&
        context.docsHash === docsHash &&
        context.securityConfigHash === securityConfigHash &&
        context.generation === session.generation &&
        context.clientInstanceId === normalizedClientId &&
        context.createdAt + CONTEXT_TTL_MS - now >= CONTEXT_REUSE_MIN_REMAINING_MS,
      );
      if (reusable) return this.describeContext(reusable[0], reusable[1], session, true);
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
      securityConfigHash,
      generation: session.generation,
      createdAt: now,
      clientInstanceId: normalizedClientId,
    });
    return this.describeContext(token, this.contexts.get(token), session, false);
  }

  describeContext(token, context, session, reused) {
    const expiresAtMs = context.createdAt + CONTEXT_TTL_MS;
    return {
      contextToken: token,
      generation: session.generation,
      issuedAt: new Date(context.createdAt).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      remainingSeconds: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
      reused,
    };
  }

  requireSession(projectId) {
    const session = this.sessions.get(projectId);
    if (!session) throw new AppError('SSH_NOT_CONNECTED', '项目当前未连接，请先在桌面工具中点击连接。');
    return session;
  }

  async openForward(projectId, targetHost, targetPort) {
    const session = this.requireSession(projectId);
    const host = String(targetHost ?? '').trim();
    const port = Number(targetPort);
    if (!host || host.length > 255 || /[\u0000-\u001f\u007f]/.test(host)) {
      throw new AppError('INVALID_ARGUMENT', '隧道目标地址无效。');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError('INVALID_ARGUMENT', '隧道目标端口无效。');
    }
    return new Promise((resolve, reject) => {
      session.client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
        if (error) {
          reject(new AppError('TUNNEL_PROVIDER_UNAVAILABLE', 'SSH 隧道通道建立失败。'));
          return;
        }
        if (this.sessions.get(projectId) !== session) {
          channel.destroy();
          reject(new AppError('TUNNEL_PROVIDER_UNAVAILABLE', 'SSH 连接已经变化，请重试。'));
          return;
        }
        resolve(channel);
      });
    });
  }

  async withInternalSftp(projectId, operation, { timeoutMs = SFTP_READ_INACTIVITY_MS } = {}) {
    const session = this.requireSession(projectId);
    return withSftp(
      session.client,
      (sftp, lifecycle) => operation(sftp, session, lifecycle),
      {
        timeoutMs,
        timeoutCode: 'SFTP_OPERATION_TIMEOUT',
        timeoutMessage: '服务器文件操作超时，请检查 SFTP 服务和目标路径。',
      },
    );
  }

  async withRemoteReadSession(projectId, operation) {
    if (typeof operation !== 'function') throw new AppError('INVALID_ARGUMENT', '服务器只读会话操作无效。');
    return this.withInternalSftp(projectId, async (sftp, _session, lifecycle) => operation({
      listDirectory: (remotePath) => listRemoteDirectoryOnSftp(sftp, remotePath),
      readRange: (remotePath, start, maxBytes) => readRemoteRangeOnSftp(sftp, remotePath, start, maxBytes, lifecycle),
    }), {
      timeoutMs: SFTP_READ_SESSION_TIMEOUT_MS,
    });
  }

  async statRemotePath(projectId, remotePath) {
    const normalized = normalizeAbsoluteRemotePath(remotePath);
    return this.withInternalSftp(projectId, async (sftp) => {
      const snapshot = await readRemoteSnapshot(sftp, normalized);
      if (!snapshot.exists) throw new AppError('SOURCE_NOT_FOUND', '服务器路径不存在。');
      return snapshot;
    });
  }

  async listRemoteDirectory(projectId, remotePath, options = {}) {
    return this.withInternalSftp(projectId, (sftp) => listRemoteDirectoryOnSftp(sftp, remotePath, options));
  }

  async readRemoteRange(projectId, remotePath, start = 0, maxBytes = 262_144) {
    return this.withInternalSftp(projectId, (sftp, _session, lifecycle) =>
      readRemoteRangeOnSftp(sftp, remotePath, start, maxBytes, lifecycle));
  }

  async downloadRemoteFile(projectId, remotePath, localPath, maxBytes = 100 * 1024 * 1024) {
    const normalized = normalizeAbsoluteRemotePath(remotePath);
    return this.withInternalSftp(projectId, async (sftp) => {
      const canonical = await sftpRealpath(sftp, normalized);
      const stats = await sftpStat(sftp, canonical);
      if (!stats.isFile()) throw new AppError('SOURCE_NOT_ALLOWED', '目标不是普通文件。');
      if (Number(stats.size) > Number(maxBytes)) throw new AppError('FILE_TOO_LARGE', '远程文件超过该数据源的下载上限。');
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      const temporary = `${localPath}.${crypto.randomBytes(4).toString('hex')}.part`;
      try {
        await sftpFastGet(sftp, canonical, temporary);
        const downloaded = await fsp.stat(temporary);
        if (downloaded.size > Number(maxBytes)) throw new AppError('FILE_TOO_LARGE', '下载文件在传输期间超过上限。');
        await fsp.rename(temporary, localPath);
        return { canonicalPath: canonical, localPath, bytes: downloaded.size, mtime: Number(stats.mtime ?? 0) };
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async uploadRemoteFileApproved(projectId, localPath, remotePath, precondition) {
    const source = path.resolve(String(localPath ?? ''));
    const target = normalizeAbsoluteRemotePath(remotePath);
    const before = await fsp.lstat(source).catch(() => { throw new AppError('PATH_INVALID', '本地上传文件不存在。'); });
    if (!before.isFile() || before.isSymbolicLink()) throw new AppError('PATH_INVALID', '只能上传本地普通文件。');
    if (before.size !== precondition?.local?.size || before.mtimeMs !== precondition?.local?.mtimeMs) {
      throw new AppError('LOCAL_FILE_CHANGED', '本地文件在确认后发生变化，需要重新确认。');
    }
    const sha256 = await hashFile(source);
    if (sha256 !== precondition?.local?.sha256) throw new AppError('LOCAL_FILE_CHANGED', '本地文件内容在确认后发生变化，需要重新确认。');
    const temporary = `${target}.part-${crypto.randomBytes(6).toString('hex')}`;
    await this.withInternalSftp(projectId, async (sftp, _session, lifecycle) => {
      await requireRemoteSnapshot(sftp, target, precondition.remote);
      try {
        await sftpFastPut(sftp, source, temporary);
        const uploaded = await sftpStat(sftp, temporary);
        if (Number(uploaded.size) !== before.size) throw new AppError('TRANSFER_INTEGRITY_FAILED', '远端临时文件大小与本地文件不一致。');
        await requireRemoteSnapshot(sftp, target, precondition.remote);
        await sftpRename(sftp, temporary, target);
      } catch (error) {
        if (!lifecycle.signal.aborted && !isSftpInterruptedError(error)) await sftpUnlink(sftp, temporary);
        throw error;
      }
    }, { timeoutMs:10 * 60 * 1000 });
    return { localPath:source, remotePath:target, bytes:before.size, sha256 };
  }

  async writeRemoteFileApproved(projectId, remotePath, content, precondition) {
    const target = normalizeAbsoluteRemotePath(remotePath);
    const buffer = Buffer.from(String(content ?? ''), 'utf8');
    if (buffer.length > 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '单次写入内容不能超过 1 MiB。');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (sha256 !== precondition?.newSha256 || buffer.length !== precondition?.bytes) throw new AppError('CONFIRMATION_SCOPE_MISMATCH', '写入内容已经变化，需要重新确认。');
    const temporary = `${target}.part-${crypto.randomBytes(6).toString('hex')}`;
    await this.withInternalSftp(projectId, async (sftp, _session, lifecycle) => {
      await requireRemoteSnapshot(sftp, target, precondition.remote);
      try {
        await sftpWriteFile(sftp, temporary, buffer);
        if (precondition.remote.exists && precondition.remote.mode) await sftpChmod(sftp, temporary, precondition.remote.mode & 0o7777);
        const written = await sftpStat(sftp, temporary);
        if (Number(written.size) !== buffer.length) throw new AppError('TRANSFER_INTEGRITY_FAILED', '远端临时文件大小与写入内容不一致。');
        await requireRemoteSnapshot(sftp, target, precondition.remote);
        await sftpRename(sftp, temporary, target);
      } catch (error) {
        if (!lifecycle.signal.aborted && !isSftpInterruptedError(error)) await sftpUnlink(sftp, temporary);
        throw error;
      }
    }, { timeoutMs:2 * 60 * 1000 });
    return { path:target, bytes:buffer.length, sha256 };
  }

  async moveRemotePathApproved(projectId, sourcePath, destinationPath, precondition) {
    const source = normalizeAbsoluteRemotePath(sourcePath);
    const destination = normalizeAbsoluteRemotePath(destinationPath);
    return this.withInternalSftp(projectId, async (sftp) => {
      await requireRemoteSnapshot(sftp, source, precondition.source);
      await requireRemoteSnapshot(sftp, destination, precondition.destination);
      await sftpRename(sftp, source, destination);
      return { sourcePath:source, destinationPath:destination, moved:true };
    });
  }

  async deleteRemotePathApproved(projectId, remotePath, precondition) {
    const target = normalizeAbsoluteRemotePath(remotePath);
    if (target === '/') throw new AppError('POLICY_DENIED', '禁止删除服务器根目录。');
    return this.withInternalSftp(projectId, async (sftp) => {
      const current = await requireRemoteSnapshot(sftp, target, precondition.remote);
      if (current.type === 'directory') await sftpRmdir(sftp, target);
      else if (current.type === 'file' || current.type === 'symlink') await sftpUnlinkStrict(sftp, target);
      else throw new AppError('SOURCE_NOT_ALLOWED', '禁止删除设备、FIFO、Socket 等特殊文件。');
      return { path:target, deleted:true, type:current.type };
    });
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
    const { config, docsHash } = await this.store.readContext(projectId);
    const securityConfigHash = this.store.securityConfigHash(config);
    if (docsHash !== context.docsHash || securityConfigHash !== context.securityConfigHash) {
      this.contexts.delete(contextToken);
      this.logSearchCursors.clearProject(projectId);
      throw new AppError('PROJECT_CONTEXT_REQUIRED', '项目文档或安全配置已经更新，请重新打开项目。');
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
    const operationId = crypto.randomUUID();
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
        operationId,
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
          operationId,
          auditWarning,
        },
      );
    }
    const finalCommand = workingDirectory
      ? `cd -- ${quotePosix(workingDirectory)} && ${raw}`
      : raw;
    const started = Date.now();
    let result;
    try {
      result = await execOnClient(
        session.client,
        finalCommand,
        Math.max(1, Number(config.limits.commandTimeoutSeconds ?? 180)) * 1000,
      );
    } catch (error) {
      const auditWarning = await this.appendAuditSafe(projectId, {
        type: 'execute',
        operationId,
        result: 'failed',
        command: redactCommand(raw),
        commandSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        workingDirectory: workingDirectory || null,
        errorCode: error?.code ?? 'SSH_EXEC_FAILED',
        durationMs: Date.now() - started,
      });
      if (error instanceof AppError) {
        error.details = { ...(error.details ?? {}), operationId, auditWarning };
      }
      throw error;
    }
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'execute',
      operationId,
      result: 'success',
      command: redactCommand(raw),
      commandSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      workingDirectory: workingDirectory || null,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
    });
    return {
      ...result,
      operationId,
      stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
      outputLimitBytes: MAX_COMMAND_OUTPUT,
      truncated: false,
      auditWarning,
    };
  }

  async executeApproved(projectId, command, workingDirectory) {
    const session = this.requireSession(projectId);
    const config = await this.store.get(projectId);
    const operationId = crypto.randomUUID();
    const raw = String(command ?? '').trim();
    if (!raw || raw.length > 16_384 || raw.includes('\0')) throw new AppError('INVALID_ARGUMENT', '命令为空或过长。');
    const finalCommand = workingDirectory ? `cd -- ${quotePosix(normalizeAbsoluteRemotePath(workingDirectory))} && ${raw}` : raw;
    const started = Date.now();
    try {
      const result = await execOnClient(session.client, finalCommand, Math.max(1, Number(config.limits.commandTimeoutSeconds ?? 180)) * 1000);
      const auditWarning = await this.appendAuditSafe(projectId, {
        type:'execute-approved', operationId, result:'success', command:redactCommand(raw),
        commandSha256:crypto.createHash('sha256').update(raw).digest('hex'), workingDirectory:workingDirectory || null,
        exitCode:result.exitCode, durationMs:Date.now() - started,
      });
      return { ...result, operationId, stdoutBytes:Buffer.byteLength(result.stdout, 'utf8'), stderrBytes:Buffer.byteLength(result.stderr, 'utf8'), outputLimitBytes:MAX_COMMAND_OUTPUT, truncated:false, auditWarning };
    } catch (error) {
      const auditWarning = await this.appendAuditSafe(projectId, {
        type:'execute-approved', operationId, result:'failed', command:redactCommand(raw),
        commandSha256:crypto.createHash('sha256').update(raw).digest('hex'), workingDirectory:workingDirectory || null,
        errorCode:error?.code ?? 'SSH_EXEC_FAILED', durationMs:Date.now() - started,
      });
      if (error instanceof AppError) error.details = { ...(error.details ?? {}), operationId, auditWarning };
      throw error;
    }
  }

  async upload(projectId, contextToken, localPath, remotePath) {
    const session = await this.requireContext(projectId, contextToken);
    const config = await this.store.get(projectId);
    const operationId = crypto.randomUUID();
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
    await withSftp(session.client, async (sftp, lifecycle) => {
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
        if (!lifecycle.signal.aborted && !isSftpInterruptedError(error)) {
          await sftpUnlink(sftp, temp);
        }
        throw error;
      }
    });
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'upload',
      operationId,
      result: 'success',
      localName: path.basename(source),
      remotePath: target,
      sizeBytes: stats.size,
      sha256: hash,
    });
    return { operationId, localPath: source, remotePath: target, sizeBytes: stats.size, sha256: hash, auditWarning };
  }

  async download(projectId, contextToken, remotePath) {
    const session = await this.requireContext(projectId, contextToken);
    const config = await this.store.get(projectId);
    const source = String(remotePath ?? '').trim();
    if (!source || source.includes('\0')) throw new AppError('PATH_INVALID', '远程路径无效。');
    const downloadsDir = this.store.downloadsDir(projectId);
    await fsp.mkdir(downloadsDir, { recursive: true });
    const base = path.posix.basename(source).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'download.log';
    const operationId = crypto.randomUUID();
    const finalPath = path.join(downloadsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${operationId}-${base}`);
    const tempPath = `${finalPath}.part`;
    let sizeBytes = 0;
    try {
      await withSftp(session.client, async (sftp) => {
        const stats = await sftpStat(sftp, source).catch((error) => {
          if (isSftpInterruptedError(error)) throw error;
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
      operationId,
      result: 'success',
      remotePath: source,
      localName: path.basename(finalPath),
      sizeBytes,
      sha256: hash,
    });
    return { operationId, remotePath: source, localPath: finalPath, sizeBytes, sha256: hash, auditWarning };
  }

  async searchLogs(projectId, contextToken, options = {}) {
    const session = await this.requireContext(projectId, contextToken);
    const operationId = crypto.randomUUID();
    const pageSize = clampInteger(options.pageSize, 5, 1, 10, '分页大小');
    if (options.cursor) {
      let page;
      try {
        page = this.logSearchCursors.page({
          cursor: String(options.cursor),
          projectId,
          token: String(contextToken),
          pageSize,
        });
      } catch (error) {
        throw new AppError(error?.code ?? 'INVALID_LOG_SEARCH_CURSOR', '日志搜索游标无效或已经过期。');
      }
      const auditWarning = await this.appendAuditSafe(projectId, {
        type: 'log-search-page',
        operationId,
        parentOperationId: page.metadata?.searchOperationId ?? null,
        result: 'success',
        returnedContexts: page.items.length,
        offset: page.offset,
        hasMore: page.hasMore,
      });
      return this.formatLogSearchPage(operationId, page, auditWarning, contextToken);
    }

    if (this.activeLogSearchProjects.has(projectId)) {
      throw new AppError('LOG_SEARCH_BUSY', '该项目已有日志搜索正在进行，请稍后重试。');
    }
    if (this.activeLogSearchCount >= 2) {
      throw new AppError('LOG_SEARCH_BUSY', '本地已有两个日志搜索正在进行，请稍后重试。');
    }
    this.activeLogSearchProjects.add(projectId);
    this.activeLogSearchCount += 1;
    try {
      return await this.searchLogsInitial(projectId, contextToken, options, operationId, pageSize, session);
    } finally {
      this.activeLogSearchProjects.delete(projectId);
      this.activeLogSearchCount -= 1;
    }
  }

  async searchLogsInitial(projectId, contextToken, options, operationId, pageSize, session) {
    const config = await this.store.get(projectId);
    if (!Array.isArray(options.files) || options.files.length < 1 || options.files.length > 10) {
      throw new AppError('INVALID_ARGUMENT', '每次日志搜索需要指定 1 到 10 个日志文件。');
    }
    if (!Array.isArray(options.keywords) || options.keywords.length < 1 || options.keywords.length > 10) {
      throw new AppError('INVALID_ARGUMENT', '每次日志搜索需要指定 1 到 10 个关键词。');
    }
    const keywords = options.keywords.map((entry) => String(entry ?? ''));
    if (keywords.some((entry) => !entry || entry.length > 256 || /[\u0000-\u001f\u007f]/.test(entry))) {
      throw new AppError('INVALID_ARGUMENT', '日志关键词不能为空、包含控制字符或超过 256 字符。');
    }
    const files = [...new Set(options.files.map(normalizeRemoteLogPath))];
    const beforeLines = clampInteger(options.beforeLines, 3, 0, 50, '前置上下文行数');
    const afterLines = clampInteger(options.afterLines, 5, 0, 50, '后置上下文行数');
    const maxMatches = clampInteger(options.maxMatches, 200, 1, 500, '最大匹配数');
    const projectScanLimit = Math.floor(Number(config.limits.maxLogScanMB ?? 50) * 1024 * 1024);
    const requestedScanLimit = options.maxScanBytes === undefined
      ? projectScanLimit
      : clampInteger(options.maxScanBytes, projectScanLimit, 65_536, projectScanLimit, '日志扫描字节数');
    const perFileBudget = Math.max(1, Math.floor(requestedScanLimit / files.length));
    const snapshots = await withSftp(session.client, async (sftp, lifecycle) => {
      const values = [];
      for (const file of files) {
        let canonicalFile;
        let stats;
        try {
          [canonicalFile, stats] = await Promise.all([
            sftpRealpath(sftp, file),
            sftpStat(sftp, file),
          ]);
        } catch (error) {
          if (isSftpInterruptedError(error)) throw error;
          throw new AppError('PATH_INVALID', '日志文件不存在或无权读取。');
        }
        canonicalFile = path.posix.normalize(canonicalFile);
        if (!stats.isFile()) throw new AppError('PATH_INVALID', '结构化日志搜索只能读取普通文件。');
        const scanBytes = Math.min(Number(stats.size), perFileBudget);
        const startByte = Math.max(0, Number(stats.size) - scanBytes);
        const content = await sftpReadRange(sftp, canonicalFile, startByte, scanBytes, lifecycle);
        values.push({
          path: file,
          content,
          sizeBytes: Number(stats.size),
          scannedBytes: content.length,
          truncated: startByte > 0,
          startByte,
        });
      }
      return values;
    }, {
      timeoutMs: 120_000,
      timeoutCode: 'LOG_SCAN_TIMEOUT',
      timeoutMessage: '日志搜索超过两分钟，已中止本次扫描。',
    });

    let search;
    try {
      search = searchLogSnapshots({
        snapshots,
        keywords,
        keywordMode: options.keywordMode ?? 'OR',
        caseSensitive: options.caseSensitive === true,
        beforeLines,
        afterLines,
        maxMatches,
      });
    } catch (error) {
      throw new AppError(error?.code ?? 'INVALID_ARGUMENT', '日志搜索参数无效。');
    }
    const { contexts: rawContexts, matches: _matches, ...rawSummary } = search;
    const summary = boundLogSearchSummary(rawSummary);
    const bounded = boundLogContexts(rawContexts);
    const contexts = bounded.contexts;
    summary.outputTruncated = bounded.outputTruncated;
    summary.truncated ||= bounded.outputTruncated;
    summary.truncation.outputTruncated = bounded.outputTruncated;
    summary.lineNumberScope = 'scanned_snapshot';
    summary.generatedAtUtc = new Date().toISOString();
    summary.searchOperationId = operationId;
    summary.files = snapshots.map(({ path: file, sizeBytes, scannedBytes, truncated, startByte }) => ({
      path: file,
      sizeBytes,
      scannedBytes,
      startByte,
      truncated,
    }));
    let page;
    try {
      page = this.logSearchCursors.start({
        projectId,
        token: String(contextToken),
        items: contexts,
        metadata: summary,
        pageSize,
      });
    } catch (error) {
      throw new AppError(error?.code ?? 'LOG_SEARCH_CACHE_LIMIT', '日志搜索结果超过本地分页缓存限制，请缩小范围。');
    }
    const auditWarning = await this.appendAuditSafe(projectId, {
      type: 'log-search',
      operationId,
      result: 'success',
      fileCount: files.length,
      keywordHashes: keywords.map((keyword) => crypto.createHash('sha256').update(keyword).digest('hex')),
      scannedBytes: snapshots.reduce((sum, snapshot) => sum + snapshot.scannedBytes, 0),
      totalMatches: search.totalMatches,
      returnedContexts: page.items.length,
      truncated: search.truncated,
      hasMore: page.hasMore,
    });
    return this.formatLogSearchPage(operationId, page, auditWarning, contextToken);
  }

  formatLogSearchPage(operationId, page, auditWarning, contextToken) {
    const context = this.contexts.get(String(contextToken ?? ''));
    const contextExpiresAt = context ? context.createdAt + CONTEXT_TTL_MS : page.expiresAt;
    const effectiveExpiresAt = Math.min(page.expiresAt, contextExpiresAt);
    return {
      operationId,
      searchOperationId: page.metadata?.searchOperationId ?? operationId,
      summary: page.metadata,
      contexts: page.items,
      pagination: {
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalContexts: page.totalItems,
        remainingContexts: page.remainingItems,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        expiresAt: new Date(effectiveExpiresAt).toISOString(),
      },
      auditWarning,
    };
  }
}
