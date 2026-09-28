import assert from 'node:assert/strict';
import test from 'node:test';
import { activeTransferProgress, transferProgress } from '../renderer/v2/src/features/server-workspace/transfer-progress.ts';

const job = (status, bytes, transferred) => ({status, bytes, transferred});

test('单个活动任务的摘要与明细保持相同进度，不受完成记录影响', () => {
  for (const transferred of [0, 1, 333333, 999999, 1000000]) {
    const active = job('running', 1000000, transferred);
    assert.deepEqual(activeTransferProgress([job('completed', 9000000, 9000000), active]), transferProgress(active));
  }
});

test('多任务按字节加权，暂停、失败和取消记录不参与摘要', () => {
  const result = activeTransferProgress([job('running', 1000, 500), job('queued', 3000, 0), ...['completed', 'paused', 'interrupted', 'error', 'cancelled'].map(status => job(status, 10000, 10000))]);
  assert.equal(result.percent, 13);
  assert.equal(result.transferred, 500);
  assert.equal(result.bytes, 4000);
});

test('正在校验和暂停收尾仍参与当前进度，任务完成后摘要跟随剩余任务', () => {
  assert.equal(activeTransferProgress([job('verifying', 1000, 1000), job('pausing', 1000, 500)]).percent, 75);
  assert.equal(activeTransferProgress([job('completed', 1000, 1000), job('running', 1000, 500)]).percent, 50);
});

test('完成状态统一归一到完整字节数，空文件完成显示百分之百', () => {
  assert.deepEqual(transferProgress(job('completed', 100, 90)), {bytes:100, transferred:100, value:100, max:100, percent:100});
  assert.equal(transferProgress(job('completed', 0, 0)).percent, 100);
  assert.equal(transferProgress(job('queued', 0, 0)).percent, 0);
});

test('异常进度被限定到文件大小内，摘要与单项使用相同边界', () => {
  for (const active of [job('running', 100, 200), job('running', 100, -2), job('running', NaN, Infinity)]) {
    const detail = transferProgress(active);
    assert.ok(detail.percent >= 0 && detail.percent <= 100);
    assert.deepEqual(activeTransferProgress([active]), detail);
  }
  assert.equal(activeTransferProgress([]).percent, 0);
});
