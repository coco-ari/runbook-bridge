import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateCoordinator } from '../src/update-coordinator.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let now = 0, softwareChecks = 0;
  const calls = [], subscriptions = [], events = [];
  const session = {origin:'https://cloud.example.invalid',repoId:'remote-a',keys:{auth:'synthetic-session-token'}};
  const cloud = {
    queue:Promise.resolve(),state:{repositories:[{repositoryId:'repo-a',catalog:[]}],mappings:[]},
    sessions:new Map([['owner-a',new Map([['repo-a',session]])]]),
    session:() => session,
    invoke:async (owner,action,input) => {
      calls.push({owner,action,input});
      assert.ok(['status','check'].includes(action),'后台只能检查状态，不能执行同步');
      return {repositories:cloud.state.repositories.map(repo => ({...repo,unlocked:cloud.sessions.get(owner)?.has(repo.repositoryId)})),cloudProjects:[],projects:[],deletedCloudProjects:[],checkIntervalMinutes:5};
    },
  };
  const software = {state:{source:{repositoryId:'repo-a',origin:'https://cloud.example.invalid'},supported:true},platform:'win32',arch:'x64',invoke:async () => software.state};
  const notifications = {items:[],reconcile:async (items,current) => { if (current()) notifications.items = items; }};
  const coordinator = new UpdateCoordinator({cloud,software,notifications,checkSoftware:async () => { softwareChecks++; },now:() => now,
    broadcast:(channel,event) => events.push({channel,event}),subscribe:options => {
      const subscription = {options,disposed:false,connection:{dispose() { subscription.disposed = true; }}};
      subscriptions.push(subscription); return subscription.connection;
    }});
  t.after(() => coordinator.dispose());
  return {coordinator,cloud,software,notifications,calls,subscriptions,events,setTime:value => { now = value; },softwareChecks:() => softwareChecks};
}
test('仓库和软件订阅认证分离，来源切换立即取消旧订阅并丢弃迟到事件',async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(t);
  f.coordinator.activate('owner-a'); await f.coordinator.refresh();
  assert.equal(f.subscriptions.length,2);
  assert.equal(f.subscriptions[0].options.token,'synthetic-session-token');
  assert.equal(f.subscriptions[1].options.token,undefined);
  f.software.state.source = {repositoryId:'repo-b',origin:'https://other.example.invalid'};
  f.coordinator.schedule();
  assert.equal(f.subscriptions[1].disposed,true);
  f.subscriptions[1].options.onChange('late');
  assert.equal(f.softwareChecks(),0);
  await f.coordinator.refresh();
  assert.equal(f.subscriptions.at(-1).options.url,'https://other.example.invalid/api/v1/updates/win32/x64/events');
  f.subscriptions.at(-1).options.onChange(null); assert.equal(f.softwareChecks(),1);
  f.cloud.state = {repositories:[],mappings:[]}; f.cloud.sessions.get('owner-a').clear();
  f.coordinator.schedule(); assert.equal(f.subscriptions[0].disposed,true);
  f.subscriptions[0].options.onChange('late');
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,0);
});
test('主进程定时补查和网络恢复不依赖界面，重复信号合并且不自动写配置',async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(t);
  f.coordinator.activate('owner-a'); await f.coordinator.refresh();
  for (let index=0;index<10;index++) f.subscriptions[0].options.onChange('new');
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,1);
  await f.coordinator.refresh();
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,1);
  f.setTime(300_001); await f.coordinator.refresh();
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,2);
  f.coordinator.wake(); await f.coordinator.refresh();
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,3);
  assert.ok(f.events.some(({event}) => event.kind === 'cloud'));
});
test('窗口会话失效和退出会取消订阅，迟到状态不会复活提示或触发检查',async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(t);
  f.coordinator.activate('owner-a'); await f.coordinator.refresh();
  f.coordinator.closeOwner('owner-a');
  assert.ok(f.subscriptions.every(subscription => subscription.disposed));
  for (const subscription of f.subscriptions) subscription.options.onChange('late');
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,0);
  assert.equal(f.softwareChecks(),0);
  assert.deepEqual(f.notifications.items,[]);
  f.coordinator.dispose(); f.coordinator.activate('owner-a'); f.coordinator.wake();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.subscriptions.length,2);
});

test('慢检查期间再次更新会补查最新 head，提醒保存期间解绑也会作废结果',async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(t);
  const invoke = f.cloud.invoke;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  f.cloud.invoke = async (...args) => {
    const result = await invoke(...args);
    if (args[1] === 'check') await gate;
    return result;
  };
  f.coordinator.activate('owner-a'); await f.coordinator.refresh();
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,1);
  f.subscriptions[0].options.onChange('new-head-during-download');
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,1);
  finish(); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(f.calls.filter(call => call.action === 'check').length,2);
  let valid;
  f.notifications.reconcile = async (_items,isCurrent) => {
    assert.equal(isCurrent(),true);
    f.cloud.state = {repositories:[],mappings:[]};
    valid = isCurrent();
  };
  await f.coordinator.refresh();
  assert.equal(valid,false);
});
