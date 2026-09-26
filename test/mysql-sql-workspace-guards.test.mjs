import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { AppError } from '../src/errors.mjs';

const scope = {projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-server'};
function harness() {
  const handlers = new Map(), listeners = new Map(), checked = [], mutations = [];
  let active = true;
  const connectionManager = {
    on() {},
    requestConnectionIntent(payload) { mutations.push(['connection',payload]); return {snapshot:{phase:'disconnected'}}; },
    networkChanged() { mutations.push(['network']); return Promise.resolve(); },
  };
  registerV2Ipc({handle:(key,handler) => handlers.set(key,handler),on:(key,listener) => listeners.set(key,listener)}, {
    workspaceStore:{},connectionManager,contextManager:{},confirmationManager:{on() {}},pluginManager:{},mysqlRuntime:{},
    v2Service:{mysqlSql:{assertScopeIdle(value) {
      checked.push(value);
      if (active && value.projectId === scope.projectId && (!value.environmentId || value.environmentId === scope.environmentId))
        throw new AppError('MYSQL_SQL_TRANSACTION_ACTIVE','当前环境有活动事务，请返回 SQL 标签提交、回滚或关闭后再操作。');
    }}},
    pluginConfigurationService:{
      createPlugin(payload) { mutations.push(['create',payload]); return payload; },
      preparePluginUpdate(payload) { mutations.push(['prepare',payload]); return {before:payload,change:{kind:'none'}}; },
      commitPreparedPlugin(_prepared,payload) { mutations.push(['metadata',payload]); return payload; },
      withConfigurationMutation(_projectId,_environmentId,_pluginId,operation) { return operation({restoreOnFailure() {}}); },
    },
  });
  return {checked,mutations,listeners,invoke:(channel,payload) => handlers.get(channel)({},payload),setActive:value => {active = value;}};
}

test('主动断开插件和环境都先保护整个环境的 SQL 事务，包括跳板插件', async () => {
  const h = harness();
  for (const [channel,payload] of [
    ['v2:connection-intent',{...scope,intent:'disconnect'}],
    ['v2:plugin-disconnect',scope],
    ['v2:environment-disconnect',scope],
  ]) {
    const response = await h.invoke(channel,payload);
    assert.equal(response.ok,false);
    assert.equal(response.error.code,'MYSQL_SQL_TRANSACTION_ACTIVE');
  }
  assert.equal(h.mutations.length,0);
  assert.deepEqual(h.checked,Array.from({length:3},() => ({projectId:scope.projectId,environmentId:scope.environmentId})));
  h.setActive(false);
  assert.equal((await h.invoke('v2:plugin-disconnect',scope)).ok,true);
  assert.equal(h.mutations.length,1);
});

test('删除与配置更新在执行持久化或清理前拒绝活动 SQL 事务', async () => {
  const h = harness();
  for (const channel of ['v2:project-delete','v2:environment-delete','v2:environment-update','v2:plugin-delete','v2:plugin-create','v2:plugin-metadata-update','v2:plugin-agent-configuration-update','v2:plugin-connection-update','v2:plugin-update','v2:plugin-connection-edit-prepare']) {
    const response = await h.invoke(channel,{...scope,expectedRevision:1,patch:{displayName:'新名称'}});
    assert.equal(response.ok,false,channel);
    assert.equal(response.error.code,'MYSQL_SQL_TRANSACTION_ACTIVE',channel);
  }
  assert.equal(h.mutations.length,0);
  assert.deepEqual(h.checked[0],{projectId:scope.projectId});
  assert.ok(h.checked.slice(1).every(value => value.projectId === scope.projectId && value.environmentId === scope.environmentId && !Object.hasOwn(value,'pluginInstanceId')));
});

test('其他环境的操作、只发起连接和后台网络状态变化不受事务退出保护阻断', async () => {
  const h = harness();
  assert.equal((await h.invoke('v2:plugin-disconnect',{...scope,environmentId:'other-environment'})).ok,true);
  assert.equal((await h.invoke('v2:connection-intent',{...scope,intent:'connect'})).ok,true);
  h.listeners.get('v2:network-changed')();
  await Promise.resolve();
  assert.deepEqual(h.mutations.map(item => item[0]),['connection','connection','network']);
  assert.equal(h.checked.length,1);
});
