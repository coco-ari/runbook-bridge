import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// ZIP 仅在内存生成，包含合成条目；测试过程不在服务器或本机解压归档。
function storedZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.content);
    let checksum = 0xffffffff;
    for (const byte of body) { checksum ^= byte; for (let bit = 0; bit < 8; bit += 1) checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1; }
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export async function runArchiveScenarios({ plugin, files, operations, scope, owner, root, owned, localRoot, localNames, measure, waitFor }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u); assert.ok(owned.has(root));
  const content = 'INFO archive-ready\nWARN archive-warning 中文\nERROR archive-error\n';
  const samples = new Map([
    ['owned.log.gz', gzipSync(content)],
    ['owned.zip', storedZip([{ name: 'a.log', content: 'hit first\nhit second\n' }, { name: 'nested/b.log', content: 'hit third 中文\nhit fourth\n' }])],
    ['unsafe.zip', storedZip([{ name: 'safe.log', content: 'hit safe\n' }, { name: '../escape.log', content: 'hit unsafe\n' }, { name: 'nested.gz', content: gzipSync('hit nested\n') }])],
    ['invalid.gz', Buffer.from('synthetic invalid archive')],
    ['ratio.gz', gzipSync(Buffer.alloc(256 * 1024, 'a'))],
    ['disguised.log', gzipSync(content)],
    ['large.log.gz', gzipSync(Array.from({ length: 192 }, () => 'INFO ' + crypto.randomBytes(256).toString('hex') + '\n').join('') + 'hit large-end\n')],
  ]);
  async function upload(name, buffer, overwrite = false) {
    assert.ok(samples.has(name)); assert.ok(!/[\\/]/u.test(name));
    const target = root + '/' + name, selected = path.join(localRoot, name);
    if (overwrite) assert.ok(owned.has(target));
    localNames.add(name); await fs.writeFile(selected, buffer, { flag: overwrite ? 'w' : 'wx', mode: 0o600 });
    const review = await files.beginUploadReview(owner, { ...scope, path: root }, [selected]);
    let ready;
    await waitFor(async () => {
      ready = await files.readUploadReview(owner, { ...scope, reviewId: review.reviewId });
      if (ready.status === 'error') throw Object.assign(new Error('归档上传预检失败'), { code: ready.error.code });
      return ready.status === 'ready';
    });
    assert.equal(ready.files.length, 1); assert.equal(ready.files[0].remotePath, target); assert.equal(ready.files[0].exists, overwrite);
    owned.add(target);
    const { jobs } = await files.confirmUpload(owner, { ...scope, preparationId: ready.preparationId, overwrite });
    await waitFor(() => jobs.every(job => { const state = files.jobs.get(job.jobId); return !state.inFlight && ['completed', 'error', 'cancelled'].includes(state.status); }));
    assert.ok(jobs.every(job => files.jobs.get(job.jobId).status === 'completed'));
  }
  const search = (name, options = {}) => {
    assert.ok(samples.has(name));
    return operations.searchLogs(plugin, { path: root + '/' + name, queries: ['hit'], maxScanBytes: 131072, maxExpandedBytes: 262144, ...options });
  };
  await measure('archives.upload-owned-samples', async () => { for (const [name, buffer] of samples) await upload(name, buffer); });
  await measure('archives.gzip-multiple-queries', async () => {
    const result = await search('owned.log.gz', { queries: ['archive-ready', 'archive-error'] });
    assert.equal(result.matchCount, 2); assert.equal(result.status, 'complete'); assert.equal(result.archivesScanned, 1);
    assert.deepEqual(result.matches.map(match => match.text), ['INFO archive-ready', 'ERROR archive-error']);
  });
  await measure('archives.gzip-cached-query', async () => {
    const result = await search('owned.log.gz', { queries: ['中文'] });
    assert.equal(result.matchCount, 1); assert.equal(result.cache.hits, 1); assert.equal(result.status, 'complete');
  });
  await measure('archives.zip-member-pagination', async () => {
    let cursor; const matches = [];
    for (let page = 0; page < 5; page += 1) {
      const result = await search('owned.zip', { maxMatches: 1, ...(cursor ? { cursor } : {}) });
      if (page > 0) assert.equal(result.cache.hits, 1);
      matches.push(...result.matches.map(match => match.text)); cursor = result.nextCursor;
      if (!cursor) { assert.equal(result.status, 'complete'); break; }
    }
    assert.equal(cursor, null); assert.deepEqual(matches, ['hit first', 'hit second', 'hit third 中文', 'hit fourth']);
  });
  await measure('archives.unsafe-and-nested-members-skipped', async () => {
    const result = await search('unsafe.zip');
    assert.equal(result.matchCount, 1); assert.equal(result.matches[0].archiveMember, 'safe.log'); assert.equal(result.status, 'partial');
    assert.ok(result.skipped.some(item => item.code === 'LOG_ARCHIVE_ENTRY_UNSAFE_PATH_SKIPPED'));
    assert.ok(result.skipped.some(item => item.code === 'LOG_ARCHIVE_ENTRY_NESTED_ARCHIVE_SKIPPED'));
  });
  await measure('archives.malformed-reported-inconclusive', async () => {
    const result = await search('invalid.gz');
    assert.equal(result.matchCount, 0); assert.equal(result.conclusion, 'inconclusive');
    assert.ok(result.skipped.some(item => item.code === 'LOG_ARCHIVE_MAGIC_MISMATCH'));
  });
  await measure('archives.compression-ratio-rejected', async () => {
    const result = await search('ratio.gz');
    assert.equal(result.matchCount, 0); assert.equal(result.conclusion, 'inconclusive');
    assert.ok(result.skipped.some(item => item.code === 'LOG_ARCHIVE_COMPRESSION_RATIO'));
  });
  await measure('archives.disguised-detection-and-exclusion', async () => {
    assert.equal((await search('disguised.log', { queries: ['archive-error'] })).matchCount, 1);
    const result = await search('disguised.log', { queries: ['archive-error'], includeArchives: false });
    assert.equal(result.matchCount, 0); assert.equal(result.cache.hits, 0); assert.equal(result.skipped[0].code, 'ARCHIVES_EXCLUDED');
  });
  await measure('archives.expansion-limit-and-suggested-retry', async () => {
    const result = await search('large.log.gz', { maxExpandedBytes: 65536 });
    assert.equal(result.conclusion, 'inconclusive'); assert.equal(result.nextCursor, null);
    const skipped = result.skipped.find(item => item.code === 'LOG_ARCHIVE_ENTRY_TOO_LARGE');
    assert.ok(skipped?.retryable); assert.ok(skipped.suggestedArguments.maxExpandedBytes > 65536);
    const retry = await search('large.log.gz', skipped.suggestedArguments);
    assert.equal(retry.status, 'complete'); assert.equal(retry.matchCount, 1);
  });
  await measure('archives.changed-target-invalidates-cache', async () => {
    await upload('owned.log.gz', gzipSync('hit updated archive content after replacement\n'), true);
    const old = await search('owned.log.gz', { queries: ['archive-ready'] });
    assert.equal(old.matchCount, 0); assert.equal(old.status, 'complete'); assert.equal(old.cache.hits, 0);
    assert.equal((await search('owned.log.gz', { queries: ['updated archive'] })).matchCount, 1);
  });
  await measure('archives.no-remote-extraction', async () => {
    const directory = await files.listDirectory(owner, { ...scope, path: root, deferLinks: true, refresh: true });
    assert.deepEqual(directory.entries.map(item => item.name).sort(), [...owned].filter(item => item !== root && path.posix.dirname(item) === root).map(item => path.posix.basename(item)).sort());
  });
}
