import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.mjs';

const FILE_ID_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_IDS = 2000;
const MAX_CONFIG_BYTES = 1024 * 1024;
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
    const result = await this.serverRuntime.executeFixed(plugin, command);
    const stdout = capText(result.stdout, plugin.limits.maxBytes);
    const stderr = capText(result.stderr, Math.max(0, plugin.limits.maxBytes - stdout.bytes));
    return {
      actionId,
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: result.durationMs,
    };
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
    if (descriptor.size > MAX_CONFIG_BYTES) throw new AppError('FILE_TOO_LARGE', '配置文件超过 1 MiB，无法安全读取和脱敏。');
    const result = await this.serverRuntime.readRemoteRange(plugin, descriptor.path, 0, MAX_CONFIG_BYTES);
    if (result.mtime !== descriptor.mtime) throw new AppError('SOURCE_CHANGED', '配置文件已经变化，请重新列出。');
    if (result.truncated) throw new AppError('FILE_TOO_LARGE', '配置文件超过安全读取上限。');
    const page = sliceUtf8(redactConfig(result.content), args.cursor, Math.min(Math.max(Number(args.maxBytes) || 262_144, 1), 262_144));
    return { fileId: args.fileId, relativePath: descriptor.relativePath, content: page.content, nextCursor: page.truncated ? String(page.endByte) : null, truncated: page.truncated, redacted: true };
  }

  async download(plugin, { fileId } = {}) {
    const descriptor = this.requireFile(plugin, fileId);
    const source = this.source(plugin, descriptor.sourceId);
    const safeName = path.posix.basename(descriptor.relativePath).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'download.bin';
    const destination = path.join(this.workspaceStore.projectDir(plugin.projectId), 'downloads', plugin.environmentId, plugin.pluginInstanceId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeName}`);
    const result = await this.serverRuntime.downloadRemoteFile(plugin, descriptor.path, destination, source.maxFileBytes);
    return { fileId, relativePath: descriptor.relativePath, savedAs: result.localPath, bytes: result.bytes };
  }
}

export const serverOperationInternals = { globMatches, withinRoot, redactConfig, capText, sliceUtf8 };
