import test from 'node:test';
import assert from 'node:assert/strict';
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
