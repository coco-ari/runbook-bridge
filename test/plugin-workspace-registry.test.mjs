import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceRegistry, reconcileWorkspaceSelection, disconnectWorkspaceScope, openWorkspaceSession,
} from '../renderer/v2/src/features/plugins/workspace-registry.ts';

const component = () => null;
const definition = (type, overrides = {}) => ({
  type, Component:component, sessionKey:plugin => plugin.pluginInstanceId, canOpen:() => true,
  retainAcrossSelection:false, retainOnDisconnect:'never', requiresConnection:true, maxSessions:1,
  focusTestId:'custom-back', returnFocusTestId:'custom-open', ...overrides,
});
const registry = createWorkspaceRegistry([
  definition('server', {retainAcrossSelection:true, retainOnDisconnect:'always', maxSessions:8}),
  definition('mysql', {retainOnDisconnect:'dirty'}), definition('redis'),
  definition('test-queue', {retainAcrossSelection:true}),
]);
function entry(type, overrides = {}) {
  const scope = {projectId:'test-project', environmentId:'test-env', pluginInstanceId:type};
  return {key:type, type, scope, plugin:{...scope, pluginType:type, revision:1},
    connected:true, dirty:false, connectionEpoch:0, runtime:null,
    projectName:'测试项目', environmentName:'测试环境', ...overrides};
}

test('第四种插件可以注册独立组件及自定义会话身份', () => {
  assert.equal(registry.get('test-queue').Component, component);
  assert.equal(registry.get('constructor'), undefined);
  assert.throws(() => createWorkspaceRegistry([definition('duplicate'), definition('duplicate')]));
  assert.throws(() => createWorkspaceRegistry([definition('invalid', {maxSessions:0})]));
  const queue = entry('test-queue');
  const state = {entries:[queue], activeKey:queue.key};
  assert.equal(reconcileWorkspaceSelection(state, null, registry), state);
});

test('选择变化保留服务器会话，并释放依赖当前选择的数据库和 Redis 会话', () => {
  const server = entry('server'), mysql = entry('mysql'), redis = entry('redis');
  const state = {entries:[server, mysql, redis], activeKey:mysql.key};
  assert.deepEqual(reconcileWorkspaceSelection(state, redis, registry), {entries:[server, redis], activeKey:null});
  assert.deepEqual(reconcileWorkspaceSelection(state, null, registry), {entries:[server], activeKey:null});
});

test('配置版本或完整作用域变化不能复用旧会话', () => {
  const mysql = entry('mysql');
  const state = {entries:[mysql], activeKey:mysql.key};
  for (const selected of [
    {...mysql, key:'mysql-v2', plugin:{...mysql.plugin, revision:2}},
    {...mysql, plugin:{...mysql.plugin, environmentId:'another-env'}},
    {...mysql, plugin:{...mysql.plugin, projectId:'another-project'}},
  ]) assert.deepEqual(reconcileWorkspaceSelection(state, selected, registry), {entries:[], activeKey:null});
});

test('快速断重连不会使已经释放的 Redis 内容和游标复活', () => {
  const redis = entry('redis');
  const state = {entries:[redis], activeKey:redis.key};
  const disconnected = disconnectWorkspaceScope(state, redis.scope, registry);
  assert.deepEqual(disconnected, {entries:[], activeKey:null});
  assert.deepEqual(reconcileWorkspaceSelection(disconnected, redis, registry), disconnected);
});

test('MySQL 断连保留编辑草稿并推进连接代次，非编辑会话被释放', () => {
  for (const dirty of [true, false]) {
    const mysql = entry('mysql', {dirty});
    const state = {entries:[mysql], activeKey:mysql.key};
    const disconnected = disconnectWorkspaceScope(state, mysql.scope, registry);
    if (dirty) {
      assert.equal(disconnected.activeKey, mysql.key);
      assert.equal(disconnected.entries[0].connectionEpoch, 1);
      assert.equal(disconnected.entries[0].dirty, true);
      assert.equal(disconnected.entries[0].connected, false);
      assert.equal(reconcileWorkspaceSelection(disconnected, {...mysql, connected:false}, registry).entries.length, 1);
    } else assert.deepEqual(disconnected, {entries:[], activeKey:null});
  }
});

test('其他环境的断连不会影响当前工作区', () => {
  const redis = entry('redis');
  const state = {entries:[redis], activeKey:redis.key};
  assert.deepEqual(disconnectWorkspaceScope(state, {...redis.scope, environmentId:'another-env'}, registry), state);
});


test('连续打开相同会话不重复创建，保留草稿且会话上限不可被连续请求突破', () => {
  const first = entry('mysql', {dirty:true, connectionEpoch:3});
  let state = {entries:[], activeKey:null};
  state = openWorkspaceSession(state, first, registry);
  state = openWorkspaceSession(state, entry('mysql'), registry);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].dirty, true);
  assert.equal(state.entries[0].connectionEpoch, 3);
  assert.equal(openWorkspaceSession(state, entry('mysql', {key:'second'}), registry), state);
  assert.equal(openWorkspaceSession(state, entry('redis', {connected:false}), registry), state);
  const crossScope = entry('redis', {scope:{projectId:'other',environmentId:'other',pluginInstanceId:'redis'}});
  assert.equal(openWorkspaceSession(state, crossScope, registry), state);
});


test('定制插件的断线保留策略与选择切换策略独立生效', () => {
  const queueRegistry = createWorkspaceRegistry([definition('test-queue', {retainOnDisconnect:'always'})]);
  const queue = entry('test-queue');
  const state = disconnectWorkspaceScope({entries:[queue],activeKey:queue.key}, queue.scope, queueRegistry);
  assert.equal(reconcileWorkspaceSelection(state, {...queue,connected:false}, queueRegistry).entries.length, 1);
  assert.equal(reconcileWorkspaceSelection(state, null, queueRegistry).entries.length, 0);
  const wrongType = {...queue,plugin:{...queue.plugin,pluginType:'redis'}};
  const empty = {entries:[],activeKey:null};
  assert.equal(openWorkspaceSession(empty, wrongType, queueRegistry), empty);
});
