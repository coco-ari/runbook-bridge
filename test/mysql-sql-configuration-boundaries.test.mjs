import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DesktopMysqlSql } from '../src/desktop-mysql-sql.mjs';
import { PluginEditSessionManager } from '../src/plugin-edit-session-manager.mjs';
import { createPluginConfigurationService } from '../src/plugin-configuration-service.mjs';
import { CloudConfigService } from '../src/cloud-config-service.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { normalizePlugin } from '../src/plugin-config-model.mjs';
import { snapshotDigest } from '../src/cloud-config-snapshot.mjs';

const scope = {projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-mysql'};
const input = {pluginType:'mysql',pluginInstanceId:scope.pluginInstanceId,target:{host:'fixture.invalid',database:'fixture'},auth:{username:'fixture'}};
const plugin = normalizePlugin(input,scope);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise,resolve};
}

function sqlFixture(t, target = scope) {
  const sql = new DesktopMysqlSql({},{});
  const key = sql.key('fixture-owner',target,'fixture-document');
  const state = {key,owner:'fixture-owner',documentId:'fixture-document',plugin:{...plugin,...target},mode:'manual',transaction:'none',busy:false,child:null,results:[],released:false};
  sql.sessions.set(key,state);
  t.after(() => sql.closeAll());
  return {sql,state};
}

function editFixture(t) {
  const {sql,state} = sqlFixture(t);
  const coordinator = new WorkspaceMutationCoordinator();
  const events = [];
  const manager = new PluginEditSessionManager({
    workspaceStore:{listPlugins:async () => [structuredClone(plugin)]},
    mutationCoordinator:coordinator,
    connectionManager:{
      snapshot:() => ({plugins:{[scope.pluginInstanceId]:{phase:'connected'}}}),
      waitForConnectionOperations:async () => undefined,
      disconnectForConfigurationEdit:async () => { events.push('disconnect'); return {connectedBefore:[scope.pluginInstanceId]}; },
    },
    assertScopeIdle:current => {
      assert.deepEqual(current,{projectId:scope.projectId,environmentId:scope.environmentId});
      events.push('sql-check'); sql.assertScopeIdle(current);
    },
  });
  return {manager,coordinator,events,state,sql};
}

test('连接配置编辑在请求排空后复查手动事务，不断开连接并释放编辑围栏', async t => {
  const f = editFixture(t);
  const finish = deferred();
  const reader = f.coordinator.runEnvironmentOperation(scope.projectId,scope.environmentId,async () => {
    await finish.promise;
    f.state.transaction = 'active';
  });
  const prepared = await f.manager.preparePluginConnectionEdit({...scope,expectedRevision:plugin.revision});
  const beginning = f.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  const rejection = assert.rejects(beginning,{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  await nextTurn();
  assert.ok(f.coordinator.environmentFence(scope.projectId,scope.environmentId));
  assert.deepEqual(f.events,[],'The post-drain check must not race ahead of the active request.');
  finish.resolve();
  await reader;
  await rejection;
  assert.deepEqual(f.events,['sql-check']);
  assert.equal(f.coordinator.environmentFence(scope.projectId,scope.environmentId),null);
  assert.equal(f.manager.sessions.size,0);
  assert.equal(f.manager.preparations.size,0);
  assert.equal(f.state.transaction,'active');
});

test('事务完成后仍允许进入连接配置编辑，先检查后断开', async t => {
  const f = editFixture(t);
  const prepared = await f.manager.preparePluginConnectionEdit({...scope,expectedRevision:plugin.revision});
  const session = await f.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  assert.deepEqual(f.events,['sql-check','disconnect']);
  assert.equal(f.coordinator.environmentFence(scope.projectId,scope.environmentId).ownerId,session.editSessionId);
  f.coordinator.releaseEnvironmentFence(session.editSessionId);
});

function configurationFixture(t) {
  const {sql,state} = sqlFixture(t);
  const coordinator = new WorkspaceMutationCoordinator();
  const after = normalizePlugin({displayName:'合成新名称'},scope,plugin);
  const events = [];
  const service = createPluginConfigurationService({
    v2Service:{mysqlSql:sql},
    workspaceStore:{
      preparePluginConnectionUpdate:async () => { events.push('prepare'); return {before:plugin,after,change:{kind:'session-affecting'}}; },
      commitPluginSnapshot:async () => { events.push('commit'); return after; },
      appendAudit:async () => events.push('audit'),
    },
    mutationCoordinator:coordinator,
    connectionManager:{
      beginConfigurationMutation:() => { events.push('runtime-fence'); return 'fixture-token'; },
      endConfigurationMutation:() => events.push('end-fence'),
      configurationChanged:async () => events.push('configuration-changed'),
    },
    contextManager:{invalidateEnvironment:() => events.push('context')},
    confirmationManager:{invalidatePlugin:() => events.push('confirmation')},
    credentialVault:{saveMerged:async () => events.push('credentials')},
    pluginEditSessionManager:{
      beginSave:() => undefined,
      commitMaterial:() => ({scope,baseRecordRevision:plugin.revision,credentialIntent:'unchanged',temporarySecrets:{}}),
      completeSave:async () => events.push('complete'),
      saveFailed:() => events.push('save-failed'),
    },
  });
  return {service,coordinator,events,state,sql,after};
}

test('排队中的配置保存等 SQL 请求完成后再次检查事务，尚未修改配置和凭据', async t => {
  const f = configurationFixture(t);
  const finish = deferred();
  const reader = f.coordinator.runEnvironmentOperation(scope.projectId,scope.environmentId,async () => {
    await finish.promise; f.state.transaction = 'active';
  });
  const saving = f.service.savePluginConnectionEdit({editSessionId:'fixture-edit',expectedRevision:plugin.revision,patch:{displayName:'合成新名称'}},{ownerId:'fixture-owner'});
  const rejection = assert.rejects(saving,{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  await nextTurn();
  assert.deepEqual(f.events,[]);
  finish.resolve(); await reader; await rejection;
  assert.deepEqual(f.events,['save-failed']);
  assert.equal(f.coordinator.environmentQueues.size,0);
  assert.equal(f.state.transaction,'active');
});

test('中央配置提交、创建插件与运行时变更都拒绝隐藏事务或未确认结果', async t => {
  for (const transaction of ['active','unknown']) {
    const f = configurationFixture(t);
    f.state.transaction = transaction;
    await assert.rejects(f.service.commitPreparedPlugin({before:plugin,after:f.after,change:{kind:'metadata'}},scope),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
    await assert.rejects(f.service.withConfigurationMutation(scope.projectId,scope.environmentId,scope.pluginInstanceId,async () => { f.events.push('operation'); }),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
    await assert.rejects(f.service.createPlugin({...scope,input}),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
    assert.deepEqual(f.events,[]);
    assert.equal(f.state.transaction,transaction);
  }
});

test('配置保护覆盖整个环境，其他环境事务不阻塞当前配置提交', async t => {
  const f = configurationFixture(t);
  f.state.transaction = 'active';
  f.state.plugin.environmentId = 'other-environment';
  const result = await f.service.commitPreparedPlugin({before:plugin,after:f.after,change:{kind:'metadata'}},scope);
  assert.equal(result,f.after);
  assert.deepEqual(f.events,['commit','audit']);
  assert.equal(f.state.transaction,'active');
});

function cloudFixture(t, target = scope) {
  const {sql,state} = sqlFixture(t,target);
  const coordinator = new WorkspaceMutationCoordinator();
  const events = [];
  const before = {files:{'workspace.yaml':'synthetic-before','environments/fixture-environment/environment.yaml':'synthetic-env'},entries:{primary:{},backup:{}}};
  const after = {files:{'workspace.yaml':'synthetic-after'},entries:{primary:{},backup:{}}};
  const backup = {record:{id:'fixture-backup',before:after},digest:'fixture-backup-digest'};
  const workspace = {
    directory:'/synthetic-cloud-fixture',vault:{},assertProjectAvailable:() => undefined,
    store:{
      writeQueues:new Map(),
      getProject:async () => ({environmentOrder:[scope.environmentId]}),
      listPlugins:async () => [],
      appendAudit:async () => events.push('audit'),
    },
    capture:async () => before,
    readBackup:async () => backup,
    rebaseRestore:() => after,
    writeSealed:async () => events.push('state'),
    commit:async () => { events.push('commit'); return {backupId:'synthetic-backup-result'}; },
  };
  const service = new CloudConfigService({
    workspace,mutationCoordinator:coordinator,v2Service:{mysqlSql:sql},
    connectionManager:{disconnect:async () => events.push('disconnect'),forgetProject:async () => events.push('forget')},
    contextManager:{invalidateProject:() => events.push('context')},
    confirmationManager:{invalidateProject:() => events.push('confirmations')},
  });
  const plan = () => service.rememberPlan('fixture-owner',{
    direction:'restore',backup,
    rows:[{rowId:scope.projectId,localId:scope.projectId,local:{before,expected:snapshotDigest(before)},summary:{rowId:scope.projectId}}],
  });
  const confirm = prepared => service.confirm('fixture-owner',{planId:prepared.planId,choices:{[scope.projectId]:'cloud'}});
  return {sql,state,service,coordinator,events,before,after,plan,confirm};
}

for (const activity of ['active','unknown','running']) {
  test(`云端覆盖或备份恢复拒绝 ${activity} SQL，保留当前连接与本地内容`, async t => {
    const f = cloudFixture(t);
    f.state.transaction = activity === 'running' ? 'none' : activity;
    f.state.busy = activity === 'running';
    const result = await f.confirm(f.plan());
    assert.equal(result.results[0].status,'failed');
    assert.equal(result.results[0].error.code,'MYSQL_SQL_TRANSACTION_ACTIVE');
    assert.match(result.results[0].error.message,/SQL 标签/u);
    assert.deepEqual(f.events,[]);
    assert.equal(f.coordinator.cloudProjects.size,0);
    assert.equal(f.state.child,null);
  });
}

test('云覆盖在项目请求排空后再检查遗留手动事务，不能用云同步隐式回滚', async t => {
  const f = cloudFixture(t);
  const finish = deferred();
  const reader = f.coordinator.runEnvironmentOperation(scope.projectId,scope.environmentId,async () => {
    await finish.promise; f.state.transaction = 'active';
  });
  const confirming = f.confirm(f.plan());
  await nextTurn();
  assert.ok(f.coordinator.cloudProjects.has(scope.projectId));
  assert.deepEqual(f.events,[]);
  finish.resolve(); await reader;
  const result = await confirming;
  assert.equal(result.results[0].error.code,'MYSQL_SQL_TRANSACTION_ACTIVE');
  assert.deepEqual(f.events,[]);
  assert.equal(f.state.transaction,'active');
});

test('云覆盖保护整个项目，包括当前详情没有显示的其他环境事务', async t => {
  const f = cloudFixture(t,{...scope,environmentId:'hidden-environment'});
  f.state.transaction = 'active';
  assert.equal((await f.confirm(f.plan())).results[0].error.code,'MYSQL_SQL_TRANSACTION_ACTIVE');
  assert.deepEqual(f.events,[]);
});

test('其他项目事务不阻塞云覆盖，正常覆盖仍依次断开并提交', async t => {
  const f = cloudFixture(t,{...scope,projectId:'other-project'});
  f.state.transaction = 'active';
  const result = await f.confirm(f.plan());
  assert.equal(result.results[0].status,'imported');
  assert.ok(f.events.indexOf('disconnect') < f.events.indexOf('commit'));
  assert.ok(f.events.includes('forget'));
  assert.equal(f.state.transaction,'active');
});

test('只读云快照路径和应用退出释放不受事务保护阻断', async t => {
  const f = cloudFixture(t);
  f.state.transaction = 'active';
  assert.equal(await f.service.withProject(scope.projectId,async () => 'synthetic-snapshot'),'synthetic-snapshot');
  assert.deepEqual(f.events,[]);
  await f.sql.closeAll();
  assert.equal(f.sql.sessions.size,0);
  assert.equal((await f.confirm(f.plan())).results[0].status,'imported');
});
