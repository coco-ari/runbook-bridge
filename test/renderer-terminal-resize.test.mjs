import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalResizeScheduler } from '../renderer/v2/src/features/server-workspace/terminal-resize.ts';
const size = (cols, sessionId = 'first') => ({ sessionId, cols, rows: 30 });
const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

test('持续拖动期间定期同步最新尺寸，不必等待所有尺寸事件结束', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], scheduler = createTerminalResizeScheduler(async value => { sent.push(value); return true; });
  t.after(() => scheduler.dispose());
  for (let index = 0; index < 4; index += 1) { scheduler.update(size(100 - index)); t.mock.timers.tick(20); }
  await settle(); assert.deepEqual(sent, [size(97)]);
  scheduler.update(size(96)); t.mock.timers.tick(80); await settle(); assert.deepEqual(sent, [size(97), size(96)]);
  scheduler.update(size(96)); t.mock.timers.tick(1000); await settle(); assert.equal(sent.length, 2);
});

test('远端慢响应时串行发送，跳过已过时的中间尺寸', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = []; let finish;
  const scheduler = createTerminalResizeScheduler(value => { sent.push(value); return new Promise(resolve => { finish = resolve; }); });
  t.after(() => scheduler.dispose());
  scheduler.update(size(100)); t.mock.timers.tick(80); assert.equal(sent.length, 1);
  scheduler.update(size(90)); scheduler.update(size(80)); t.mock.timers.tick(1000); assert.equal(sent.length, 1);
  finish(true); await settle(); t.mock.timers.tick(80); assert.deepEqual(sent, [size(100), size(80)]);
  finish(true); await settle();
});

test('会话切换取消旧排队，迟到响应不能吞掉新会话的相同尺寸', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = []; let finish;
  const scheduler = createTerminalResizeScheduler(value => { sent.push(value); return new Promise(resolve => { finish = resolve; }); });
  t.after(() => scheduler.dispose());
  scheduler.update(size(100)); scheduler.reset(); t.mock.timers.tick(1000); assert.equal(sent.length, 0);
  scheduler.update(size(90)); t.mock.timers.tick(80); scheduler.reset(); scheduler.update(size(90, 'second'));
  finish(true); await settle(); t.mock.timers.tick(80); assert.deepEqual(sent, [size(90), size(90, 'second')]);
  finish(true); await settle();
});

test('失败不会被当作同步成功，也不会自动无限重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const scheduler = createTerminalResizeScheduler(async () => { attempts += 1; if (attempts === 1) throw Error('合成失败'); return attempts > 2; });
  t.after(() => scheduler.dispose());
  scheduler.update(size(100)); t.mock.timers.tick(80); await settle(); t.mock.timers.tick(1000); assert.equal(attempts, 1);
  scheduler.update(size(100)); t.mock.timers.tick(80); await settle(); assert.equal(attempts, 2);
  scheduler.update(size(100)); t.mock.timers.tick(80); await settle(); assert.equal(attempts, 3);
  scheduler.update(size(100)); t.mock.timers.tick(1000); await settle(); assert.equal(attempts, 3);
});

test('卸载后不再发送尺寸，排队或在途完成均不复活调度器', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = []; let finish;
  const pending = createTerminalResizeScheduler(async value => { sent.push(value); return true; });
  pending.update(size(100)); pending.dispose(); t.mock.timers.tick(1000); assert.equal(sent.length, 0);
  const active = createTerminalResizeScheduler(value => { sent.push(value); return new Promise(resolve => { finish = resolve; }); });
  active.update(size(90)); t.mock.timers.tick(80); active.update(size(80)); active.dispose(); finish(true); await settle();
  active.update(size(70)); t.mock.timers.tick(1000); await settle(); assert.deepEqual(sent, [size(90)]);
});
