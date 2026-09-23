import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ServerOperations } from '../src/server-operations.mjs';

const root = '/search-fixture';
const plugin = {
  projectId: 'search-test', environmentId: 'local', pluginInstanceId: 'server', revision: 1,
  pluginType: 'server', limits: { maxBytes: 1048576 }, sources: [], actions: [],
};

function memoryRuntime(initial, { onList } = {}) {
  const files = new Map();
  const calls = { lists: [], reads: [] };
  const put = (relative, value) => files.set(root + '/' + relative, { content: Buffer.from(value), mtime: 1 });
  for (const [relative, value] of Object.entries(initial)) put(relative, value);
  const directories = () => {
    const result = new Set([root]);
    for (const selected of files.keys()) {
      let current = path.posix.dirname(selected);
      while (current.startsWith(root) && !result.has(current)) { result.add(current); current = path.posix.dirname(current); }
    }
    return result;
  };
  const statPath = async selected => {
    const file = files.get(selected);
    if (file) return { path: selected, canonicalPath: selected, type: 'file', size: file.content.length, mtime: file.mtime };
    if (directories().has(selected)) return { path: selected, canonicalPath: selected, type: 'directory', size: 0, mtime: 1 };
    throw Object.assign(new Error('合成路径不存在'), { code: 'SOURCE_NOT_FOUND' });
  };
  const listDirectory = async selected => {
    calls.lists.push(selected);
    const entries = [];
    for (const directory of directories()) if (directory !== root && path.posix.dirname(directory) === selected) {
      entries.push({ name: path.posix.basename(directory), canonicalPath: directory, isDirectory: true, isFile: false, isSymbolicLink: false, size: 0, mtime: 1 });
    }
    for (const [filePath, file] of files) if (path.posix.dirname(filePath) === selected) {
      entries.push({ name: path.posix.basename(filePath), canonicalPath: filePath, isDirectory: false, isFile: true, isSymbolicLink: false, size: file.content.length, mtime: file.mtime });
    }
    return onList ? onList(selected, entries, calls.lists.length) : entries;
  };
  const read = async (selected, start, maxBytes, options = {}) => {
    calls.reads.push({ path: selected, start, maxBytes });
    const file = files.get(selected);
    assert.ok(file, '读取必须限定于合成文件');
    const offset = options.tail ? Math.max(0, file.content.length - maxBytes) : start;
    const end = Math.min(file.content.length, offset + maxBytes);
    return { canonicalPath: selected, content: file.content.subarray(offset, end), startByte: offset, endByte: end,
      size: file.content.length, mtime: file.mtime, truncated: end < file.content.length };
  };
  // 夹具保留旧文本读取协议；正文搜索优先使用原始字节，避免跨页解码损坏。
  const readRange = async (...args) => { const result = await read(...args); return { ...result, content: result.content.toString('utf8') }; };
  const runtime = {
    statRemotePath: (_plugin, selected) => statPath(selected),
    withRemoteReadSession: async (_plugin, operation) => operation({ generation: 1, statPath, listDirectory, readRange, readBuffer: read }),
  };
  return { runtime, calls, put };
}

function operationsFor(t, fixture) {
  const operations = new ServerOperations(fixture.runtime, {});
  t.after(() => {
    operations.docker.dispose();
    for (const key of operations.logSnapshotCache.entries.keys()) operations.logSnapshotCache.remove(key);
    operations.logSnapshotCache.scheduleExpiry();
  });
  return operations;
}

for (const keyword of ['ascii-marker', '中文标记', '🔎标记']) {
  test(`文件内容搜索跨 1 MiB 页边界保留 ${keyword} 字面量匹配`, async t => {
    const content = 'a'.repeat(1048575) + keyword + '\n';
    const fixture = memoryRuntime({ 'large.conf': content });
    const operations = operationsFor(t, fixture);
    const result = await operations.searchFiles(plugin, { path: root, contains: keyword, pattern: '*.conf', maxDepth: 0,
      maxFiles: 2, maxMatches: 2, maxScanBytes: 2 * 1048576 });
    assert.equal(fixture.calls.reads.length, 2);
    assert.equal(result.scannedBytes, Buffer.byteLength(content));
    assert.equal(result.truncated, false);
    assert.equal(result.matchCount, 1);
    assert.equal(result.matches[0].line, 1);
  });
}

test('显式刷新不能沿用刷新前仍在等待的旧目录清单', async t => {
  let releaseFirst, announceFirst;
  let active = 0;
  let maxActive = 0;
  const pending = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { announceFirst = resolve; });
  const fixture = memoryRuntime({ 'old.log': 'old\n' }, { onList: async (_selected, entries, count) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (count === 1) { announceFirst(); await pending; }
      return entries;
    } finally { active -= 1; }
  } });
  t.after(() => releaseFirst());
  const operations = operationsFor(t, fixture);
  const args = { path: root, pattern: '*.log', maxDepth: 0, maxResults: 10 };
  const first = operations.findFiles(plugin, args);
  await started;
  fixture.put('new.log', 'new\n');
  const refreshed = Promise.all(Array.from({ length: 24 }, () => operations.findFiles(plugin, { ...args, refresh: true })));
  await nextTurn();
  releaseFirst();
  await first;
  const results = await refreshed;
  for (const result of results) assert.deepEqual(result.files.map(file => file.name).sort(), ['new.log', 'old.log']);
  results[0].files[0].name = 'changed-by-caller';
  assert.deepEqual(results[1].files.map(file => file.name).sort(), ['new.log', 'old.log']);
  assert.equal(fixture.calls.lists.length, 2);
  assert.equal(maxActive, 1);
  assert.equal(operations.discovery.refreshes.size, 0);
  assert.equal(operations.discovery.cache.pending.size, 0);
  const cached = await operations.findFiles(plugin, args);
  assert.deepEqual(cached.files.map(file => file.name).sort(), ['new.log', 'old.log']);
  assert.equal(fixture.calls.lists.length, 2);
});

test('目录深度与文件数量上限分别限制发现范围', async t => {
  const fixture = memoryRuntime({ 'root.log': 'root\n', 'child/one.log': 'one\n', 'child/grand/two.log': 'two\n' });
  const operations = operationsFor(t, fixture);
  const shallow = await operations.findFiles(plugin, { path: root, pattern: '*.log', maxDepth: 0, maxResults: 10 });
  assert.deepEqual(shallow.files.map(file => file.name), ['root.log']);
  assert.equal(shallow.truncated, false);
  assert.deepEqual(fixture.calls.lists, [root]);
  const bounded = await operations.findFiles(plugin, { path: root, pattern: '*.log', maxDepth: 2, maxResults: 1, refresh: true });
  assert.equal(bounded.files.length, 1);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.remainingDirectories, [{ path: root + '/child', maxDepth: 1 }]);
});

test('日志受文件数量限制的零命中只能在全部游标结束后声明无匹配', async t => {
  const fixture = memoryRuntime({ 'a.log': 'ordinary a\n', 'b.log': 'ordinary b\n', 'c.log': 'ordinary c\n' });
  const operations = operationsFor(t, fixture);
  const args = { path: root, queries: ['absent-marker'], maxFiles: 1, maxScanBytes: 65536 };
  const first = await operations.searchLogs(plugin, args);
  assert.equal(first.matchCount, 0);
  assert.equal(first.conclusion, 'inconclusive');
  assert.equal(first.status, 'partial');
  assert.ok(first.nextCursor);
  await assert.rejects(operations.searchLogs(plugin, { ...args, maxFiles: 2, cursor: first.nextCursor }), { code: 'LOG_CURSOR_MISMATCH' });
  const second = await operations.searchLogs(plugin, { ...args, cursor: first.nextCursor });
  const final = await operations.searchLogs(plugin, { ...args, cursor: second.nextCursor });
  assert.equal(final.nextCursor, null);
  assert.equal(final.status, 'complete');
  assert.equal(final.conclusion, 'no_match');
  assert.equal(final.progress.filesFinished, 3);
  assert.deepEqual(fixture.calls.lists, [root]);
});

test('正文搜索的字节预算不足跨页字符时仍保持预算上限', async t => {
  const fixture = memoryRuntime({ 'large.conf': 'a'.repeat(1048575) + '中文标记\n' });
  const operations = operationsFor(t, fixture);
  const result = await operations.searchFiles(plugin, { path: root, contains: '中文标记', pattern: '*.conf', maxDepth: 0,
    maxFiles: 2, maxMatches: 2, maxScanBytes: 1048576 });
  assert.equal(fixture.calls.reads.length, 1);
  assert.equal(fixture.calls.reads[0].maxBytes, 1048576);
  assert.equal(result.scannedBytes, 1048576);
  assert.equal(result.matchCount, 0);
  assert.equal(result.truncated, true);
});

test('旧目录请求失败后显式刷新仍重新读取并清理等待队列', async t => {
  let release, announce;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  const fixture = memoryRuntime({ 'old.log': 'old\n' }, { onList: async (_selected, entries, count) => {
    if (count === 1) {
      announce();
      await pending;
      throw Object.assign(new Error('合成旧读取失败'), { code: 'SFTP_READ_FAILED' });
    }
    return entries;
  } });
  t.after(() => release());
  const operations = operationsFor(t, fixture);
  const args = { path: root, pattern: '*.log', maxDepth: 0 };
  const first = assert.rejects(operations.findFiles(plugin, args), { code: 'SFTP_READ_FAILED' });
  await started;
  fixture.put('new.log', 'new\n');
  const refreshed = operations.findFiles(plugin, { ...args, refresh: true });
  await nextTurn();
  release();
  await first;
  const result = await refreshed;
  assert.deepEqual(result.files.map(file => file.name).sort(), ['new.log', 'old.log']);
  assert.equal(fixture.calls.lists.length, 2);
  assert.equal(operations.discovery.refreshes.size, 0);
  assert.equal(operations.discovery.cache.pending.size, 0);
});

test('不同目录的显式刷新等待数有界且完成后可继续读取', async t => {
  let release, announce;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  const fixture = memoryRuntime({ 'root.log': 'root\n', 'child/one.log': 'one\n' }, { onList: async (_selected, entries, count) => {
    if (count === 1) { announce(); await pending; }
    return entries;
  } });
  t.after(() => release());
  const operations = operationsFor(t, fixture);
  operations.discovery.cache.maxPending = 1;
  const args = { path: root, pattern: '*.log', maxDepth: 0 };
  const first = operations.findFiles(plugin, args);
  await started;
  const refreshed = operations.findFiles(plugin, { ...args, refresh: true });
  await nextTurn();
  await assert.rejects(operations.findFiles(plugin, { ...args, path: root + '/child', refresh: true }), { code: 'READ_BUSY' });
  assert.equal(fixture.calls.lists.length, 1);
  release();
  await Promise.all([first, refreshed]);
  assert.equal(operations.discovery.refreshes.size, 0);
  assert.equal(operations.discovery.cache.pending.size, 0);
  const child = await operations.findFiles(plugin, { ...args, path: root + '/child', refresh: true });
  assert.deepEqual(child.files.map(file => file.name), ['one.log']);
  assert.equal(fixture.calls.lists.length, 3);
});

test('显式刷新自身失败后释放队列并允许下一次重新读取', async t => {
  let fail = false;
  const fixture = memoryRuntime({ 'old.log': 'old\n' }, { onList: async (_selected, entries) => {
    if (fail) throw Object.assign(new Error('合成刷新读取失败'), { code: 'SFTP_READ_FAILED' });
    return entries;
  } });
  const operations = operationsFor(t, fixture);
  const args = { path: root, pattern: '*.log', maxDepth: 0 };
  await operations.findFiles(plugin, args);
  fail = true;
  await assert.rejects(operations.findFiles(plugin, { ...args, refresh: true }), { code: 'SFTP_READ_FAILED' });
  assert.equal(operations.discovery.refreshes.size, 0);
  assert.equal(operations.discovery.cache.pending.size, 0);
  fail = false;
  fixture.put('new.log', 'new\n');
  const result = await operations.findFiles(plugin, { ...args, refresh: true });
  assert.deepEqual(result.files.map(file => file.name).sort(), ['new.log', 'old.log']);
  assert.equal(fixture.calls.lists.length, 3);
});
