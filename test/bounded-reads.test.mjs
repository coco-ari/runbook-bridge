import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedReadCache } from '../src/bounded-read-cache.mjs';
import { BoundedReadScheduler } from '../src/bounded-read-scheduler.mjs';

test('同一插件串行、不同插件可并行，内存不足的任务等待释放', async () => {
  const gate = new BoundedReadScheduler({ maxConcurrent:3, maxReservedBytes:10 });
  const active = new Set();
  let peak = 0;
  const run = (key, bytes) => gate.run(key, bytes, async () => {
    assert.equal(active.has(key), false);
    active.add(key);
    peak = Math.max(peak, active.size);
    assert.ok(gate.reservedBytes <= 10);
    await delay(10);
    active.delete(key);
  });
  await Promise.all([run('a',6), run('a',6), run('b',4), run('c',5)]);
  assert.equal(peak,2);
});

test('排队超时不执行远程操作，失败后释放资源', async () => {
  const gate = new BoundedReadScheduler({ queueTimeoutMs:10, maxConcurrent:1 });
  const first = gate.run('a',1,() => delay(40));
  let started = false;
  await assert.rejects(gate.run('a',1,() => { started = true; }), error => error.code === 'READ_BUSY' && error.details.phase === 'queue');
  await first;
  assert.equal(started,false);
  await assert.rejects(gate.run('a',1,() => { throw new Error('fixture'); }), /fixture/);
  assert.equal(await gate.run('b',1,() => 42),42);
});

test('缓存合并相同读取，隔离返回值并在过期、刷新和容量上限时重新读取', async () => {
  let now = 100;
  let reads = 0;
  const cache = new BoundedReadCache({ now:() => now, ttlMs:20, maxEntries:2, maxBytes:100 });
  const load = async () => { reads += 1; await delay(5); return { name:'fixture' }; };
  const [first,second] = await Promise.all([cache.read('a',load),cache.read('a',load)]);
  assert.equal(reads,1);
  first.value.name = 'changed';
  assert.equal(second.value.name,'fixture');
  assert.equal((await cache.read('a',load)).hit,true);
  now += 21;
  await cache.read('a',load);
  assert.equal(reads,2);
  await cache.read('a',load,{refresh:true});
  assert.equal(reads,3);
  await cache.read('b',load);
  await cache.read('c',load);
  assert.equal(cache.entries.size,2);
  assert.ok(cache.bytes <= 100);
  await cache.read('a',load);
  assert.equal(reads,6);
});

test('缓存清理期间完成的请求不会复活旧条目，读取失败不污染后续请求', async () => {
  const cache = new BoundedReadCache();
  const read = cache.read('a',async () => { await delay(10); return { value:1 }; });
  cache.clear();
  await read;
  assert.equal(cache.entries.size,0);
  await assert.rejects(cache.read('a',() => { throw new Error('fixture'); }),/fixture/);
  assert.equal((await cache.read('a',() => ({value:2}))).value.value,2);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('读取预先取消时不占用队列，取消原因正文不进入错误', async () => {
  const scheduler = new BoundedReadScheduler(), controller = new AbortController();
  controller.abort(new Error('fixture-private-reason'));
  await assert.rejects(scheduler.run('a', 1, () => assert.fail('不应执行'), { signal:controller.signal }), error => error.code === 'READ_CANCELLED' && !error.message.includes('fixture-private-reason'));
  assert.equal(scheduler.queue.length, 0); assert.equal(scheduler.active, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('反复取消排队读取释放队列容量和监听器，保留已占用的资源预算', async () => {
  const scheduler = new BoundedReadScheduler({ maxConcurrent:1, maxQueued:1, maxReservedBytes:4 });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const active = scheduler.run('a', 4, () => gate);
  try {
    for (let index = 0; index < 5; index++) {
      const controller = new AbortController();
      const waiting = scheduler.run('b', 4, () => assert.fail('已取消任务不应执行'), { signal:controller.signal });
      const rejected = assert.rejects(waiting, { code:'READ_CANCELLED' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
      controller.abort(); await rejected;
      assert.equal(scheduler.queue.length, 0); assert.equal(scheduler.reservedBytes, 4);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  } finally { release(); await active; }
  assert.equal(await scheduler.run('b', 4, () => 42), 42);
});

test('读取已出队但尚未调用操作时取消，不执行操作且归还预算', async () => {
  const scheduler = new BoundedReadScheduler(), controller = new AbortController();
  const pending = scheduler.run('a', 3, () => assert.fail('不应执行'), { signal:controller.signal });
  const rejected = assert.rejects(pending, { code:'READ_CANCELLED' });
  controller.abort(); await rejected; await flush();
  assert.equal(scheduler.active, 0); assert.equal(scheduler.reservedBytes, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('取消已运行操作不会提前释放并发或内存，等待真实操作完成后再启动后继', async () => {
  const scheduler = new BoundedReadScheduler({ maxConcurrent:1, maxReservedBytes:3 }), controller = new AbortController();
  let release, nextStarted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const active = scheduler.run('a', 3, () => gate, { signal:controller.signal });
  await flush(); controller.abort();
  const next = scheduler.run('b', 3, () => { nextStarted = true; });
  try {
    await flush(); assert.equal(nextStarted, false);
    assert.equal(scheduler.active, 1); assert.equal(scheduler.reservedBytes, 3);
  } finally { release(); await active; await next; }
  assert.equal(nextStarted, true);
});

test('排队超时后移除取消监听器，迟到取消不重复结束任务', async () => {
  const scheduler = new BoundedReadScheduler({ maxConcurrent:1, queueTimeoutMs:10 }), controller = new AbortController();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const active = scheduler.run('a', 1, () => gate);
  try {
    await assert.rejects(scheduler.run('b', 1, () => assert.fail('不应执行'), { signal:controller.signal }), { code:'READ_BUSY' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(); assert.equal(scheduler.queue.length, 0);
  } finally { release(); await active; }
});
