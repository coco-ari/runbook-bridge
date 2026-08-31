const DEFAULT_MAX_MATCHES = 100;
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
  if (Buffer.isBuffer(content)) return content.toString('utf8');
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('utf8');
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

function* iterateLogLines(content) {
  let start = 0;
  let lineIndex = 0;
  for (let cursor = 0; cursor < content.length; cursor += 1) {
    const code = content.charCodeAt(cursor);
    if (code !== 0x0a && code !== 0x0d) continue;
    yield { lineIndex, text:content.slice(start, cursor) };
    lineIndex += 1;
    if (code === 0x0d && content.charCodeAt(cursor + 1) === 0x0a) cursor += 1;
    start = cursor + 1;
  }
  yield { lineIndex, text:content.slice(start) };
}

function matchDescriptor(snapshot, lineIndex, text, matchedKeywords) {
  const originalTextBytes = Buffer.byteLength(text, 'utf8');
  const textTruncated = originalTextBytes > MAX_MATCH_TEXT_BYTES;
  const prefix = textTruncated ? Buffer.from(text.slice(0, MAX_MATCH_TEXT_BYTES), 'utf8') : null;
  let prefixEnd = prefix ? Math.min(prefix.length, MAX_MATCH_TEXT_BYTES) : 0;
  while (prefix && prefixEnd > 0 && prefixEnd < prefix.length && (prefix[prefixEnd] & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return {
    snapshotIndex: snapshot.snapshotIndex,
    path: snapshot.path,
    lineNumber: lineIndex + 1,
    text: textTruncated
      ? prefix.subarray(0, prefixEnd).toString('utf8')
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

  let totalMatches = 0;
  let firstMatch = null;
  let lastMatch = null;
  const matches = [];
  const contexts = [];
  const snapshotSummaries = [];

  for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
    const snapshot = snapshots[snapshotIndex];
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
    const prepared = {
      snapshotIndex,
      path: requiredText(snapshot.path, `snapshots[${snapshotIndex}].path`),
    };
    const summary = {
      snapshotIndex,
      path:prepared.path,
      sizeBytes,
      scannedBytes,
      unscannedBytes:Math.max(0, sizeBytes - scannedBytes),
      reportedTruncated,
      truncated:sourceTruncated,
      totalMatches:0,
      returnedMatches:0,
      firstMatch:null,
      lastMatch:null,
    };
    const selectedIndexes = [];
    let lineCount = 0;
    for (const { lineIndex, text } of iterateLogLines(content)) {
      lineCount = lineIndex + 1;
      const evaluation = lineMatches(
        text,
        normalizedKeywords,
        normalizedMode,
        normalizedCaseSensitive,
      );
      if (!evaluation.matched) continue;

      const descriptor = matchDescriptor(prepared, lineIndex, text, evaluation.matchedKeywords);
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

    if (selectedIndexes.length) {
      const selectedSet = new Set(selectedIndexes);
      const ranges = mergeContextRanges(
        selectedIndexes,
        lineCount,
        normalizedBeforeLines,
        normalizedAfterLines,
      );
      let rangeIndex = 0;
      let context = null;
      for (const { lineIndex, text } of iterateLogLines(content)) {
        const range = ranges[rangeIndex];
        if (!range) break;
        if (lineIndex < range.start) continue;
        context ??= {
          snapshotIndex,
          path:prepared.path,
          startLine:range.start + 1,
          endLine:range.end + 1,
          matchLineNumbers:[],
          selectedMatchLineNumbers:[],
          lines:[],
        };
        const evaluation = lineMatches(
          text,
          normalizedKeywords,
          normalizedMode,
          normalizedCaseSensitive,
        );
        if (evaluation.matched) context.matchLineNumbers.push(lineIndex + 1);
        if (selectedSet.has(lineIndex)) context.selectedMatchLineNumbers.push(lineIndex + 1);
        context.lines.push({
          lineNumber: lineIndex + 1,
          text,
          isMatch: evaluation.matched,
          selectedMatch: selectedSet.has(lineIndex),
          matchedKeywords: evaluation.matched ? evaluation.matchedKeywords : [],
        });
        if (lineIndex === range.end) {
          contexts.push(context);
          context = null;
          rangeIndex += 1;
        }
      }
    }
    snapshotSummaries.push(summary);
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
