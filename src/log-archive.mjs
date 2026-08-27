import path from 'node:path';
import { createGunzip } from 'node:zlib';
import unzipper from 'unzipper';

const DEFAULT_MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 100;
const MAX_ENTRY_NAME_BYTES = 1024;

const ZIP_LOCAL_FILE_MAGIC = 0x04034b50;
const ZIP_END_MAGIC = 0x06054b50;
const ZIP64_END_MAGIC = 0x06064b50;
const ZIP64_LOCATOR_MAGIC = 0x07064b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_UNIX_PLATFORM = 3;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK = 0o120000;

function archiveError(code, message, details = undefined, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', `${name} must be a positive safe integer.`);
  }
  return number;
}

function positiveRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', 'maxCompressionRatio must be a positive finite number.');
  }
  return number;
}

function contentBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', 'content must be a Buffer, Uint8Array, or string.');
}

function hasGzipMagic(content) {
  return content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
}

function hasZipMagic(content) {
  if (content.length < 4) return false;
  const signature = content.readUInt32LE(0);
  return signature === ZIP_LOCAL_FILE_MAGIC || signature === ZIP_END_MAGIC;
}

function archiveType(filePath, content) {
  const lower = filePath.toLocaleLowerCase('en-US');
  const expectsGzip = lower.endsWith('.gz') || lower.endsWith('.gzip');
  const expectsZip = lower.endsWith('.zip');
  const gzipMagic = hasGzipMagic(content);
  const zipMagic = hasZipMagic(content);

  if (expectsGzip && !gzipMagic) {
    throw archiveError('LOG_ARCHIVE_MAGIC_MISMATCH', 'The file extension indicates gzip, but the gzip magic bytes are missing.', { filePath });
  }
  if (expectsZip && !zipMagic) {
    throw archiveError('LOG_ARCHIVE_MAGIC_MISMATCH', 'The file extension indicates ZIP, but the ZIP magic bytes are missing.', { filePath });
  }
  if (expectsGzip || gzipMagic) return 'gzip';
  if (expectsZip || zipMagic) return 'zip';
  return 'plain';
}

function ensureExpandedLimits(bytes, { maxExpandedBytes, maxEntryBytes, inputBytes, maxCompressionRatio }, entry = null) {
  if (bytes > maxEntryBytes) {
    throw archiveError('LOG_ARCHIVE_ENTRY_TOO_LARGE', 'An expanded archive entry exceeds maxEntryBytes.', { archiveEntry: entry, bytes, maxEntryBytes });
  }
  if (bytes > maxExpandedBytes) {
    throw archiveError('LOG_ARCHIVE_EXPANDED_LIMIT', 'Expanded archive content exceeds maxExpandedBytes.', { bytes, maxExpandedBytes });
  }
  if (bytes > inputBytes * maxCompressionRatio) {
    throw archiveError('LOG_ARCHIVE_COMPRESSION_RATIO', 'Archive expansion exceeds maxCompressionRatio.', {
      archiveEntry: entry,
      inputBytes,
      expandedBytes: bytes,
      maxCompressionRatio,
    });
  }
}

function virtualGzipPath(filePath) {
  const stripped = filePath.replace(/\.(?:gz|gzip)$/iu, '');
  return stripped || `${filePath}!gzip`;
}

function baseName(value) {
  return path.posix.basename(String(value).replace(/\\/gu, '/'));
}

function findZipEnd(content) {
  const minimum = Math.max(0, content.length - ZIP_END_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = content.length - ZIP_END_MIN_BYTES; offset >= minimum; offset -= 1) {
    if (content.readUInt32LE(offset) !== ZIP_END_MAGIC) continue;
    const commentBytes = content.readUInt16LE(offset + 20);
    if (offset + ZIP_END_MIN_BYTES + commentBytes !== content.length) continue;
    return {
      offset,
      diskNumber: content.readUInt16LE(offset + 4),
      centralDirectoryDisk: content.readUInt16LE(offset + 6),
      entriesOnDisk: content.readUInt16LE(offset + 8),
      totalEntries: content.readUInt16LE(offset + 10),
      centralDirectoryBytes: content.readUInt32LE(offset + 12),
      centralDirectoryOffset: content.readUInt32LE(offset + 16),
    };
  }
  throw archiveError('LOG_ARCHIVE_INVALID', 'The ZIP end-of-central-directory record is missing or malformed.');
}

function preflightZip(content, maxEntries) {
  const end = findZipEnd(content);
  if (end.diskNumber !== 0 || end.centralDirectoryDisk !== 0 || end.entriesOnDisk !== end.totalEntries) {
    throw archiveError('LOG_ARCHIVE_MULTIDISK_UNSUPPORTED', 'Multi-disk ZIP archives are not supported.');
  }
  if (end.totalEntries === 0xffff || end.centralDirectoryBytes === 0xffffffff || end.centralDirectoryOffset === 0xffffffff) {
    throw archiveError('LOG_ARCHIVE_ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported by the bounded log expander.');
  }
  if (end.totalEntries > maxEntries) {
    throw archiveError('LOG_ARCHIVE_ENTRY_LIMIT', 'The ZIP archive contains more entries than maxEntries.', {
      entries: end.totalEntries,
      maxEntries,
    });
  }
  if (end.centralDirectoryOffset + end.centralDirectoryBytes > end.offset) {
    throw archiveError('LOG_ARCHIVE_INVALID', 'The ZIP central directory points outside the archive.');
  }
  return end;
}

function unsafeEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath || Buffer.byteLength(entryPath, 'utf8') > MAX_ENTRY_NAME_BYTES) return true;
  if (/\0|[\u0001-\u001f\u007f]/u.test(entryPath)) return true;
  const normalizedSeparators = entryPath.replace(/\\/gu, '/');
  if (normalizedSeparators.startsWith('/') || /^[A-Za-z]:/u.test(normalizedSeparators)) return true;
  const parts = normalizedSeparators.split('/');
  return parts.includes('..') || parts.some((part) => part === '');
}

function normalizedEntryPath(entryPath) {
  return path.posix.normalize(entryPath.replace(/\\/gu, '/')).replace(/^\.\//u, '');
}

function isNestedArchive(entryPath, content = null) {
  const lower = entryPath.toLocaleLowerCase('en-US');
  if (lower.endsWith('.zip') || lower.endsWith('.gz') || lower.endsWith('.gzip')) return true;
  return content !== null && (hasGzipMagic(content) || hasZipMagic(content));
}

function isZipSymlink(entry) {
  const platform = (Number(entry.versionMadeBy) >>> 8) & 0xff;
  if (platform !== ZIP_UNIX_PLATFORM) return false;
  const mode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  return (mode & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK;
}

function warning(code, archiveEntry, message) {
  return { code, archiveEntry, message };
}

function reportedExpandedBytes(details) {
  const value = Number(details?.expandedBytes);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function withZipProgress(error, state) {
  const stableError = String(error?.code ?? '').startsWith('LOG_ARCHIVE_')
    ? error
    : archiveError('LOG_ARCHIVE_INVALID', 'The ZIP archive could not be expanded.', undefined, error);
  const existingDetails = stableError.details !== null && typeof stableError.details === 'object'
    ? stableError.details
    : {};
  stableError.details = {
    ...existingDetails,
    entriesScanned: state.entriesScanned,
    entriesSkipped: state.entriesSkipped,
    expandedBytes: Math.max(state.expandedBytes, reportedExpandedBytes(existingDetails)),
  };
  return stableError;
}

function withZipEntryProgress(error, state, entryPath, entryBytes) {
  const stableError = String(error?.code ?? '').startsWith('LOG_ARCHIVE_')
    ? error
    : archiveError('LOG_ARCHIVE_INVALID', 'A ZIP entry could not be expanded.', { archiveEntry: entryPath }, error);
  const existingDetails = stableError.details !== null && typeof stableError.details === 'object'
    ? stableError.details
    : {};
  stableError.details = {
    ...existingDetails,
    archiveEntry: existingDetails.archiveEntry ?? entryPath,
    expandedBytes: Math.max(
      reportedExpandedBytes(existingDetails),
      state.expandedBytes + entryBytes,
    ),
  };
  return stableError;
}

function withGzipProgress(error, expandedBytes) {
  const stableError = String(error?.code ?? '').startsWith('LOG_ARCHIVE_')
    ? error
    : archiveError('LOG_ARCHIVE_INVALID', 'The gzip archive is malformed or unsupported.', undefined, error);
  const existingDetails = stableError.details !== null && typeof stableError.details === 'object'
    ? stableError.details
    : {};
  stableError.details = {
    ...existingDetails,
    entriesScanned: 1,
    entriesSkipped: 0,
    expandedBytes: Math.max(expandedBytes, reportedExpandedBytes(existingDetails)),
  };
  return stableError;
}

function declaredZipSizes(entry) {
  const compressedBytes = Number(entry.compressedSize);
  const expandedBytes = Number(entry.uncompressedSize);
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 0
    || !Number.isSafeInteger(expandedBytes) || expandedBytes < 0) {
    throw archiveError('LOG_ARCHIVE_INVALID', 'A ZIP entry has invalid size metadata.', { archiveEntry: entry.path });
  }
  return { compressedBytes, expandedBytes };
}

function ensureZipEntryLimits(entryPath, sizes, state, limits) {
  if (sizes.expandedBytes > limits.maxEntryBytes) {
    throw archiveError('LOG_ARCHIVE_ENTRY_TOO_LARGE', 'A ZIP entry exceeds maxEntryBytes.', {
      archiveEntry: entryPath,
      expandedBytes: state.expandedBytes + sizes.expandedBytes,
      maxEntryBytes: limits.maxEntryBytes,
    });
  }
  if (state.expandedBytes + sizes.expandedBytes > limits.maxExpandedBytes) {
    throw archiveError('LOG_ARCHIVE_EXPANDED_LIMIT', 'ZIP expansion exceeds maxExpandedBytes.', {
      archiveEntry: entryPath,
      expandedBytes: state.expandedBytes + sizes.expandedBytes,
      maxExpandedBytes: limits.maxExpandedBytes,
    });
  }
  if (sizes.expandedBytes > Math.max(1, sizes.compressedBytes) * limits.maxCompressionRatio) {
    throw archiveError('LOG_ARCHIVE_COMPRESSION_RATIO', 'A ZIP entry exceeds maxCompressionRatio.', {
      archiveEntry: entryPath,
      compressedBytes: sizes.compressedBytes,
      expandedBytes: state.expandedBytes + sizes.expandedBytes,
      maxCompressionRatio: limits.maxCompressionRatio,
    });
  }
}

async function readZipEntry(entry, entryPath, sizes, state, limits) {
  const chunks = [];
  let bytes = 0;
  let stream;
  try {
    stream = entry.stream();
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > limits.maxEntryBytes) {
        throw archiveError('LOG_ARCHIVE_ENTRY_TOO_LARGE', 'A ZIP entry exceeds maxEntryBytes while expanding.', {
          archiveEntry: entryPath,
          bytes,
          maxEntryBytes: limits.maxEntryBytes,
        });
      }
      if (state.expandedBytes + bytes > limits.maxExpandedBytes) {
        throw archiveError('LOG_ARCHIVE_EXPANDED_LIMIT', 'ZIP expansion exceeds maxExpandedBytes.', {
          archiveEntry: entryPath,
          expandedBytes: state.expandedBytes + bytes,
          maxExpandedBytes: limits.maxExpandedBytes,
        });
      }
      if (bytes > Math.max(1, sizes.compressedBytes) * limits.maxCompressionRatio
        || state.expandedBytes + bytes > limits.inputBytes * limits.maxCompressionRatio) {
        throw archiveError('LOG_ARCHIVE_COMPRESSION_RATIO', 'ZIP expansion exceeds maxCompressionRatio.', {
          archiveEntry: entryPath,
          compressedBytes: sizes.compressedBytes,
          expandedBytes: bytes,
          maxCompressionRatio: limits.maxCompressionRatio,
        });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream?.destroy?.();
    throw withZipEntryProgress(error, state, entryPath, bytes);
  }
  if (bytes !== sizes.expandedBytes) {
    throw archiveError('LOG_ARCHIVE_INVALID', 'A ZIP entry expanded to a size different from its directory metadata.', {
      archiveEntry: entryPath,
      declaredBytes: sizes.expandedBytes,
      actualBytes: bytes,
      expandedBytes: state.expandedBytes + bytes,
    });
  }
  return Buffer.concat(chunks, bytes);
}

async function expandGzip(filePath, input, limits) {
  const declaredBytes = input.length >= 4 ? input.readUInt32LE(input.length - 4) : 0;
  try {
    ensureExpandedLimits(declaredBytes, { ...limits, inputBytes: input.length }, null);
  } catch (error) {
    throw withGzipProgress(error, declaredBytes);
  }
  const maximumOutput = Math.max(1, Math.min(
    limits.maxExpandedBytes,
    limits.maxEntryBytes,
    Math.floor(input.length * limits.maxCompressionRatio),
  ));
  const chunks = [];
  let expandedBytes = 0;
  let stream;
  try {
    stream = createGunzip();
    stream.end(input);
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      expandedBytes += chunk.length;
      if (expandedBytes > maximumOutput) {
        throw archiveError('LOG_ARCHIVE_EXPANDED_LIMIT', 'Gzip expansion exceeded its bounded output limit.', {
          maxExpandedBytes: limits.maxExpandedBytes,
          maxEntryBytes: limits.maxEntryBytes,
          maxCompressionRatio: limits.maxCompressionRatio,
          expandedBytes,
        });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream?.destroy?.();
    const stableError = String(error?.code ?? '').startsWith('LOG_ARCHIVE_')
      ? error
      : archiveError('LOG_ARCHIVE_INVALID', 'The gzip archive is malformed or unsupported.', { filePath }, error);
    throw withGzipProgress(stableError, expandedBytes);
  }
  const expanded = Buffer.concat(chunks, expandedBytes);
  try {
    ensureExpandedLimits(expanded.length, { ...limits, inputBytes: input.length }, null);
  } catch (error) {
    throw withGzipProgress(error, expandedBytes);
  }
  const expandedPath = virtualGzipPath(filePath);
  return {
    archiveType: 'gzip',
    snapshots: [{
      path: expandedPath,
      content: expanded,
      archivePath: filePath,
      archiveEntry: baseName(expandedPath),
      truncated: false,
    }],
    inputBytes: input.length,
    expandedBytes: expanded.length,
    entriesScanned: 1,
    entriesSkipped: 0,
    warnings: [],
    truncated: false,
  };
}

async function expandZip(filePath, input, limits) {
  const end = preflightZip(input, limits.maxEntries);
  let directory;
  try {
    directory = await unzipper.Open.buffer(input);
  } catch (error) {
    throw archiveError('LOG_ARCHIVE_INVALID', 'The ZIP archive is malformed or unsupported.', { filePath }, error);
  }
  if (!Array.isArray(directory.files) || directory.files.length !== end.totalEntries) {
    throw archiveError('LOG_ARCHIVE_INVALID', 'The ZIP directory entry count is inconsistent.', {
      declaredEntries: end.totalEntries,
      parsedEntries: Array.isArray(directory.files) ? directory.files.length : null,
    });
  }

  const snapshots = [];
  const warnings = [];
  const state = { expandedBytes: 0, entriesScanned: 0, entriesSkipped: 0 };
  const skip = (entry, code, message) => {
    state.entriesSkipped += 1;
    warnings.push(warning(code, String(entry.path ?? ''), message));
  };

  try {
    for (const entry of directory.files) {
      state.entriesScanned += 1;
      const rawPath = String(entry.path ?? '');
      if (entry.type === 'Directory' || /[/\\]$/u.test(rawPath)) {
        continue;
      }
      if (unsafeEntryPath(rawPath)) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_UNSAFE_PATH_SKIPPED', 'The entry path is unsafe.');
        continue;
      }
      if (isZipSymlink(entry)) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_SYMLINK_SKIPPED', 'Symbolic-link entries are not expanded.');
        continue;
      }
      if ((Number(entry.flags) & 0x1) !== 0) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_ENCRYPTED_SKIPPED', 'Encrypted entries are not expanded.');
        continue;
      }
      const entryPath = normalizedEntryPath(rawPath);
      if (isNestedArchive(entryPath)) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_NESTED_ARCHIVE_SKIPPED', 'Nested archive entries are not expanded.');
        continue;
      }
      if (![0, 8].includes(Number(entry.compressionMethod))) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_COMPRESSION_SKIPPED', 'The entry compression method is unsupported.');
        continue;
      }

      const sizes = declaredZipSizes(entry);
      ensureZipEntryLimits(entryPath, sizes, state, limits);
      const expanded = await readZipEntry(entry, entryPath, sizes, state, limits);
      state.expandedBytes += expanded.length;
      if (state.expandedBytes > input.length * limits.maxCompressionRatio) {
        throw archiveError('LOG_ARCHIVE_COMPRESSION_RATIO', 'ZIP expansion exceeds maxCompressionRatio.', {
          inputBytes: input.length,
          expandedBytes: state.expandedBytes,
          maxCompressionRatio: limits.maxCompressionRatio,
        });
      }
      if (isNestedArchive(entryPath, expanded)) {
        skip(entry, 'LOG_ARCHIVE_ENTRY_NESTED_ARCHIVE_SKIPPED', 'Nested archive content is not expanded.');
        continue;
      }
      snapshots.push({
        path: `${filePath}!${entryPath}`,
        content: expanded,
        archivePath: filePath,
        archiveEntry: entryPath,
        truncated: false,
      });
    }
  } catch (error) {
    throw withZipProgress(error, state);
  }

  return {
    archiveType: 'zip',
    snapshots,
    inputBytes: input.length,
    expandedBytes: state.expandedBytes,
    entriesScanned: state.entriesScanned,
    entriesSkipped: state.entriesSkipped,
    warnings,
    truncated: state.entriesSkipped > 0,
  };
}

export function detectLogArchiveType({ filePath, content } = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', 'filePath must be a non-empty path without NUL bytes.');
  }
  return archiveType(filePath, contentBuffer(content));
}

export async function expandLogArchive({
  filePath,
  content,
  allowArchives = true,
  maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  maxCompressionRatio = DEFAULT_MAX_COMPRESSION_RATIO,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', 'filePath must be a non-empty path without NUL bytes.');
  }
  if (typeof allowArchives !== 'boolean') {
    throw archiveError('LOG_ARCHIVE_INVALID_ARGUMENT', 'allowArchives must be a boolean.');
  }
  const input = contentBuffer(content);
  const limits = {
    maxExpandedBytes: positiveInteger(maxExpandedBytes, 'maxExpandedBytes'),
    maxEntries: positiveInteger(maxEntries, 'maxEntries'),
    maxEntryBytes: positiveInteger(maxEntryBytes, 'maxEntryBytes'),
    maxCompressionRatio: positiveRatio(maxCompressionRatio),
    inputBytes: input.length,
  };
  const type = archiveType(filePath, input);
  if (!allowArchives && type !== 'plain') {
    throw archiveError('LOG_ARCHIVE_DISABLED', 'Archive expansion is disabled for this log search.', {
      filePath,
      archiveType: type,
    });
  }
  if (type === 'gzip') return expandGzip(filePath, input, limits);
  if (type === 'zip') return expandZip(filePath, input, limits);

  if (input.length > limits.maxExpandedBytes) {
    throw archiveError('LOG_ARCHIVE_EXPANDED_LIMIT', 'Plain log content exceeds maxExpandedBytes.', {
      bytes: input.length,
      maxExpandedBytes: limits.maxExpandedBytes,
    });
  }
  return {
    archiveType: 'plain',
    snapshots: [{
      path: filePath,
      content: input,
      archivePath: null,
      archiveEntry: null,
      truncated: false,
    }],
    inputBytes: input.length,
    expandedBytes: input.length,
    entriesScanned: 1,
    entriesSkipped: 0,
    warnings: [],
    truncated: false,
  };
}
