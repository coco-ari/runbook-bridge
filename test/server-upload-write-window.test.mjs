import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { writeUploadBlocks, UPLOAD_BLOCK_BYTES as BLOCK, UPLOAD_WINDOW_BLOCKS as LIMIT } from '../src/server-upload-transfer.mjs';

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
function fixture(blocks = 96, extra = 19) {
  const data = Buffer.alloc(blocks * BLOCK + extra, 0x61), pending = [], sent = [], reads = [];
  const destination = Buffer.alloc(data.length), scope = {};
  let time = 0, maximum = 0;
  const sftp = {write(handle, buffer, offset, length, position, callback) {
    const item = {handle, position, length, started:time, callback};
    buffer.copy(destination, position, offset, offset + length);
    sent.push(item); pending.push(item); maximum = Math.max(maximum, pending.length);
  }};
  const localHandle = {read:async (buffer, offset, length, position) => { reads.push({length, position}); return {bytesRead:data.copy(buffer, offset, position, position + length)}; }};
  const start = (options = {}) => writeUploadBlocks({sftp, handle:Buffer.from([1]), localHandle, size:data.length, writeScope:scope, now:() => time, ...options});
  const reply = (item, duration = 80, error) => {
    const index = pending.indexOf(item); assert.notEqual(index, -1); pending.splice(index, 1);
    time = Math.max(time, item.started + duration); item.callback(error);
  };
  const round = async (duration = 80, reverse = false) => {
    const current = [...pending]; if (reverse) current.reverse();
    for (const item of current) reply(item, duration);
    await flush();
  };
  const drain = async (duration = 80, reverse = false) => {
    for (let attempt = 0; attempt < blocks * 4 + 100; attempt += 1) {
      await flush(); if (!pending.length) return;
      await round(duration, reverse);
    }
    assert.fail('上传调度未在有限回执内收敛。');
  };
  return {data, destination, pending, sent, reads, scope, sftp, start, reply, round, drain, get maximum() { return maximum; }, get time() { return time; }};
}

test('快 ACK 从一个请求扩至上限，读取与连续检查点仍按一 MiB', async () => {
  const f = fixture(), checkpoints = [], progress = [];
  const transfer = f.start({onCheckpoint:value => checkpoints.push(value), onAcknowledged:value => progress.push(value)});
  await flush(); assert.equal(f.pending.length, 1);
  await f.round(); assert.equal(f.pending.length, 2);
  await f.round(); assert.equal(f.pending.length, 4);
  await f.drain(); const result = await transfer;
  assert.equal(f.maximum, LIMIT); assert.equal(result.bytes, f.data.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(f.data).digest('hex'));
  assert.deepEqual(f.destination, f.data);
  assert.deepEqual(checkpoints.map(value => value.bytes), [BLOCK * LIMIT, BLOCK * LIMIT * 2, BLOCK * LIMIT * 3, f.data.length]);
  assert.deepEqual(f.reads.map(value => value.length), [BLOCK * LIMIT, BLOCK * LIMIT, BLOCK * LIMIT, 19]);
  assert.equal(progress.at(-1), f.data.length);
});

test('稳定 350ms 高 RTT 仍可扩到32，不按 RTT 线性封顶', async () => {
  const f = fixture(); const transfer = f.start(); await f.drain(350);
  await transfer; assert.equal(f.maximum, LIMIT);
});

test('持续慢 ACK 超过两秒保持一个请求', async () => {
  const f = fixture(8, 0); const transfer = f.start(); await f.drain(2200);
  await transfer; assert.equal(f.maximum, 1);
});

test('实际 ACK 比基线明显变慢后缩窗，不靠旧 ACK 数量扩张', async () => {
  const f = fixture(32, 0); const transfer = f.start(); await flush(); await f.round(); await f.round();
  assert.equal(f.pending.length, 4);
  const old = [...f.pending];
  f.reply(old[0], 500); await flush(); assert.equal(f.pending.length, 3);
  f.reply(old[1], 500); await flush(); assert.equal(f.pending.length, 2);
  f.reply(old[2], 500); await flush(); assert.equal(f.pending.length, 1);
  f.reply(old[3], 500); await flush(); assert.equal(f.pending.length, 1);
  assert.equal(f.maximum, 4);
  // 旧窗口全部收尾后，新发出的无积压单请求才可重新测量稳定网络。
  await f.round(500); assert.equal(f.pending.length, 2);
  await f.drain(500); await transfer;
});

test('乱序回执只按完整批次发布检查点，哈希保持完整', async () => {
  const f = fixture(40, 7), checkpoints = [];
  const transfer = f.start({onCheckpoint:value => checkpoints.push(value)});
  await flush(); await f.round(); await f.round();
  const held = f.pending[0];
  for (let index = 0; index < 50; index += 1) {
    const current = f.pending.filter(item => item !== held);
    if (!current.length) break;
    for (const item of current.reverse()) f.reply(item, 80);
    await flush();
  }
  assert.equal(checkpoints.length, 0); assert.equal(f.reads.length, 1);
  f.reply(held, 80); await f.drain(80, true);
  const result = await transfer;
  assert.equal(result.sha256, crypto.createHash('sha256').update(f.data).digest('hex'));
  assert.deepEqual(f.destination, f.data); assert.equal(checkpoints.at(-1).bytes, f.data.length);
});

test('首个 WRITE 失败后不再发送或推进检查点', async () => {
  const f = fixture(8), checkpoints = [], progress = [], expected = new Error('合成失败');
  const transfer = f.start({onCheckpoint:value => checkpoints.push(value), onAcknowledged:value => progress.push(value)});
  const rejected = assert.rejects(transfer, error => error === expected);
  await flush(); assert.equal(f.pending.length, 1); f.reply(f.pending[0], 80, expected);
  await rejected; await flush(); assert.equal(f.sent.length, 1); assert.deepEqual(checkpoints, []); assert.deepEqual(progress, []);
});

test('取消后迟到成功与失败回执只收尾，不补发或更新进度', async () => {
  const f = fixture(64), stop = new AbortController(), progress = [], checkpoints = [];
  const transfer = f.start({signal:stop.signal, onAcknowledged:value => progress.push(value), onCheckpoint:value => checkpoints.push(value)});
  const rejected = assert.rejects(transfer, {name:'AbortError'});
  await flush(); await f.round(); const sent = f.sent.length, acknowledged = progress.length;
  stop.abort(); await rejected;
  const late = [...f.pending]; f.reply(late[0], 80); if (late[1]) f.reply(late[1], 80, new Error('合成断线'));
  await flush(); assert.equal(f.sent.length, sent); assert.equal(progress.length, acknowledged); assert.deepEqual(checkpoints, []);
});

test('恢复从原连续偏移继续，完整 SHA 与原文件一致', async () => {
  const f = fixture(65, 11), start = BLOCK * LIMIT;
  f.data.copy(f.destination, 0, 0, start);
  const transfer = f.start({start, hash:crypto.createHash('sha256').update(f.data.subarray(0, start))});
  await f.drain(); const result = await transfer;
  assert.equal(f.sent[0].position, start); assert.equal(result.bytes, f.data.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(f.data).digest('hex')); assert.deepEqual(f.destination, f.data);
});

test('暂停仅在整批检查点后生效，不截断已确认批次', async () => {
  const f = fixture(65), checkpoints = [], paused = Object.assign(new Error('合成暂停'), {code:'UPLOAD_PAUSED'});
  let requested = false;
  const transfer = f.start({onAcknowledged:() => { requested = true; }, onCheckpoint:value => checkpoints.push(value), checkPause:() => { if (requested) throw paused; }});
  const rejected = assert.rejects(transfer, error => error === paused);
  await f.drain(); await rejected;
  assert.equal(f.sent.length, LIMIT); assert.deepEqual(checkpoints.map(value => value.bytes), [BLOCK * LIMIT]); assert.equal(f.reads.length, 1);
});

test('同一 SSH 连接的两个 SFTP 上传共享32上限且都有进展', async () => {
  const f = fixture(96), first = Buffer.from([1]), second = Buffer.from([2]);
  const a = f.start({handle:first});
  const otherSftp = {write:f.sftp.write.bind(f.sftp)};
  const b = f.start({handle:second, sftp:otherSftp});
  await flush(); assert.equal(f.pending.length, 1);
  await f.round(); assert.ok(f.sent.some(item => item.handle === second));
  await f.drain(); await Promise.all([a, b]); assert.equal(f.maximum, LIMIT);
  assert.equal(f.sent.filter(item => item.handle === first).length, 97);
  assert.equal(f.sent.filter(item => item.handle === second).length, 97);
});

test('失败批次不会堵住共享连接上的另一个上传', async () => {
  const f = fixture(8, 0), expected = new Error('合成写失败'), second = Buffer.from([2]);
  const a = f.start(), rejected = assert.rejects(a, error => error === expected);
  const b = f.start({handle:second});
  await flush(); f.reply(f.pending[0], 80, expected); await rejected; await flush();
  assert.equal(f.pending[0].handle, second); await f.drain(); await b;
  assert.equal(f.sent.filter(item => item.handle !== second).length, 1);
});

test('连接空闲后的新上传重新从一个请求开始，文件内部不重置', async () => {
  const f = fixture(96, 0); const first = f.start(); await f.drain(); await first;
  assert.equal(f.maximum, LIMIT); const sent = f.sent.length;
  const second = f.start(); await flush(); assert.equal(f.pending.length, 1); assert.equal(f.sent.length, sent + 1);
  await f.drain(); await second;
});

test('批内失败后迟到回执不更新该批进度，其他批仍能收敛', async () => {
  const f = fixture(64, 0), progress = [], firstHandle = Buffer.from([1]), secondHandle = Buffer.from([2]);
  const expected = new Error('合成断线');
  const first = f.start({handle:firstHandle, onAcknowledged:bytes => progress.push(bytes)});
  const rejected = assert.rejects(first, error => error === expected);
  await flush(); await f.round(); await f.round();
  const late = [...f.pending], sent = f.sent.length, confirmed = progress.length;
  const second = f.start({handle:secondHandle}); await flush();
  f.reply(late[0], 80, expected); await rejected;
  for (const item of late.slice(1)) f.reply(item, 80);
  await f.drain(); await second;
  assert.equal(progress.length, confirmed);
  assert.equal(f.sent.filter(item => item.handle === firstHandle).length, sent);
});

test('同步 WRITE 失败也不补发该批下一块', async () => {
  const f = fixture(8, 0), expected = new Error('合成同步失败'); let writes = 0;
  const transfer = f.start({sftp:{write(...args) { writes += 1; args.at(-1)(writes === 2 ? expected : null); }}});
  await assert.rejects(transfer, error => error === expected); assert.equal(writes, 2);
});

test('预先取消不读取或发送任何文件块', async () => {
  const f = fixture(8), stop = new AbortController(); stop.abort();
  await assert.rejects(f.start({signal:stop.signal}), {name:'AbortError'});
  assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
});

test('单请求无积压时重新建立基线，稳定 RTT 变慢后可以恢复扩窗', async () => {
  const f = fixture(96, 0); const transfer = f.start();
  await flush(); await f.round(10); await f.round(10); assert.equal(f.pending.length, 4);
  await f.round(350); assert.equal(f.pending.length, 1);
  await f.round(350); assert.equal(f.pending.length, 2);
  await f.round(350); assert.equal(f.pending.length, 4);
  await f.drain(350); await transfer; assert.equal(f.maximum, LIMIT);
});


test('稳定回执的多批上传不因扩窗重复等待确认轮次', async () => {
  const f = fixture(128, 0); const transfer = f.start(); await f.drain(80);
  const result = await transfer;
  assert.equal(result.bytes, 4 * 1024 * 1024); assert.equal(f.maximum, LIMIT);
  // 首批最多六轮，后续三个完整批次各一轮；扩窗前的正常回执仍应推进额度。
  assert.ok(f.time <= 9 * 80, '稳定四 MiB 上传不应额外空等一轮确认');
});
