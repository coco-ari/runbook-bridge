import crypto from 'node:crypto';

const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_CACHED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHED_ENTRIES = 10_000;
const DEFAULT_MAX_CURSORS = 100;
const ABSOLUTE_MAX_PAGE_SIZE = 100;
const MAX_MATCH_TEXT_BYTES = 8 * 1024;

function codedError(code, message, ErrorType = Error) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function finiteInteger(value, name, fallback, { minimum = 0 } = {}) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw codedError(
      'INVALID_LOG_SEARCH_ARGUMENT',
      `${name} must be a safe integer greater than or equal to ${minimum}`,
      RangeError,
    );
  }
  return resolved;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw codedError('INVALID_LOG_SEARCH_ARGUMENT', `${name} must be a non-empty string`, TypeError);
  }
  return value;
}

function snapshotText(content, index) {
  if (typeof content === 'string') return content;
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return Buffer.from(content).toString('utf8');
  }
  throw codedError(
    'INVALID_LOG_SEARCH_ARGUMENT',
    `snapshots[${index}].content must be a string or byte buffer`,
    TypeError,
  );
}

function normalizeKeywords(keywords, caseSensitive) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw codedError(
      'INVALID_LOG_SEARCH_ARGUMENT',
      'keywords must contain at least one literal string',
      TypeError,
    );
  }

  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < keywords.length; index += 1) {
    const keyword = keywords[index];
    if (typeof keyword !== 'string' || keyword.length === 0) {
      throw codedError(
        'INVALID_LOG_SEARCH_ARGUMENT',
        `keywords[${index}] must be a non-empty literal string`,
        TypeError,
      );
    }
    const comparison = caseSensitive ? keyword : keyword.toLowerCase();
    if (seen.has(comparison)) continue;
    seen.add(comparison);
    normalized.push({ literal: keyword, comparison });
  }
  return normalized;
}

function lineMatches(text, normalizedKeywords, keywordMode, caseSensitive) {
  const comparisonText = caseSensitive ? text : text.toLowerCase();
  const matchedKeywords = [];
  for (const keyword of normalizedKeywords) {
    if (comparisonText.includes(keyword.comparison)) matchedKeywords.push(keyword.literal);
  }
  const matched = keywordMode === 'AND'
    ? matchedKeywords.length === normalizedKeywords.length
    : matchedKeywords.length > 0;
  return { matched, matchedKeywords };
}

function mergeContextRanges(matchIndexes, lineCount, beforeLines, afterLines) {
  const ranges = [];
  for (const matchIndex of matchIndexes) {
    const start = Math.max(0, matchIndex - beforeLines);
    const end = Math.min(lineCount - 1, matchIndex + afterLines);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function matchDescriptor(snapshot, lineIndex, text, matchedKeywords) {
  const originalTextBytes = Buffer.byteLength(text, 'utf8');
  const textTruncated = originalTextBytes > MAX_MATCH_TEXT_BYTES;
  return {
    snapshotIndex: snapshot.snapshotIndex,
    path: snapshot.path,
    lineNumber: lineIndex + 1,
    text: textTruncated
      ? Buffer.from(text, 'utf8').subarray(0, MAX_MATCH_TEXT_BYTES).toString('utf8')
      : text,
    ...(textTruncated ? { textTruncated: true, originalTextBytes } : {}),
    matchedKeywords,
  };
}

/**
 * Searches immutable log snapshots without interpreting keywords as regular expressions.
 * Matching is line-based: AND requires every keyword on the same line, while OR requires one.
 */
export function searchLogSnapshots({
  snapshots,
  keywords,
  keywordMode = 'OR',
  caseSensitive = false,
  beforeLines = 0,
  afterLines = 0,
  maxMatches = DEFAULT_MAX_MATCHES,
} = {}) {
  if (!Array.isArray(snapshots)) {
    throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'snapshots must be an array', TypeError);
  }

  const normalizedMode = String(keywordMode).toUpperCase();
  if (normalizedMode !== 'AND' && normalizedMode !== 'OR') {
    throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'keywordMode must be AND or OR', TypeError);
  }
  const normalizedCaseSensitive = Boolean(caseSensitive);
  const normalizedKeywords = normalizeKeywords(keywords, normalizedCaseSensitive);
  const normalizedBeforeLines = finiteInteger(beforeLines, 'beforeLines', 0);
  const normalizedAfterLines = finiteInteger(afterLines, 'afterLines', 0);
  const normalizedMaxMatches = finiteInteger(maxMatches, 'maxMatches', DEFAULT_MAX_MATCHES);

  const preparedSnapshots = snapshots.map((snapshot, snapshotIndex) => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw codedError(
        'INVALID_LOG_SEARCH_ARGUMENT',
        `snapshots[${snapshotIndex}] must be an object`,
        TypeError,
      );
    }
    const content = snapshotText(snapshot.content, snapshotIndex);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const sizeBytes = finiteInteger(
      snapshot.sizeBytes,
      `snapshots[${snapshotIndex}].sizeBytes`,
      contentBytes,
    );
    const scannedBytes = finiteInteger(
      snapshot.scannedBytes,
      `snapshots[${snapshotIndex}].scannedBytes`,
      contentBytes,
    );
    const reportedTruncated = Boolean(snapshot.truncated);
    const sourceTruncated = reportedTruncated || scannedBytes < sizeBytes;
    return {
      snapshotIndex,
      path: requiredText(snapshot.path, `snapshots[${snapshotIndex}].path`),
      lines: content.split(/\r\n|\n|\r/),
      metadata: {
        snapshotIndex,
        path: snapshot.path,
        sizeBytes,
        scannedBytes,
        unscannedBytes: Math.max(0, sizeBytes - scannedBytes),
        reportedTruncated,
        truncated: sourceTruncated,
      },
    };
  });

  let totalMatches = 0;
  let firstMatch = null;
  let lastMatch = null;
  const matches = [];
  const selectedBySnapshot = new Map();
  const snapshotSummaries = preparedSnapshots.map((snapshot) => ({
    ...snapshot.metadata,
    totalMatches: 0,
    returnedMatches: 0,
    firstMatch: null,
    lastMatch: null,
  }));

  for (const snapshot of preparedSnapshots) {
    const selectedIndexes = [];
    const summary = snapshotSummaries[snapshot.snapshotIndex];
    for (let lineIndex = 0; lineIndex < snapshot.lines.length; lineIndex += 1) {
      const text = snapshot.lines[lineIndex];
      const evaluation = lineMatches(
        text,
        normalizedKeywords,
        normalizedMode,
        normalizedCaseSensitive,
      );
      if (!evaluation.matched) continue;

      const descriptor = matchDescriptor(snapshot, lineIndex, text, evaluation.matchedKeywords);
      totalMatches += 1;
      summary.totalMatches += 1;
      firstMatch ??= descriptor;
      lastMatch = descriptor;
      summary.firstMatch ??= descriptor;
      summary.lastMatch = descriptor;

      if (matches.length < normalizedMaxMatches) {
        matches.push(descriptor);
        selectedIndexes.push(lineIndex);
        summary.returnedMatches += 1;
      }
    }
    selectedBySnapshot.set(snapshot.snapshotIndex, selectedIndexes);
  }

  const contexts = [];
  for (const snapshot of preparedSnapshots) {
    const selectedIndexes = selectedBySnapshot.get(snapshot.snapshotIndex);
    if (!selectedIndexes?.length) continue;
    const selectedSet = new Set(selectedIndexes);
    const ranges = mergeContextRanges(
      selectedIndexes,
      snapshot.lines.length,
      normalizedBeforeLines,
      normalizedAfterLines,
    );
    for (const range of ranges) {
      const lines = [];
      const matchLineNumbers = [];
      const selectedMatchLineNumbers = [];
      for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
        const text = snapshot.lines[lineIndex];
        const evaluation = lineMatches(
          text,
          normalizedKeywords,
          normalizedMode,
          normalizedCaseSensitive,
        );
        if (evaluation.matched) matchLineNumbers.push(lineIndex + 1);
        if (selectedSet.has(lineIndex)) selectedMatchLineNumbers.push(lineIndex + 1);
        lines.push({
          lineNumber: lineIndex + 1,
          text,
          isMatch: evaluation.matched,
          selectedMatch: selectedSet.has(lineIndex),
          matchedKeywords: evaluation.matched ? evaluation.matchedKeywords : [],
        });
      }
      contexts.push({
        snapshotIndex: snapshot.snapshotIndex,
        path: snapshot.path,
        startLine: range.start + 1,
        endLine: range.end + 1,
        matchLineNumbers,
        selectedMatchLineNumbers,
        lines,
      });
    }
  }

  const sourceTruncated = snapshotSummaries.some((snapshot) => snapshot.truncated);
  const resultLimited = totalMatches > matches.length;
  const truncation = {
    any: sourceTruncated || resultLimited,
    sourceTruncated,
    resultLimited,
    omittedMatches: Math.max(0, totalMatches - matches.length),
    snapshots: snapshotSummaries.map((snapshot) => ({
      snapshotIndex: snapshot.snapshotIndex,
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      scannedBytes: snapshot.scannedBytes,
      unscannedBytes: snapshot.unscannedBytes,
      reportedTruncated: snapshot.reportedTruncated,
      truncated: snapshot.truncated,
    })),
  };

  return {
    keywords: normalizedKeywords.map((keyword) => keyword.literal),
    keywordMode: normalizedMode,
    caseSensitive: normalizedCaseSensitive,
    beforeLines: normalizedBeforeLines,
    afterLines: normalizedAfterLines,
    maxMatches: normalizedMaxMatches,
    totalMatches,
    returnedMatches: matches.length,
    firstMatch,
    lastMatch,
    matches,
    contexts,
    snapshots: snapshotSummaries,
    truncated: truncation.any,
    truncation,
  };
}

function positiveLimit(value, name, fallback) {
  return finiteInteger(value, name, fallback, { minimum: 1 });
}

function serializeCacheValue(value, name) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`${name} is not JSON serializable`);
    }
    return serialized;
  } catch (error) {
    if (error?.code === 'INVALID_LOG_SEARCH_ARGUMENT') throw error;
    throw codedError(
      'INVALID_LOG_SEARCH_ARGUMENT',
      `${name} must be JSON serializable`,
      TypeError,
    );
  }
}

function encodedBytes(serializedItems, serializedMetadata) {
  let bytes = 2 + Math.max(0, serializedItems.length - 1);
  for (const serialized of serializedItems) bytes += Buffer.byteLength(serialized, 'utf8');
  if (serializedMetadata !== null) bytes += Buffer.byteLength(serializedMetadata, 'utf8');
  return bytes;
}

function invalidCursor() {
  return codedError('INVALID_LOG_SEARCH_CURSOR', 'Log search cursor is invalid or expired');
}

/**
 * Short-lived, in-memory pagination for search responses. The store never logs cached values.
 * A cursor is stateful and advances after each successful read; completed cursors are removed.
 */
export class LogSearchCursorStore {
  constructor(options = {}) {
    this.ttlMs = positiveLimit(options.ttlMs, 'ttlMs', DEFAULT_CURSOR_TTL_MS);
    this.maxPageSize = Math.min(
      ABSOLUTE_MAX_PAGE_SIZE,
      positiveLimit(options.maxPageSize, 'maxPageSize', ABSOLUTE_MAX_PAGE_SIZE),
    );
    this.maxCachedBytes = positiveLimit(
      options.maxCachedBytes ?? options.maxBytes,
      'maxCachedBytes',
      DEFAULT_MAX_CACHED_BYTES,
    );
    this.maxCachedEntries = positiveLimit(
      options.maxCachedEntries ?? options.maxEntries,
      'maxCachedEntries',
      DEFAULT_MAX_CACHED_ENTRIES,
    );
    this.maxCursors = positiveLimit(options.maxCursors, 'maxCursors', DEFAULT_MAX_CURSORS);
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'now must be a function', TypeError);
    }
    if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
      throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'randomBytes must be a function', TypeError);
    }
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.bindingSecret = crypto.randomBytes(32);
    this.cursors = new Map();
    this.cachedBytes = 0;
    this.cachedEntries = 0;
  }

  create({ projectId, token, items, entries, metadata = null } = {}) {
    const boundProjectId = requiredText(projectId, 'projectId');
    const boundToken = requiredText(token, 'token');
    const values = items ?? entries;
    if (!Array.isArray(values)) {
      throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'items must be an array', TypeError);
    }

    this.pruneExpired();
    const serializedItems = values.map((value, index) => serializeCacheValue(value, `items[${index}]`));
    const serializedMetadata = metadata === null ? null : serializeCacheValue(metadata, 'metadata');
    const bytes = encodedBytes(serializedItems, serializedMetadata);
    if (serializedItems.length > this.maxCachedEntries || bytes > this.maxCachedBytes) {
      throw codedError(
        'LOG_SEARCH_CACHE_LIMIT',
        'Log search result exceeds the in-memory cursor cache limit',
        RangeError,
      );
    }

    while (
      this.cursors.size >= this.maxCursors
      || this.cachedEntries + serializedItems.length > this.maxCachedEntries
      || this.cachedBytes + bytes > this.maxCachedBytes
    ) {
      const oldestCursor = this.cursors.keys().next().value;
      if (oldestCursor === undefined) break;
      this.remove(oldestCursor);
    }

    const createdAt = this.currentTime();
    const cursor = this.newCursor();
    this.cursors.set(cursor, {
      projectId: boundProjectId,
      tokenDigest: this.tokenDigest(boundToken),
      serializedItems,
      serializedMetadata,
      offset: 0,
      bytes,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
    this.cachedBytes += bytes;
    this.cachedEntries += serializedItems.length;
    return cursor;
  }

  start({ pageSize, ...input } = {}) {
    const cursor = this.create(input);
    return this.page({
      cursor,
      projectId: input.projectId,
      token: input.token,
      pageSize,
    });
  }

  page({ cursor, projectId, token, pageSize = this.maxPageSize } = {}) {
    requiredText(cursor, 'cursor');
    const boundProjectId = requiredText(projectId, 'projectId');
    const boundToken = requiredText(token, 'token');
    const normalizedPageSize = Math.min(
      this.maxPageSize,
      positiveLimit(pageSize, 'pageSize', this.maxPageSize),
    );

    this.pruneExpired();
    const entry = this.cursors.get(cursor);
    if (!entry || entry.projectId !== boundProjectId) throw invalidCursor();
    const suppliedDigest = this.tokenDigest(boundToken);
    if (
      suppliedDigest.length !== entry.tokenDigest.length
      || !crypto.timingSafeEqual(suppliedDigest, entry.tokenDigest)
    ) {
      throw invalidCursor();
    }

    const offset = entry.offset;
    const end = Math.min(offset + normalizedPageSize, entry.serializedItems.length);
    const items = entry.serializedItems.slice(offset, end).map((value) => JSON.parse(value));
    entry.offset = end;
    const hasMore = end < entry.serializedItems.length;
    const metadata = entry.serializedMetadata === null ? null : JSON.parse(entry.serializedMetadata);
    const response = {
      items,
      offset,
      nextOffset: end,
      totalItems: entry.serializedItems.length,
      remainingItems: entry.serializedItems.length - end,
      hasMore,
      nextCursor: hasMore ? cursor : null,
      expiresAt: entry.expiresAt,
      metadata,
    };

    if (hasMore) {
      // Touch the entry for bounded-cache eviction without extending its security TTL.
      this.cursors.delete(cursor);
      this.cursors.set(cursor, entry);
    } else {
      this.remove(cursor);
    }
    return response;
  }

  read(input) {
    return this.page(input);
  }

  delete({ cursor, projectId, token } = {}) {
    requiredText(cursor, 'cursor');
    const entry = this.cursors.get(cursor);
    if (!entry) return false;
    if (entry.projectId !== requiredText(projectId, 'projectId')) throw invalidCursor();
    const suppliedDigest = this.tokenDigest(requiredText(token, 'token'));
    if (!crypto.timingSafeEqual(suppliedDigest, entry.tokenDigest)) throw invalidCursor();
    this.remove(cursor);
    return true;
  }

  clearProject(projectId) {
    const boundProjectId = requiredText(projectId, 'projectId');
    let removed = 0;
    for (const [cursor, entry] of this.cursors) {
      if (entry.projectId !== boundProjectId) continue;
      this.remove(cursor);
      removed += 1;
    }
    return removed;
  }

  clear() {
    for (const cursor of [...this.cursors.keys()]) this.remove(cursor);
  }

  pruneExpired() {
    const now = this.currentTime();
    let removed = 0;
    for (const [cursor, entry] of this.cursors) {
      if (entry.expiresAt > now) continue;
      this.remove(cursor);
      removed += 1;
    }
    return removed;
  }

  stats() {
    this.pruneExpired();
    return {
      cursors: this.cursors.size,
      cachedEntries: this.cachedEntries,
      cachedBytes: this.cachedBytes,
      maxCursors: this.maxCursors,
      maxCachedEntries: this.maxCachedEntries,
      maxCachedBytes: this.maxCachedBytes,
      maxPageSize: this.maxPageSize,
      ttlMs: this.ttlMs,
    };
  }

  currentTime() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'now() must return epoch milliseconds', TypeError);
    }
    return value;
  }

  tokenDigest(token) {
    return crypto.createHmac('sha256', this.bindingSecret).update(token, 'utf8').digest();
  }

  newCursor() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const bytes = this.randomBytes(24);
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        throw codedError('INVALID_LOG_SEARCH_ARGUMENT', 'randomBytes() must return bytes', TypeError);
      }
      const cursor = Buffer.from(bytes).toString('base64url');
      if (cursor.length >= 32 && !this.cursors.has(cursor)) return cursor;
    }
    throw codedError('LOG_SEARCH_CURSOR_GENERATION_FAILED', 'Could not allocate a unique cursor');
  }

  remove(cursor) {
    const entry = this.cursors.get(cursor);
    if (!entry) return false;
    this.cursors.delete(cursor);
    this.cachedBytes -= entry.bytes;
    this.cachedEntries -= entry.serializedItems.length;
    entry.serializedItems.fill('');
    entry.serializedMetadata = null;
    return true;
  }
}
