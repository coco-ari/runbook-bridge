import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerUploadProgress, uploadTimeouts } from '../src/server-upload-progress.mjs';

test('上传速度从传输开始计算，等待确认时衰减，校验时不显示剩余时间', () => {
  let at = 1000;
  const meter = new ServerUploadProgress(() => at);
  meter.update(0, 'preparing');
  at += 60_000;
  meter.update(0, 'uploading');
  at += 1000;
  meter.update(1024, 'uploading');
  assert.deepEqual(meter.snapshot(1024, 4096), { phase: 'uploading', bytesPerSecond: 1024, etaSeconds: 3 });
  at += 5000;
  assert.deepEqual(meter.snapshot(1024, 4096), { phase: 'uploading', bytesPerSecond: 0, etaSeconds: null });
  at += 500;
  meter.update(2048, 'uploading');
  assert.ok(meter.snapshot(2048, 4096).bytesPerSecond > 0);
  meter.update(4096, 'verifying');
  assert.deepEqual(meter.snapshot(4096, 4096), { phase: 'verifying', bytesPerSecond: null, etaSeconds: null });
});

test('速度样本有界，空文件和时钟回退不产生无效估算', () => {
  let at = 1000;
  const meter = new ServerUploadProgress(() => at);
  meter.update(0, 'uploading');
  assert.equal(meter.snapshot(0, 0).etaSeconds, null);
  for (let i = 1; i <= 10000; i += 1) { at += 10; meter.update(i, 'uploading'); }
  assert.ok(meter.samples.length <= 32);
  at = 0;
  assert.equal(meter.snapshot(10000, 20000).bytesPerSecond, null);
});

test('大文件不再共用固定十分钟总时限，无进展时限独立且总时限有上界', () => {
  assert.equal(uploadTimeouts(0).timeoutMs, 600_000);
  assert.ok(uploadTimeouts(500 * 1024 * 1024).timeoutMs > 60 * 60_000);
  assert.equal(uploadTimeouts(500 * 1024 * 1024).inactivityMs, 90_000);
  assert.ok(uploadTimeouts(Number.MAX_SAFE_INTEGER).timeoutMs <= 12 * 60 * 60_000);
});
