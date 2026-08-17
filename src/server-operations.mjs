import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const FILE_ID_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_IDS = 2000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const REMOTE_DIRECTORY_CONCURRENCY = 2;
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

export class ServerOperations {
  constructor(serverRuntime, workspaceStore) {
    this.serverRuntime = serverRuntime;
    this.workspaceStore = workspaceStore;
    this.files = new Map();
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

  async listFiles(plugin, { sourceId, cursor = 0, limit = 200 } = {}) {
    const source = this.source(plugin, sourceId);
    const entries = await this.serverRuntime.listRemoteDirectory(plugin, source.root);
    const filtered = entries.filter((entry) =>
      entry.isFile && !entry.isSymbolicLink && entry.canonicalPath && withinRoot(source.root, entry.canonicalPath) && entry.size <= source.maxFileBytes && source.patterns.some((pattern) => globMatches(pattern, entry.name)),
    ).sort((left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name));
    const offset = Math.max(Number(cursor) || 0, 0);
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
    const descriptor = this.requireFile(plugin, fileId);
    const source = this.source(plugin, descriptor.sourceId);
    if (source.kind !== 'log') throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于日志数据源。');
    const limit = Math.min(Math.max(Number(maxBytes) || 262_144, 1), plugin.limits.maxBytes);
    const start = cursor !== null ? Math.max(Number(cursor) || 0, 0) : tail ? Math.max(0, descriptor.size - limit) : 0;
    const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, start, limit);
    if (result.mtime !== descriptor.mtime) throw new AppError('SOURCE_CHANGED', '文件已经变化，请重新列出。');
    return { fileId, relativePath: descriptor.relativePath, content: result.content, startByte: result.startByte, endByte: result.endByte, size: result.size, nextCursor: result.truncated ? String(result.endByte) : null, truncated: result.truncated };
  }

  async searchLogs(plugin, { fileIds, contains, maxLines = 200, maxScanBytes = 4 * 1024 * 1024 } = {}) {
    const needle = String(contains ?? '');
    if (!needle || Buffer.byteLength(needle) > 1024 || /[\u0000\r\n]/.test(needle)) throw new AppError('INVALID_ARGUMENT', '日志搜索文本无效。');
    if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 10) throw new AppError('INVALID_ARGUMENT', '日志搜索需要 1 到 10 个 fileId。');
    const limit = Math.min(Math.max(Number(maxLines) || 200, 1), 200);
    const scanBudget = Math.min(Math.max(Number(maxScanBytes) || 65_536, 65_536), 8 * 1024 * 1024);
    const matches = [];
    let scannedBytes = 0;
    for (const fileId of fileIds) {
      const descriptor = this.requireFile(plugin, fileId);
      const source = this.source(plugin, descriptor.sourceId);
      if (source.kind !== 'log') throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于日志数据源。');
      const remaining = scanBudget - scannedBytes;
      if (remaining <= 0 || matches.length >= limit) break;
      const start = Math.max(0, descriptor.size - remaining);
      const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, start, remaining);
      scannedBytes += Buffer.byteLength(result.content);
      const lines = result.content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        if (lines[index].includes(needle)) matches.push({ fileId, relativePath: descriptor.relativePath, lineOffset: index, text: capText(lines[index], 4096).text });
      }
    }
    return { matches, matchCount: matches.length, scannedBytes, truncated: matches.length >= limit || scannedBytes >= scanBudget, limitsApplied: { maxLines: limit, maxScanBytes: scanBudget } };
  }

  async readConfig(plugin, args) {
    const descriptor = this.requireFile(plugin, args.fileId);
    const source = this.source(plugin, descriptor.sourceId);
    if (source.kind !== 'config') throw new AppError('SOURCE_NOT_ALLOWED', '该文件不属于配置数据源。');
    if (descriptor.size > MAX_CONFIG_BYTES) throw new AppError('FILE_TOO_LARGE', '配置文件超过 1 MiB，请改用 server_read_file 分页读取。');
    const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, 0, MAX_CONFIG_BYTES);
    if (result.mtime !== descriptor.mtime) throw new AppError('SOURCE_CHANGED', '配置文件已经变化，请重新列出。');
    if (result.truncated) throw new AppError('FILE_TOO_LARGE', '配置文件超过安全读取上限。');
    const page = sliceUtf8(result.content, args.cursor, Math.min(Math.max(Number(args.maxBytes) || 262_144, 1), 262_144));
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

  async listDirectory(plugin, { path: remotePath, cursor = 0, limit = 200 } = {}) {
    const requestedPath = normalizeRemotePath(remotePath);
    const entries = await this.serverRuntime.listRemoteDirectory(plugin, requestedPath);
    const offset = Math.max(Number(cursor) || 0, 0);
    const pageSize = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const sorted = entries.sort((left, right) => left.name.localeCompare(right.name));
    return {
      path:requestedPath,
      entries:sorted.slice(offset, offset + pageSize).map((entry) => ({
        name:entry.name,
        path:entry.canonicalPath ?? path.posix.join(requestedPath, entry.name),
        size:entry.size,
        mtime:entry.mtime,
        mode:entry.mode,
        type:entry.isSymbolicLink ? 'symlink' : entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'special',
      })),
      nextCursor:offset + pageSize < sorted.length ? String(offset + pageSize) : null,
      truncated:Boolean(entries.truncated) || offset + pageSize < sorted.length,
    };
  }

  withRemoteReadSession(plugin, operation) {
    if (typeof this.serverRuntime.withRemoteReadSession === 'function') {
      return this.serverRuntime.withRemoteReadSession(plugin, operation);
    }
    return operation({
      listDirectory: (remotePath) => this.serverRuntime.listRemoteDirectory(plugin, remotePath),
      readRange: (remotePath, start, maxBytes) => this.serverRuntime.readRemoteRange(plugin, remotePath, start, maxBytes),
    });
  }

  async findFilesWithReader(reader, { path: remotePath, pattern = '*', maxDepth = 6, maxResults = 500 } = {}) {
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
          if (entry.isFile && !entry.isSymbolicLink && globMatches(filter, entry.name)) {
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

  async readFile(plugin, { path: remotePath, cursor = 0, maxBytes = 262_144 } = {}) {
    const requestedPath = normalizeRemotePath(remotePath);
    const limit = Math.min(Math.max(Number(maxBytes) || 262_144, 1), 1024 * 1024);
    const result = await this.serverRuntime.readRemoteRange(plugin, requestedPath, Math.max(Number(cursor) || 0, 0), limit);
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
