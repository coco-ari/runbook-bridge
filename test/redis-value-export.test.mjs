import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RedisEditConnection } from '../src/redis-edit-connection.mjs';
import { exportRedisValue } from '../src/redis-value-export.mjs';
import { redisProtocolFixture } from './fixtures/redis-workspace-server.mjs';

async function harness(t, { changed = false, disconnected = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'redis-export-'));
  const target = path.join(directory, 'value.txt');
  const raw = Buffer.from('中😀'.repeat(160000));
  let transaction = false;
  const fixture = await redisProtocolFixture((args, socket) => {
    if (args[0] === 'WATCH') return 'OK';
    if (args[0] === 'TYPE') return 'string';
    if (args[0] === 'STRLEN') return raw.length;
    if (args[0] === 'GETRANGE') {
      if (disconnected) { socket.destroy(); return; }
      return raw.subarray(Number(args[2]), Number(args[3]) + 1);
    }
    if (args[0] === 'MULTI') { transaction = true; return 'OK'; }
    if (args[0] === 'PTTL') return transaction ? 'QUEUED' : -1;
    if (args[0] === 'EXEC') return changed ? null : [-1];
    throw new Error('未登记测试命令');
  });
  const connection = new RedisEditConnection({ socket: { host: '127.0.0.1', port: fixture.port }, database: 0 });
  t.after(async () => { connection.close(); await fixture.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const run = (picker = async () => target, verify = async () => {}) => exportRedisValue(connection, { limits: { timeoutMs: 2000 } }, 'fixture:export', picker, () => {}, verify);
  return { run, raw, directory, target, fixture };
}

test('导出分块写入原始字节，跨块中文不损坏，事务仅校验不写 Redis', async t => {
  const h = await harness(t);
  const result = await h.run();
  assert.equal(result.saved, true);
  assert.equal(result.bytes, h.raw.length);
  assert.deepEqual(await fs.readFile(h.target), h.raw);
  assert.deepEqual(await fs.readdir(h.directory), ['value.txt']);
  assert.ok(h.fixture.calls.filter(args => args[0] === 'GETRANGE').every(args => Number(args[3]) - Number(args[2]) + 1 <= 256 * 1024));
  assert.ok(!h.fixture.calls.some(args => ['SET', 'UNLINK'].includes(args[0])));
});

test('等长并发修改与断线均丢弃临时文件，原目标保持不变', async t => {
  for (const options of [{ changed: true }, { disconnected: true }]) {
    const h = await harness(t, options);
    await fs.writeFile(h.target, 'existing');
    await assert.rejects(h.run());
    assert.equal(await fs.readFile(h.target, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(h.directory), ['value.txt']);
  }
});

test('取消导出不读取远端，目标在导出期间变化时拒绝覆盖', async t => {
  const cancelled = await harness(t);
  assert.deepEqual(await cancelled.run(async () => null), { saved: false });
  assert.equal(cancelled.fixture.calls.length, 0);
  const h = await harness(t);
  await fs.writeFile(h.target, 'old');
  await assert.rejects(h.run(undefined, async () => fs.writeFile(h.target, 'new')), { code: 'REDIS_EXPORT_TARGET_CHANGED' });
  assert.equal(await fs.readFile(h.target, 'utf8'), 'new');
  assert.deepEqual(await fs.readdir(h.directory), ['value.txt']);
});
