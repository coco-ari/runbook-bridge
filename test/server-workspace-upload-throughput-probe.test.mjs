import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';
import { abortable, sftpCall, writeUploadBlocks, UPLOAD_BLOCK_BYTES, UPLOAD_WINDOW_BLOCKS } from '../src/server-upload-transfer.mjs';

test('真实 SSH 上传协议对比：有界分块、回执延迟、连续检查点及断线收敛', { timeout: 90000 }, async t => {
  for (const latency of [0, 80]) await t.test('写入回执延迟 ' + latency + ' ms', async child => {
    const bytes = 4 * 1024 * 1024 + 13;
    const fixture = await createUploadFixture(child, { writeDelayMs: latency, capacity: bytes });
    const data = crypto.randomBytes(bytes);
    const source = path.join(fixture.root, 'throughput.bin');
    await fsp.writeFile(source, data);
    const { sftp } = await fixture.connect();
    const before = performance.now();
    await abortable(pipeline(fs.createReadStream(source, {highWaterMark:64*1024}), sftp.createWriteStream('/stream.bin', {flags:'wx',highWaterMark:512*1024})), sftp.probeSignal);
    const streamMs = performance.now() - before;
    const localHandle = await fsp.open(source, 'r');
    const handle = await sftpCall(sftp, 'open', '/blocks.bin', 'wx');
    const checkpoints = [];
    fixture.counters.maxPendingWrites = 0;
    const started = performance.now();
    try {
      await writeUploadBlocks({sftp,handle,localHandle,size:bytes,signal:sftp.probeSignal,onCheckpoint: value => checkpoints.push(value)});
    } finally { await localHandle.close(); await sftpCall(sftp, 'close', handle); }
    const blocksMs = performance.now() - started;
    assert.deepEqual(fixture.files.get('/stream.bin'), data);
    assert.deepEqual(fixture.files.get('/blocks.bin'), data);
    assert.equal(checkpoints.at(-1).sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.ok(fixture.counters.maxPendingWrites <= UPLOAD_WINDOW_BLOCKS);
    assert.ok(checkpoints.every((item,index) => item.bytes === Math.min(bytes, (index+1)*UPLOAD_BLOCK_BYTES*UPLOAD_WINDOW_BLOCKS)));
    child.diagnostic(JSON.stringify({bytes,writeAckDelayMs:latency,streamMs:Math.round(streamMs),blocksMs:Math.round(blocksMs),ratio:Number((streamMs/blocksMs).toFixed(2)),maxPendingWrites:fixture.counters.maxPendingWrites}));
  });
  await t.test('未回执的后续块不会推进检查点', async child => {
    const bytes = 3 * 1024 * 1024 + 13;
    const fixture = await createUploadFixture(child, {capacity:bytes});
    const data = crypto.randomBytes(bytes);
    const source = path.join(fixture.root, 'interrupted.bin');
    await fsp.writeFile(source, data);
    const connection = await fixture.connect();
    fixture.faults.dropAfter = 1536 * 1024;
    const localHandle = await fsp.open(source, 'r');
    const handle = await sftpCall(connection.sftp, 'open', '/partial.bin', 'wx');
    const checkpoints = [];
    try {
      await assert.rejects(writeUploadBlocks({sftp:connection.sftp,handle,localHandle,size:bytes,signal:connection.sftp.probeSignal,onCheckpoint: value => checkpoints.push(value)}));
    } finally { await localHandle.close(); }
    assert.equal(checkpoints.at(-1).bytes, 1024 * 1024);
    assert.ok(fixture.files.get('/partial.bin').length > checkpoints.at(-1).bytes);
    const resumed = await fixture.connect();
    const resumedLocal = await fsp.open(source, 'r');
    const resumedHandle = await sftpCall(resumed.sftp, 'open', '/partial.bin', 'r+');
    const offset = checkpoints.at(-1).bytes;
    const hash = crypto.createHash('sha256').update(data.subarray(0, offset));
    const writeCount = fixture.counters.writes.length;
    try {
      await writeUploadBlocks({sftp:resumed.sftp,handle:resumedHandle,localHandle:resumedLocal,size:bytes,start:offset,hash,signal:resumed.sftp.probeSignal});
    } finally { await resumedLocal.close(); await sftpCall(resumed.sftp,'close',resumedHandle); }
    assert.equal(fixture.counters.writes[writeCount].offset, offset);
    assert.deepEqual(fixture.files.get('/partial.bin'), data);
  });
});
