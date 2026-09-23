import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

async function until(predicate) {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) await delay(10);
  assert.ok(predicate(), '正文校验请求应在观察期限内进入预期状态');
}

const failure = code => Object.assign(new Error('合成校验失败'), { code });

async function setup(t, { content = Buffer.from('prefix:fixture') } = {}) {
  const f = await createUploadFixture(t);
  f.files.set('/file.txt', content);
  f.faults.realPaths.set('/alias.txt', '/file.txt');
  await f.broker.connect('fixture', { password:'fixture-password' });
  const requests = [], responses = [], channels = [];
  const state = { hold:response => response.validation };
  const client = f.broker.requireSession('fixture').client, open = client.sftp;
  client.sftp = function(callback) {
    return open.call(this, (error, channel) => {
      if (channel) {
        const progress = { reads:0, readResponses:0, closed:false };
        channels.push(channel);
        for (const method of ['realpath', 'stat', 'open', 'read', 'close']) {
          const original = channel[method];
          channel[method] = function(...args) {
            const done = args.pop();
            const validation = progress.closed && ['stat', 'realpath'].includes(method);
            const request = { method, path:args[0], validation, ...progress };
            requests.push(request);
            if (method === 'read') progress.reads += 1;
            return original.call(this, ...args, (...results) => {
              let released = false;
              const response = { method, validation, results, released:false, release(...replacement) {
                if (released) return;
                released = true;
                response.released = true;
                if (method === 'read') progress.readResponses += 1;
                if (method === 'close') progress.closed = true;
                done(...(replacement.length ? replacement : results));
              } };
              responses.push(response);
              if (!state.hold(response)) response.release();
            });
          };
        }
      }
      callback(error, channel);
    });
  };
  const release = () => { state.hold = () => false; for (const response of responses) response.release(); };
  t.after(release);
  return { ...f, content, state, requests, responses, channels, release,
    pending:() => responses.filter(response => response.validation && !response.released),
    pool:() => f.broker.requireSession('fixture').workspaceReads,
    read:(sessionOptions = {}, options = {}, method = 'readRange', start = 0, limit = content.length) => f.broker.withRemoteReadSession('fixture', reader => reader[method]('/alias.txt', start, limit, options), { reuseWorkspace:true, pipelineReadValidation:true, ...sessionOptions }),
  };
}

for (const first of ['stat', 'realpath']) test('正文末次校验先返回 ' + first + ' 仍等待另一响应，完成后才交付与归还通道', async t => {
  const f = await setup(t, { content:Buffer.alloc(150_000, 0x61) });
  let settled = false;
  const method = first === 'stat' ? 'readBuffer' : 'readRange';
  const reading = f.read({}, { pipelineReadValidation:false }, method).finally(() => { settled = true; });
  reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    assert.deepEqual(f.requests.slice(0, 3).map(item => item.method), ['realpath', 'stat', 'open']);
    const validation = f.requests.filter(item => item.validation);
    assert.deepEqual(validation.map(item => [item.method, item.path]), [['stat', '/file.txt'], ['realpath', '/alias.txt']]);
    assert.ok(validation.every(item => item.closed && item.reads > 1 && item.readResponses === item.reads));
    assert.equal(f.pool().entries.get(f.channels[0]).idle, false);
    f.pending().find(item => item.method === first).release();
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.pool().entries.get(f.channels[0]).idle, false);
    f.pending()[0].release();
    const result = await reading;
    assert.equal(result.canonicalPath, '/file.txt');
    assert.deepEqual(result.content, method === 'readBuffer' ? f.content : f.content.toString());
    assert.equal(f.pool().entries.get(f.channels[0]).idle, true);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('正文前路径与属性仍串行，全部 READ 和 CLOSE 回执结束后才发末次校验', async t => {
  const f = await setup(t, { content:Buffer.alloc(150_000, 0x61) });
  f.state.hold = () => true;
  const reading = f.read(); reading.catch(() => undefined);
  try {
    await until(() => f.responses.length === 1);
    assert.deepEqual(f.requests.map(item => item.method), ['realpath']);
    f.responses[0].release();
    await until(() => f.responses.length === 2);
    assert.deepEqual(f.requests.map(item => item.method), ['realpath', 'stat']);
    f.responses[1].release();
    await until(() => f.responses.length === 3);
    f.responses[2].release();
    await until(() => f.responses.filter(item => item.method === 'read').length > 1);
    assert.equal(f.requests.some(item => item.method === 'close' || item.validation), false);
    f.state.hold = response => response.method !== 'read';
    for (const response of f.responses.filter(item => item.method === 'read')) response.release();
    await until(() => f.responses.some(item => item.method === 'close'));
    assert.equal(f.requests.some(item => item.validation), false);
    f.responses.find(item => item.method === 'close').release();
    await until(() => f.pending().length === 2);
    f.release();
    assert.equal((await reading).content.length, f.content.length);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const method of ['readRange', 'readBuffer']) test('默认 Agent ' + method + ' 保持串行，普通读取参数不能开启内部流水线', async t => {
  const f = await setup(t);
  const reading = f.broker.withRemoteReadSession('fixture', reader => reader[method]('/alias.txt', 0, f.content.length, { pipelineReadValidation:true }));
  reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 1);
    assert.deepEqual(f.requests.filter(item => item.validation).map(item => item.method), ['stat']);
    assert.equal(f.pool(), undefined);
    f.pending()[0].release();
    await until(() => f.pending().length === 1);
    assert.deepEqual(f.requests.filter(item => item.validation).map(item => item.method), ['stat', 'realpath']);
    f.pending()[0].release();
    assert.equal((await reading).canonicalPath, '/file.txt');
    assert.equal(f.pool(), undefined);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const code of [2, 3]) for (const first of ['stat', 'realpath']) test('末次 STAT 与 REALPATH 双失败，' + first + ' 先返回时保留属性错误 ' + code + ' 的优先级', async t => {
  const f = await setup(t);
  let settled = false;
  const reading = f.read().finally(() => { settled = true; }); reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    f.pending().find(item => item.method === first).release(failure(first === 'stat' ? code : 4));
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.pool().entries.get(f.channels[0]).idle, false);
    const last = f.pending()[0]; last.release(failure(last.method === 'stat' ? code : 4));
    await assert.rejects(reading, { code:code === 2 ? 'SOURCE_CHANGED' : 'SOURCE_ACCESS_DENIED' });
    assert.equal(f.pool().entries.size, 0);
    assert.equal(f.broker.status('fixture').connected, true);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const code of [2, 3]) test('末次属性正常时 REALPATH 失败 ' + code + ' 保留原有错误映射', async t => {
  const f = await setup(t);
  const reading = f.read(); reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    f.pending().find(item => item.method === 'realpath').release(failure(code));
    f.pending()[0].release();
    await assert.rejects(reading, { code:code === 2 ? 'SOURCE_NOT_FOUND' : 'SOURCE_ACCESS_DENIED' });
    assert.equal(f.pool().entries.size, 0);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const scenario of [
  { name:'大小缩小', change:stats => { stats.size -= 1; } },
  { name:'大小增长', change:stats => { stats.size += 1; } },
  { name:'修改时间变化', change:stats => { stats.mtime += 1; } },
  { name:'模式变化', change:stats => { stats.mode = 0o100600; } },
  { name:'类型变为目录', change:stats => { stats.mode = 0o40755; } },
  { name:'类型变为特殊文件', change:stats => { stats.mode = 0o10644; } },
  { name:'允许增长仍拒绝缩小', options:{allowGrowth:true}, change:stats => { stats.size -= 1; } },
  { name:'允许增长仍拒绝修改时间倒退', options:{allowGrowth:true}, change:stats => { stats.size += 1; stats.mtime -= 1; } },
]) test('末次' + scenario.name + ' 优先于 REALPATH 失败', async t => {
  const f = await setup(t);
  const reading = f.read({}, scenario.options); reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    const attributes = f.pending().find(item => item.method === 'stat');
    scenario.change(attributes.results[1]);
    f.pending().find(item => item.method === 'realpath').release(failure(3));
    attributes.release();
    await assert.rejects(reading, { code:'SOURCE_CHANGED' });
    assert.equal(f.pool().entries.size, 0);
  } finally { f.release(); await reading.catch(() => undefined); }
});

test('末次真实路径变化仍拒绝交付正文并废弃通道', async t => {
  const f = await setup(t);
  const reading = f.read(); reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    f.pending().find(item => item.method === 'realpath').release(null, '/changed.txt');
    f.pending()[0].release();
    await assert.rejects(reading, { code:'SOURCE_CHANGED' });
    assert.equal(f.pool().entries.size, 0);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const tail of [false, true]) test('末次并行校验保留 allowGrowth 与 tail=' + tail + ' 的初始读取边界', async t => {
  const f = await setup(t);
  const reading = f.read({}, {allowGrowth:true, tail}, 'readRange', 0, 7); reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    const attributes = f.pending().find(item => item.method === 'stat');
    attributes.results[1].size += 9;
    attributes.results[1].mtime += 1;
    f.release();
    const result = await reading;
    assert.equal(result.content, tail ? 'fixture' : 'prefix:');
    assert.equal(result.startByte, tail ? 7 : 0);
    assert.equal(result.endByte, tail ? 14 : 7);
    assert.equal(result.size, 14);
    assert.equal(result.mtime, 1);
    assert.equal(result.observedSize, 23);
    assert.equal(result.sourceGrew, true);
    assert.equal(result.truncated, !tail);
  } finally { f.release(); await reading.catch(() => undefined); }
});

for (const late of ['成功', '失败']) test('末次并行校验取消后的迟到' + late + ' 不能交付、再发请求或归还旧通道', async t => {
  const f = await setup(t), controller = new AbortController();
  let deliveries = 0;
  const reading = f.read({signal:controller.signal}).then(result => { deliveries += 1; return result; });
  reading.catch(() => undefined);
  try {
    await until(() => f.pending().length === 2);
    const channel = f.channels[0], count = f.requests.length;
    controller.abort();
    await assert.rejects(reading, { code:'TRANSFER_CANCELLED' });
    assert.equal(f.pool().entries.size, 0);
    assert.equal(f.broker.status('fixture').connected, true);
    for (const response of f.pending()) response.release(...(late === '失败' ? [failure(3)] : response.results));
    await delay(20);
    assert.equal(deliveries, 0);
    assert.equal(f.requests.length, count);
    assert.equal(f.pool().entries.has(channel), false);
    f.release();
    assert.equal((await f.read()).content, f.content.toString());
    assert.equal(f.channels.length, 2);
    assert.equal(f.pool().entries.has(channel), false);
  } finally { f.release(); await reading.catch(() => undefined); }
});
