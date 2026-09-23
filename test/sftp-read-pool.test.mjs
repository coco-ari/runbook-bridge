import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SftpReadPool } from '../src/sftp-read-pool.mjs';

function harness(options = {}) {
  const client = new EventEmitter();
  const channels = [];
  const pending = [];
  client.sftp = callback => {
    if (options.deferOpen) { pending.push(callback); return; }
    const channel = makeChannel();
    channels.push(channel);
    callback(null, channel);
  };
  const pool = new SftpReadPool(client, { idleMs: 5000, ...options });
  const acquire = () => new Promise((resolve, reject) => pool.sftp((error, channel) => error ? reject(error) : resolve(channel)));
  return { client, channels, pending, pool, acquire };
}
function makeChannel() {
  const channel = new EventEmitter();
  channel.ended = 0;
  channel.end = () => {
    channel.ended += 1;
    queueMicrotask(() => { channel.emit('end'); channel.emit('close'); });
  };
  return channel;
}

test('成功归还的通道可重复独占租用，仍在使用的通道不会被共享', async t => {
  const h = harness(); t.after(() => h.pool.dispose());
  const first = await h.acquire();
  const second = await h.acquire();
  assert.notEqual(first, second);
  assert.equal(h.pool.release(first), true);
  assert.equal(await h.acquire(), first);
  assert.equal(h.channels.length, 2);
  assert.equal(first.ended, 0);
  assert.equal(h.pool.release(first), true);
  assert.equal(h.pool.release(first), false, '同一个租约不能重复归还');
});

test('空闲通道数量有界，保留最近归还的通道', async t => {
  const h = harness(); t.after(() => h.pool.dispose());
  const first = await h.acquire();
  const second = await h.acquire();
  h.pool.release(first); h.pool.release(second);
  assert.equal(first.ended, 1);
  assert.equal(second.ended, 0);
  assert.equal(h.pool.entries.size, 1);
  assert.equal(await h.acquire(), second);
});

test('空闲超时释放通道，正在租用的通道不受旧计时器影响', async t => {
  const h = harness({ idleMs: 20 }); t.after(() => h.pool.dispose());
  const first = await h.acquire();
  h.pool.release(first);
  assert.equal(await h.acquire(), first);
  await delay(40);
  assert.equal(first.ended, 0);
  h.pool.release(first);
  await delay(40);
  assert.equal(first.ended, 1);
  assert.equal(h.pool.entries.size, 0);
  assert.notEqual(await h.acquire(), first);
});

test('空闲错误或远端关闭后不再复用通道，也不会抛出未处理错误', async t => {
  const h = harness(); t.after(() => h.pool.dispose());
  const failed = await h.acquire();
  h.pool.release(failed);
  assert.doesNotThrow(() => failed.emit('error', new Error('模拟关闭')));
  assert.equal(h.pool.release(failed), false);
  const ended = await h.acquire();
  assert.notEqual(ended, failed);
  h.pool.release(ended);
  ended.emit('end');
  assert.notEqual(await h.acquire(), ended);
});

test('连接断开同时释放空闲与活动通道，旧池不能用于新连接', async () => {
  const h = harness();
  const active = await h.acquire();
  const idle = await h.acquire(); h.pool.release(idle);
  h.client.emit('close');
  assert.equal(active.ended, 1);
  assert.equal(idle.ended, 1);
  assert.equal(h.pool.entries.size, 0);
  assert.equal(h.pool.release(active), false);
  await assert.rejects(h.acquire(), { code: 'SFTP_UNAVAILABLE' });
  assert.equal(h.client.listenerCount('close'), 0);
  assert.equal(h.client.listenerCount('error'), 0);
});

test('取消连接后迟到的建池回调关闭通道，不复活资源', async () => {
  const h = harness({ deferOpen: true });
  const pending = h.acquire();
  const rejection = assert.rejects(pending, { code: 'SFTP_UNAVAILABLE' });
  h.pool.dispose();
  const late = makeChannel();
  h.pending.shift()(null, late);
  await rejection;
  assert.equal(late.ended, 1);
  assert.equal(h.pool.entries.size, 0);
});

test('通道创建失败不会污染池，后续请求可重新建立', async t => {
  const h = harness({ deferOpen: true }); t.after(() => h.pool.dispose());
  const first = h.acquire();
  const rejection = assert.rejects(first, { code: 'SFTP_UNAVAILABLE' });
  h.pending.shift()(Object.assign(new Error('模拟创建失败'), { code: 'SFTP_UNAVAILABLE' }));
  await rejection;
  const next = h.acquire();
  const channel = makeChannel();
  h.pending.shift()(null, channel);
  assert.equal(await next, channel);
  assert.equal(h.pool.release(channel), true);
});

test('反复复用不增加事件监听器，关闭后释放所有池监听器', async () => {
  const h = harness();
  const channel = await h.acquire();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(h.pool.release(channel), true);
    assert.equal(await h.acquire(), channel);
  }
  assert.equal(channel.listenerCount('error'), 1);
  assert.equal(channel.listenerCount('end'), 1);
  assert.equal(channel.listenerCount('close'), 1);
  h.pool.dispose();
  await delay(0);
  assert.equal(channel.listenerCount('error'), 0);
  assert.equal(channel.listenerCount('end'), 0);
  assert.equal(channel.listenerCount('close'), 0);
});

test('默认目录通道跨短暂停留复用，并在三十秒空闲后释放', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const h = harness({ idleMs:undefined }); t.after(() => h.pool.dispose());
  const first = await h.acquire(); h.pool.release(first);
  t.mock.timers.tick(8000);
  assert.equal(first.ended, 0, '查看目录后短暂停留不重新建立通道');
  assert.equal(await h.acquire(), first); h.pool.release(first);
  t.mock.timers.tick(29999); assert.equal(first.ended, 0);
  t.mock.timers.tick(1); assert.equal(first.ended, 1); assert.equal(h.pool.entries.size, 0);
  assert.notEqual(await h.acquire(), first);
});
