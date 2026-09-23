import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';
import { ServerOperations } from '../src/server-operations.mjs';

async function setup(t, content = 'A中文😀B\n') {
  const fixture = await createUploadFixture(t);
  const selected = '/logs/utf8.log';
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  fixture.files.set(selected, data);
  await fixture.broker.connect('fixture', {password:'fixture-password'});
  const requests = [], controls = {};
  const client = fixture.broker.requireSession('fixture').client, open = client.sftp;
  client.sftp = function(callback) {
    return open.call(this, (error, channel) => {
      if (channel) {
        const read = channel.read, close = channel.close;
        channel.read = function(...args) {
          requests.push({position:args[4], length:args[3]});
          return read.apply(this, args);
        };
        channel.close = function(handle, done) {
          return close.call(this, handle, (...args) => { controls.afterClose?.(); done(...args); });
        };
      }
      callback(error, channel);
    });
  };
  const runtime = {readRemoteRange: (_plugin, ...args) => fixture.broker.readRemoteRange('fixture', ...args)};
  const operations = new ServerOperations(runtime, {});
  t.after(() => operations.docker.dispose());
  const source = {sourceId:'logs', kind:'log', root:'/logs', patterns:['*.log'], maxFileBytes:1048576};
  const plugin = {projectId:'utf8-fixture', environmentId:'test', pluginInstanceId:'server', limits:{maxBytes:1048576}, sources:[source]};
  const fileId = operations.rememberFile(plugin, source, {canonicalPath:selected, size:data.length, mtime:1});
  return {...fixture, selected, data, requests, controls, operations, plugin,
    read:(method, args) => operations[method](plugin, {path:selected, fileId, tail:false, ...args}),
  };
}

for (const method of ['readFile', 'readLog']) {
  test(method + ' 小页完整返回前缀，预算不足报错后可用同一游标无损续查', async t => {
    const f = await setup(t);
    const first = await f.read(method, {maxBytes:2});
    assert.equal(first.content, 'A');
    assert.equal(first.startByte, 0);
    assert.equal(first.endByte, 1);
    assert.equal(first.nextCursor, '1');
    assert.equal(first.truncated, true);
    assert.deepEqual(f.requests, [{position:0, length:2}]);
    assert.equal(f.counters.downloaded, 2);
    const beforeError = f.counters.downloaded;
    await assert.rejects(f.read(method, {cursor:first.nextCursor, maxBytes:2}), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.field, 'maxBytes');
      assert.equal(error.details.minimumBytes, 3);
      assert.ok(error.details.suggestedValue >= 3);
      assert.match(error.message, /cursor.*maxBytes/u);
      return true;
    });
    assert.equal(f.counters.downloaded - beforeError, 2, '失败也不会超预算读取额外字节');
    let cursor = first.nextCursor;
    const pages = [first.content];
    for (let count = 0; cursor !== null && count < 10; count += 1) {
      const before = f.counters.downloaded, offset = Number(cursor);
      const page = await f.read(method, {cursor, maxBytes:4});
      assert.equal(page.startByte, offset);
      assert.ok(page.endByte > offset);
      assert.ok(Buffer.byteLength(page.content) <= 4);
      assert.ok(f.counters.downloaded - before <= 4);
      assert.equal(page.content.includes('\ufffd'), false);
      if (page.nextCursor !== null) assert.equal(page.nextCursor, String(page.endByte));
      pages.push(page.content); cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(pages.join(''), f.data.toString());
  });

  test(method + ' 四字节字符不能用三字节预算返回，也不产生停滞游标', async t => {
    const f = await setup(t, '😀B');
    await assert.rejects(f.read(method, {maxBytes:3}), error => error.code === 'INVALID_ARGUMENT' && error.details.minimumBytes === 4 && error.details.suggestedValue >= 4);
    assert.equal(f.counters.downloaded, 3);
    const page = await f.read(method, {maxBytes:4});
    assert.equal(page.content, '😀');
    assert.equal(page.nextCursor, '4');
    assert.equal(page.endByte, 4);
  });

  test(method + ' 手工字节偏移落入字符中间时保留替换语义，生成游标可继续且不跳字节', async t => {
    const f = await setup(t, 'A中文B');
    let cursor = '2';
    const pages = [];
    for (let count = 0; cursor !== null && count < 8; count += 1) {
      const before = f.counters.downloaded, offset = Number(cursor);
      const page = await f.read(method, {cursor, maxBytes:3});
      assert.equal(page.startByte, offset);
      assert.ok(page.endByte > offset);
      assert.ok(Buffer.byteLength(page.content) <= 3);
      assert.ok(f.counters.downloaded - before <= 3);
      if (page.nextCursor !== null) assert.equal(page.nextCursor, String(page.endByte));
      pages.push(page.content); cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(pages.join(''), f.data.subarray(2).toString('utf8'));
  });

  test(method + ' 尾读向文件末尾推进残缺起点，返回真实范围且不额外读取', async t => {
    const f = await setup(t, 'A中文B');
    const page = await f.read(method, {maxBytes:2, tail:true});
    assert.equal(page.content, 'B');
    assert.equal(page.startByte, 7);
    assert.equal(page.endByte, 8);
    assert.equal(page.nextCursor, null);
    assert.equal(page.truncated, false);
    assert.deepEqual(f.requests, [{position:6, length:2}]);
    assert.equal(f.counters.downloaded, 2);
  });

  test(method + ' 尾读窗口不能容纳完整字符时给出可纠正预算错误', async t => {
    const f = await setup(t, '中');
    await assert.rejects(f.read(method, {maxBytes:2, tail:true}), error => error.code === 'INVALID_ARGUMENT' && error.details.suggestedValue >= 4);
    assert.equal(f.counters.downloaded, 2);
    const page = await f.read(method, {maxBytes:4, tail:true});
    assert.equal(page.content, '中');
    assert.equal(page.startByte, 0);
    assert.equal(page.nextCursor, null);
  });
}

test('非法 UTF-8 的替换字符也受返回字节预算约束，游标按源字节推进', async t => {
  const f = await setup(t, Buffer.from([0xff, 0xff, 0xff]));
  await assert.rejects(f.read('readFile', {maxBytes:2}), error => error.code === 'INVALID_ARGUMENT' && error.details.minimumBytes === 3);
  let cursor = '0';
  const pages = [];
  for (let count = 0; cursor !== null && count < 4; count += 1) {
    const before = f.counters.downloaded;
    const page = await f.read('readFile', {cursor, maxBytes:3});
    assert.equal(page.content, '\ufffd');
    assert.equal(Buffer.byteLength(page.content), 3);
    assert.equal(page.endByte, Number(cursor) + 1);
    assert.ok(f.counters.downloaded - before <= 3);
    pages.push(page.content); cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(pages.join(''), f.data.toString('utf8'));
});


for (const method of ['readFile', 'readLog']) for (const bytes of [
  [0x80, 0x80, 0x80], [0xff, 0x80, 0x41], [0xe0, 0x80, 0x41],
]) test(method + ' 非法 UTF-8 ' + Buffer.from(bytes).toString('hex') + ' 返回的每个游标都能原样续查', async t => {
  const f = await setup(t, Buffer.from(bytes));
  let cursor = '0';
  const pages = [];
  for (let count = 0; cursor !== null && count < bytes.length + 1; count += 1) {
    const before = f.counters.downloaded, offset = Number(cursor);
    const page = await f.read(method, {cursor, maxBytes:3});
    assert.equal(page.startByte, offset);
    assert.ok(page.endByte > offset);
    assert.ok(Buffer.byteLength(page.content) <= 3);
    assert.ok(f.counters.downloaded - before <= 3);
    if (page.nextCursor !== null) assert.equal(page.nextCursor, String(page.endByte));
    pages.push(page.content); cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(pages.join(''), f.data.toString('utf8'));
});

test('完整窗口保留既有非法 UTF-8 和文件尾残缺字节的替换语义', async t => {
  const f = await setup(t, Buffer.from([0x41, 0xe0, 0x80, 0xff, 0xed, 0xa0, 0x80, 0xf0, 0x90]));
  const page = await f.read('readFile', {maxBytes:64});
  assert.equal(page.content, f.data.toString('utf8'));
  assert.equal(page.startByte, 0);
  assert.equal(page.endByte, f.data.length);
  assert.equal(page.nextCursor, null);
  assert.equal(f.counters.downloaded, f.data.length);
});

test('文本边界不改变二进制读取的精确范围与字节内容', async t => {
  const f = await setup(t, 'A中文B');
  const result = await f.broker.withRemoteReadSession('fixture', reader => reader.readBuffer(f.selected, 0, 2));
  assert.deepEqual(result.content, f.data.subarray(0, 2));
  assert.equal(result.startByte, 0);
  assert.equal(result.endByte, 2);
  assert.equal(f.counters.downloaded, 2);
});

for (const change of ['size', 'mode', 'realpath']) test('UTF-8 预算检查之前仍拒绝正文读取期间的 ' + change + ' 变化', async t => {
  const f = await setup(t, '中文');
  f.controls.afterClose = () => {
    if (change === 'size') f.files.set(f.selected, Buffer.from('A'));
    else if (change === 'mode') f.modes.set(f.selected, 0o100600);
    else f.faults.realPaths.set(f.selected, '/logs/changed.log');
  };
  await assert.rejects(f.read('readFile', {maxBytes:2}), {code:'SOURCE_CHANGED'});
  assert.equal(f.counters.downloaded, 2);
});

test('增长文件仍固定原读取预算，截断字符保留给后续游标并返回增长标记', async t => {
  const f = await setup(t, 'A中');
  f.controls.afterClose = () => { f.files.set(f.selected, Buffer.concat([f.data, Buffer.from('B')])); };
  const page = await f.read('readFile', {maxBytes:2});
  assert.equal(page.content, 'A');
  assert.equal(page.endByte, 1);
  assert.equal(page.nextCursor, '1');
  assert.equal(page.size, 4);
  assert.equal(page.observedSize, 5);
  assert.equal(page.sourceGrew, true);
  assert.equal(f.counters.downloaded, 2);
  f.controls.afterClose = null;
  const next = await f.read('readFile', {cursor:page.nextCursor, maxBytes:4});
  assert.equal(next.content, '中B');
  assert.equal(next.nextCursor, null);
});

test('登记配置的过小 UTF-8 页预算不能返回空内容和不前进游标', async t => {
  const f = await setup(t, 'A中B');
  const source = {sourceId:'config', kind:'config', root:'/logs', patterns:['*.log'], maxFileBytes:1048576};
  const plugin = {...f.plugin, sources:[source]};
  const fileId = f.operations.rememberFile(plugin, source, {canonicalPath:f.selected, size:f.data.length, mtime:1});
  const first = await f.operations.readConfig(plugin, {fileId, maxBytes:2});
  assert.equal(first.content, 'A');
  assert.equal(first.nextCursor, '1');
  await assert.rejects(f.operations.readConfig(plugin, {fileId, cursor:first.nextCursor, maxBytes:2}), error => error.code === 'INVALID_ARGUMENT' && error.details.minimumBytes === 3);
  const next = await f.operations.readConfig(plugin, {fileId, cursor:first.nextCursor, maxBytes:3});
  assert.equal(next.content, '中');
  assert.equal(next.nextCursor, '4');
});
