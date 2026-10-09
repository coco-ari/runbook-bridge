import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftwareUpdateShutdownGate } from '../src/software-update-shutdown.mjs';
import { toPublicError } from '../src/errors.mjs';

test('更新停机在任务完成前拒绝安装，并在关闭资源后启动安装器',async () => {
  const gate = new SoftwareUpdateShutdownGate();
  let finish;
  const active = gate.run(() => new Promise(resolve => { finish = resolve; }));
  const order = [];
  const driver = {verifyDownloaded:async () => order.push('verify'),quitAndInstall:() => order.push('install')};
  const options = {assertIdle:() => {},close:async () => {
    order.push('close');
    assert.equal(gate.allowQuit,false);
    await assert.rejects(gate.run(() => order.push('unexpected')),{code:'UPDATE_BUSY'});
  },onFailure:() => order.push('failure')};
  await assert.rejects(gate.install(driver,options),{code:'UPDATE_BUSY'});
  finish(); await active;
  await gate.install(driver,options);
  assert.deepEqual(order,['verify','close','install']);
  assert.equal(gate.allowQuit,true);
  await gate.run(() => assert.fail()).catch(error => assert.equal(toPublicError(error).code,'UPDATE_BUSY'));
});

test('摘要复核期间产生的新任务阻止安装，校验失败不进入停机',async () => {
  const gate = new SoftwareUpdateShutdownGate();
  let active,finish,closed = false;
  const driver = {verifyDownloaded:async () => { active = gate.run(() => new Promise(resolve => { finish = resolve; })); },quitAndInstall:() => assert.fail()};
  const options = {assertIdle:() => {},close:async () => { closed = true; },onFailure:() => assert.fail()};
  await assert.rejects(gate.install(driver,options),{code:'UPDATE_BUSY'});
  assert.equal(closed,false); assert.equal(gate.closing,false);
  finish(); await active;
  driver.verifyDownloaded = async () => { throw Object.assign(new Error(),{code:'UPDATE_INTEGRITY_FAILED'}); };
  await assert.rejects(gate.install(driver,options),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.equal(gate.closing,false);
});

test('关闭资源失败时禁止安装且不重新开放已关闭的服务',async () => {
  const gate = new SoftwareUpdateShutdownGate();
  let failed = false;
  await assert.rejects(gate.install({verifyDownloaded:async () => {},quitAndInstall:() => assert.fail()}, {
    assertIdle:() => {},close:async () => { throw new Error('private detail'); },onFailure:() => { failed = true; },
  }),{code:'UPDATE_INSTALL_FAILED'});
  assert.equal(failed,true);
  await assert.rejects(gate.run(() => assert.fail()),{code:'UPDATE_BUSY'});
});
