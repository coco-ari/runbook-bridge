import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSoftwareUpdateIdle, startSoftwareUpdateChecks } from '../src/software-update-lifecycle.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}
function idleWorkspace() {
  return {
    serverWorkspaceFiles:{exitSummary:() => ({active:0,resumable:0}),editor:{exitSummary:() => 0}},
    v2Service:{mysqlSql:{exitSummary:() => ({active:0})}},
    pluginEditSessionManager:{sessions:new Map()},
    mutationCoordinator:new WorkspaceMutationCoordinator(),
  };
}

test('安装更新前阻止传输、事务、草稿、配置编辑和云变更，不改变原任务',() => {
  assert.doesNotThrow(() => assertSoftwareUpdateIdle(idleWorkspace()));
  const mutations = [
    v2 => { v2.serverWorkspaceFiles.exitSummary = () => ({active:1,resumable:0}); },
    v2 => { v2.serverWorkspaceFiles.exitSummary = () => ({active:0,resumable:1}); },
    v2 => { v2.v2Service.mysqlSql.exitSummary = () => ({active:1}); },
    v2 => { v2.serverWorkspaceFiles.editor.exitSummary = () => 1; },
    v2 => { v2.pluginEditSessionManager.sessions.set('synthetic-session',{}); },
    v2 => { v2.mutationCoordinator.environmentActivity.set('synthetic/fixture',{readers:1,writers:0}); },
    v2 => { v2.mutationCoordinator.environmentActivity.set('synthetic/fixture',{readers:0,writers:1}); },
    v2 => { v2.mutationCoordinator.environmentFences.set('synthetic/fixture',{}); },
    v2 => { v2.mutationCoordinator.cloudProjects.add('synthetic'); },
    v2 => { v2.mutationCoordinator.projectsDeleting.add('synthetic'); },
  ];
  for (const mutate of mutations) {
    const v2 = idleWorkspace();
    mutate(v2);
    assert.throws(() => assertSoftwareUpdateIdle(v2),{code:'UPDATE_BUSY'});
    assert.throws(() => assertSoftwareUpdateIdle(v2),{code:'UPDATE_BUSY'},'拒绝安装不能终止或清理原任务');
  }
  assert.throws(() => assertSoftwareUpdateIdle(null),{code:'UPDATE_BUSY'});
  const faulty = idleWorkspace();
  faulty.serverWorkspaceFiles.exitSummary = () => { throw new Error('synthetic-private-state'); };
  assert.throws(() => assertSoftwareUpdateIdle(faulty),error => error.code === 'UPDATE_BUSY' && !error.message.includes('synthetic-private-state'));
});

test('自动检查启动立即执行，每十五分钟重试且只通知每个新版本一次',async t => {
  t.mock.timers.enable({apis:['setInterval']});
  let state = {phase:'idle',supported:true,availableVersion:null};
  let availableVersion = '2.1.0';
  const calls = [], notifications = [];
  const controller = startSoftwareUpdateChecks({invoke:async action => {
    calls.push(action);
    if (action === 'check') state = {...state,phase:'available',availableVersion};
    return state;
  }},{onAvailable:result => { notifications.push(result.availableVersion); }});
  t.after(() => controller.dispose());
  await flush();
  assert.deepEqual(calls,['status','check']);
  assert.deepEqual(notifications,['2.1.0']);
  t.mock.timers.tick(15 * 60_000 - 1); await flush();
  assert.equal(calls.length,2);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(calls,['status','check','status','check']);
  assert.deepEqual(notifications,['2.1.0']);
  availableVersion = '2.2.0';
  t.mock.timers.tick(15 * 60_000); await flush();
  assert.deepEqual(notifications,['2.1.0','2.2.0']);
});

test('自动检查仅处理允许的空闲阶段，下载和安装状态不重新检查',async () => {
  for (const phase of ['idle','current','error','no-source','source-required','unsupported','checking','available','downloading','downloaded','installing']) {
    const calls = [];
    const controller = startSoftwareUpdateChecks({invoke:async action => {
      calls.push(action);
      return {phase,supported:true,availableVersion:null};
    }});
    await controller.checkNow();
    controller.dispose();
    assert.deepEqual(calls,['idle','current','error','no-source','source-required','available'].includes(phase) ? ['status','check'] : ['status']);
  }
  const calls = [];
  const unsupported = startSoftwareUpdateChecks({invoke:async action => { calls.push(action); return {phase:'idle',supported:false}; }});
  await unsupported.checkNow(); unsupported.dispose();
  assert.deepEqual(calls,['status']);
});

test('自动检查与手动触发去重，退出期间不发起检查或晚到通知',async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const read = deferred(), check = deferred();
  const calls = [], notifications = [];
  const controller = startSoftwareUpdateChecks({invoke:action => {
    calls.push(action);
    return action === 'status' ? read.promise : check.promise;
  }},{intervalMs:1000,onAvailable:state => notifications.push(state.availableVersion)});
  await flush();
  const first = controller.checkNow(), second = controller.checkNow();
  assert.equal(first,second);
  t.mock.timers.tick(5000); await flush();
  assert.deepEqual(calls,['status']);
  read.resolve({phase:'idle',supported:true}); await flush();
  assert.deepEqual(calls,['status','check']);
  controller.dispose();
  check.resolve({phase:'available',supported:true,availableVersion:'2.1.0'}); await flush();
  t.mock.timers.tick(5000); await controller.checkNow();
  assert.deepEqual(calls,['status','check']);
  assert.deepEqual(notifications,[]);
  const stopped = startSoftwareUpdateChecks({invoke:() => assert.fail('同步停止后不能触发启动任务')});
  stopped.dispose(); await flush();
});

test('检查异常或通知异常不影响后续检查，通知失败也不重复弹出',async t => {
  t.mock.timers.enable({apis:['setInterval']});
  let fail = true, notices = 0;
  const calls = [];
  const controller = startSoftwareUpdateChecks({invoke:async action => {
    calls.push(action);
    if (fail) throw new Error('synthetic-offline');
    return {phase:'available',supported:true,availableVersion:'2.1.0'};
  }},{intervalMs:1000,onAvailable:() => { notices++; throw new Error('synthetic-notification-failed'); }});
  t.after(() => controller.dispose());
  await flush();
  fail = false;
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(calls,['status','status','check','status','check']);
  assert.equal(notices,1);
});
