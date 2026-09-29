import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {EnvironmentConnectionManager} from '../src/environment-connection-manager.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes,no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
}

function plugin(id,type,environmentId = 'e1',transport = null) {
  return {
    projectId:'p1',environmentId,pluginInstanceId:id,pluginType:type,displayName:id,
    revision:1,configState:'ready',
    transport:transport ?? (type === 'server' ? {kind:'direct'} : {kind:'serverTunnel',serverPluginInstanceId:'server'}),
  };
}

function fixture(t,{extra = [],connect,getPlugin,disconnect} = {}) {
  const plugins = [plugin('server','server'),plugin('mysql','mysql'),plugin('redis','redis'),...extra];
  const calls = [];
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async (_projectId,environmentId) => plugins.filter(item => item.environmentId === environmentId),
    getPlugin:getPlugin ?? (async (_projectId,environmentId,id) => plugins.find(item => item.environmentId === environmentId && item.pluginInstanceId === id)),
    appendAudit:async () => {},
  };
  const manager = new EnvironmentConnectionManager(store,{
    connect:async (item,secrets,options) => {
      calls.push(item.pluginInstanceId);
      return connect ? connect(item,secrets,options) : {connectedAt:'fixture'};
    },
    disconnect:disconnect ?? (async () => {}),
    closeAll:async () => {},
  },{retryDelays:[1000],networkDebounceMs:0});
  t.after(() => manager.closeAll());
  return {manager,plugins,calls};
}

async function settleUntil(check) {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail('连接状态未按预期收敛');
}

test('旧连接后置检查失败不能覆盖新网络重连状态或清除重试计时器',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const postcheck = deferred();
  const entered = deferred();
  let first = true;
  const f = fixture(t,{getPlugin:async (_projectId,_environmentId,id) => {
    if (first) { first = false; entered.resolve(); return postcheck.promise; }
    return f.plugins.find(item => item.pluginInstanceId === id);
  }});
  const connecting = f.manager.connect('p1','e1');
  await entered.promise;
  await f.manager.networkChanged('fixture-network-change');
  assert.equal(f.manager.snapshot('p1','e1').reconnect.phase,'waiting');
  postcheck.reject(Object.assign(new Error('模拟旧后置检查失败'),{code:'FIXTURE_POSTCHECK_FAILED'}));
  await connecting;
  await settleUntil(() => f.manager.activeConnectionOperations('p1','e1').length === 0);
  const waiting = f.manager.snapshot('p1','e1');
  assert.equal(waiting.desiredConnected,true);
  assert.equal(waiting.reconnect.phase,'waiting');
  assert.equal(f.manager.retryTimers.size,1);
  for (const item of Object.values(waiting.plugins)) assert.equal(item.phase,'reconnecting');
  t.mock.timers.tick(1000);
  await settleUntil(() => f.manager.snapshot('p1','e1').phase === 'connected' && !f.manager.snapshot('p1','e1').reconnect);
  assert.equal(f.manager.activeConnectionOperations('p1','e1').length,0);
});

test('网络变化中止未完成的服务器握手后仍按依赖自动重连',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const handshake = deferred();
  let signal;
  let first = true;
  const f = fixture(t,{connect:async (item,_secrets,options) => {
    if (first && item.pluginInstanceId === 'server') {
      first = false;
      signal = options.signal;
      return handshake.promise;
    }
    return {connectedAt:'fixture'};
  }});
  const connecting = f.manager.connect('p1','e1');
  await settleUntil(() => signal);
  await f.manager.networkChanged('fixture-network-change');
  await connecting;
  await settleUntil(() => f.manager.activeConnectionOperations('p1','e1').length === 0);
  assert.equal(signal.aborted,true);
  assert.equal(f.manager.snapshot('p1','e1').desiredConnected,true);
  assert.equal(f.manager.snapshot('p1','e1').reconnect.phase,'waiting');
  t.mock.timers.tick(1000);
  await settleUntil(() => f.manager.snapshot('p1','e1').phase === 'connected');
  handshake.resolve({connectedAt:'late-fixture'});
  await nextTurn();
  assert.deepEqual(f.calls,['server','server','mysql','redis']);
  assert.equal(f.manager.snapshot('p1','e1').phase,'connected');
});

test('服务器掉线立即阻止下游旧连接，慢清理不覆盖无关连接，迟到结果不影响恢复',async t => {
  for (const lateFailure of [false,true]) {
    await t.test(lateFailure ? '迟到失败' : '迟到成功',async child => {
      child.mock.timers.enable({apis:['setTimeout']});
      const database = deferred();
      const independent = deferred();
      const cleanup = deferred();
      const cleanupEntered = deferred();
      const signals = new Map();
      let recovering = false;
      const f = fixture(child,{
        extra:[plugin('independent','mysql','e1',{kind:'direct'}),plugin('other','redis','e2',{kind:'direct'})],
        connect:async (item,_secrets,{signal}) => {
          signals.set(item.pluginInstanceId,signal);
          if (item.pluginInstanceId === 'independent') return independent.promise;
          if (!recovering && ['mysql','redis'].includes(item.pluginInstanceId)) return database.promise;
          return {connectedAt:'fixture'};
        },
        disconnect:async (_item,reason) => {
          if (reason === 'provider-lost') { cleanupEntered.resolve(); await cleanup.promise; }
        },
      });
      await f.manager.connect('p1','e2');
      const connecting = f.manager.connect('p1','e1');
      await settleUntil(() => signals.has('mysql') && signals.has('redis'));
      const oldSignals = ['mysql','redis'].map(id => signals.get(id));
      const lost = f.manager.pluginLost('p1','e1','server');
      await cleanupEntered.promise;
      try {
        const state = f.manager.snapshot('p1','e1');
        assert.equal(state.plugins.server.phase,'error');
        for (const id of ['mysql','redis']) assert.equal(state.plugins[id].phase,'blocked');
        assert.ok(oldSignals.every(signal => signal.aborted));
        assert.equal(signals.get('independent').aborted,false);
        assert.equal(signals.get('other').aborted,false);
        independent.resolve({connectedAt:'independent-fixture'});
        await settleUntil(() => f.manager.snapshot('p1','e1').plugins.independent.phase === 'connected');
      } finally { cleanup.resolve(); }
      await lost;
      await connecting;
      await settleUntil(() => f.manager.activeConnectionOperations('p1','e1').length === 0);
      assert.equal(f.manager.snapshot('p1','e1').plugins.independent.phase,'connected');
      recovering = true;
      child.mock.timers.tick(1000);
      await settleUntil(() => f.manager.snapshot('p1','e1').phase === 'connected');
      if (lateFailure) database.reject(new Error('模拟旧隧道失败'));
      else database.resolve({connectedAt:'late-fixture'});
      await nextTurn();
      for (const item of Object.values(f.manager.snapshot('p1','e1').plugins)) assert.equal(item.phase,'connected');
      assert.equal(f.manager.snapshot('p1','e2').plugins.other.phase,'connected');
      assert.equal(f.calls.filter(id => id === 'independent').length,1);
      assert.equal(f.calls.filter(id => id === 'other').length,1);
    });
  }
});

test('网络重连后的手动断开优先于迟到取消，且保持下游手动断开状态',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const postcheck = deferred();
  const entered = deferred();
  const f = fixture(t,{getPlugin:async () => { entered.resolve(); return postcheck.promise; }});
  const connecting = f.manager.connect('p1','e1');
  await entered.promise;
  await f.manager.networkChanged('fixture-network-change');
  await f.manager.disconnectPlugin('p1','e1','server');
  postcheck.reject(new Error('模拟迟到检查失败'));
  await connecting;
  await settleUntil(() => f.manager.activeConnectionOperations('p1','e1').length === 0);
  for (const item of Object.values(f.manager.snapshot('p1','e1').plugins)) {
    assert.equal(item.phase,'disconnected');
    assert.equal(item.reason,'USER_DISCONNECTED');
  }
  t.mock.timers.tick(2000);
  await nextTurn();
  assert.deepEqual(f.calls,['server']);
  assert.equal(f.manager.retryTimers.size,0);
});


test('服务器掉线与自动恢复保留用户手动断开的下游插件',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(t);
  await f.manager.connect('p1','e1');
  await f.manager.disconnectPlugin('p1','e1','mysql');
  await f.manager.pluginLost('p1','e1','server');
  const blocked = f.manager.snapshot('p1','e1');
  assert.equal(blocked.plugins.mysql.phase,'disconnected');
  assert.equal(blocked.plugins.mysql.reason,'USER_DISCONNECTED');
  assert.equal(blocked.plugins.redis.phase,'blocked');
  t.mock.timers.tick(1000);
  await settleUntil(() => f.manager.snapshot('p1','e1').plugins.redis.phase === 'connected');
  assert.equal(f.manager.snapshot('p1','e1').plugins.mysql.phase,'disconnected');
  assert.equal(f.calls.filter(id => id === 'mysql').length,1);
  assert.equal(f.calls.filter(id => id === 'redis').length,2);
});

test('取消后迟到的成功后置检查会结束旧任务，不能清除新重连计划',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const postcheck = deferred();
  const entered = deferred();
  let first = true;
  const f = fixture(t,{getPlugin:async (_projectId,_environmentId,id) => {
    if (first) { first = false; entered.resolve(); return postcheck.promise; }
    return f.plugins.find(item => item.pluginInstanceId === id);
  }});
  const connecting = f.manager.connect('p1','e1');
  await entered.promise;
  const [old] = f.manager.connectionOperations.values();
  await f.manager.networkChanged('fixture-network-change');
  postcheck.resolve(f.plugins[0]);
  await connecting;
  await old.promise;
  assert.equal(old.status,'cancelled');
  assert.equal(f.manager.snapshot('p1','e1').reconnect.phase,'waiting');
  t.mock.timers.tick(1000);
  await settleUntil(() => f.manager.snapshot('p1','e1').phase === 'connected');
});
