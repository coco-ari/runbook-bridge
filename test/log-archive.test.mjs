import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';

import { detectLogArchiveType, expandLogArchive } from '../src/log-archive.mjs';

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const content = Buffer.from(item.content ?? '');
    const directory = item.directory === true || item.name.endsWith('/');
    const method = item.method ?? (directory ? 0 : 8);
    const flags = (item.encrypted === true ? 0x1 : 0) | 0x800;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const checksum = crc32(content);
    const mode = item.mode ?? (directory ? 0o040755 : 0o100644);
    const declaredBytes = item.declaredBytes ?? content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredBytes, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredBytes, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('returns a plain file as one in-memory snapshot', async () => {
  const content = Buffer.from('INFO ready\n');
  const result = await expandLogArchive({ filePath: '/var/log/app.log', content });

  assert.equal(result.archiveType, 'plain');
  assert.equal(result.inputBytes, content.length);
  assert.equal(result.expandedBytes, content.length);
  assert.equal(result.entriesScanned, 1);
  assert.equal(result.entriesSkipped, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.snapshots, [{
    path: '/var/log/app.log',
    content,
    archivePath: null,
    archiveEntry: null,
    truncated: false,
  }]);
});

test('plain logs use the total scan bound rather than the per-archive-entry bound', async () => {
  const content = Buffer.from('12345678');
  const result = await expandLogArchive({
    filePath: '/var/log/large.log',
    content,
    maxEntryBytes: 4,
    maxExpandedBytes: 16,
  });

  assert.equal(result.archiveType, 'plain');
  assert.deepEqual(result.snapshots[0].content, content);
});

test('expands gzip content without writing it to disk', async () => {
  const original = Buffer.from('first line\nsecond line\n');
  const archive = gzipSync(original);
  const result = await expandLogArchive({ filePath: '/var/log/app.log.gz', content: archive });

  assert.equal(result.archiveType, 'gzip');
  assert.equal(result.inputBytes, archive.length);
  assert.equal(result.expandedBytes, original.length);
  assert.equal(result.entriesScanned, 1);
  assert.equal(result.entriesSkipped, 0);
  assert.equal(result.snapshots[0].path, '/var/log/app.log');
  assert.equal(result.snapshots[0].archivePath, '/var/log/app.log.gz');
  assert.equal(result.snapshots[0].archiveEntry, 'app.log');
  assert.deepEqual(result.snapshots[0].content, original);
});

test('reports gzip output progress when validation fails after decompression starts', async () => {
  const original = Buffer.alloc(64 * 1024);
  let value = 0x12345678;
  for (let index = 0; index < original.length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    original[index] = value & 0xff;
  }
  const archive = gzipSync(original);
  archive[archive.length - 8] ^= 0x01;

  await assert.rejects(expandLogArchive({
    filePath: '/var/log/corrupt.log.gz',
    content: archive,
  }), (error) => {
    assert.equal(error.code, 'LOG_ARCHIVE_INVALID');
    assert.equal(error.details.entriesScanned, 1);
    assert.equal(error.details.entriesSkipped, 0);
    assert.ok(error.details.expandedBytes > 0);
    assert.ok(error.details.expandedBytes <= original.length);
    return true;
  });
});

test('expands multiple regular ZIP entries in central-directory order', async () => {
  const archive = createZip([
    { name: 'app.log', content: 'app one\n' },
    { name: 'workers/', directory: true },
    { name: 'workers/worker.log', content: 'worker two\n' },
  ]);
  const result = await expandLogArchive({ filePath: '/logs/bundle.zip', content: archive });

  assert.equal(result.archiveType, 'zip');
  assert.equal(result.entriesScanned, 3);
  assert.equal(result.entriesSkipped, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.snapshots.map(({ path, archiveEntry, content }) => ({
    path,
    archiveEntry,
    content: content.toString('utf8'),
  })), [
    { path: '/logs/bundle.zip!app.log', archiveEntry: 'app.log', content: 'app one\n' },
    { path: '/logs/bundle.zip!workers/worker.log', archiveEntry: 'workers/worker.log', content: 'worker two\n' },
  ]);
});

test('skips unsafe, directory, symlink, encrypted, and nested ZIP entries', async () => {
  const archive = createZip([
    { name: 'safe.log', content: 'safe\n' },
    { name: 'folder/', directory: true },
    { name: '../escape.log', content: 'escape\n' },
    { name: 'current/../../escape.log', content: 'escape again\n' },
    { name: 'C:drive-relative.log', content: 'drive relative\n' },
    { name: 'link.log', content: 'target.log', mode: 0o120777, method: 0 },
    { name: 'secret.log', content: 'not really encrypted', encrypted: true, method: 0 },
    { name: 'nested.zip', content: 'nested archive placeholder', method: 0 },
  ]);
  const result = await expandLogArchive({ filePath: '/logs/mixed.zip', content: archive });

  assert.deepEqual(result.snapshots.map((snapshot) => snapshot.archiveEntry), ['safe.log']);
  assert.equal(result.entriesScanned, 8);
  assert.equal(result.entriesSkipped, 6);
  assert.equal(result.truncated, true);
  assert.deepEqual(new Set(result.warnings.map(({ code }) => code)), new Set([
    'LOG_ARCHIVE_ENTRY_UNSAFE_PATH_SKIPPED',
    'LOG_ARCHIVE_ENTRY_SYMLINK_SKIPPED',
    'LOG_ARCHIVE_ENTRY_ENCRYPTED_SKIPPED',
    'LOG_ARCHIVE_ENTRY_NESTED_ARCHIVE_SKIPPED',
  ]));
});

test('rejects a highly compressible ZIP entry using a stable zip-bomb error code', async () => {
  const archive = createZip([{ name: 'bomb.log', content: Buffer.alloc(256 * 1024, 0x41) }]);
  await rejectsWithCode(expandLogArchive({
    filePath: '/logs/bomb.zip',
    content: archive,
    maxCompressionRatio: 10,
  }), 'LOG_ARCHIVE_COMPRESSION_RATIO');
});

test('reports request-budget progress when a later ZIP entry fails', async () => {
  const accepted = Buffer.from('accepted log\n');
  const archive = createZip([
    { name: '../unsafe.log', content: 'unsafe', method: 0 },
    { name: 'accepted.log', content: accepted, method: 0 },
    { name: 'bomb.log', content: Buffer.alloc(256 * 1024, 0x41) },
  ]);

  await assert.rejects(expandLogArchive({
    filePath: '/logs/partial.zip',
    content: archive,
    maxCompressionRatio: 10,
  }), (error) => {
    assert.equal(error.code, 'LOG_ARCHIVE_COMPRESSION_RATIO');
    assert.equal(error.details.archiveEntry, 'bomb.log');
    assert.equal(error.details.entriesScanned, 3);
    assert.equal(error.details.entriesSkipped, 1);
    assert.equal(error.details.expandedBytes, accepted.length + (256 * 1024));
    return true;
  });
});

test('preserves declared ZIP failure progress larger than completed entry progress', async () => {
  const archive = createZip([
    { name: 'one.log', content: '1234', method: 0 },
    { name: 'two.log', content: '5678', method: 0 },
  ]);

  await assert.rejects(expandLogArchive({
    filePath: '/logs/declared-progress.zip',
    content: archive,
    maxExpandedBytes: 7,
  }), (error) => {
    assert.equal(error.code, 'LOG_ARCHIVE_EXPANDED_LIMIT');
    assert.equal(error.details.entriesScanned, 2);
    assert.equal(error.details.expandedBytes, 8);
    return true;
  });
});

test('includes partial output from the failing ZIP member in progress', async () => {
  const accepted = Buffer.from('accepted\n');
  const failing = Buffer.alloc(64 * 1024, 0x61);
  const archive = createZip([
    { name: 'accepted.log', content: accepted, method: 0 },
    { name: 'wrong-size.log', content: failing, declaredBytes: 1, method: 8 },
  ]);

  await assert.rejects(expandLogArchive({
    filePath: '/logs/partial-member.zip',
    content: archive,
  }), (error) => {
    assert.equal(error.code, 'LOG_ARCHIVE_COMPRESSION_RATIO');
    assert.equal(error.details.entriesScanned, 2);
    assert.ok(error.details.expandedBytes > accepted.length);
    assert.ok(error.details.expandedBytes <= accepted.length + failing.length);
    return true;
  });
});

test('detectLogArchiveType identifies magic without relying on the file extension', () => {
  const gzip = gzipSync(Buffer.from('hidden gzip\n'));
  const zip = createZip([{ name: 'hidden.log', content: 'hidden zip\n' }]);

  assert.equal(detectLogArchiveType({ filePath: '/logs/gzip.log', content: gzip }), 'gzip');
  assert.equal(detectLogArchiveType({ filePath: '/logs/zip.log', content: zip }), 'zip');
  assert.equal(detectLogArchiveType({ filePath: '/logs/plain.log', content: Buffer.from('plain\n') }), 'plain');
});

test('allowArchives false rejects archives detected by magic even behind plain extensions', async () => {
  const gzip = gzipSync(Buffer.from('hidden gzip\n'));
  const zip = createZip([{ name: 'hidden.log', content: 'hidden zip\n' }]);

  for (const [content, archiveType] of [[gzip, 'gzip'], [zip, 'zip']]) {
    await assert.rejects(expandLogArchive({
      filePath: `/logs/disguised-${archiveType}.log`,
      content,
      allowArchives: false,
    }), (error) => {
      assert.equal(error.code, 'LOG_ARCHIVE_DISABLED');
      assert.equal(error.details.archiveType, archiveType);
      return true;
    });
  }

  const plain = Buffer.from('plain log\n');
  const result = await expandLogArchive({
    filePath: '/logs/plain.log',
    content: plain,
    allowArchives: false,
  });
  assert.equal(result.archiveType, 'plain');
  assert.deepEqual(result.snapshots[0].content, plain);
});

test('enforces entry count, per-entry bytes, and total expanded bytes', async () => {
  const twoEntries = createZip([
    { name: 'one.log', content: '1234', method: 0 },
    { name: 'two.log', content: '5678', method: 0 },
  ]);

  await rejectsWithCode(expandLogArchive({
    filePath: 'two.zip',
    content: twoEntries,
    maxEntries: 1,
  }), 'LOG_ARCHIVE_ENTRY_LIMIT');
  await rejectsWithCode(expandLogArchive({
    filePath: 'two.zip',
    content: twoEntries,
    maxEntryBytes: 3,
  }), 'LOG_ARCHIVE_ENTRY_TOO_LARGE');
  await rejectsWithCode(expandLogArchive({
    filePath: 'two.zip',
    content: twoEntries,
    maxExpandedBytes: 7,
  }), 'LOG_ARCHIVE_EXPANDED_LIMIT');
});

test('a gzip rejected by declared output size still consumes one archive entry', async () => {
  const archive = gzipSync(Buffer.alloc(1024, 0x61));
  await assert.rejects(
    expandLogArchive({
      filePath: 'oversized.log.gz',
      content: archive,
      maxExpandedBytes: 64,
      maxEntryBytes: 2048,
      maxCompressionRatio: 1000,
    }),
    (error) => error.code === 'LOG_ARCHIVE_EXPANDED_LIMIT'
      && error.details?.entriesScanned === 1
      && error.details?.expandedBytes === 1024,
  );
});

test('rejects archive extensions with missing magic bytes and malformed archives', async () => {
  await rejectsWithCode(expandLogArchive({
    filePath: 'app.log.gz',
    content: Buffer.from('not gzip'),
  }), 'LOG_ARCHIVE_MAGIC_MISMATCH');
  await rejectsWithCode(expandLogArchive({
    filePath: 'logs.zip',
    content: Buffer.from('not zip'),
  }), 'LOG_ARCHIVE_MAGIC_MISMATCH');
  await rejectsWithCode(expandLogArchive({
    filePath: 'logs.zip',
    content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  }), 'LOG_ARCHIVE_INVALID');
});
