import path from 'node:path';
import { AppError } from './errors.mjs';
import { globMatches, withinRoot, capText, normalizeRemotePath, namePattern, archiveSuffix, assertLogReadIdentity } from './server-read-utils.mjs';
import { detectLogArchiveType } from './log-archive.mjs';
import { BoundedReadScheduler } from './bounded-read-scheduler.mjs';
import { logProcessor } from './log-processor.mjs';
import { LogSearchCursors, logSearchBinding } from './log-search-cursors.mjs';
import { LOG_SEARCH_LIMITS, logInteger } from './log-search-limits.mjs';

const LOG_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const LOG_SNAPSHOT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LOG_SEARCH_MAX_EXPANDED_BYTES = LOG_SEARCH_LIMITS.maxExpandedBytes.maximum;
const LOG_SEARCH_MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const LOG_SEARCH_MAX_CONCURRENT = 2;
const LOG_SEARCH_MAX_RESERVED_BYTES = 512 * 1024 * 1024;
const LOG_SEARCH_MAX_QUEUED = 32;

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

function withoutArchiveSuffix(name) {
  return archiveSuffix(name) ? String(name).replace(/\.(?:zip|gz|gzip)$/iu, '') : String(name);
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

function logSearchGuidance(reasons) {
  const guidance = [];
  if (reasons.has('sourceGrew')) guidance.push('日志在读取期间增长，coverage 标明本次范围；需要最新内容时再次搜索，不能据此断言新增内容没有匹配。');
  if (reasons.has('fileTailOnly')) guidance.push('本次只搜索文件尾部；历史问题请用日期 pattern 选择轮转日志，或在上限内增大 maxScanBytes。');
  if (reasons.has('maxScanBytes')) guidance.push('扫描预算不足；指定单个文件后按文件大小设置 maxScanBytes，最大 67108864。ZIP/GZIP 必须完整读取压缩输入。');
  if (reasons.has('maxExpandedBytes') || reasons.has('archiveRejected')) guidance.push('检查 skipped 中的具体原因；解压大小超限时可增大 maxExpandedBytes，最大 134217728；损坏、加密、压缩比或不支持的格式无法通过增加扫描预算解决。');
  if (reasons.has('maxFilesOrListing')) guidance.push('文件发现范围不完整；用日期 pattern、单个文件 path 或更窄的子目录继续搜索。');
  if (reasons.has('timeBudget')) guidance.push('搜索时间预算已用尽；指定单个文件并合并 queries，缩小读取范围后重试。');
  return guidance;
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

export class ServerLogSearch {
  constructor(operations, options = {}) {
    this.serverRuntime = operations.serverRuntime;
    this.source = operations.source.bind(operations);
    this.requireFile = operations.requireFile.bind(operations);
    this.withRemoteReadSession = operations.withRemoteReadSession.bind(operations);
    this.findFilesWithReader = operations.findFilesWithReader.bind(operations);
    this.processor = options.logProcessor ?? logProcessor;
    this.pageTimeMs = options.logPageTimeMs ?? 60_000;
    this.cursors = new LogSearchCursors({ now:options.now ?? Date.now });
    this.logSnapshotCache = new LogSnapshotCache({
      now:options.now ?? Date.now,
      ttlMs:options.logSnapshotCacheTtlMs ?? LOG_SNAPSHOT_CACHE_TTL_MS,
      maxBytes:options.maxLogSnapshotCacheBytes ?? LOG_SNAPSHOT_CACHE_MAX_BYTES,
    });
    this.logSearchGate = new BoundedReadScheduler({
      busyCode:'LOG_SEARCH_BUSY',
      maxConcurrent:options.logSearchMaxConcurrent ?? LOG_SEARCH_MAX_CONCURRENT,
      maxReservedBytes:options.logSearchMaxReservedBytes ?? LOG_SEARCH_MAX_RESERVED_BYTES,
      maxQueued:options.logSearchMaxQueued ?? LOG_SEARCH_MAX_QUEUED,
    });
  }

  async searchLogs(plugin, args = {}) {
    if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new AppError('INVALID_ARGUMENT','refresh 必须是布尔值。');
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
    const maxMatches = logInteger(args.maxMatches ?? args.maxLines, 'maxMatches');
    const maxFiles = logInteger(args.maxFiles, 'maxFiles', selector === 'fileIds' ? 10 : 20);
    const maxDepth = logInteger(args.maxDepth, 'maxDepth');
    const beforeLines = logInteger(args.beforeLines, 'beforeLines');
    const afterLines = logInteger(args.afterLines, 'afterLines');
    const scanBudget = logInteger(args.maxScanBytes, 'maxScanBytes', legacy ? 4 * 1024 * 1024 : 16 * 1024 * 1024);
    const expandedBudget = logInteger(args.maxExpandedBytes, 'maxExpandedBytes',
      Math.min(LOG_SEARCH_MAX_EXPANDED_BYTES, Math.max(scanBudget, scanBudget * 4)));
    const maxArchiveEntries = logInteger(args.maxArchiveEntries, 'maxArchiveEntries');
    for (const field of ['includeArchives','caseSensitive']) {
      if (args[field] !== undefined && typeof args[field] !== 'boolean') throw new AppError('INVALID_ARGUMENT', field + ' 必须是布尔值。', {field});
    }
    const includeArchives = args.includeArchives !== false;
    const filter = args.pattern === undefined ? null : namePattern(args.pattern);
    const caseSensitive = args.caseSensitive !== false;
    const gateKey = [plugin.projectId,plugin.environmentId,plugin.pluginInstanceId].join('\u0000');
    const reservationBytes = (scanBudget * 2) + (expandedBudget * 3);

    return this.logSearchGate.run(gateKey, reservationBytes, () => this.withRemoteReadSession(plugin, async (reader) => {
      const deadline = Date.now() + this.pageTimeMs;
      const binding = logSearchBinding(plugin,args,reader.generation);
      const resumed = args.cursor === undefined ? null : this.cursors.get(args.cursor,binding);
      const directStat = !resumed && selector === 'path'
        ? await (typeof reader.statPath === 'function'
          ? reader.statPath(normalizeRemotePath(args.path))
          : this.serverRuntime.statRemotePath(plugin, normalizeRemotePath(args.path)))
        : null;
      const truncationReasons = new Set();
      const skipped = [];
      let selectionTruncated = false;
      let files;
      let selection;
      let remainingDirectories = resumed?.remainingDirectories ?? [];

      if (resumed) {
        files = resumed.files;
        selection = resumed.selection;
        selectionTruncated = resumed.selectionTruncated;
      } else if (selector === 'fileIds') {
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
          const grew = assertLogReadIdentity(file, { ...current, canonicalPath:current.canonicalPath ?? current.path }, {
            allowGrowth:!archiveSuffix(file.path),
          });
          if (grew) file.listedIdentity = { ...file };
          file.size = current.size;
          file.mtime = current.mtime;
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
        const found = await this.findFilesWithReader(reader, { path:root, pattern:'*', maxDepth, maxResults:1000, acceptsFile, cacheScope:[gateKey,plugin.revision], rootIdentity:sourceStat, refresh:args.refresh === true });
        const eligible = found.files.filter((file) => file.path);
        eligible.sort((left, right) => Number(right.mtime ?? 0) - Number(left.mtime ?? 0) || left.path.localeCompare(right.path));
        files = eligible.map((file) => ({
          ...file,
          canonicalPath:file.path,
          relativePath:path.posix.relative(root, file.path),
          source,
          allowedRoot:root,
          fileId:null,
        }));
        selectionTruncated = found.truncated;
        remainingDirectories = found.remainingDirectories ?? [];
        skipped.push(...(found.skipped ?? []));
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
        const found = await this.findFilesWithReader(reader, { path:root, pattern:'*', maxDepth, maxResults:1000, acceptsFile, cacheScope:[gateKey,plugin.revision], rootIdentity:directStat, refresh:args.refresh === true });
        const eligible = found.files.filter((file) => file.path && (filter
          ? globMatches(filter, file.name) || (includeArchives && archiveSuffix(file.name) && globMatches(filter, withoutArchiveSuffix(file.name)))
          : defaultLogName(file.name, includeArchives)));
        eligible.sort((left, right) => Number(right.mtime ?? 0) - Number(left.mtime ?? 0) || left.path.localeCompare(right.path));
        files = eligible.map((file) => ({
          ...file,
          canonicalPath:file.path,
          relativePath:path.posix.relative(root, file.path),
          allowedRoot:root,
          source:null,
          fileId:null,
        }));
        selectionTruncated = found.truncated;
        remainingDirectories = found.remainingDirectories ?? [];
        skipped.push(...(found.skipped ?? []));
        selection = { type:'path', path:normalizeRemotePath(args.path), targetType:'directory', pattern:filter };
      } else {
        throw new AppError('SOURCE_NOT_ALLOWED', 'path 必须指向普通文件或目录。');
      }

      if (selectionTruncated || files.length > maxFiles) truncationReasons.add('maxFilesOrListing');
      if (resumed?.unresolved) truncationReasons.add('previousGaps');
      let pending = files;
      let attemptedFiles = 0;

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

      for (const [fileIndex,file] of files.entries()) {
        pending = files.slice(fileIndex);
        if (attemptedFiles >= maxFiles) break;
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
        attemptedFiles += 1;
        pending = files.slice(fileIndex + 1);
        let resumedGrowth = false;
        let resumedSize = Number(file.size);
        try {
          if (resumed || file.fromCachedListing) {
            const current = await reader.statPath(file.canonicalPath ?? file.path);
            if (current.type !== 'file') throw new AppError('SOURCE_CHANGED','续查文件已经被替换。');
            if (!resumed) {
              if ((current.canonicalPath ?? current.path) !== (file.canonicalPath ?? file.path)) throw new AppError('SOURCE_CHANGED','目录缓存中的文件路径已经变化。',{reason:'path'});
              file.size = current.size;
              file.mtime = current.mtime;
            }
            resumedGrowth = assertLogReadIdentity(file, current, {allowGrowth:!archiveSuffix(file.name ?? file.path) && (!file.archiveType || file.archiveType === 'plain')});
            resumedSize = Number(current.size);
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
          let sourceGrew = resumedGrowth;
          let observedSize = Math.max(fileSize,resumedSize);
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
              pending = files.slice(fileIndex);
              break;
            }
            // 先计入请求范围，读取中途失败仍消耗本页预算。
            scannedBytes += probeLength;
            let probe;
            if (typeof reader.readBuffer === 'function') {
              probe = await reader.readBuffer(file.canonicalPath ?? file.path, 0, probeLength, { allowGrowth:true });
            } else if (typeof this.serverRuntime.readRemoteBuffer === 'function') {
              probe = await this.serverRuntime.readRemoteBuffer(plugin, file.canonicalPath ?? file.path, 0, probeLength, { allowGrowth:true });
            } else {
              throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '当前 Server Runtime 不支持二进制日志读取。');
            }
            const probeContent = Buffer.isBuffer(probe.content) ? probe.content : Buffer.from(probe.content ?? []);
            if (probeContent.length !== probeLength) {
              throw new AppError('SOURCE_CHANGED', '日志文件在类型探测期间已经变化，请重新搜索。');
            }
            probeBytesRead = probeContent.length;
            remoteBytesRead += probeBytesRead;
            remainingScan -= probeBytesRead;
            const detectedType = detectLogArchiveType({
              filePath:file.canonicalPath ?? file.path,
              content:probeContent,
            });
            effectiveArchive = detectedType === 'plain' ? null : detectedType;
            sourceGrew = assertLogReadIdentity(effectiveArchive ? file.listedIdentity ?? file : file, probe, { allowGrowth:!effectiveArchive }) || sourceGrew;
            observedSize = Number(probe.observedSize ?? probe.size);
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
            pending = files.slice(fileIndex);
            break;
          }
          if (effectiveArchive && fileSize > remainingScan) {
            skipped.push({ path:file.path, code:'ARCHIVE_INPUT_LIMIT', size:Number(file.size), remainingBytes:remainingScan });
            truncationReasons.add('maxScanBytes');
            continue;
          }
          const rangeEnd = file.windowEnd ?? file.rangeEndByte ?? fileSize;
          const length = file.windowStart === undefined
            ? Math.min(rangeEnd, effectiveArchive ? remainingScan : Math.min(remainingScan, remainingExpanded))
            : rangeEnd - file.windowStart;
          const start = file.windowStart ?? (effectiveArchive ? 0 : Math.max(0, rangeEnd - length));
          let searchedStart = start;
          if (start > 0) truncationReasons.add('fileTailOnly');
          const cacheKey = JSON.stringify([
            plugin.projectId, plugin.environmentId, plugin.pluginInstanceId,
            plugin.revision ?? null, reader.generation ?? null,
            file.canonicalPath ?? file.path, Number(file.size), Number(file.mtime), start, length,
            remainingExpanded, remainingArchiveEntries, includeArchives, effectiveArchive,
          ]);
          const cached = sourceGrew || file.listedIdentity || (args.refresh === true && !resumed) ? null : this.logSnapshotCache.get(cacheKey);
          scannedBytes += length;
          let content;
          let expanded;
          try {
            if (cached) {
              cacheHits += 1;
              cacheSavedRemoteBytes += length;
              // 缓存可定时清零，复制后交给工作线程以免排队期间失效。
              content = Buffer.from(cached.snapshots[0].content);
            } else {
              cacheMisses += 1;
              let read;
              if (length === 0) {
                read = { canonicalPath:file.canonicalPath ?? file.path, content:Buffer.alloc(0), startByte:0, endByte:0, size:0, mtime:Number(file.mtime), truncated:false };
              } else if (typeof reader.readBuffer === 'function') {
                read = await reader.readBuffer(file.canonicalPath ?? file.path, start, length, { allowGrowth:!effectiveArchive });
              } else if (typeof this.serverRuntime.readRemoteBuffer === 'function') {
                read = await this.serverRuntime.readRemoteBuffer(plugin, file.canonicalPath ?? file.path, start, length, { allowGrowth:!effectiveArchive });
              } else {
                throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '当前 Server Runtime 不支持二进制日志读取。');
              }
              content = Buffer.isBuffer(read.content) ? read.content : Buffer.from(read.content ?? []);
              remoteBytesRead += content.length;
              const detectedType = detectLogArchiveType({ filePath:read.canonicalPath, content });
              const allowGrowth = detectedType === 'plain' && !effectiveArchive;
              sourceGrew = assertLogReadIdentity(allowGrowth ? file : file.listedIdentity ?? file, read, { allowGrowth }) || sourceGrew;
              observedSize = Math.max(observedSize, Number(read.observedSize ?? read.size));
              if (content.length !== length) throw new AppError('SOURCE_CHANGED', '日志读取范围不完整，请重新搜索。');
            }
            if (!effectiveArchive && start > 0) {
              const boundaries = [content.indexOf(10),content.indexOf(13)].filter(index => index >= 0);
              if (boundaries.length) {
                const boundary = Math.min(...boundaries);
                searchedStart += boundary + (content[boundary] === 13 && content[boundary + 1] === 10 ? 2 : 1);
              } else {
                skipped.push({path:file.path,code:'LOG_LINE_EXCEEDS_WINDOW',startByte:start,endByte:rangeEnd});
                truncationReasons.add('lineBoundary');
              }
            }
            if (!cached && !sourceGrew) this.logSnapshotCache.set(cacheKey, { snapshots:[{ content:Buffer.from(content) }] });
            if (Date.now() >= deadline) {
              pending = files.slice(fileIndex);
              truncationReasons.add('timeBudget');
              break;
            }
            expanded = await this.processor.run('process', {
              archive:{
                filePath:file.canonicalPath ?? file.path, content,
                maxExpandedBytes:remainingExpanded, maxEntries:Math.max(1, remainingArchiveEntries),
                maxEntryBytes:remainingExpanded, maxCompressionRatio:100, allowArchives:includeArchives,
              },
              search:{
                keywords:queries, keywordMode:modeValue === 'all' ? 'AND' : 'OR', caseSensitive,
                beforeLines, afterLines, maxMatches:Math.max(0, maxMatches - matches.length),
                matchOffset:file.matchOffset ?? 0, skipPrefixBytes:searchedStart - start,
                maxContextBytes:Math.max(0, LOG_SEARCH_MAX_CONTEXT_BYTES - contextBytes),
              },
            }, {timeoutMs:Math.max(1,deadline - Date.now())});
          } catch (error) {
            if (error?.code === 'LOG_PROCESSING_TIMEOUT') {
              pending = files.slice(fileIndex);
              truncationReasons.add('timeBudget');
              break;
            }
            if (!String(error?.code ?? '').startsWith('LOG_ARCHIVE_')) throw error;
            archiveEntriesScanned += Math.min(Math.max(0, remainingArchiveEntries), Math.max(0, Math.floor(Number(error?.details?.entriesScanned) || 0)));
            expandedBytes += Math.min(Math.max(0, remainingExpanded), Math.max(0, Math.floor(Number(error?.details?.expandedBytes) || 0)));
            if (error.code === 'LOG_ARCHIVE_DISABLED') skipped.push({ path:file.path, code:'ARCHIVES_EXCLUDED' });
            else {
              skipped.push({ path:file.path, code:error.code, details:error.details ?? null });
              truncationReasons.add('archiveRejected');
            }
            if (archiveEntriesScanned >= maxArchiveEntries) truncationReasons.add('maxArchiveEntries');
            if (expandedBytes >= expandedBudget) truncationReasons.add('maxExpandedBytes');
            continue;
          }
          file.archiveType = expanded.archiveType;

          if (sourceGrew) truncationReasons.add('sourceGrew');
          expandedBytes += expanded.expandedBytes;
          scannedFiles += 1;
          if (expanded.archiveType !== 'plain') {
            archivesScanned += 1;
            archiveEntriesScanned += expanded.entriesScanned;
          }
          for (const warning of expanded.warnings) skipped.push({ path:file.path, archiveMember:warning.archiveEntry, code:warning.code });
          if (expanded.truncated) truncationReasons.add('archiveEntriesSkipped');

          for (const snapshot of expanded.snapshots) {
            const search = snapshot.search;
            if (search.outputTruncated) truncationReasons.add('outputBytes');
            totalMatches += search.totalMatches;
            const lineNumberScope = snapshot.archiveEntry ? 'archiveMember' : searchedStart === 0 ? 'file' : rangeEnd === fileSize ? 'scannedTail' : 'scannedRange';
            for (const match of search.matches) {
              matches.push({
                ...(file.fileId ? { fileId:file.fileId } : {}),
                relativePath:file.relativePath,
                path:file.canonicalPath ?? file.path,
                ...(snapshot.archiveEntry ? { archiveMember:snapshot.archiveEntry } : {}),
                lineNumber:match.lineNumber,
                lineNumberScope,
                scanStartByte:searchedStart,
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
              scanStartByte:searchedStart,
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
            if (search.truncation.resultLimited) truncationReasons.add('maxMatches');
          }
          coverage.push({
            ...(file.fileId ? { fileId:file.fileId } : {}),
            path:file.canonicalPath ?? file.path,
            relativePath:file.relativePath,
            scanStartByte:searchedStart,
            scannedBytes:expanded.inputBytes,
            readStartByte:start,
            searchedBytes:expanded.inputBytes - (searchedStart - start),
            probeBytesRead,
            expandedBytes:expanded.expandedBytes,
            scanEndByte:start + expanded.inputBytes,
            snapshotSize:fileSize,
            observedSize,
            sourceGrew,
            complete:searchedStart === 0 && !expanded.truncated && !sourceGrew,
          });
          const windowMatches = expanded.snapshots.reduce((sum,snapshot) => sum + snapshot.search.totalMatches,0);
          const returnedMatches = expanded.snapshots.reduce((sum,snapshot) => sum + snapshot.search.matches.length,0);
          if ((file.matchOffset ?? 0) + returnedMatches < windowMatches) {
            pending.unshift({...file,windowStart:start,windowEnd:rangeEnd,matchOffset:(file.matchOffset ?? 0) + returnedMatches});
            break;
          }
          if (!effectiveArchive && start > 0) {
            const endByte = searchedStart < rangeEnd ? searchedStart : start;
            if (searchedStart >= rangeEnd) truncationReasons.add('lineBoundary');
            pending.unshift({...file,windowStart:undefined,windowEnd:undefined,rangeEndByte:endByte,matchOffset:0});
            break;
          }
        } catch (error) {
          const multiple = files.length > 1 || (resumed?.filesFinished ?? 0) > 0;
          if (!multiple || error.details?.reason === 'path' || !['SOURCE_CHANGED','SOURCE_NOT_FOUND'].includes(error?.code)) throw error;
          skipped.push({path:file.path,code:error.code});
          truncationReasons.add('sourceUnavailable');
        }
      }

      if (scannedBytes >= scanBudget && scannedFiles < files.length) truncationReasons.add('maxScanBytes');
      if (expandedBytes >= expandedBudget && scannedFiles < files.length) truncationReasons.add('maxExpandedBytes');
      const cache = this.logSnapshotCache.stats();
      const unresolved = Boolean(resumed?.unresolved) || skipped.some(item => item.code !== 'ARCHIVES_EXCLUDED') || truncationReasons.has('sourceGrew') || truncationReasons.has('lineBoundary');
      const matchedSoFar = (resumed?.matchedSoFar ?? 0) + matches.length;
      const filesFinished = (resumed?.filesFinished ?? 0) + files.length - pending.length;
      const nextCursor = pending.length ? this.cursors.put(binding,{files:pending,selection,selectionTruncated,unresolved,matchedSoFar,filesFinished,remainingDirectories}) : null;
      const complete = !nextCursor && !selectionTruncated && !unresolved;
      if (nextCursor) truncationReasons.add('moreResults');
      const guidance = logSearchGuidance(truncationReasons);
      if (nextCursor) guidance.unshift('使用完全相同的搜索参数并传入 nextCursor 作为 cursor 继续；无需重新发现目录。');
      if (unresolved) guidance.push('部分文件或行未能完整读取；请检查本页及前页的 skipped，不能据此排除日志证据。');
      return {
        selection:{ ...selection, includeArchives },
        query:{ count:queries.length, mode:modeValue, caseSensitive, literal:true },
        matches,
        contexts,
        matchCount:matches.length,
        totalMatches,
        filesConsidered:Math.min(files.length,maxFiles),
        nextCursor,
        remainingDirectories,
        status:complete ? 'complete' : 'partial',
        conclusion:matchedSoFar > 0 ? 'matches' : complete ? 'no_match' : 'inconclusive',
        progress:{filesFinished,filesRemaining:pending.length,matchedSoFar,selectionComplete:!selectionTruncated},
        scannedFiles,
        scannedBytes,
        remoteBytesRead,
        expandedBytes,
        archivesScanned,
        archiveEntriesScanned,
        coverage,
        guidance,
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

}
