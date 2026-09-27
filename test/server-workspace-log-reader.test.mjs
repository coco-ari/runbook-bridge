import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerWorkspaceLogReader } from '../src/server-workspace-log-reader.mjs';
import { mergeFilePreview, filePreviewMatches } from '../renderer/v2/src/features/server-workspace/file-preview-model.ts';
import { fileListEntries } from '../renderer/v2/src/features/server-workspace/file-list-model.ts';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

function fixture(content = 'fixture 日志😀\n') {
  let body = Buffer.from(content), mtime = 1;
  const calls = [];
  const operations = {readFile:async (_plugin, input) => {
    calls.push(input);
    let start = input.tail ? Math.max(0, body.length - input.maxBytes) : Number(input.cursor ?? 0);
    while (start < body.length && (body[start] & 0xc0) === 0x80) start++;
    let end = Math.min(body.length, start + input.maxBytes);
    while (end < body.length && (body[end] & 0xc0) === 0x80) end--;
    return {path:input.path, content:body.subarray(start, end).toString(), startByte:start, endByte:end, size:body.length, mtime, nextCursor:end < body.length ? String(end) : null, truncated:end < body.length};
  }};
  const reader = new ServerWorkspaceLogReader(operations);
  const binding = {scope:{projectId:'fixture',environmentId:'test',pluginInstanceId:'server'},revision:1,generation:1,epoch:0};
  const read = (payload = {}, overrides = {}) => {
    reader.options(payload);
    return reader.read({}, {path:'/fixture.log', ...payload}, overrides.owner ?? 'renderer:1', {...binding, ...overrides.binding}, {canonicalPath:overrides.canonicalPath ?? '/fixture.log',size:body.length,mtime}, {});
  };
  return {read, calls, reader, set:text => {body = Buffer.from(text); mtime++;}};
}

test('日志游标从末尾续读 Unicode，空轮询不重复并保留衔接校验', async () => {
  const f = fixture();
  let page = await f.read({tail:true});
  assert.equal(page.content, 'fixture 日志😀\n');
  assert.equal(page.endByte, Buffer.byteLength(page.content));
  assert.equal(Buffer.from(page.followToken.split('.')[0], 'base64url').toString().includes('日志'), false);
  const empty = await f.read({followToken:page.followToken});
  assert.equal(empty.content, '');
  f.set('fixture 日志😀\n追加中文😀\n');
  const appended = await f.read({followToken:empty.followToken});
  assert.equal(appended.content, '追加中文😀\n');
  assert.equal(appended.reset, false);
  assert.equal(appended.startByte, page.endByte);
  assert.ok(f.calls.every(call => call.maxBytes <= 262144));
});

test('截断、同长度重写及超出单次增量上限重新读取末尾', async () => {
  for (const next of ['new\n', 'replacement line\n', 'original lineabc\n' + 'x'.repeat(300000)]) {
    const f = fixture('original lineabc\n');
    const first = await f.read({tail:true});
    f.set(next);
    const page = await f.read({followToken:first.followToken});
    assert.equal(page.reset, true);
    assert.equal(page.resetReason, next.length > 300000 ? 'limit' : 'changed');
    assert.equal(f.calls.at(-1).tail, true);
    assert.ok(Buffer.byteLength(page.content) <= 262144);
    assert.equal(page.endByte, Buffer.byteLength(next));
  }
});

test('跟随游标不可跨窗口、连接、配置、路径使用，不接受篡改或错误位置', async () => {
  const f = fixture(); const first = await f.read({tail:true});
  for (const overrides of [{owner:'renderer:2'}, {binding:{revision:2}}, {binding:{generation:2}}, {binding:{epoch:1}}, {canonicalPath:'/other.log'}]) {
    const before = f.calls.length;
    await assert.rejects(f.read({followToken:first.followToken}, overrides), {code:'WORKSPACE_CHANGED'});
    assert.equal(f.calls.length, before);
  }
  const altered = first.followToken.slice(0,-1) + (first.followToken.endsWith('0') ? '1' : '0');
  await assert.rejects(f.read({followToken:altered}), {code:'WORKSPACE_CHANGED'});
  for (const payload of [{tail:'yes'}, {cursor:'-1'}, {cursor:'9007199254740992'}, {tail:true,cursor:'1'}, {followToken:first.followToken, cursor:'0'}, {followToken:''}]) assert.throws(() => f.read(payload), {code:'INVALID_ARGUMENT'});
});

test('二进制日志不提供跟随游标，头尾分页仍保持边界', async () => {
  const f = fixture('head\0tail');
  const page = await f.read({tail:true});
  assert.equal(page.followToken, undefined);
  assert.equal(page.content, 'head\0tail');
  const text = fixture('x'.repeat(300000));
  const head = await text.read({cursor:'0'});
  assert.equal(head.nextCursor, '262144');
  assert.equal((await text.read({cursor:head.nextCursor})).content.length, 37856);
});

const page = (content, startByte = 0, extra = {}) => ({path:'/fixture',content,startByte,endByte:startByte + Buffer.byteLength(content),size:1000000,mtime:1,nextCursor:null,truncated:false,...extra});
test('日志缓存只拼接连续范围，有界行数和字符数且不切断代理对', () => {
  const before = page('原始\n');
  assert.equal(mergeFilePreview(before, page('追加\n', before.endByte), true).data.content, '原始\n追加\n');
  assert.equal(mergeFilePreview(before, page('替换\n'), true).data.content, '替换\n');
  assert.equal(mergeFilePreview(before, page('重置\n', before.endByte, {reset:true}), true).data.content, '重置\n');
  const lines = mergeFilePreview(undefined, page('x\n'.repeat(6000)), false);
  assert.equal(lines.data.content.split('\n').length, 5000); assert.equal(lines.clipped, true);
  const unicode = mergeFilePreview(undefined, page('😀'.repeat(140000) + 'a'), false);
  assert.ok(unicode.data.content.length <= 262144);
  assert.equal(unicode.data.content.includes('\ufffd'), false);
  assert.ok(!/[\uDC00-\uDFFF]/u.test(unicode.data.content[0]));
  assert.equal(unicode.data.startByte + Buffer.byteLength(unicode.data.content), unicode.data.endByte);
});

test('搜索按原始字符位置匹配，忽略正则含义且限制匹配数量', () => {
  assert.deepEqual(filePreviewMatches('İ 错误错误 [x]', '错误'), [2,4]);
  assert.deepEqual(filePreviewMatches('[x]', '[x]'), [0]);
  assert.equal(filePreviewMatches('a'.repeat(2000), 'a').length, 1000);
  assert.deepEqual(filePreviewMatches('text',''), []);
});

test('目录详情排序保留文件夹在前、自然名称序且不修改分页原数组', () => {
  const entries = [{name:'file10',type:'file',size:10,mtime:3},{name:'file2',type:'file',size:20,mtime:1},{name:'folder',type:'directory',size:0,mtime:2},{name:'.hidden',type:'file',size:1,mtime:4}];
  const before = JSON.stringify(entries);
  const names = (...args) => fileListEntries(entries,...args).map(item => item.name);
  assert.deepEqual(names('', 'name', false, false), ['folder','file2','file10']);
  assert.deepEqual(names('', 'size', true, false), ['folder','file2','file10']);
  assert.deepEqual(names('', 'mtime', true, true), ['folder','.hidden','file10','file2']);
  assert.deepEqual(names('FILE2', 'name', false, false), ['file2']);
  assert.equal(JSON.stringify(entries), before);
});

test('真实本地 SFTP 日志尾部、增量与截断读取复用有界会话', {timeout:15000}, async t => {
  const fixture = await createUploadFixture(t);
  const scope = {projectId:'fixture',environmentId:'test',pluginInstanceId:'server'};
  const plugin = {...scope,revision:1,pluginType:'server',configState:'ready'};
  const runtime = {
    status:() => fixture.broker.status('fixture'),
    statRemotePath:(_plugin,target) => fixture.broker.statRemotePath('fixture',target),
    withRemoteReadSession:(_plugin,fn,options) => fixture.broker.withRemoteReadSession('fixture',fn,options),
  };
  const store = {getPlugin:async () => plugin};
  const operations = new ServerOperations(runtime,store);
  const files = new ServerWorkspaceFiles({workspaceStore:store,serverRuntime:runtime,serverOperations:operations});
  t.after(() => {files.dispose();operations.docker.dispose();});
  fixture.files.set('/fixture.log',Buffer.from('头部\n中文😀\n'));
  await fixture.broker.connect('fixture',{password:'fixture-password'});
  const initial = await files.readFile('renderer:1',{...scope,path:'/fixture.log',tail:true});
  assert.equal(initial.content,'头部\n中文😀\n');
  fixture.files.set('/fixture.log',Buffer.from('头部\n中文😀\n追加😀\n'));
  const appended = await files.readFile('renderer:1',{...scope,path:'/fixture.log',followToken:initial.followToken});
  assert.equal(appended.content,'追加😀\n'); assert.equal(appended.reset,false);
  fixture.files.set('/fixture.log',Buffer.from('新日志\n'));
  const rotated = await files.readFile('renderer:1',{...scope,path:'/fixture.log',followToken:appended.followToken});
  assert.equal(rotated.content,'新日志\n'); assert.equal(rotated.reset,true);
  fixture.modes.set('/fixture.log',0o020600);
  await assert.rejects(files.readFile('renderer:1',{...scope,path:'/fixture.log',tail:true}),{code:'PATH_INVALID'});
});
