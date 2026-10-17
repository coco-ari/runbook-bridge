import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { PluginCredentialVault, pluginCredentialInternals } from '../src/plugin-credential-vault.mjs';
import { PluginBatchTransaction } from '../src/plugin-batch-transaction.mjs';
import { createPluginConfigurationService } from '../src/plugin-configuration-service.mjs';
import { normalizePlugin } from '../src/plugin-config-model.mjs';
import { mysqlPluginGroup, mysqlGroupMembers, mysqlGroupTags } from '../src/mysql-plugin-group.mjs';
import { exportCloudProject, normalizeCloudSnapshot } from '../src/cloud-config-snapshot.mjs';
import { CloudConfigWorkspace } from '../src/cloud-config-workspace.mjs';
import { migrateMysqlConnections } from '../src/mysql-connection-migration.mjs';
import YAML from 'yaml';
import { AppError } from '../src/errors.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';

const scope = {projectId:'project-test',environmentId:'env-test'};
const password = 'synthetic-batch-password';
function encryption() {
  const key = crypto.randomBytes(32);
  return {isEncryptionAvailable:() => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString('utf8');
    }};
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-batch-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new WorkspaceStore(root); await store.init();
  await store.createProject({...scope,name:'合成批量测试',environmentId:scope.environmentId});
  const secure = encryption();
  const vault = new PluginCredentialVault(root,secure);
  const transaction = new PluginBatchTransaction(store,vault,secure);
  const coordinator = new WorkspaceMutationCoordinator();
  const events = [];
  let editMaterial;
  const services = {workspaceStore:store,credentialVault:vault,pluginBatchTransaction:transaction,mutationCoordinator:coordinator,
    assertScopeIdle:() => {},
    connectionManager:{beginConfigurationMutation:() => 'token',endConfigurationMutation:() => {},configurationChanged:async (_p,_e,id) => { events.push(id); }},
    contextManager:{invalidateEnvironment:() => {}},confirmationManager:{invalidatePlugin:() => {}},
    pluginEditSessionManager:{captureCredentialIntent:() => {},beginSave:() => {},commitMaterial:() => editMaterial,completeSave:async () => ({outcome:'started'}),saveFailed:() => {}},
  };
  const service = createPluginConfigurationService(services);
  const create = (extra = {}) => service.mysqlGroups.create({...scope,input:{pluginType:'mysql',pluginInstanceId:'mysql-batch-first',target:{host:'db.example.invalid',database:'ignored'},auth:{username:'reader'},tags:['业务'],tls:{mode:'required'}},databases:['orders','billing'],groupName:'业务数据库',secrets:{password},...extra});
  const save = async (plugin,patch,extra = {}) => {
    editMaterial = {scope:{...scope,pluginInstanceId:plugin.pluginInstanceId},baseRecordRevision:plugin.revision,credentialIntent:'rebind-existing',temporarySecrets:extra.temporarySecrets ?? {},mysqlGroupMembers:mysqlGroupMembers(plugin,await store.listPlugins(scope.projectId,scope.environmentId))};
    return service.savePluginConnectionEdit({editSessionId:'test-edit',expectedRevision:plugin.revision,patch,applyToMysqlGroup:true,...extra});
  };
  return {root,store,vault,secure,transaction,coordinator,service,services,events,create,save};
}

async function deletePayload(f,plugin) {
  const group = await f.service.mysqlGroups.describe({...scope,pluginInstanceId:plugin.pluginInstanceId});
  return {...scope,pluginInstanceId:plugin.pluginInstanceId,expectedConnectionId:group.id,expectedRevision:group.revision,
    expectedMembers:group.members.map(({pluginInstanceId,revision}) => ({pluginInstanceId,revision}))};
}

async function corruptSharedCredentials(f,plugin,kind = 'binding') {
  const key = pluginCredentialInternals.resourceKey(plugin);
  for (const file of [f.vault.file,f.vault.backupFile]) {
    const envelope = JSON.parse(await fs.readFile(file,'utf8'));
    if (kind === 'binding') envelope.entries[key].bindingHash = '0'.repeat(64);
    else envelope.entries[key].ciphertext = Buffer.from('合成不可解密内容').toString('base64');
    await fs.writeFile(file,JSON.stringify(envelope));
  }
}

async function savedGroupState(f) {
  const plugins = await f.store.listPlugins(scope.projectId,scope.environmentId);
  return {plugins,environment:await fs.readFile(f.store.environmentPath(scope.projectId,scope.environmentId),'utf8'),
    files:await Promise.all(plugins.map(plugin => fs.readFile(f.store.pluginPath(scope.projectId,scope.environmentId,plugin.pluginInstanceId),'utf8'))),
    credentials:await f.vault.captureProjectEntries(scope.projectId)};
}

test('迁移单库与数据库组的不可读凭据必须确认替换，确认后整组恢复且不泄露凭据',async t => {
  for (const single of [true,false]) for (const kind of ['binding','decrypt']) await t.test(`${single ? '迁移单库' : '数据库组'} · ${kind}`,async t => {
    const f = await fixture(t);
    if (single) {
      const legacy = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-legacy-repair',target:{host:'repair.invalid',database:'orders'},auth:{username:'reader'}});
      await f.vault.save(legacy,{password});
      await migrateMysqlConnections(f.store,f.vault,f.transaction);
    } else await f.create();
    const [plugin] = await f.store.listPlugins(scope.projectId,scope.environmentId);
    await corruptSharedCredentials(f,plugin,kind);
    const before = await savedGroupState(f);
    const cause = kind === 'binding' ? 'CREDENTIAL_BINDING_MISMATCH' : 'CREDENTIAL_DECRYPT_FAILED';
    await assert.rejects(f.save(plugin,{}),{code:cause});
    const temporarySecrets = {password:crypto.randomBytes(24).toString('hex')};
    await assert.rejects(f.save(plugin,{}, {temporarySecrets}),error => {
      assert.equal(error.code,'CREDENTIAL_REPLACEMENT_INCOMPLETE');
      assert.equal(error.details.causeCode,cause);
      assert.equal(JSON.stringify(error).includes(temporarySecrets.password),false);
      return true;
    });
    await assert.rejects(f.save(plugin,{}, {forceCredentialReplacement:true}),{code:'INVALID_ARGUMENT'});
    assert.deepEqual(await savedGroupState(f),before);
    const result = await f.save(plugin,{}, {temporarySecrets,forceCredentialReplacement:true});
    assert.equal(result.committed,true);
    assert.equal(JSON.stringify(result).includes(temporarySecrets.password),false);
    const after = await f.store.listPlugins(scope.projectId,scope.environmentId);
    assert.deepEqual(after.map(item => [item.pluginInstanceId,item.target.database]),before.plugins.map(item => [item.pluginInstanceId,item.target.database]));
    for (const member of after) assert.deepEqual(await f.vault.load(member),temporarySecrets);
  });
});

test('确认期间备份凭据恢复可读时，替换密码仍保留历史 TLS 字段',async t => {
  const f = await fixture(t);
  const oldSecrets = {password,caPem:'synthetic-ca',clientKeyPem:'synthetic-key',tlsPassphrase:'synthetic-passphrase'};
  const {plugin} = await f.create({secrets:oldSecrets});
  const goodBackup = await fs.readFile(f.vault.backupFile);
  await corruptSharedCredentials(f,plugin,'decrypt');
  const temporarySecrets = {password:crypto.randomBytes(24).toString('hex')};
  await assert.rejects(f.save(plugin,{}, {temporarySecrets}),{code:'CREDENTIAL_REPLACEMENT_INCOMPLETE'});
  await fs.writeFile(f.vault.backupFile,goodBackup);
  await f.save(plugin,{}, {temporarySecrets,forceCredentialReplacement:true});
  for (const member of await f.store.listPlugins(scope.projectId,scope.environmentId)) {
    assert.deepEqual(await f.vault.load(member),{...oldSecrets,...temporarySecrets});
  }
});

test('确认替换不能绕过系统加密不可用或凭据库结构损坏，原文件保持不变',async t => {
  const f = await fixture(t);
  const {plugin} = await f.create();
  const before = await savedGroupState(f);
  const replacement = {temporarySecrets:{password:'synthetic-new-password'},forceCredentialReplacement:true};
  f.secure.isEncryptionAvailable = () => false;
  await assert.rejects(f.save(plugin,{},replacement),{code:'CREDENTIAL_ENCRYPTION_UNAVAILABLE'});
  f.secure.isEncryptionAvailable = () => true;
  assert.deepEqual(await savedGroupState(f),before);
  for (const file of [f.vault.file,f.vault.backupFile]) await fs.writeFile(file,'合成损坏的凭据库');
  await assert.rejects(f.save(plugin,{},replacement),{code:'CREDENTIAL_STORE_INVALID'});
  for (const file of [f.vault.file,f.vault.backupFile]) assert.equal(await fs.readFile(file,'utf8'),'合成损坏的凭据库');
  assert.deepEqual(await f.store.listPlugins(scope.projectId,scope.environmentId),before.plugins);
});

test('确认替换凭据与新增数据库保存失败时，回滚配置和原密文并保留其他连接',async t => {
  const f = await fixture(t);
  const {plugin} = await f.create();
  const unrelated = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-unrelated-repair',target:{host:'unrelated.invalid',database:'other'},auth:{username:'reader'}});
  await f.vault.save(unrelated,{password:'synthetic-unrelated-secret'});
  await corruptSharedCredentials(f,plugin);
  const before = await savedGroupState(f);
  const write = f.vault.atomicWrite.bind(f.vault);
  let failed = false;
  f.vault.atomicWrite = async (file,...args) => {
    if (file === f.vault.backupFile && !failed) { failed = true; throw new Error('合成凭据备份写入失败'); }
    return write(file,...args);
  };
  const replacement = {temporarySecrets:{password:'synthetic-recovered-secret'},forceCredentialReplacement:true,databases:['orders','billing','archive']};
  await assert.rejects(f.save(plugin,{target:{host:'recovered.invalid'}},replacement),/合成凭据备份写入失败/);
  assert.deepEqual(await savedGroupState(f),before);
  assert.equal(f.transaction.hasUnresolved(),false);
  await f.save(plugin,{target:{host:'recovered.invalid'}},replacement);
  const members = mysqlGroupMembers(plugin,await f.store.listPlugins(scope.projectId,scope.environmentId));
  assert.equal(members.length,3);
  for (const member of members) {
    assert.equal(member.target.host,'recovered.invalid');
    assert.deepEqual(await f.vault.load(member),replacement.temporarySecrets);
  }
  assert.deepEqual(await f.vault.load(unrelated),{password:'synthetic-unrelated-secret'});
});

test('不可读凭据不能在确认替换时分配给移出的数据库，须先恢复再取消关联',async t => {
  const f = await fixture(t);
  const {plugin} = await f.create();
  await corruptSharedCredentials(f,plugin);
  const before = await savedGroupState(f);
  const replacement = {temporarySecrets:{password:'synthetic-recovered-secret'},forceCredentialReplacement:true};
  await assert.rejects(f.save(plugin,{}, {...replacement,databases:['orders']}),{code:'MYSQL_GROUP_CREDENTIAL_RECOVERY_REQUIRED'});
  assert.deepEqual(await savedGroupState(f),before);
  await f.save(plugin,{},replacement);
  const current = await f.store.getPlugin(scope.projectId,scope.environmentId,plugin.pluginInstanceId);
  await f.save(current,{}, {databases:['orders']});
  const members = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.equal(new Set(members.map(member => member.mysqlConnectionId)).size,2);
  for (const member of members) assert.deepEqual(await f.vault.load(member),replacement.temporarySecrets);
});

test('整组删除原子移除连接及成员，真实连接管理器仅断开目标组并保留隧道、Redis 和其他库',async t => {
  const f = await fixture(t);
  const server = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'server',pluginInstanceId:'shared-server',target:{host:'server.invalid'},auth:{username:'operator',type:'agent'}});
  const redis = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'redis',pluginInstanceId:'other-redis',target:{host:'redis.invalid',db:0}});
  const {plugins} = await f.create({input:{pluginType:'mysql',pluginInstanceId:'mysql-group-first',target:{host:'mysql.invalid'},auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:server.pluginInstanceId}}});
  const other = await f.create({input:{pluginType:'mysql',pluginInstanceId:'mysql-other',target:{host:'mysql.invalid'},auth:{username:'reader'}},databases:['other']});
  const disconnected = [], broadcasts = [], invalidated = [];
  const manager = new EnvironmentConnectionManager(f.store,{connect:async () => ({}),disconnect:async plugin => {disconnected.push(plugin.pluginInstanceId);return {};},closeAll:async () => {throw new Error('不能断开整个环境');}},{retryDelays:[],mutationCoordinator:f.coordinator});
  const service = createPluginConfigurationService({...f.services,connectionManager:manager,
    broadcast:(_channel,event) => broadcasts.push(event),confirmationManager:{invalidatePlugin:(_p,_e,id) => invalidated.push(id)}});
  await manager.requestConnectionIntent({...scope,intent:'connect'});
  const vaultBefore = await f.vault.captureProjectEntries(scope.projectId);
  const result = await service.mysqlGroups.remove(await deletePayload(f,plugins[0]));
  assert.equal(result.deletedCount,2);
  assert.equal(result.credentialsPreserved,true);
  assert.deepEqual(disconnected.sort(),plugins.map(item => item.pluginInstanceId).sort());
  assert.deepEqual(invalidated.sort(),disconnected);
  assert.deepEqual(broadcasts.map(item => item.pluginInstanceId).sort(),disconnected);
  const remaining = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.deepEqual(remaining.map(item => item.pluginInstanceId).sort(),[server.pluginInstanceId,redis.pluginInstanceId,other.plugin.pluginInstanceId].sort());
  for (const item of remaining) assert.equal(manager.snapshot(scope.projectId,scope.environmentId).plugins[item.pluginInstanceId].phase,'connected');
  const environment = await f.store.getEnvironment(scope.projectId,scope.environmentId);
  assert.deepEqual(environment.mysqlConnections.map(item => item.connectionId),[other.plugin.mysqlConnectionId]);
  assert.deepEqual(await f.vault.captureProjectEntries(scope.projectId),vaultBefore);
  for (const item of plugins) await assert.rejects(fs.stat(f.store.pluginPath(scope.projectId,scope.environmentId,item.pluginInstanceId)),{code:'ENOENT'});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(password));
});

test('整组删除拒绝确认后变化的成员、连接版本和跨组目标',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const payload = await deletePayload(f,plugins[0]);
  for (const invalid of [
    {...payload,expectedMembers:[]},
    {...payload,expectedMembers:[payload.expectedMembers[0],payload.expectedMembers[0]]},
  ]) await assert.rejects(f.service.mysqlGroups.remove(invalid),{code:'INVALID_ARGUMENT'});
  for (const stale of [
    {...payload,expectedConnectionId:crypto.randomUUID()},
    {...payload,expectedRevision:payload.expectedRevision+1},
    {...payload,expectedMembers:payload.expectedMembers.slice(0,1)},
    {...payload,expectedMembers:[...payload.expectedMembers,{pluginInstanceId:'unrelated',revision:1}]},
  ]) await assert.rejects(f.service.mysqlGroups.remove(stale),{code:'CONFIG_REVISION_CONFLICT'});
  await f.store.updatePlugin(scope.projectId,scope.environmentId,plugins[1].pluginInstanceId,{displayName:'已改名'},1);
  await assert.rejects(f.service.mysqlGroups.remove(payload),{code:'CONFIG_REVISION_CONFLICT'});
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,2);
});

test('整组删除在活动 SQL 或编辑会话期间拒绝执行',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const payload = await deletePayload(f,plugins[0]);
  const service = createPluginConfigurationService({...f.services,assertScopeIdle:() => {throw new AppError('MYSQL_SQL_TRANSACTION_ACTIVE','合成活动事务');}});
  await assert.rejects(service.mysqlGroups.remove(payload),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  f.coordinator.installEnvironmentEditFence(scope.projectId,scope.environmentId,'active-edit');
  await assert.rejects(f.service.mysqlGroups.remove(payload),{code:'PLUGIN_EDIT_BUSY'});
  f.coordinator.releaseEnvironmentFence('active-edit');
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,2);
});

test('整组删除在成员文件已移除后持久化失败，会恢复全部成员、索引和凭据',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const payload = await deletePayload(f,plugins[0]);
  const before = await f.transaction.snapshot(scope.projectId,scope.environmentId,plugins.map(item => item.pluginInstanceId));
  const environment = await f.store.getEnvironment(scope.projectId,scope.environmentId);
  const vaultBefore = await f.vault.captureProjectEntries(scope.projectId);
  const restore = f.vault.restorePluginEntries.bind(f.vault);
  let injected = false;
  f.vault.restorePluginEntries = async (...args) => {
    if (!injected) {
      injected = true;
      for (const plugin of plugins) await assert.rejects(fs.stat(f.store.pluginPath(scope.projectId,scope.environmentId,plugin.pluginInstanceId)),{code:'ENOENT'});
      throw new Error('合成删除持久化失败');
    }
    return restore(...args);
  };
  await assert.rejects(f.service.mysqlGroups.remove(payload),/合成删除持久化失败/);
  assert.deepEqual(await f.transaction.snapshot(scope.projectId,scope.environmentId,plugins.map(item => item.pluginInstanceId)),before);
  assert.deepEqual(await f.store.getEnvironment(scope.projectId,scope.environmentId),environment);
  assert.deepEqual(await f.vault.captureProjectEntries(scope.projectId),vaultBefore);
  assert.equal((await f.service.mysqlGroups.remove(payload)).deletedCount,2);
});

test('整组已删除但连接清理失败时明确报告提交成功并继续清理其他成员',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const cleaned = [];
  f.services.connectionManager.disconnectRuntime = async plugin => {cleaned.push(plugin.pluginInstanceId);throw new AppError('FIXTURE_DISCONNECT_FAILED','合成清理失败');};
  const result = await f.service.mysqlGroups.remove(await deletePayload(f,plugins[0]));
  assert.equal(result.committed,true);
  assert.equal(result.runtimeWarning.code,'FIXTURE_DISCONNECT_FAILED');
  assert.equal(cleaned.length,2);
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,0);
});

test('公共连接和凭据只保存一份，数据库保持独立标识，云格式使用版本 5',async t => {
  const f = await fixture(t);
  const result = await f.create();
  assert.equal(result.createdCount,2);
  const plugins = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.deepEqual(plugins.map(item => item.target.database),['orders','billing']);
  assert.equal(mysqlPluginGroup(plugins[0]).id,mysqlPluginGroup(plugins[1]).id);
  for (const plugin of plugins) {
    assert.equal(plugin.target.databases,undefined);
    assert.equal((await f.vault.load(plugin)).password,password);
    assert.equal(plugin.tags.includes('业务'),true);
  }
  assert.doesNotMatch(JSON.stringify(result),new RegExp(password));
  const portable = await exportCloudProject(f.store,f.vault,scope.projectId);
  const snapshot = {schemaVersion:5,projects:[portable],history:[{projectId:scope.projectId,deletedAt:null,versions:[{versionId:crypto.randomUUID(),createdAt:new Date().toISOString(),project:portable}]}],tombstones:[]};
  assert.deepEqual(normalizeCloudSnapshot(snapshot,f.vault),snapshot);
  assert.equal(portable.environments[0].mysqlConnections.length,1);
  assert.equal(Object.keys((await f.vault.captureProjectEntries(scope.projectId)).primary).length,1);
  for (const plugin of plugins) {
    const persisted = YAML.parse(await fs.readFile(f.store.pluginPath(scope.projectId,scope.environmentId,plugin.pluginInstanceId),'utf8'));
    assert.deepEqual(persisted.target,{database:plugin.target.database});
    for (const field of ['auth','transport','tls']) assert.equal(persisted[field],undefined);
    assert.deepEqual(portable.environments[0].plugins.find(item => item.config.pluginInstanceId === plugin.pluginInstanceId).secrets,{});
  }
  await assert.rejects(f.create(),{code:'PLUGIN_ALREADY_EXISTS'});
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,2);
});

test('统一编辑只同步公共连接，固定库、名称和 Agent 限制保持各自配置',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const second = await f.store.updatePlugin(scope.projectId,scope.environmentId,plugins[1].pluginInstanceId,{displayName:'账单查询',limits:{maxRows:17},policy:{select:'deny'}},1);
  const result = await f.save(plugins[0],{target:{host:'new-db.example.invalid'},auth:{username:'other-reader'}},{temporarySecrets:{password:'synthetic-new-password'}});
  assert.equal(result.updatedCount,2);
  const after = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.deepEqual(after.map(item => item.target.database),['orders','billing']);
  assert.equal(after[1].displayName,second.displayName);
  assert.deepEqual(after[1].limits,second.limits);
  assert.deepEqual(after[1].policy,second.policy);
  for (const plugin of after) {
    assert.equal(plugin.target.host,'new-db.example.invalid');
    assert.equal(plugin.auth.username,'other-reader');
    assert.equal((await f.vault.load(plugin)).password,'synthetic-new-password');
  }
  assert.doesNotMatch(JSON.stringify(result),/synthetic-new-password/);
  await assert.rejects(f.service.preparePluginUpdate({...scope,pluginInstanceId:after[0].pluginInstanceId,patch:{target:{host:'bypass.invalid'}},expectedRevision:after[0].revision},'connection'),{code:'MYSQL_GROUP_EDIT_REQUIRED'});
});

test('共享凭据不会在成员之间漂移；移出连接创建独立凭据且保留库身份',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  await f.vault.save(plugins[1],{password:'synthetic-old-client-password'});
  let group = await f.service.mysqlGroups.describe({...scope,pluginInstanceId:plugins[0].pluginInstanceId});
  assert.equal(group.credentialsInconsistent,false);
  assert.equal(group.connectionInconsistent,false);
  assert.doesNotMatch(JSON.stringify(group),/synthetic-old-client-password/);
  assert.equal((await f.vault.load(plugins[0])).password,'synthetic-old-client-password');
  await f.save(plugins[0],{target:{host:'updated.invalid'}});
  group = await f.service.mysqlGroups.describe({...scope,pluginInstanceId:plugins[0].pluginInstanceId});
  assert.equal(group.credentialsInconsistent,false);
  const beforeDetach = await f.store.getPlugin(scope.projectId,scope.environmentId,plugins[1].pluginInstanceId);
  const detached = await f.service.mysqlGroups.detach({...scope,pluginInstanceId:beforeDetach.pluginInstanceId,expectedRevision:beforeDetach.revision});
  assert.notEqual(mysqlPluginGroup(detached).id,mysqlPluginGroup(beforeDetach).id);
  assert.deepEqual(detached.target,beforeDetach.target);
  assert.deepEqual(await f.vault.load(detached),await f.vault.load(beforeDetach));
  assert.deepEqual(detached.tags,['业务']);
});

test('批量创建拒绝重复库和超量；环境编辑门禁阻止并发保存',async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({databases:['same','same']}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(f.create({databases:Array.from({length:101},(_,i) => `db_${i}`)}),{code:'INVALID_ARGUMENT'});
  f.coordinator.installEnvironmentEditFence(scope.projectId,scope.environmentId,'other-editor');
  await assert.rejects(f.create(),{code:'PLUGIN_EDIT_BUSY'});
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,0);
});

test('单库可追加数据库并恢复单库展示，原身份与权限保留，取消关联不删除数据',async t => {
  const f = await fixture(t);
  const {plugin} = await f.create({databases:['orders']});
  await f.save(plugin,{}, {databases:['orders','reports']});
  let members = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.equal(members.length,2);
  assert.equal(members[0].pluginInstanceId,plugin.pluginInstanceId);
  assert.equal(members[0].mysqlConnectionId,members[1].mysqlConnectionId);
  await f.save(members[0],{}, {databases:['orders']});
  members = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.equal(members.length,2);
  assert.notEqual(members[0].mysqlConnectionId,members[1].mysqlConnectionId);
  assert.equal(members[1].target.database,'reports');
  assert.deepEqual(await f.vault.load(members[0]),await f.vault.load(members[1]));
});

test('整组连接只向现有规划器提交本连接的成员，不扩大到其他插件',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const requests = [];
  f.services.connectionManager.requestConnectionIntent = request => { requests.push(request); return {outcome:'started'}; };
  for (const intent of ['connect','disconnect']) await f.service.mysqlGroups.connect({...scope,pluginInstanceId:plugins[0].pluginInstanceId,intent});
  assert.deepEqual(requests[0].pluginInstanceIds,plugins.map(item => item.pluginInstanceId));
  assert.deepEqual(requests.slice(1).map(item => item.pluginInstanceId),plugins.map(item => item.pluginInstanceId));
  await assert.rejects(f.service.mysqlGroups.connect({...scope,pluginInstanceId:plugins[0].pluginInstanceId,intent:'anything'}),{code:'INVALID_ARGUMENT'});
});

test('迁移保留单库标识和凭据，同一旧组只合并配置相同的成员，重启幂等',async t => {
  const f = await fixture(t);
  const tags = mysqlGroupTags([],crypto.randomUUID(),'旧数据库组');
  const original = [];
  for (const [index,database] of ['orders','reports','archive','standalone'].entries()) {
    const plugin = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:`mysql-legacy-${index}`,displayName:database,
      tags:index < 3 ? tags : [],target:{host:'legacy.invalid',database},auth:{username:'reader'},policy:{select:'deny'},limits:{maxRows:17}});
    await f.vault.save(plugin,{password:index === 2 ? 'synthetic-other' : password});
    original.push(plugin);
  }
  const result = await migrateMysqlConnections(f.store,f.vault,f.transaction);
  assert.equal(result.migrated,4);
  assert.deepEqual(result.blockedProjects,[]);
  const migrated = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.deepEqual(migrated.map(item => item.pluginInstanceId),original.map(item => item.pluginInstanceId));
  assert.equal(new Set(migrated.map(item => item.mysqlConnectionId)).size,3);
  for (const [index,plugin] of migrated.entries()) {
    assert.deepEqual(plugin.policy,original[index].policy);
    assert.deepEqual(plugin.limits,original[index].limits);
    assert.equal((await f.vault.load(plugin)).password,index === 2 ? 'synthetic-other' : password);
  }
  assert.equal(Object.keys((await f.vault.captureProjectEntries(scope.projectId)).primary).length,3);
  assert.equal((await migrateMysqlConnections(f.store,f.vault,f.transaction)).migrated,0);
  assert.deepEqual(await f.store.listPlugins(scope.projectId,scope.environmentId),migrated);
  assert.ok((await fs.readdir(path.join(f.transaction.directory,'backups'))).length > 0);
});

test('迁移失败完整保留原单库配置，重新启动可重试',async t => {
  const f = await fixture(t);
  const plugin = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-legacy',target:{host:'legacy.invalid',database:'orders'},auth:{username:'reader'}});
  await f.vault.save(plugin,{password});
  const originalWrite = f.store.atomicWrite.bind(f.store);
  let injected = false;
  f.store.atomicWrite = async (file,value) => {
    if (!injected && file === f.store.pluginPath(scope.projectId,scope.environmentId,plugin.pluginInstanceId)) { injected = true; throw new Error('合成迁移失败'); }
    return originalWrite(file,value);
  };
  assert.deepEqual((await migrateMysqlConnections(f.store,f.vault,f.transaction)).blockedProjects,[scope.projectId]);
  assert.deepEqual(await f.store.getPlugin(scope.projectId,scope.environmentId,plugin.pluginInstanceId),plugin);
  assert.equal((await f.vault.load(plugin)).password,password);
  f.store.atomicWrite = originalWrite;
  f.transaction.blocked.clear();
  assert.equal((await migrateMysqlConnections(f.store,f.vault,f.transaction)).migrated,1);
});

test('原多库实验配置迁移为独立只读数据库节点，不丢失已选库',async t => {
  const f = await fixture(t);
  const plugin = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-experiment',target:{host:'legacy.invalid',database:'orders'},auth:{username:'reader'}});
  await f.vault.save(plugin,{password});
  await f.store.writeYaml(f.store.pluginPath(scope.projectId,scope.environmentId,plugin.pluginInstanceId),{...plugin,target:{...plugin.target,databases:['orders','reports']}});
  assert.equal((await migrateMysqlConnections(f.store,f.vault,f.transaction)).migrated,1);
  const plugins = await f.store.listPlugins(scope.projectId,scope.environmentId);
  assert.deepEqual(plugins.map(item => item.target.database),['orders','reports']);
  assert.equal(plugins[0].pluginInstanceId,plugin.pluginInstanceId);
  assert.equal(new Set(plugins.map(item => item.mysqlConnectionId)).size,1);
  for (const item of plugins) assert.equal((await f.vault.load(item)).password,password);
});

test('新云快照往返只传一份公共凭据，节点跨环境引用和夹带公共配置被拒绝',async t => {
  const f = await fixture(t);
  await f.create();
  const portable = await exportCloudProject(f.store,f.vault,scope.projectId);
  const g = await fixture(t);
  const workspace = new CloudConfigWorkspace(g.store,g.vault,g.transaction.encryption);
  const before = await workspace.capture(scope.projectId);
  await workspace.commit(before,await workspace.materialize(portable,scope.projectId,before));
  assert.deepEqual(await exportCloudProject(g.store,g.vault,scope.projectId),portable);
  const snapshot = project => ({schemaVersion:5,projects:[project],history:[{projectId:scope.projectId,deletedAt:null,versions:[{versionId:crypto.randomUUID(),createdAt:new Date().toISOString(),project}]}],tombstones:[]});
  const forged = structuredClone(portable);
  forged.environments[0].plugins[0].config.target.host = 'forged.invalid';
  assert.throws(() => normalizeCloudSnapshot(snapshot(forged),f.vault),{code:'CLOUD_FORMAT_INVALID'});
  const missing = structuredClone(portable);
  missing.environments[0].mysqlConnections = [];
  assert.throws(() => normalizeCloudSnapshot(snapshot(missing),f.vault),{code:'CLOUD_DEPENDENCY_INVALID'});
});

test('恢复旧本机备份时也在同一事务中升级共享连接，无需重启再迁移',async t => {
  const f = await fixture(t);
  const plugin = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-backup',target:{host:'backup.invalid',database:'orders'},auth:{username:'reader'}});
  await f.vault.save(plugin,{password});
  const workspace = new CloudConfigWorkspace(f.store,f.vault,f.secure);
  const before = await workspace.capture(scope.projectId);
  const after = await workspace.upgradeMysqlSnapshot(workspace.rebaseRestore(before,before));
  assert.equal((await f.store.getPlugin(scope.projectId,scope.environmentId,plugin.pluginInstanceId)).mysqlConnectionId,undefined);
  await workspace.commit(before,after);
  const restored = await f.store.getPlugin(scope.projectId,scope.environmentId,plugin.pluginInstanceId);
  assert.ok(restored.mysqlConnectionId);
  assert.equal((await f.vault.load(restored)).password,password);
  assert.equal(restored.pluginInstanceId,plugin.pluginInstanceId);
});

test('相同分组标签不能跨环境或跨插件类型合并',() => {
  const tags = mysqlGroupTags([],crypto.randomUUID(),'合成组');
  const one = normalizePlugin({pluginType:'mysql',tags,target:{host:'example.invalid',database:'db'},auth:{username:'test'}},scope);
  const other = {...one,environmentId:'other-env'};
  assert.deepEqual(mysqlGroupMembers(one,[one,other,{...one,pluginType:'redis'}]),[one]);
  assert.equal(mysqlPluginGroup({...one,tags:[...tags,`rbb:mysql-group:${crypto.randomUUID()}`]}),null);
});

test('配置文件写入失败时，批量创建完整回滚环境索引、文件及凭据',async t => {
  const f = await fixture(t);
  const environment = await f.store.getEnvironment(scope.projectId,scope.environmentId);
  const write = f.store.atomicWrite.bind(f.store);
  let writes = 0;
  f.store.atomicWrite = async (file,...args) => {
    if (file.includes(`${path.sep}plugins${path.sep}`) && ++writes === 2) throw new Error('synthetic-write-failure');
    return write(file,...args);
  };
  await assert.rejects(f.create(),/synthetic-write-failure/);
  assert.deepEqual(await f.store.getEnvironment(scope.projectId,scope.environmentId),environment);
  assert.deepEqual(await f.store.listPlugins(scope.projectId,scope.environmentId),[]);
  assert.equal(f.transaction.hasUnresolved(),false);
  assert.deepEqual(await f.vault.captureProjectEntries(scope.projectId),{primary:{},backup:{}});
});

test('凭据第二槽写入失败时全组更新回滚，并保留无关插件条目',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const unrelated = await f.store.createPlugin(scope.projectId,scope.environmentId,{pluginType:'mysql',pluginInstanceId:'mysql-other',target:{host:'other.invalid',database:'other'},auth:{username:'reader'}});
  await f.vault.save(unrelated,{password:'synthetic-unrelated-password'});
  const before = await f.vault.captureProjectEntries(scope.projectId);
  const write = f.vault.atomicWrite.bind(f.vault);
  let failed = false;
  f.vault.atomicWrite = async (file,...args) => {
    if (file === f.vault.backupFile && !failed) { failed = true; throw new Error('synthetic-vault-failure'); }
    return write(file,...args);
  };
  const prepared = await f.service.preparePluginUpdate({...scope,pluginInstanceId:plugins[0].pluginInstanceId,patch:{target:{host:'new.invalid'}},applyToMysqlGroup:true,expectedRevision:1,credentialIntent:'rebind-existing'},'connection');
  await assert.rejects(f.service.mysqlGroups.save({...scope,pluginInstanceId:plugins[0].pluginInstanceId,editSessionId:'test-edit',applyToMysqlGroup:true},{mysqlGroupMembers:plugins},prepared),/synthetic-vault-failure/);
  assert.deepEqual((await f.store.listPlugins(scope.projectId,scope.environmentId)).slice(0,2),plugins);
  assert.deepEqual(await f.vault.captureProjectEntries(scope.projectId),before);
});

test('未提供密码的批量创建也不能重复覆盖已有插件',async t => {
  const f = await fixture(t);
  await f.create({secrets:{}});
  await assert.rejects(f.create({secrets:{}}),{code:'PLUGIN_ALREADY_EXISTS'});
  assert.equal((await f.store.listPlugins(scope.projectId,scope.environmentId)).length,2);
});

test('恢复遇到第三种本地配置状态时隔离项目且不覆盖任何成员',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const before = await f.transaction.snapshot(scope.projectId,scope.environmentId,plugins.map(plugin => plugin.pluginInstanceId));
  const recordId = crypto.randomUUID();
  await f.transaction.writeSealed(path.join(f.transaction.directory,'transactions',`${recordId}.json`),{
    schemaVersion:1,id:recordId,phase:'prepared',projectId:scope.projectId,before,after:structuredClone(before),
  });
  const changed = await f.store.updatePlugin(scope.projectId,scope.environmentId,plugins[1].pluginInstanceId,{displayName:'事务后修改'},1);
  const recovery = new PluginBatchTransaction(f.store,f.vault,f.secure);
  await recovery.recoverAll();
  assert.equal(recovery.hasUnresolved(),true);
  assert.throws(() => recovery.assertProjectAvailable(scope.projectId),{code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED'});
  assert.deepEqual(await f.store.getPlugin(scope.projectId,scope.environmentId,plugins[1].pluginInstanceId),changed);
  assert.deepEqual(await f.store.getPlugin(scope.projectId,scope.environmentId,plugins[0].pluginInstanceId),plugins[0]);
});

test('中断事务保留加密日志，重启恢复全部成员',async t => {
  const f = await fixture(t);
  const {plugins} = await f.create();
  const write = f.store.atomicWrite.bind(f.store);
  let count = 0;
  f.store.atomicWrite = async (file,...args) => {
    if (file.includes(`${path.sep}plugins${path.sep}`) && ++count >= 2) throw new Error('synthetic-disk-offline');
    return write(file,...args);
  };
  await assert.rejects(f.save(plugins[0],{target:{host:'changed.invalid'}}),{code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED'});
  assert.equal(f.transaction.hasUnresolved(),true);
  const journalDir = path.join(f.transaction.directory,'transactions');
  for (const name of await fs.readdir(journalDir)) {
    const text = await fs.readFile(path.join(journalDir,name),'utf8');
    assert.doesNotMatch(text,/synthetic-batch-password|changed\.invalid|db\.example\.invalid/);
  }
  f.store.atomicWrite = write;
  const recovery = new PluginBatchTransaction(f.store,f.vault,f.secure);
  await recovery.recoverAll();
  assert.equal(recovery.hasUnresolved(),false);
  assert.deepEqual(await f.store.listPlugins(scope.projectId,scope.environmentId),plugins);
  for (const plugin of plugins) assert.equal((await f.vault.load(plugin)).password,password);
});
