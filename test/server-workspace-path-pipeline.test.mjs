import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';

async function until(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await delay(10);
  assert.ok(predicate(), '路径请求应在观察期限内进入预期状态');
}
async function setup(t) {
  const f = await createUploadFixture(t);
  f.files.set('/srv', Buffer.alloc(0)); f.modes.set('/srv', 0o40755);
  await f.broker.connect('fixture', { password:'fixture-password' });
  const client = f.broker.requireSession('fixture').client, open = client.sftp;
  const requests = [], responses = [], channels = [];
  let holding = true;
  client.sftp = function(callback) {
    return open.call(this, (error, channel) => {
      if (channel) {
        const state = { channel, ended: false };
        const end = channel.end;
        channel.end = function(...args) { state.ended = true; return end.apply(this, args); };
        channels.push(state);
      }
      if (channel) for (const method of ['lstat','realpath']) {
        const original = channel[method];
        channel[method] = function(value, done) {
          requests.push({ method, value });
          return original.call(this, value, (failure, result) => {
            let released = false;
            const response = { method, release: (override = failure) => {
              if (released) return; released = true; done(override, result);
            } };
            if (holding) responses.push(response); else response.release();
          });
        };
      }
      callback(error, channel);
    });
  };
  const release = () => { holding = false; for (const item of responses) item.release(); };
  t.after(release);
  return { ...f, requests, responses, channels, release,
    read: options => f.broker.withWorkspaceReadSession('fixture', reader => reader.statPath('/srv'), options),
    pool: () => f.broker.requireSession('fixture').workspaceReads,
  };
}

for (const first of ['lstat','realpath']) test('目录路径两个请求同时在途，先返回 ' + first + ' 时仍不交付或归还通道', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.read().finally(() => { settled = true; }); reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    assert.deepEqual(f.requests, [{method:'lstat',value:'/srv'}, {method:'realpath',value:'/srv'}]);
    assert.ok([...f.pool().entries.values()].every(entry => !entry.idle));
    f.responses.find(item => item.method === first).release(); await delay(20);
    assert.equal(settled, false);
    assert.ok([...f.pool().entries.values()].every(entry => !entry.idle));
    f.responses.find(item => item.method !== first).release();
    assert.deepEqual(await reading, {exists:true,path:'/srv',canonicalPath:'/srv',type:'directory',size:0,mtime:1,mode:0o40755});
    assert.ok([...f.pool().entries.values()].every(entry => entry.idle));
    f.release(); assert.equal((await f.read()).canonicalPath, '/srv');
    assert.equal(f.pool().entries.size, 1);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const code of [2,3]) test('目录属性失败 ' + code + ' 等待已发真实路径请求结束，再映射错误并废弃通道', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.read().finally(() => { settled = true; }); reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    f.responses.find(item => item.method === 'lstat').release(Object.assign(new Error('合成属性失败'), {code}));
    await delay(20); assert.equal(settled, false);
    assert.ok([...f.pool().entries.values()].every(entry => !entry.idle));
    f.responses.find(item => item.method === 'realpath').release();
    await assert.rejects(reading, {code:code === 2 ? 'SOURCE_NOT_FOUND' : 'SOURCE_ACCESS_DENIED'});
    assert.ok([...f.pool().entries.values()].every(entry => !entry.idle));
    await until(() => f.pool().entries.size === 0);
    f.release(); assert.equal((await f.read()).type, 'directory');
    assert.equal(f.broker.status('fixture').connected, true);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('真实路径失败仍等待属性响应，并保留无法解析的路径状态', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.read().finally(() => { settled = true; }); reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    f.responses.find(item => item.method === 'realpath').release(Object.assign(new Error('合成失效链接'), {code:2}));
    await delay(20); assert.equal(settled, false);
    f.responses.find(item => item.method === 'lstat').release();
    assert.equal((await reading).canonicalPath, null);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('取消并行路径读取不关闭 SSH，迟到响应不能重新入池', async t => {
  const f = await setup(t), controller = new AbortController();
  const reading = f.read({signal:controller.signal}); reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    const old = [...f.pool().entries.keys()][0];
    controller.abort(); await assert.rejects(reading, {code:'TRANSFER_CANCELLED'});
    assert.ok([...f.pool().entries.values()].every(entry => !entry.idle));
    await until(() => f.pool().entries.size === 0);
    assert.equal(f.broker.status('fixture').connected, true);
    f.release(); assert.equal((await f.read()).type, 'directory');
    assert.equal(f.pool().entries.has(old), false);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('普通路径读取仍按原有次序执行，不启用人工目录的流水线', async t => {
  const f = await setup(t);
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'));
  reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 1);
    assert.deepEqual(f.requests.map(item => item.method), ['lstat']);
    f.responses[0].release(); await until(() => f.responses.length === 2);
    f.responses[1].release(); assert.equal((await reading).canonicalPath, '/srv');
    assert.equal(f.pool(), undefined);
  } finally { f.release(); await reading.catch(() => undefined); }
});


for (const first of ['lstat', 'realpath']) test('显式元数据流水线先返回 ' + first + ' 时仍等待另一响应且不使用目录池', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true })
    .finally(() => { settled = true; });
  reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    assert.deepEqual(f.requests, [{method:'lstat',value:'/srv'}, {method:'realpath',value:'/srv'}]);
    assert.equal(f.pool(), undefined);
    f.responses.find(item => item.method === first).release();
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.channels[0].ended, false);
    f.responses.find(item => item.method !== first).release();
    assert.equal((await reading).canonicalPath, '/srv');
    assert.equal(f.channels[0].ended, true);
    assert.equal(f.pool(), undefined);
    f.release();
    await f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true });
    assert.equal(f.channels.length, 2, '成功后关闭通道，后续调用重新创建通道');
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const code of [2, 3]) test('显式元数据流水线属性失败 ' + code + ' 等待另一响应并保留错误映射', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true })
    .finally(() => { settled = true; });
  reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    f.responses.find(item => item.method === 'lstat').release(Object.assign(new Error('合成属性失败'), {code}));
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.channels[0].ended, false);
    f.responses.find(item => item.method === 'realpath').release(Object.assign(new Error('合成路径失败'), {code:4}));
    await assert.rejects(reading, {code:code === 2 ? 'SOURCE_NOT_FOUND' : 'SOURCE_ACCESS_DENIED'});
    assert.equal(f.channels[0].ended, true);
    assert.equal(f.pool(), undefined);
    assert.equal(f.broker.status('fixture').connected, true);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('显式元数据流水线真实路径失败仍等待属性并返回无法解析状态', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true })
    .finally(() => { settled = true; });
  reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    f.responses.find(item => item.method === 'realpath').release(Object.assign(new Error('合成失效链接'), {code:2}));
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.channels[0].ended, false);
    f.responses.find(item => item.method === 'lstat').release();
    assert.equal((await reading).canonicalPath, null);
    assert.equal(f.channels[0].ended, true);
    assert.equal(f.pool(), undefined);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const late of ['success', 'failure']) test('显式元数据流水线取消后迟到 ' + late + ' 响应不能交付或复用通道', async t => {
  const f = await setup(t), controller = new AbortController();
  let deliveries = 0;
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true, signal: controller.signal }).then(result => { deliveries += 1; return result; });
  reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 2);
    controller.abort();
    await assert.rejects(reading, {code:'TRANSFER_CANCELLED'});
    assert.equal(f.channels[0].ended, true);
    assert.equal(f.broker.status('fixture').connected, true);
    assert.equal(f.pool(), undefined);
    if (late === 'failure') for (const response of f.responses) response.release(Object.assign(new Error('合成迟到失败'), {code:3}));
    f.release();
    await delay(20);
    assert.equal(deliveries, 0);
    assert.equal((await f.broker.withRemoteReadSession('fixture', reader => reader.statPath('/srv'), { pipelineMetadata: true })).type, 'directory');
    assert.equal(f.channels.length, 2);
    assert.notEqual(f.channels[0].channel, f.channels[1].channel);
    assert.equal(f.pool(), undefined);
  } finally { f.release(); await reading.catch(() => undefined); }
});

async function setupDesktop(t) {
  const f = await createUploadFixture(t);
  await f.broker.connect('fixture', { password:'fixture-password' });
  const scope = { projectId:'fixture-project', environmentId:'test', pluginInstanceId:'server' };
  const plugin = { ...scope, revision:1, pluginType:'server', configState:'ready' };
  const store = { getPlugin:async () => plugin };
  const runtime = new ServerPluginRuntime(store, {});
  runtime.broker = f.broker;
  runtime.key = () => 'fixture';
  const operations = new ServerOperations(runtime, store);
  const workspace = new ServerWorkspaceFiles({ workspaceStore:store, serverRuntime:runtime, serverOperations:operations });
  t.after(() => { workspace.dispose(); operations.docker.dispose(); });
  const calls = [], channels = [];
  let metadataActive = 0, metadataPeak = 0, metadataBatches = 0, schedulerPeak = 0;
  const observeClient = client => {
    const open = client.sftp;
    client.sftp = function(callback) {
      return open.call(this, (error, channel) => {
        if (channel) {
          channels.push(channel);
          schedulerPeak = Math.max(schedulerPeak, runtime.readScheduler.active);
          for (const method of ['lstat', 'realpath', 'stat', 'open', 'read', 'close', 'opendir', 'readdir']) {
            const original = channel[method];
            channel[method] = function(...args) {
              const done = args.pop();
              const metadata = ['lstat', 'realpath', 'stat'].includes(method);
              calls.push({method, value:args[0], channel});
              schedulerPeak = Math.max(schedulerPeak, runtime.readScheduler.active);
              if (metadata) {
                if (metadataActive === 0) metadataBatches += 1;
                metadataActive += 1;
                metadataPeak = Math.max(metadataPeak, metadataActive);
              }
              return original.call(this, ...args, (...results) => {
                if (metadata) metadataActive -= 1;
                if (method === 'close') f.afterClose?.();
                if (f.onResponse) f.onResponse({ method, args, results, done, channel });
                else done(...results);
              });
            };
          }
        }
        callback(error, channel);
      });
    };
  };
  observeClient(f.broker.requireSession('fixture').client);
  f.files.set('/', Buffer.alloc(0)); f.modes.set('/', 0o40755);
  const payload = Buffer.from('fixture');
  f.files.set('/actual.txt', payload);
  f.files.set('/link.txt', Buffer.from('/actual.txt'));
  f.modes.set('/link.txt', 0o120777);
  f.faults.realPaths.set('/link.txt', '/actual.txt');
  return { ...f, fixture:f, workspace, runtime, scope, calls, channels, observeClient,
    counts:() => ({metadataActive, metadataPeak, metadataBatches, schedulerPeak}),
  };
}

for (const scenario of [
  {method:'readFile', path:'/actual.txt', metadata:8, batches:5},
  {method:'readFile', path:'/link.txt', metadata:12, batches:7},
  {method:'fileInfo', path:'/actual.txt', metadata:2, batches:1},
  {method:'fileInfo', path:'/link.txt', metadata:6, batches:3},
]) test('桌面真实调用链 ' + scenario.method + ' ' + scenario.path + ' 复用通道后保留全部元数据请求与正文校验', async t => {
  const f = await setupDesktop(t);
  const result = await f.workspace[scenario.method]('renderer:1', {...f.scope, path:scenario.path});
  const metadata = f.calls.filter(item => ['lstat', 'realpath', 'stat'].includes(item.method));
  assert.equal(metadata.length, scenario.metadata);
  assert.deepEqual(f.counts(), {metadataActive:0, metadataPeak:2, metadataBatches:scenario.batches, schedulerPeak:1});
  assert.equal(result.path, scenario.path);
  assert.equal(result.canonicalPath, '/actual.txt');
  assert.equal(f.channels.length, 1);
  const pool = f.broker.requireSession('fixture').workspaceReads;
  assert.equal(pool.entries.size, 1);
  assert.equal(pool.entries.get(f.channels[0]).idle, true);
  assert.equal(f.runtime.readScheduler.active, 0);
  if (scenario.method === 'readFile') {
    assert.equal(result.content, 'fixture');
    const start = f.calls.findIndex(item => item.method === 'open');
    assert.deepEqual(f.calls.slice(start - 2, start + 5).map(item => item.method), ['realpath','stat','open','read','close','stat','realpath']);
    const paths = scenario.path === '/actual.txt' ? ['/actual.txt'] : ['/link.txt', '/actual.txt'];
    assert.deepEqual(f.calls.slice(0, start - 2).map(item => item.value), paths.flatMap(value => [value, value]));
    assert.deepEqual(f.calls.slice(start + 5).map(item => item.value), paths.flatMap(value => [value, value]));
  } else {
    assert.equal(f.calls.some(item => ['open', 'read', 'close'].includes(item.method)), false);
    assert.equal(f.counters.downloaded, 0);
    if (scenario.path === '/link.txt') assert.equal(result.linkTargetType, 'file');
  }
});

test('桌面预览开启元数据流水线后仍拒绝正文读取期间的链接换目标', async t => {
  const f = await setupDesktop(t);
  f.files.set('/changed.txt', Buffer.from('changed'));
  f.fixture.afterClose = () => f.faults.realPaths.set('/link.txt', '/changed.txt');
  await assert.rejects(f.workspace.readFile('renderer:1', {...f.scope, path:'/link.txt'}), {code:'WORKSPACE_PATH_CHANGED'});
  assert.equal(f.counters.downloaded, 7);
  assert.equal(f.runtime.readScheduler.active, 0);
  assert.equal(f.broker.requireSession('fixture').workspaceReads.entries.size, 0);
  f.fixture.afterClose = null;
  assert.equal((await f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'})).content, 'fixture');
  assert.equal(f.channels.length, 2, '末次链接校验失败的通道不能复用');
});


test('同一窗口依次读取目录、属性和预览复用同一通道，正文句柄按次关闭', async t => {
  const f = await setupDesktop(t);
  const directory = await f.workspace.listDirectory('renderer:1', {...f.scope, path:'/', deferLinks:true});
  assert.ok(directory.entries.some(entry => entry.name === 'actual.txt'));
  assert.equal(f.channels.length, 1);
  const channel = f.channels[0];
  const info = await f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'});
  const preview = await f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'});
  assert.equal(info.type, 'file');
  assert.equal(preview.content, 'fixture');
  assert.equal(f.channels.length, 1);
  assert.ok(f.calls.every(call => call.channel === channel));
  assert.deepEqual(f.calls.filter(call => ['opendir', 'open', 'close'].includes(call.method)).map(call => call.method), ['opendir', 'close', 'open', 'close']);
  assert.equal(f.counts().schedulerPeak, 1, '属性与预览仍占用普通读取预算');
  assert.equal(f.broker.requireSession('fixture').workspaceReads.entries.get(channel).idle, true);
});

test('桌面预览仍受每插件两个读取名额限制，活动通道独占且第三次读取排队复用', async t => {
  const f = await setupDesktop(t), held = [];
  let holding = true;
  f.fixture.onResponse = response => {
    if (holding && response.method === 'lstat') held.push(response);
    else response.done(...response.results);
  };
  const release = () => { holding = false; for (const response of held.splice(0)) response.done(...response.results); };
  t.after(release);
  const readings = Array.from({length:3}, () => f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'}));
  for (const reading of readings) reading.catch(() => undefined);
  try {
    await until(() => held.length === 2 && f.runtime.readScheduler.queue.length === 1);
    const pool = f.broker.requireSession('fixture').workspaceReads;
    assert.equal(f.runtime.readScheduler.active, 2);
    assert.equal(f.runtime.readScheduler.activeCounts.get('fixture'), 2);
    assert.equal(f.channels.length, 2);
    assert.notEqual(held[0].channel, held[1].channel);
    assert.equal(pool.entries.size, 2);
    assert.ok([...pool.entries.values()].every(entry => !entry.idle));
    release();
    const results = await Promise.all(readings);
    assert.ok(results.every(result => result.content === 'fixture'));
    assert.equal(f.channels.length, 2, '排队请求借用已归还通道，不建立第三个通道');
    assert.equal(f.counts().schedulerPeak, 2);
    assert.equal(f.runtime.readScheduler.active, 0);
    assert.equal(pool.entries.size, 1, '全部完成后仅保留一个空闲通道');
    assert.ok([...pool.entries.values()].every(entry => entry.idle));
  } finally { release(); await Promise.allSettled(readings); }
});

for (const scenario of [
  {pendingMethod:'read', nextMethod:'listDirectory'},
  {pendingMethod:'close', nextMethod:'fileInfo'},
]) test('正文 ' + scenario.pendingMethod + ' 回执到达前通道不能归还，' + scenario.nextMethod + ' 使用独立通道', async t => {
  const f = await setupDesktop(t);
  let held, delivered = false;
  f.fixture.onResponse = response => {
    if (response.method === scenario.pendingMethod) held = response;
    else response.done(...response.results);
  };
  const release = () => { if (held) { const response = held; held = null; response.done(...response.results); } };
  t.after(release);
  const reading = f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'}).then(value => { delivered = true; return value; });
  reading.catch(() => undefined);
  try {
    await until(() => Boolean(held));
    const channel = held.channel, pool = f.broker.requireSession('fixture').workspaceReads;
    assert.equal(delivered, false);
    assert.equal(pool.entries.get(channel).idle, false);
    const result = await f.workspace[scenario.nextMethod]('renderer:1', {...f.scope, path:scenario.nextMethod === 'fileInfo' ? '/actual.txt' : '/', deferLinks:true});
    if (scenario.nextMethod === 'fileInfo') assert.equal(result.type, 'file');
    else assert.ok(result.entries.some(entry => entry.name === 'actual.txt'));
    assert.equal(f.channels.length, 2);
    assert.equal(pool.entries.get(channel).idle, false);
    release();
    assert.equal((await reading).content, 'fixture');
    assert.equal(pool.entries.get(channel).idle, true);
  } finally { release(); await reading.catch(() => undefined); }
});

for (const method of ['read', 'close']) test('桌面预览 ' + method + ' 失败后废弃通道，后续属性读取重新建立', async t => {
  const f = await setupDesktop(t);
  f.fixture.onResponse = response => response.method === method
    ? response.done(Object.assign(new Error('合成正文读取失败'), {code:3}))
    : response.done(...response.results);
  await assert.rejects(f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'}), {code:'SOURCE_ACCESS_DENIED'});
  const pool = f.broker.requireSession('fixture').workspaceReads;
  assert.equal(pool.entries.size, 0);
  assert.equal(f.broker.status('fixture').connected, true);
  f.fixture.onResponse = null;
  assert.equal((await f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'})).type, 'file');
  assert.equal(f.channels.length, 2);
  assert.notEqual(f.channels[0], f.channels[1]);
});

for (const late of ['success', 'failure']) test('桌面属性取消后的迟到 ' + late + ' 回执不能归还旧通道', async t => {
  const f = await setupDesktop(t), controller = new AbortController(), held = [];
  const readSession = f.runtime.withRemoteReadSession.bind(f.runtime);
  f.runtime.withRemoteReadSession = (plugin, operation, options) => readSession(plugin, operation, {...options, signal:controller.signal});
  f.fixture.onResponse = response => held.push(response);
  let delivered = false;
  const reading = f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'}).then(value => { delivered = true; return value; });
  reading.catch(() => undefined);
  const release = () => { f.fixture.onResponse = null; for (const response of held.splice(0)) response.done(...response.results); };
  t.after(release);
  try {
    await until(() => held.length === 2);
    const pool = f.broker.requireSession('fixture').workspaceReads, channel = f.channels[0];
    controller.abort();
    await assert.rejects(reading, {code:'TRANSFER_CANCELLED'});
    assert.equal(pool.entries.size, 0);
    if (late === 'failure') for (const response of held) response.results = [Object.assign(new Error('合成迟到失败'), {code:3})];
    release();
    f.runtime.withRemoteReadSession = readSession;
    assert.equal((await f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'})).type, 'file');
    assert.equal(delivered, false);
    assert.equal(pool.entries.has(channel), false);
    assert.equal(f.channels.length, 2);
    assert.equal(f.broker.status('fixture').connected, true);
  } finally { release(); await reading.catch(() => undefined); }
});

for (const active of [false, true]) test('桌面读取在' + (active ? '在途' : '空闲') + '状态断连重连后不能借用旧池', async t => {
  const f = await setupDesktop(t), held = [];
  await f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'});
  const session = f.broker.requireSession('fixture'), oldPool = session.workspaceReads, oldChannel = f.channels[0];
  let reading;
  const release = () => { f.fixture.onResponse = null; for (const response of held.splice(0)) response.done(...response.results); };
  t.after(release);
  try {
    if (active) {
      f.fixture.onResponse = response => held.push(response);
      reading = f.workspace.fileInfo('renderer:1', {...f.scope, path:'/actual.txt'});
      reading.catch(() => undefined);
      await until(() => held.length === 2);
    }
    await f.broker.disconnect('fixture');
    assert.equal(oldPool.disposed, true);
    assert.equal(oldPool.entries.size, 0);
    assert.equal(oldPool.release(oldChannel), false);
    f.fixture.onResponse = null;
    await f.broker.connect('fixture', {password:'fixture-password'});
    f.observeClient(f.broker.requireSession('fixture').client);
    assert.notEqual(f.broker.status('fixture').generation, session.generation);
    assert.equal((await f.workspace.readFile('renderer:1', {...f.scope, path:'/actual.txt'})).content, 'fixture');
    const pool = f.broker.requireSession('fixture').workspaceReads;
    assert.notEqual(pool, oldPool);
    assert.equal(pool.entries.has(oldChannel), false);
    assert.equal(f.channels.length, 2);
    release();
    if (reading) await assert.rejects(reading, {code:'TRANSFER_INTERRUPTED'});
    assert.equal(oldPool.entries.size, 0);
  } finally { release(); await reading?.catch(() => undefined); }
});
