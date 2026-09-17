import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransferExitGuard } from '../src/desktop-transfer-exit-guard.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const event = () => ({prevented:false, preventDefault() { this.prevented = true; }});

test('没有未结束传输时直接退出，不出现确认', () => {
  const guard = createTransferExitGuard({summary:() => ({active:0,resumable:0}), confirm:() => assert.fail('无需确认'), quit:() => assert.fail('直接交给原退出流程')});
  const e = event();
  assert.equal(guard.allow(e), true);
  assert.equal(e.prevented, false);
});

test('关闭窗口和应用退出共用确认，取消保留任务，批准后只触发一次退出', async () => {
  const summary = {active:2, resumable:1};
  const received = [];
  let answer;
  let quits = 0;
  const guard = createTransferExitGuard({summary:() => summary, confirm:counts => { received.push({...counts}); return new Promise(resolve => { answer=resolve; }); }, quit:() => { quits += 1; }});
  const first = event(), duplicate = event();
  assert.equal(guard.allow(first), false);
  assert.equal(guard.allow(duplicate), false);
  assert.ok(first.prevented && duplicate.prevented);
  await flush();
  assert.deepEqual(received, [summary]);
  answer(false); await flush();
  assert.equal(quits, 0);
  assert.equal(guard.allow(event()), false);
  await flush(); answer(true); await flush();
  assert.equal(quits, 1);
  assert.equal(guard.allow(event()), true);
  assert.equal(received.length, 2);
});

test('只有暂停任务也提示；对话框失败后保留窗口且下次仍可退出', async () => {
  let attempts=0, quits=0;
  const guard=createTransferExitGuard({summary:() => ({active:0,resumable:1}), confirm:async () => { if (!attempts++) throw new Error('模拟对话框失败'); return true; }, quit:() => { quits++; }});
  assert.equal(guard.allow(event()), false);
  await flush(); assert.equal(quits,0);
  assert.equal(guard.allow(event()), false);
  await flush(); assert.equal(quits,1);
});

test('退出确认期间任务完成不会打开第二个对话框', async () => {
  let active=1, answer, calls=0;
  const guard=createTransferExitGuard({summary:() => ({active,resumable:0}), confirm:() => { calls++; return new Promise(resolve => {answer=resolve;}); }, quit:() => assert.fail('用户取消退出')});
  guard.allow(event()); await flush();
  active=0;
  assert.equal(guard.allow(event()),false);
  assert.equal(calls,1);
  answer(false); await flush();
  assert.equal(guard.allow(event()),true);
});
