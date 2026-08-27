import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { detectLogArchiveType, expandLogArchive } from './log-archive.mjs';
import { searchLogSnapshots } from './log-search.mjs';
import { parseOffsetCursor } from './pagination-cursor.mjs';

const FILE_ID_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_IDS = 2000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const REMOTE_DIRECTORY_CONCURRENCY = 2;
const LOG_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const LOG_SNAPSHOT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LOG_SEARCH_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const LOG_SEARCH_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const LOG_SEARCH_MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const LOG_SEARCH_MAX_CONCURRENT = 2;
const LOG_SEARCH_MAX_RESERVED_BYTES = 384 * 1024 * 1024;
const LOG_SEARCH_MAX_QUEUED = 32;
const SECRET_KEY = /^(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)$/i;

function globMatches(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u').test(name);
}

function withinRoot(root, candidate) {
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '');
  const normalized = path.posix.normalize(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

function redactConfig(content) {
  const raw = String(content);
  let normalized = raw;
  try {
    const parsed = JSON.parse(raw);
    const redactObject = (value) => {
      if (Array.isArray(value)) return value.map(redactObject);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redactObject(item)]));
    };
    normalized = JSON.stringify(redactObject(parsed), null, 2);
  } catch {
    // Non-JSON configuration is handled by the bounded text redactors below.
  }
  return normalized
    .replace(/(^|\n)(\s*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)\s*:\s*[>|][+-]?\s*\r?\n)(?:[ \t]+[^\r\n]*(?:\r?\n|$))+/gi, '$1$2  [REDACTED]\n')
    .replace(/(^|\n)(\s*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)\s*[:=]\s*)([^\r\n]+)/gi, '$1$2[REDACTED]')
    .replace(/(<(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|authorization)>)[\s\S]*?(<\/(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|authorization)>)/gi, '$1[REDACTED]$2')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1\n[REDACTED]\n$2')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED_AUTH]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi, '$1[REDACTED]@');
}

function sliceUtf8(value, start, maxBytes) {
  const buffer = Buffer.from(String(value), 'utf8');
  let offset = Math.min(Math.max(Number(start) || 0, 0), buffer.length);
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1;
  let end = Math.min(offset + maxBytes, buffer.length);
  while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(offset, end).toString('utf8'), startByte: offset, endByte: end, size: buffer.length, truncated: end < buffer.length };
}

function capText(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
}

function normalizeRemotePath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text || text.length > 4096 || text.includes('\0') || !text.startsWith('/')) {
    throw new AppError('PATH_INVALID', '服务器路径必须是绝对路径。');
  }
  return path.posix.normalize(text);
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function namePattern(value) {
  const pattern = String(value ?? '*').trim() || '*';
  if (pattern.length > 256 || pattern.includes('/') || pattern.includes('\\') || pattern.includes('\0')) {
    throw new AppError('INVALID_ARGUMENT', '文件名模式只能匹配单个文件名。');
  }
  return pattern;
}

function searchInteger(value, fallback, minimum, maximum, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new AppError('INVALID_ARGUMENT', `${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return resolved;
}

function normalizeLogQueries({ contains, queries } = {}) {
  const hasContains = contains !== undefined;
  const hasQueries = queries !== undefined;
  if (hasContains === hasQueries) throw new AppError('INVALID_ARGUMENT', '日志搜索必须且只能提供 contains 或 queries。');
  const values = hasQueries ? queries : [contains];
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) {
    throw new AppError('INVALID_ARGUMENT', '日志搜索需要 1 到 10 个查询文本。');
  }
  const unique = [];
  let totalBytes = 0;
  for (const value of values) {
    const text = String(value ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!text || bytes > 1024 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new AppError('INVALID_ARGUMENT', '日志查询文本不能为空、包含控制字符或超过 1024 字节。');
    }
    totalBytes += bytes;
    if (totalBytes > 4096) throw new AppError('INVALID_ARGUMENT', '日志查询文本合计不能超过 4096 字节。');
    if (!unique.includes(text)) unique.push(text);
  }
  return unique;
}

function archiveSuffix(name) {
  const lower = String(name ?? '').toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz')) return 'gzip';
  return null;
}

function assertLogReadIdentity(file, read) {
  if (Number.isFinite(Number(file.size)) && Number(read.size) !== Number(file.size)) {
    throw new AppError('SOURCE_CHANGED', '日志文件大小已经变化，请重新搜索。');
  }
  if (Number.isFinite(Number(file.mtime)) && Number(read.mtime) !== Number(file.mtime)) {
    throw new AppError('SOURCE_CHANGED', '日志文件修改时间已经变化，请重新搜索。');
  }
  if (path.posix.normalize(read.canonicalPath) !== path.posix.normalize(file.canonicalPath ?? file.path)) {
    throw new AppError('SOURCE_CHANGED', '日志文件路径在搜索期间已经变化，请重新搜索。');
  }
  if (file.allowedRoot && !withinRoot(file.allowedRoot, read.canonicalPath)) {
    throw new AppError('SOURCE_NOT_ALLOWED', '日志文件已经移出登记的数据源。');
  }
}

function withoutArchiveSuffix(name) {
  return archiveSuffix(name) ? String(name).replace(/\.(?:zip|gz)$/iu, '') : String(name);
}

function defaultLogName(name, includeArchives) {
  if (archiveSuffix(name)) return includeArchives;
  const candidate = String(name);
  return /(?:\.log(?:\.\d+)?|\.txt|\.out)$/iu.test(candidate);
}

function sourceNameMatches(source, name, filter, includeArchives) {
  if (!includeArchives && archiveSuffix(name)) return false;
  const candidates = includeArchives && archiveSuffix(name) ? [String(name), withoutArchiveSuffix(name)] : [String(name)];
  const patterns = Array.isArray(source.patterns) ? source.patterns : [];
  const sourceMatch = candidates.some((candidate) => patterns.some((pattern) => globMatches(pattern, candidate)));
  return sourceMatch && (!filter || candidates.some((candidate) => globMatches(filter, candidate)));
}

function cacheEntryBytes(value) {
  return value.snapshots.reduce((sum, snapshot) => sum + snapshot.content.length, 0);
}

function clearSnapshotBuffers(value) {
  const cleared = new Set();
  for (const snapshot of value?.snapshots ?? []) {
    if (!Buffer.isBuffer(snapshot.content) || cleared.has(snapshot.content)) continue;
    cleared.add(snapshot.content);
    snapshot.content.fill(0);
  }
}

class LogSearchGate {
  constructor({
    maxConcurrent = LOG_SEARCH_MAX_CONCURRENT,
    maxReservedBytes = LOG_SEARCH_MAX_RESERVED_BYTES,
    maxQueued = LOG_SEARCH_MAX_QUEUED,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxReservedBytes = maxReservedBytes;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.reservedBytes = 0;
    this.activeKeys = new Set();
    this.queue = [];
  }

  run(key, reservationBytes, operation) {
    if (typeof operation !== 'function') throw new AppError('INVALID_ARGUMENT', '日志搜索操作无效。');
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1 || reservationBytes > this.maxReservedBytes) {
      throw new AppError('RESULT_LIMIT_EXCEEDED', '日志搜索请求超过本地内存预算。');
    }
    if (this.queue.length >= this.maxQueued) {
      throw new AppError('LOG_SEARCH_BUSY', '本地日志搜索队列已满，请稍后重试。');
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ key, reservationBytes, operation, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.maxConcurrent) {
      const index = this.queue.findIndex((task) =>
        !this.activeKeys.has(task.key)
        && this.reservedBytes + task.reservationBytes <= this.maxReservedBytes);
      if (index < 0) break;
      const [task] = this.queue.splice(index, 1);
      this.active += 1;
      this.reservedBytes += task.reservationBytes;
      this.activeKeys.add(task.key);
      Promise.resolve()
        .then(task.operation)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.reservedBytes -= task.reservationBytes;
          this.activeKeys.delete(task.key);
          this.drain();
        });
    }
  }
}

class LogSnapshotCache {
  constructor({ now = Date.now, ttlMs = LOG_SNAPSHOT_CACHE_TTL_MS, maxBytes = LOG_SNAPSHOT_CACHE_MAX_BYTES } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
    this.expiryTimer = null;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    clearSnapshotBuffers(entry.value);
    return true;
  }

  prune() {
    const current = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= current) this.remove(key);
    this.scheduleExpiry();
  }

  scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.entries.size) return;
    const expiresAt = Math.min(...[...this.entries.values()].map((entry) => entry.expiresAt));
    const delay = Math.max(1, expiresAt - this.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.prune();
    }, delay);
    this.expiryTimer.unref?.();
  }

  get(key) {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.prune();
    const bytes = cacheEntryBytes(value);
    if (bytes <= 0 || bytes > this.maxBytes) return false;
    this.remove(key);
    while (this.entries.size && this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
    this.entries.set(key, { value, bytes, expiresAt:this.now() + this.ttlMs });
    this.bytes += bytes;
    this.scheduleExpiry();
    return true;
  }

  stats() {
    this.prune();
    return { entries:this.entries.size, bytes:this.bytes, maxBytes:this.maxBytes, ttlMs:this.ttlMs };
  }
}

function boundedContexts(contexts, maxBytes = LOG_SEARCH_MAX_CONTEXT_BYTES) {
  const values = [];
  let bytes = 0;
  let truncated = false;
  for (const context of contexts) {
    const lines = [];
    for (const line of context.lines) {
      const text = capText(line.text, 4096).text;
      const size = Buffer.byteLength(text, 'utf8') + 128;
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      lines.push({ ...line, text });
    }
    if (lines.length) values.push({ ...context, lines });
    if (truncated) break;
  }
  return { contexts:values, bytes, truncated };
}

export class ServerOperations {
  constructor(serverRuntime, workspaceStore, options = {}) {
    this.serverRuntime = serverRuntime;
    this.workspaceStore = workspaceStore;
    this.files = new Map();
    this.expandLogArchive = options.expandLogArchive ?? expandLogArchive;
    this.logSnapshotCache = new LogSnapshotCache({
      now:options.now ?? Date.now,
      ttlMs:options.logSnapshotCacheTtlMs ?? LOG_SNAPSHOT_CACHE_TTL_MS,
      maxBytes:options.maxLogSnapshotCacheBytes ?? LOG_SNAPSHOT_CACHE_MAX_BYTES,
    });
    this.logSearchGate = new LogSearchGate({
      maxConcurrent:options.logSearchMaxConcurrent ?? LOG_SEARCH_MAX_CONCURRENT,
      maxReservedBytes:options.logSearchMaxReservedBytes ?? LOG_SEARCH_MAX_RESERVED_BYTES,
      maxQueued:options.logSearchMaxQueued ?? LOG_SEARCH_MAX_QUEUED,
    });
  }

  cleanupFiles() {
    const cutoff = Date.now() - FILE_ID_TTL_MS;
    for (const [id, descriptor] of this.files) if (descriptor.createdAt < cutoff) this.files.delete(id);
    while (this.files.size > MAX_FILE_IDS) this.files.delete(this.files.keys().next().value);
  }

  listActions(plugin) {
    const configured = plugin.actions ?? [];
    const base = [
      { actionId: 'system.summary', displayName: '系统摘要', parameters: [] },
      { actionId: 'process.summary', displayName: '进程摘要', parameters: [] },
      { actionId: 'network.listen', displayName: '监听端口', parameters: [] },
    ];
    for (const item of configured) {
      if (item.actionId === 'service.status') base.push({ actionId: item.actionId, displayName: item.displayName, parameters: [{ name: 'serviceId', enum: [item.serviceId] }] });
      if (item.actionId === 'filesystem.usage') base.push({ actionId: item.actionId, displayName: item.displayName, parameters: [{ name: 'mountId', enum: [item.mountId] }] });
    }
    return base;
  }

  listSources(plugin) {
    return (plugin.sources ?? []).map((source) => ({ sourceId: source.sourceId, displayName: source.displayName, kind: source.kind, patterns: [...source.patterns] }));
  }

  commandFor(plugin, actionId, parameters = {}) {
    const allowedKeys = actionId === 'service.status' ? ['serviceId'] : actionId === 'filesystem.usage' ? ['mountId'] : [];
    if (Object.keys(parameters).some((name) => !allowedKeys.includes(name))) throw new AppError('INVALID_ARGUMENT', 'action 参数包含未知字段。');
    if (actionId === 'system.summary') return "LC_ALL=C uptime; free -b; df -P -B1";
    if (actionId === 'process.summary') return "LC_ALL=C ps -eo pid,ppid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -n 101";
    if (actionId === 'network.listen') return 'LC_ALL=C ss -lntup';
    if (actionId === 'service.status') {
      const item = plugin.actions.find((candidate) => candidate.actionId === actionId && candidate.serviceId === parameters.serviceId);
      if (!item) throw new AppError('POLICY_DENIED', 'serviceId 未登记。');
      return `LC_ALL=C systemctl --no-pager --full status -- ${item.unit}`;
    }
    if (actionId === 'filesystem.usage') {
      const item = plugin.actions.find((candidate) => candidate.actionId === actionId && candidate.mountId === parameters.mountId);
      if (!item) throw new AppError('POLICY_DENIED', 'mountId 未登记。');
      return `LC_ALL=C df -P -B1 -- ${item.mountPath}`;
    }
    throw new AppError('POLICY_DENIED', 'actionId 未登记。');
  }

  async runAction(plugin, actionId, parameters) {
    const command = this.commandFor(plugin, actionId, parameters);
    return this.runReadCommand(plugin, command, { actionId });
  }

  async runReadCommand(plugin, command, metadata = {}) {
    const result = await this.serverRuntime.executeFixed(plugin, command);
    const stdout = capText(result.stdout, plugin.limits.maxBytes);
    const stderr = capText(result.stderr, Math.max(0, plugin.limits.maxBytes - stdout.bytes));
    return {
      ...metadata,
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: result.durationMs,
    };
  }

  inspectService(plugin, { unit, view = 'status' } = {}) {
    const name = String(unit ?? '').trim();
    if (!name || name.length > 255 || !/^[A-Za-z0-9_.@:-]+$/.test(name)) throw new AppError('INVALID_ARGUMENT', 'systemd unit 名称无效。');
    if (!['status','show','cat'].includes(view)) throw new AppError('INVALID_ARGUMENT', '服务查询类型必须是 status、show 或 cat。');
    const command = `LC_ALL=C systemctl --no-pager --full ${view} -- ${quotePosix(name)}`;
    return this.runReadCommand(plugin, command, { unit:name, view });
  }

  queryJournal(plugin, { unit, since, priority, lines = 500 } = {}) {
    const count = Math.min(Math.max(Number(lines) || 500, 1), 2000);
    const parts = ['LC_ALL=C journalctl --no-pager -o short-iso', `-n ${count}`];
    if (unit !== undefined) {
      const name = String(unit).trim();
      if (!name || name.length > 255 || !/^[A-Za-z0-9_.@:-]+$/.test(name)) throw new AppError('INVALID_ARGUMENT', 'systemd unit 名称无效。');
      parts.push(`--unit ${quotePosix(name)}`);
    }
    if (since !== undefined) {
      const value = String(since).trim();
      if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new AppError('INVALID_ARGUMENT', 'journal since 参数无效。');
      parts.push(`--since ${quotePosix(value)}`);
    }
    if (priority !== undefined) {
      const value = Number(priority);
      if (!Number.isInteger(value) || value < 0 || value > 7) throw new AppError('INVALID_ARGUMENT', 'journal priority 必须在 0 到 7 之间。');
      parts.push(`--priority ${value}`);
    }
    return this.runReadCommand(plugin, parts.join(' '), { unit:unit ?? null, lines:count });
  }

  inspectContainer(plugin, { runtime = 'docker', container } = {}) {
    if (!['docker','podman'].includes(runtime)) throw new AppError('INVALID_ARGUMENT', '容器运行时必须是 docker 或 podman。');
    if (container === undefined) return this.runReadCommand(plugin, `LC_ALL=C ${runtime} ps --no-trunc`, { runtime, operation:'list' });
    const value = String(container).trim();
    if (!value || value.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new AppError('INVALID_ARGUMENT', '容器名称或 ID 无效。');
    return this.runReadCommand(plugin, `LC_ALL=C ${runtime} inspect ${quotePosix(value)}`, { runtime, operation:'inspect', container:value });
  }

  source(plugin, sourceId) {
    const source = (plugin.sources ?? []).find((item) => item.sourceId === sourceId);
    if (!source) throw new AppError('SOURCE_NOT_ALLOWED', 'sourceId 未登记。');
    return source;
  }

  rememberFile(plugin, source, entry) {
    this.cleanupFiles();
    const fileId = crypto.randomBytes(24).toString('base64url');
    this.files.set(fileId, {
      projectId: plugin.projectId,
      environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
      sourceId: source.sourceId,
      path: entry.canonicalPath,
      relativePath: path.posix.relative(source.root, entry.canonicalPath),
      size: entry.size,
      mtime: entry.mtime,
      createdAt: Date.now(),
    });
    return fileId;
  }

  requireFile(plugin, fileId) {
    this.cleanupFiles();
    const descriptor = this.files.get(String(fileId ?? ''));
    if (!descriptor || descriptor.projectId !== plugin.projectId || descriptor.environmentId !== plugin.environmentId || descriptor.pluginInstanceId !== plugin.pluginInstanceId) {
      throw new AppError('SOURCE_NOT_ALLOWED', 'fileId 无效或已经过期。');
    }
    return descriptor;
  }

  describeFile(plugin, fileId) {
    const descriptor = this.requireFile(plugin, fileId);
    const source = this.source(plugin, descriptor.sourceId);
    return { relativePath:descriptor.relativePath, size:descriptor.size, sourceName:source.displayName, kind:source.kind };
  }

  async listFiles(plugin, { sourceId, cursor, limit = 200 } = {}) {
    const offset = parseOffsetCursor(cursor);
    const source = this.source(plugin, sourceId);
    const entries = await this.serverRuntime.listRemoteDirectory(plugin, source.root);
    const filtered = entries.filter((entry) =>
      entry.isFile && !entry.isSymbolicLink && entry.canonicalPath && withinRoot(source.root, entry.canonicalPath) && entry.size <= source.maxFileBytes && source.patterns.some((pattern) => globMatches(pattern, entry.name)),
    ).sort((left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name));
    const pageSize = Math.min(Math.max(Number(limit) || 200, 1), 200);
    const page = filtered.slice(offset, offset + pageSize);
    return {
      sourceId,
      files: page.map((entry) => ({ fileId: this.rememberFile(plugin, source, entry), name: entry.name, relativePath: path.posix.relative(source.root, entry.canonicalPath), size: entry.size, mtime: entry.mtime })),
      nextCursor: offset + pageSize < filtered.length ? String(offset + pageSize) : null,
      truncated: offset + pageSize < filtered.length,
    };
  }

  async readLog(plugin, { fileId, cursor = null, maxBytes = 262_144, tail = true } = {}) {
    const offset = cursor === null ? null : parseOffsetCursor(cursor);
    const descriptor = this.requireFile(plugin, fileId);
    const source = this.source(plugin, descriptor.sourceId);
    if (source.kind !== 'log') throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于日志数据源。');
    const limit = Math.min(Math.max(Number(maxBytes) || 262_144, 1), plugin.limits.maxBytes);
    const start = offset !== null ? offset : tail ? Math.max(0, descriptor.size - limit) : 0;
    const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, start, limit);
    if (result.mtime !== descriptor.mtime) throw new AppError('SOURCE_CHANGED', '文件已经变化，请重新列出。');
    return { fileId, relativePath: descriptor.relativePath, content: result.content, startByte: result.startByte, endByte: result.endByte, size: result.size, nextCursor: result.truncated ? String(result.endByte) : null, truncated: result.truncated };
  }

  async searchLogs(plugin, args = {}) {
    const selectors = ['fileIds','sourceId','path'].filter((name) => args[name] !== undefined);
    if (selectors.length !== 1) throw new AppError('INVALID_ARGUMENT', '日志搜索必须且只能提供 fileIds、sourceId 或 path 之一。');
    const selector = selectors[0];
    const queries = normalizeLogQueries(args);
    const legacy = selector === 'fileIds' && args.contains !== undefined && args.queries === undefined;
    const modeValue = String(args.matchMode ?? 'any').toLowerCase();
    if (!['any','all'].includes(modeValue)) throw new AppError('INVALID_ARGUMENT', 'matchMode 必须是 any 或 all。');
    if (args.maxLines !== undefined && args.maxMatches !== undefined) {
      throw new AppError('INVALID_ARGUMENT', 'maxLines 与 maxMatches 不能同时提供。');
    }
    const maxMatches = searchInteger(args.maxMatches ?? args.maxLines, 200, 1, 500, '最大匹配数');
    const maxFiles = searchInteger(args.maxFiles, selector === 'fileIds' ? 10 : 20, 1, 100, '最大文件数');
    const maxDepth = searchInteger(args.maxDepth, 3, 0, 12, '最大目录深度');
    const beforeLines = searchInteger(args.beforeLines, 2, 0, 50, '前置上下文行数');
    const afterLines = searchInteger(args.afterLines, 2, 0, 50, '后置上下文行数');
    const scanBudget = searchInteger(args.maxScanBytes, legacy ? 4 * 1024 * 1024 : 16 * 1024 * 1024, 65_536, LOG_SEARCH_MAX_SCAN_BYTES, '日志扫描字节数');
    const expandedBudget = searchInteger(
      args.maxExpandedBytes,
      Math.min(LOG_SEARCH_MAX_EXPANDED_BYTES, Math.max(scanBudget, scanBudget * 4)),
      65_536,
      LOG_SEARCH_MAX_EXPANDED_BYTES,
      '日志展开字节数',
    );
    const maxArchiveEntries = searchInteger(args.maxArchiveEntries, 128, 1, 128, '归档条目数');
    const includeArchives = args.includeArchives !== false;
    const filter = args.pattern === undefined ? null : namePattern(args.pattern);
    const caseSensitive = args.caseSensitive !== false;
    const gateKey = [plugin.projectId,plugin.environmentId,plugin.pluginInstanceId].join('\u0000');
    const reservationBytes = scanBudget + (expandedBudget * 2);

    return this.logSearchGate.run(gateKey, reservationBytes, () => this.withRemoteReadSession(plugin, async (reader) => {
      const directStat = selector === 'path'
        ? await (typeof reader.statPath === 'function'
          ? reader.statPath(normalizeRemotePath(args.path))
          : this.serverRuntime.statRemotePath(plugin, normalizeRemotePath(args.path)))
        : null;
      const truncationReasons = new Set();
      const skipped = [];
      let selectionTruncated = false;
      let files;
      let selection;

      if (selector === 'fileIds') {
        if (!Array.isArray(args.fileIds) || args.fileIds.length < 1 || args.fileIds.length > 10) {
          throw new AppError('INVALID_ARGUMENT', 'fileIds 必须包含 1 到 10 个日志文件。');
        }
        files = args.fileIds.map((fileId) => {
          const descriptor = this.requireFile(plugin, fileId);
          const source = this.source(plugin, descriptor.sourceId);
          if (source.kind !== 'log' || !withinRoot(source.root, descriptor.path)) {
            throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于有效的日志数据源。');
          }
          return { ...descriptor, fileId, source, name:path.posix.basename(descriptor.path), canonicalPath:descriptor.path };
        });
        for (const file of files) {
          const current = await (typeof reader.statPath === 'function'
            ? reader.statPath(file.path)
            : this.serverRuntime.statRemotePath(plugin, file.path));
          if (current.type !== 'file' || !withinRoot(file.source.root, current.canonicalPath ?? current.path)) {
            throw new AppError('SOURCE_NOT_ALLOWED', '该文件不再属于有效的日志数据源。');
          }
          if (Number(current.size) !== Number(file.size) || Number(current.mtime) !== Number(file.mtime)) {
            throw new AppError('SOURCE_CHANGED', '日志文件已经变化，请重新列出。');
          }
          file.canonicalPath = current.canonicalPath ?? current.path;
          file.allowedRoot = file.source.root;
        }
        selection = { type:'fileIds', fileIds:[...args.fileIds] };
      } else if (selector === 'sourceId') {
        const source = this.source(plugin, args.sourceId);
        if (source.kind !== 'log') throw new AppError('SOURCE_NOT_ALLOWED', 'sourceId 不属于日志数据源。');
        const sourceStat = await (typeof reader.statPath === 'function'
          ? reader.statPath(source.root)
          : this.serverRuntime.statRemotePath(plugin, source.root));
        if (sourceStat.type !== 'directory') throw new AppError('SOURCE_NOT_ALLOWED', '日志数据源根路径不是目录。');
        const root = sourceStat.canonicalPath ?? sourceStat.path;
        const acceptsFile = (entry) => Number(entry.size ?? 0) <= Number(source.maxFileBytes)
          && sourceNameMatches(source, entry.name, filter, includeArchives);
        const found = await this.findFilesWithReader(reader, { path:root, pattern:'*', maxDepth, maxResults:1000, acceptsFile });
        const eligible = found.files.filter((file) => file.path);
        eligible.sort((left, right) => Number(right.mtime ?? 0) - Number(left.mtime ?? 0) || left.path.localeCompare(right.path));
        files = eligible.slice(0, maxFiles).map((file) => ({
          ...file,
          canonicalPath:file.path,
          relativePath:path.posix.relative(root, file.path),
          source,
          allowedRoot:root,
          fileId:null,
        }));
        selectionTruncated = found.truncated || eligible.length > files.length;
        selection = { type:'sourceId', sourceId:source.sourceId, pattern:filter, root };
      } else if (directStat.type === 'file') {
        if (!includeArchives && archiveSuffix(directStat.canonicalPath ?? directStat.path)) {
          files = [];
          skipped.push({ path:directStat.canonicalPath ?? directStat.path, code:'ARCHIVES_EXCLUDED' });
        } else {
          files = [{
            path:directStat.canonicalPath ?? directStat.path,
            canonicalPath:directStat.canonicalPath ?? directStat.path,
            name:path.posix.basename(directStat.canonicalPath ?? directStat.path),
            size:Number(directStat.size ?? 0),
            mtime:Number(directStat.mtime ?? 0),
            relativePath:path.posix.basename(directStat.canonicalPath ?? directStat.path),
            source:null,
            fileId:null,
          }];
        }
        selection = { type:'path', path:normalizeRemotePath(args.path), targetType:'file', pattern:filter };
      } else if (directStat.type === 'directory') {
        const root = directStat.canonicalPath ?? normalizeRemotePath(args.path);
        const acceptsFile = (entry) => (filter
          ? globMatches(filter, entry.name) || (includeArchives && archiveSuffix(entry.name) && globMatches(filter, withoutArchiveSuffix(entry.name)))
          : defaultLogName(entry.name, includeArchives));
        const found = await this.findFilesWithReader(reader, { path:root, pattern:'*', maxDepth, maxResults:1000, acceptsFile });
        const eligible = found.files.filter((file) => file.path && (filter
          ? globMatches(filter, file.name) || (includeArchives && archiveSuffix(file.name) && globMatches(filter, withoutArchiveSuffix(file.name)))
          : defaultLogName(file.name, includeArchives)));
        eligible.sort((left, right) => Number(right.mtime ?? 0) - Number(left.mtime ?? 0) || left.path.localeCompare(right.path));
        files = eligible.slice(0, maxFiles).map((file) => ({
          ...file,
          canonicalPath:file.path,
          relativePath:path.posix.relative(root, file.path),
          allowedRoot:root,
          source:null,
          fileId:null,
        }));
        selectionTruncated = found.truncated || eligible.length > files.length;
        selection = { type:'path', path:normalizeRemotePath(args.path), targetType:'directory', pattern:filter };
      } else {
        throw new AppError('SOURCE_NOT_ALLOWED', 'path 必须指向普通文件或目录。');
      }

      if (files.length > maxFiles) {
        files = files.slice(0, maxFiles);
        selectionTruncated = true;
      }
      if (selectionTruncated) truncationReasons.add('maxFilesOrListing');

      const matches = [];
      const contexts = [];
      const coverage = [];
      let contextBytes = 0;
      let totalMatches = 0;
      let scannedBytes = 0;
      let remoteBytesRead = 0;
      let expandedBytes = 0;
      let scannedFiles = 0;
      let archivesScanned = 0;
      let archiveEntriesScanned = 0;
      let cacheHits = 0;
      let cacheMisses = 0;
      let cacheSavedRemoteBytes = 0;
      const deadline = Date.now() + 100_000;

      for (const file of files) {
        if (matches.length >= maxMatches) {
          truncationReasons.add('maxMatches');
          break;
        }
        if (Date.now() >= deadline) {
          truncationReasons.add('timeBudget');
          break;
        }
        let remainingScan = scanBudget - scannedBytes;
        const remainingExpanded = expandedBudget - expandedBytes;
        if (remainingScan <= 0) {
          truncationReasons.add('maxScanBytes');
          break;
        }
        if (remainingExpanded <= 0) {
          truncationReasons.add('maxExpandedBytes');
          break;
        }
        let effectiveArchive = archiveSuffix(file.name ?? file.path);
        if (effectiveArchive && !includeArchives) {
          skipped.push({ path:file.path, code:'ARCHIVES_EXCLUDED' });
          continue;
        }
        const remainingArchiveEntries = maxArchiveEntries - archiveEntriesScanned;
        if (file.allowedRoot && !withinRoot(file.allowedRoot, file.canonicalPath ?? file.path)) {
          throw new AppError('SOURCE_NOT_ALLOWED', '发现的日志文件位于搜索根目录之外。');
        }
        const fileSize = Math.max(0, Number(file.size) || 0);
        let probeBytesRead = 0;
        const plainLength = Math.min(fileSize, remainingScan, remainingExpanded);
        const needsArchiveProbe = !effectiveArchive && fileSize > 0 && (
          !includeArchives
          || remainingArchiveEntries <= 0
          || fileSize > plainLength
        );
        if (needsArchiveProbe) {
          const probeLength = Math.min(4, fileSize);
          if (probeLength > remainingScan) {
            truncationReasons.add('maxScanBytes');
            break;
          }
          let probe;
          if (typeof reader.readBuffer === 'function') {
            probe = await reader.readBuffer(file.canonicalPath ?? file.path, 0, probeLength);
          } else if (typeof this.serverRuntime.readRemoteBuffer === 'function') {
            probe = await this.serverRuntime.readRemoteBuffer(plugin, file.canonicalPath ?? file.path, 0, probeLength);
          } else {
            throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '当前 Server Runtime 不支持二进制日志读取。');
          }
          assertLogReadIdentity(file, probe);
          const probeContent = Buffer.isBuffer(probe.content) ? probe.content : Buffer.from(probe.content ?? []);
          if (probeContent.length !== probeLength) {
            throw new AppError('SOURCE_CHANGED', '日志文件在类型探测期间已经变化，请重新搜索。');
          }
          probeBytesRead = probeContent.length;
          scannedBytes += probeBytesRead;
          remoteBytesRead += probeBytesRead;
          remainingScan -= probeBytesRead;
          const detectedType = detectLogArchiveType({
            filePath:file.canonicalPath ?? file.path,
            content:probeContent,
          });
          effectiveArchive = detectedType === 'plain' ? null : detectedType;
        }
        if (effectiveArchive && !includeArchives) {
          skipped.push({ path:file.path, code:'ARCHIVES_EXCLUDED' });
          continue;
        }
        if (effectiveArchive && remainingArchiveEntries <= 0) {
          skipped.push({ path:file.path, code:'ARCHIVE_ENTRY_BUDGET_EXHAUSTED' });
          truncationReasons.add('maxArchiveEntries');
          continue;
        }
        if (!effectiveArchive && fileSize > 0 && remainingScan <= 0) {
          truncationReasons.add('maxScanBytes');
          break;
        }
        if (effectiveArchive && fileSize > remainingScan) {
          skipped.push({ path:file.path, code:'ARCHIVE_INPUT_LIMIT', size:Number(file.size), remainingBytes:remainingScan });
          truncationReasons.add('maxScanBytes');
          continue;
        }
        const length = Math.min(
          fileSize,
          effectiveArchive ? remainingScan : Math.min(remainingScan, remainingExpanded),
        );
        const start = effectiveArchive ? 0 : Math.max(0, fileSize - length);
        if (start > 0) truncationReasons.add('fileTailOnly');
        const cacheKey = JSON.stringify([
          plugin.projectId, plugin.environmentId, plugin.pluginInstanceId,
          plugin.revision ?? null, reader.generation ?? null,
          file.canonicalPath ?? file.path, Number(file.size), Number(file.mtime), start, length,
          remainingExpanded, remainingArchiveEntries, includeArchives, effectiveArchive,
        ]);
        let expanded = this.logSnapshotCache.get(cacheKey);
        if (expanded) {
          cacheHits += 1;
          cacheSavedRemoteBytes += length;
        } else {
          cacheMisses += 1;
          let read;
          if (length === 0) {
            read = { canonicalPath:file.canonicalPath ?? file.path, content:Buffer.alloc(0), startByte:0, endByte:0, size:0, mtime:Number(file.mtime), truncated:false };
          } else if (typeof reader.readBuffer === 'function') {
            read = await reader.readBuffer(file.canonicalPath ?? file.path, start, length);
          } else if (typeof this.serverRuntime.readRemoteBuffer === 'function') {
            read = await this.serverRuntime.readRemoteBuffer(plugin, file.canonicalPath ?? file.path, start, length);
          } else {
            throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '当前 Server Runtime 不支持二进制日志读取。');
          }
          const content = Buffer.isBuffer(read.content) ? read.content : Buffer.from(read.content ?? []);
          assertLogReadIdentity(file, read);
          try {
            expanded = await this.expandLogArchive({
              filePath:read.canonicalPath,
              content,
              maxExpandedBytes:remainingExpanded,
              maxEntries:Math.max(1, remainingArchiveEntries),
              maxEntryBytes:Math.min(32 * 1024 * 1024, remainingExpanded),
              maxCompressionRatio:100,
              allowArchives:includeArchives,
            });
          } catch (error) {
            if (!String(error?.code ?? '').startsWith('LOG_ARCHIVE_')) throw error;
            const failedEntries = Math.min(
              Math.max(0, remainingArchiveEntries),
              Math.max(0, Math.floor(Number(error?.details?.entriesScanned) || 0)),
            );
            const failedExpandedBytes = Math.min(
              Math.max(0, remainingExpanded),
              Math.max(0, Math.floor(Number(error?.details?.expandedBytes) || 0)),
            );
            archiveEntriesScanned += failedEntries;
            expandedBytes += failedExpandedBytes;
            if (error.code === 'LOG_ARCHIVE_DISABLED') {
              skipped.push({ path:file.path, code:'ARCHIVES_EXCLUDED' });
            } else {
              skipped.push({ path:file.path, code:error.code, details:error.details ?? null });
              truncationReasons.add('archiveRejected');
            }
            if (archiveEntriesScanned >= maxArchiveEntries) truncationReasons.add('maxArchiveEntries');
            if (expandedBytes >= expandedBudget) truncationReasons.add('maxExpandedBytes');
            scannedBytes += content.length;
            remoteBytesRead += content.length;
            continue;
          }
          this.logSnapshotCache.set(cacheKey, expanded);
          remoteBytesRead += content.length;
        }

        scannedBytes += expanded.inputBytes;
        expandedBytes += expanded.expandedBytes;
        scannedFiles += 1;
        if (expanded.archiveType !== 'plain') {
          archivesScanned += 1;
          archiveEntriesScanned += expanded.entriesScanned;
        }
        for (const warning of expanded.warnings) skipped.push({ path:file.path, archiveMember:warning.archiveEntry, code:warning.code });
        if (expanded.truncated) truncationReasons.add('archiveEntriesSkipped');

        for (const snapshot of expanded.snapshots) {
          const search = searchLogSnapshots({
            snapshots:[snapshot],
            keywords:queries,
            keywordMode:modeValue === 'all' ? 'AND' : 'OR',
            caseSensitive,
            beforeLines,
            afterLines,
            maxMatches:Math.max(0, maxMatches - matches.length),
          });
          totalMatches += search.totalMatches;
          const lineNumberScope = snapshot.archiveEntry ? 'archiveMember' : start === 0 ? 'file' : 'scannedTail';
          for (const match of search.matches) {
            matches.push({
              ...(file.fileId ? { fileId:file.fileId } : {}),
              relativePath:file.relativePath,
              path:file.canonicalPath ?? file.path,
              ...(snapshot.archiveEntry ? { archiveMember:snapshot.archiveEntry } : {}),
              lineNumber:match.lineNumber,
              lineNumberScope,
              scanStartByte:start,
              lineOffset:match.lineNumber - 1,
              text:capText(match.text, 4096).text,
              matchedQueries:match.matchedKeywords,
            });
          }
          const mappedContexts = search.contexts.map((context) => ({
            ...(file.fileId ? { fileId:file.fileId } : {}),
            relativePath:file.relativePath,
            path:file.canonicalPath ?? file.path,
            ...(snapshot.archiveEntry ? { archiveMember:snapshot.archiveEntry } : {}),
            lineNumberScope,
            scanStartByte:start,
            startLine:context.startLine,
            endLine:context.endLine,
            matchLineNumbers:context.matchLineNumbers,
            lines:context.lines.map((line) => ({
              lineNumber:line.lineNumber,
              text:line.text,
              isMatch:line.isMatch,
              matchedQueries:line.matchedKeywords,
            })),
          }));
          const bounded = boundedContexts(mappedContexts, Math.max(0, LOG_SEARCH_MAX_CONTEXT_BYTES - contextBytes));
          contexts.push(...bounded.contexts);
          contextBytes += bounded.bytes;
          if (bounded.truncated) truncationReasons.add('outputBytes');
          if (search.truncated) truncationReasons.add('maxMatches');
        }
        coverage.push({
          ...(file.fileId ? { fileId:file.fileId } : {}),
          path:file.canonicalPath ?? file.path,
          relativePath:file.relativePath,
          scanStartByte:start,
          scannedBytes:expanded.inputBytes,
          probeBytesRead,
          expandedBytes:expanded.expandedBytes,
          complete:start === 0 && !expanded.truncated,
        });
      }

      if (scannedBytes >= scanBudget && scannedFiles < files.length) truncationReasons.add('maxScanBytes');
      if (expandedBytes >= expandedBudget && scannedFiles < files.length) truncationReasons.add('maxExpandedBytes');
      const cache = this.logSnapshotCache.stats();
      return {
        selection:{ ...selection, includeArchives },
        query:{ count:queries.length, mode:modeValue, caseSensitive, literal:true },
        matches,
        contexts,
        matchCount:matches.length,
        totalMatches,
        filesConsidered:files.length,
        scannedFiles,
        scannedBytes,
        remoteBytesRead,
        expandedBytes,
        archivesScanned,
        archiveEntriesScanned,
        coverage,
        skipped,
        cache:{ hits:cacheHits, misses:cacheMisses, savedRemoteBytes:cacheSavedRemoteBytes, entries:cache.entries, bytes:cache.bytes, ttlMs:cache.ttlMs },
        truncated:selectionTruncated || truncationReasons.size > 0,
        truncationReasons:[...truncationReasons],
        limitsApplied:{
          maxLines:maxMatches,
          maxMatches,
          maxFiles,
          maxDepth,
          maxScanBytes:scanBudget,
          maxExpandedBytes:expandedBudget,
          maxArchiveEntries,
          beforeLines,
          afterLines,
        },
      };
    }));
  }

  async readConfig(plugin, args) {
    const offset = parseOffsetCursor(args.cursor);
    const descriptor = this.requireFile(plugin, args.fileId);
    const source = this.source(plugin, descriptor.sourceId);
    if (source.kind !== 'config') throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于配置数据源。');
    if (descriptor.size > MAX_CONFIG_BYTES) throw new AppError('FILE_TOO_LARGE', '配置文件超过 1 MiB，请改用 server_read_file 分页读取。');
    const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, 0, MAX_CONFIG_BYTES);
    if (result.mtime !== descriptor.mtime) throw new AppError('SOURCE_CHANGED', '配置文件已经变化，请重新列出。');
    if (result.truncated) throw new AppError('FILE_TOO_LARGE', '配置文件超过安全读取上限。');
    const page = sliceUtf8(result.content, offset, Math.min(Math.max(Number(args.maxBytes) || 262_144, 1), 262_144));
    return { fileId: args.fileId, relativePath: descriptor.relativePath, content: page.content, nextCursor: page.truncated ? String(page.endByte) : null, truncated: page.truncated, redacted: false };
  }

  async download(plugin, { fileId } = {}) {
    const descriptor = this.requireFile(plugin, fileId);
    const source = this.source(plugin, descriptor.sourceId);
    const safeName = path.posix.basename(descriptor.relativePath).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'download.bin';
    const destination = path.join(this.workspaceStore.projectDir(plugin.projectId), 'downloads', plugin.environmentId, plugin.pluginInstanceId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeName}`);
    const result = await this.serverRuntime.downloadRemoteFile(plugin, descriptor.path, destination, source.maxFileBytes);
    return { fileId, relativePath: descriptor.relativePath, savedAs: result.localPath, bytes: result.bytes };
  }

  statPath(plugin, { path: remotePath } = {}) {
    return this.serverRuntime.statRemotePath(plugin, normalizeRemotePath(remotePath));
  }

  async listDirectory(plugin, { path: remotePath, cursor, limit = 200 } = {}) {
    const offset = parseOffsetCursor(cursor);
    const requestedPath = normalizeRemotePath(remotePath);
    const pageSize = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const entries = await this.serverRuntime.listRemoteDirectory(plugin, requestedPath, { offset, limit:pageSize + 1, sortByName:true });
    // Older/custom runtimes return the whole directory; keep that contract as
    // a fallback while native runtimes resolve symlinks only for this page.
    const pagedByRuntime = Number(entries.pageOffset) === offset;
    const sorted = pagedByRuntime ? entries : entries.sort((left, right) => left.name.localeCompare(right.name)).slice(offset);
    const page = sorted.slice(0, pageSize);
    const hasMoreWithinCap = pagedByRuntime ? Boolean(entries.hasMoreWithinCap) || sorted.length > pageSize : sorted.length > pageSize;
    const sourceTruncated = pagedByRuntime ? Boolean(entries.sourceTruncated) : Boolean(entries.truncated);
    return {
      path:requestedPath,
      entries:page.map((entry) => ({
        name:entry.name,
        path:entry.canonicalPath ?? path.posix.join(requestedPath, entry.name),
        size:entry.size,
        mtime:entry.mtime,
        mode:entry.mode,
        type:entry.isSymbolicLink ? 'symlink' : entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'special',
      })),
      nextCursor:hasMoreWithinCap ? String(offset + pageSize) : null,
      truncated:hasMoreWithinCap || sourceTruncated,
    };
  }

  withRemoteReadSession(plugin, operation) {
    if (typeof this.serverRuntime.withRemoteReadSession === 'function') {
      return this.serverRuntime.withRemoteReadSession(plugin, operation);
    }
    return operation({
      statPath: (remotePath) => this.serverRuntime.statRemotePath(plugin, remotePath),
      listDirectory: (remotePath) => this.serverRuntime.listRemoteDirectory(plugin, remotePath),
      readRange: (remotePath, start, maxBytes) => this.serverRuntime.readRemoteRange(plugin, remotePath, start, maxBytes),
      ...(typeof this.serverRuntime.readRemoteBuffer === 'function'
        ? { readBuffer:(remotePath, start, maxBytes) => this.serverRuntime.readRemoteBuffer(plugin, remotePath, start, maxBytes) }
        : {}),
    });
  }

  async findFilesWithReader(reader, {
    path: remotePath,
    pattern = '*',
    maxDepth = 6,
    maxResults = 500,
    acceptsFile = null,
  } = {}) {
    const root = normalizeRemotePath(remotePath);
    const filter = namePattern(pattern);
    const depthLimit = Math.min(Math.max(Number(maxDepth) || 0, 0), 12);
    const resultLimit = Math.min(Math.max(Number(maxResults) || 500, 1), 1000);
    const queue = [{ path:root, depth:0 }];
    const matches = [];
    let visitedDirectories = 0;
    let visitedEntries = 0;
    let truncated = false;
    while (queue.length && matches.length < resultLimit && visitedDirectories < 200 && visitedEntries < 10_000) {
      const batchSize = Math.min(REMOTE_DIRECTORY_CONCURRENCY, queue.length, 200 - visitedDirectories);
      const batch = queue.splice(0, batchSize);
      const listed = await Promise.all(batch.map(async (current) => ({ current, entries:await reader.listDirectory(current.path) })));
      for (const { current, entries } of listed) {
        truncated ||= Boolean(entries.truncated);
        visitedDirectories += 1;
        if (matches.length >= resultLimit || visitedEntries >= 10_000) {
          truncated = true;
          continue;
        }
        for (const entry of entries) {
          visitedEntries += 1;
          if (entry.isFile && !entry.isSymbolicLink && entry.canonicalPath
            && globMatches(filter, entry.name) && (!acceptsFile || acceptsFile(entry))) {
            matches.push({ path:entry.canonicalPath, name:entry.name, size:entry.size, mtime:entry.mtime });
            if (matches.length >= resultLimit) break;
          }
          if (entry.isDirectory && !entry.isSymbolicLink && current.depth < depthLimit && entry.canonicalPath) {
            queue.push({ path:entry.canonicalPath, depth:current.depth + 1 });
          }
          if (visitedEntries >= 10_000) break;
        }
      }
    }
    truncated ||= queue.length > 0 || matches.length >= resultLimit || visitedDirectories >= 200 || visitedEntries >= 10_000;
    return { root, pattern:filter, files:matches, truncated, scanned:{ directories:visitedDirectories, entries:visitedEntries }, limitsApplied:{ maxDepth:depthLimit, maxResults:resultLimit, maxDirectories:200, maxEntries:10_000 } };
  }

  findFiles(plugin, options = {}) {
    return this.withRemoteReadSession(plugin, (reader) => this.findFilesWithReader(reader, options));
  }

  async readFile(plugin, { path: remotePath, cursor, maxBytes = 262_144 } = {}) {
    const offset = parseOffsetCursor(cursor);
    const requestedPath = normalizeRemotePath(remotePath);
    const limit = Math.min(Math.max(Number(maxBytes) || 262_144, 1), 1024 * 1024);
    const result = await this.serverRuntime.readRemoteRange(plugin, requestedPath, offset, limit);
    return { path:result.canonicalPath, content:result.content, startByte:result.startByte, endByte:result.endByte, size:result.size, mtime:result.mtime, nextCursor:result.truncated ? String(result.endByte) : null, truncated:result.truncated };
  }

  async searchFiles(plugin, { path: remotePath, pattern = '*', contains, maxDepth = 6, maxFiles = 100, maxMatches = 200, maxScanBytes = 16 * 1024 * 1024 } = {}) {
    const needle = String(contains ?? '');
    if (!needle || Buffer.byteLength(needle) > 4096 || needle.includes('\0')) throw new AppError('INVALID_ARGUMENT', '搜索文本不能为空且不能超过 4096 字节。');
    const fileLimit = Math.min(Math.max(Number(maxFiles) || 100, 1), 500);
    const matchLimit = Math.min(Math.max(Number(maxMatches) || 200, 1), 500);
    const scanLimit = Math.min(Math.max(Number(maxScanBytes) || 1024 * 1024, 64 * 1024), 32 * 1024 * 1024);
    return this.withRemoteReadSession(plugin, async (reader) => {
      const found = await this.findFilesWithReader(reader, { path:remotePath, pattern, maxDepth, maxResults:fileLimit });
      const matches = [];
      let scannedBytes = 0;
      let scannedFiles = 0;
      for (const file of found.files) {
        if (scannedBytes >= scanLimit || matches.length >= matchLimit) break;
        let cursor = 0;
        let lineBase = 0;
        let carry = '';
        scannedFiles += 1;
        while (scannedBytes < scanLimit && matches.length < matchLimit) {
          const remaining = scanLimit - scannedBytes;
          const page = await reader.readRange(file.path, cursor, Math.min(1024 * 1024, remaining));
          const bytes = page.endByte - page.startByte;
          scannedBytes += bytes;
          const text = carry + page.content;
          const lines = text.split(/\r?\n/);
          carry = page.truncated ? lines.pop() ?? '' : '';
          for (let index = 0; index < lines.length && matches.length < matchLimit; index += 1) {
            if (lines[index].includes(needle)) matches.push({ path:file.path, line:lineBase + index + 1, text:capText(lines[index], 4096).text });
          }
          lineBase += lines.length;
          cursor = page.endByte;
          if (!page.truncated || bytes === 0) {
            if (carry.includes(needle) && matches.length < matchLimit) matches.push({ path:file.path, line:lineBase + 1, text:capText(carry, 4096).text });
            break;
          }
        }
      }
      const truncated = found.truncated || scannedFiles < found.files.length || scannedBytes >= scanLimit || matches.length >= matchLimit;
      return { matches, matchCount:matches.length, scannedFiles, scannedBytes, truncated, limitsApplied:{ maxFiles:fileLimit, maxMatches:matchLimit, maxScanBytes:scanLimit } };
    });
  }

  async downloadPath(plugin, { path: remotePath } = {}) {
    const requestedPath = normalizeRemotePath(remotePath);
    const safeName = path.posix.basename(requestedPath).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'download.bin';
    const destination = path.join(this.workspaceStore.projectDir(plugin.projectId), 'downloads', plugin.environmentId, plugin.pluginInstanceId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeName}`);
    const result = await this.serverRuntime.downloadRemoteFile(plugin, requestedPath, destination, 500 * 1024 * 1024);
    return { path:result.canonicalPath, savedAs:result.localPath, bytes:result.bytes, mtime:result.mtime };
  }

  async remoteSnapshot(plugin, remotePath) {
    try {
      const value = await this.serverRuntime.statRemotePath(plugin, normalizeRemotePath(remotePath));
      return { exists:true, path:value.path, canonicalPath:value.canonicalPath, type:value.type, size:value.size, mtime:value.mtime, mode:value.mode };
    } catch (error) {
      if (error?.code === 'SOURCE_NOT_FOUND') return { exists:false, path:normalizeRemotePath(remotePath) };
      throw error;
    }
  }

  async prepareMutation(plugin, capability, input) {
    const args = { ...input };
    if (capability === 'fs.upload') {
      const localPath = path.resolve(String(args.localPath ?? ''));
      const local = await fsp.lstat(localPath).catch(() => { throw new AppError('PATH_INVALID', '本地上传文件不存在。'); });
      if (!local.isFile() || local.isSymbolicLink()) throw new AppError('PATH_INVALID', '只能上传本地普通文件。');
      if (local.size > 500 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '上传文件不能超过 500 MiB。');
      const sha256 = await sha256File(localPath);
      const after = await fsp.lstat(localPath);
      if (after.size !== local.size || after.mtimeMs !== local.mtimeMs) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在校验期间发生变化。');
      const remotePath = normalizeRemotePath(args.remotePath);
      const remote = await this.remoteSnapshot(plugin, remotePath);
      if (remote.exists && args.overwrite !== true) throw new AppError('TARGET_EXISTS', '远程目标已存在；如需覆盖请明确传 overwrite=true。');
      return { localPath, remotePath, overwrite:args.overwrite === true, _precondition:{ local:{ size:local.size, mtimeMs:local.mtimeMs, sha256 }, remote } };
    }
    if (capability === 'fs.write') {
      const remotePath = normalizeRemotePath(args.path);
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content) > 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '单次写入内容不能超过 1 MiB。');
      const remote = await this.remoteSnapshot(plugin, remotePath);
      if (remote.exists && args.overwrite !== true) throw new AppError('TARGET_EXISTS', '远程目标已存在；如需覆盖请明确传 overwrite=true。');
      return { path:remotePath, content, overwrite:args.overwrite === true, _precondition:{ remote, newSha256:crypto.createHash('sha256').update(content).digest('hex'), bytes:Buffer.byteLength(content) } };
    }
    if (capability === 'fs.move') {
      const sourcePath = normalizeRemotePath(args.sourcePath);
      const destinationPath = normalizeRemotePath(args.destinationPath);
      if (sourcePath === destinationPath) throw new AppError('INVALID_ARGUMENT', '源路径和目标路径不能相同。');
      const source = await this.remoteSnapshot(plugin, sourcePath);
      if (!source.exists) throw new AppError('SOURCE_NOT_FOUND', '待移动的服务器路径不存在。');
      const destination = await this.remoteSnapshot(plugin, destinationPath);
      if (destination.exists && args.overwrite !== true) throw new AppError('TARGET_EXISTS', '目标路径已存在；如需覆盖请明确传 overwrite=true。');
      return { sourcePath, destinationPath, overwrite:args.overwrite === true, _precondition:{ source, destination } };
    }
    if (capability === 'fs.delete') {
      const remotePath = normalizeRemotePath(args.path);
      if (remotePath === '/') throw new AppError('POLICY_DENIED', '禁止删除服务器根目录。');
      const remote = await this.remoteSnapshot(plugin, remotePath);
      if (!remote.exists) throw new AppError('SOURCE_NOT_FOUND', '待删除的服务器路径不存在。');
      return { path:remotePath, _precondition:{ remote } };
    }
    if (capability === 'service.control') {
      const action = String(args.action ?? '');
      const unit = String(args.unit ?? '').trim();
      if (!['restart','reload','stop','start'].includes(action)) throw new AppError('INVALID_ARGUMENT', '服务操作必须是 start、stop、restart 或 reload。');
      if (!unit || unit.length > 255 || !/^[A-Za-z0-9_.@:-]+$/.test(unit)) throw new AppError('INVALID_ARGUMENT', 'systemd unit 名称无效。');
      return { action, unit };
    }
    if (capability === 'shell.execute') {
      const command = String(args.command ?? '').trim();
      if (!command || command.length > 16_384 || command.includes('\0')) throw new AppError('INVALID_ARGUMENT', 'Shell 命令为空或过长。');
      const workingDirectory = args.workingDirectory ? normalizeRemotePath(args.workingDirectory) : undefined;
      return { command, ...(workingDirectory ? { workingDirectory } : {}) };
    }
    return args;
  }

  mutate(plugin, capability, args) {
    if (capability === 'fs.upload') return this.serverRuntime.uploadRemoteFile(plugin, args.localPath, args.remotePath, args._precondition);
    if (capability === 'fs.write') return this.serverRuntime.writeRemoteFile(plugin, args.path, args.content, args._precondition);
    if (capability === 'fs.move') return this.serverRuntime.moveRemotePath(plugin, args.sourcePath, args.destinationPath, args._precondition);
    if (capability === 'fs.delete') return this.serverRuntime.deleteRemotePath(plugin, args.path, args._precondition);
    if (capability === 'service.control') return this.serverRuntime.executeApproved(plugin, `LC_ALL=C systemctl ${args.action} -- ${quotePosix(args.unit)}`);
    if (capability === 'shell.execute') return this.serverRuntime.executeApproved(plugin, args.command, args.workingDirectory);
    throw new AppError('CAPABILITY_NOT_IMPLEMENTED', 'Server 变更操作尚未实现。');
  }
}

export const serverOperationInternals = { globMatches, withinRoot, redactConfig, capText, sliceUtf8, normalizeRemotePath, quotePosix };
