import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createCloudServer } from '../services/cloud-config/server.mjs';
import { CloudConfigClient } from '../src/cloud-config-client.mjs';
import { CloudConfigService } from '../src/cloud-config-service.mjs';
import { CloudConfigWorkspace } from '../src/cloud-config-workspace.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { PluginCredentialVault, pluginCredentialInternals } from '../src/plugin-credential-vault.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { newCloudMeta, deriveCloudKeys, encryptCloudSnapshot, decryptCloudSnapshot, cloudHash, validateCloudMeta } from '../src/cloud-config-crypto.mjs';
import { exportCloudProject, snapshotDigest, normalizeCloudSnapshot, cloudBackupDiff, cloudProjectDiff } from '../src/cloud-config-snapshot.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { RedisWorkspaceManager } from '../src/redis-workspace-manager.mjs';
import { ServerDockerManager } from '../src/server-docker-manager.mjs';
import { registerCloudConfigIpc } from '../src/cloud-config-ipc.mjs';

const PASSWORD = 'synthetic-cloud-password-for-tests';
const ADMIN = 'synthetic-admin-token-only-for-tests-12345';
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable:() => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8');
    },
  };
}
async function device(t,client) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-cloud-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new WorkspaceStore(root); await store.init();
  const secure = encryption(), vault = new PluginCredentialVault(root,secure);
  const workspace = new CloudConfigWorkspace(store,vault,secure);
  const coordinator = new WorkspaceMutationCoordinator();
  const events = [];
  const service = new CloudConfigService({workspace,mutationCoordinator:coordinator,client,
    connectionManager:{disconnect:async () => events.push('disconnect'),forgetProject:async () => {}},
    contextManager:{invalidateProject:() => events.push('context')},confirmationManager:{invalidateProject:() => events.push('approval')},
  });
  await service.init();
  return {root,store,secure,vault,workspace,coordinator,service,events,call:(action,args = {}) => service.invoke('test-owner',action,args)};
}
async function cloud(t,retention = 20) {
  const server = createCloudServer({adminToken:ADMIN,retention});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {origin:`http://127.0.0.1:${server.address().port}`,client:new CloudConfigClient()};
}
async function project(device,projectId = 'project-test') {
  const p = await device.store.createProject({projectId,name:'合成测试项目',environmentId:'env-test'});
  const server = await device.store.createPlugin(p.projectId,'env-test',{pluginType:'server',pluginInstanceId:'server-test',displayName:'合成服务器',target:{host:'server.example.invalid',hostKeyFingerprint:'SHA256:synthetic',dockerSocket:'/run/user/1000/docker.sock'},auth:{type:'password',username:'tester'}});
  await device.vault.save(server,{password:'synthetic-ssh-secret',proxyPassword:'synthetic-proxy-secret'});
  const mysql = await device.store.createPlugin(p.projectId,'env-test',{pluginType:'mysql',pluginInstanceId:'mysql-test',displayName:'合成数据库',target:{host:'db.example.invalid',database:'sample'},auth:{username:'tester'},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-test'},tls:{mode:'verifyIdentity'}});
  await device.vault.save(mysql,{password:'synthetic-mysql-secret',clientKeyPem:'synthetic-client-key',caPem:'synthetic-ca',clientCertPem:'synthetic-cert'});
  const redis = await device.store.createPlugin(p.projectId,'env-test',{pluginType:'redis',pluginInstanceId:'redis-test',displayName:'合成缓存',target:{host:'cache.example.invalid'},auth:{username:'tester'},patterns:[{patternId:'sample-range',pattern:'sample:*',displayName:'合成范围'}]});
  await device.vault.save(redis,{password:'synthetic-redis-secret'});
  await device.store.saveRunbook(p.projectId,'env-test','# 合成环境\n仅用于测试。');
  return p;
}
async function upload(device,id) {
  const plan = await device.call('prepare',{direction:'upload',projectIds:[id]});
  return device.call('confirm',{planId:plan.planId,choices:Object.fromEntries(plan.rows.map(row => [row.rowId,'local']))});
}
async function download(device,id,snapshotId = null) {
  const plan = await device.call('prepare',{direction:'download',projectIds:[id],snapshotId});
  return device.call('confirm',{planId:plan.planId,choices:Object.fromEntries(plan.rows.map(row => [row.rowId,'cloud']))});
}

test('恢复预览区分配置文件类型，并提示删除插件中的凭据变化',() => {
  const before = {files:{'workspace.yaml':'same','environments/env-test/environment.yaml':'same','environments/env-test/plugins/server-test.yaml':'old','environments/env-test/plugins/remove-test.yaml':'removed','environments/env-test/README.md':'old'},entries:{primary:{},backup:{}}};
  const after = {files:{'workspace.yaml':'same','environments/env-test/environment.yaml':'same','environments/env-test/plugins/server-test.yaml':'new','environments/env-test/plugins/add-test.yaml':'added','environments/env-test/README.md':'new'},entries:{primary:{},backup:{}}};
  const diff = cloudBackupDiff(before,after);
  assert.deepEqual([diff.added,diff.removed,diff.modified,diff.runbooksChanged],[1,1,1,1]);
  assert.equal(diff.credentialsChanged,false);
  const project = {name:'合成项目',environments:[{environmentId:'env-test',name:'测试',runbook:'',questions:[],plugins:[{config:{pluginInstanceId:'server-test'},secrets:{password:'synthetic-removed-password'}}]}]};
  assert.equal(cloudProjectDiff(project,{...project,environments:[]}).credentialsChanged,true);
});

test('真实连接管理器按依赖断开并清除浏览会话，断开失败时阻止导入',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a);
  await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId);
  const connected = new Set(['server-test','mysql-test','redis-test']), disconnected = [], invalidated = [];
  const plugins = {
    status:plugin => ({connected:connected.has(plugin.pluginInstanceId)}),
    disconnect:async plugin => { disconnected.push(plugin.pluginInstanceId); connected.delete(plugin.pluginInstanceId); },
  };
  a.service.pluginManager = plugins;
  a.service.connectionManager = new EnvironmentConnectionManager(a.store,plugins,{mutationCoordinator:a.coordinator});
  a.service.v2Service = {redisWorkspaceManager:{invalidate:scope => invalidated.push(scope)}};
  const imported = await download(a,p.projectId);
  assert.equal(imported.results[0].status,'imported');
  assert.equal(connected.size,0);
  assert.equal(disconnected.at(-1),'server-test');
  assert.deepEqual(invalidated,[{projectId:p.projectId}]);
  assert.equal(a.service.connectionManager.snapshot(p.projectId,'env-test').desiredConnected,false);
  const before = snapshotDigest(await a.workspace.capture(p.projectId));
  connected.add('server-test');
  plugins.disconnect = async () => { throw new Error('synthetic disconnect failure'); };
  const rejected = await download(a,p.projectId);
  assert.equal(rejected.results[0].error.code,'CLOUD_PROJECT_BUSY');
  assert.equal(snapshotDigest(await a.workspace.capture(p.projectId)),before);
});

test('云导入取消同项目的 Docker 读取并清除分页快照，保留其他项目会话',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a), other = await project(a,'other-project');
  await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId);
  const container = index => ({id:index.toString(16).padStart(64,'0'),name:'synthetic-'+index,image:'example.invalid/test:latest',state:'running',status:'Up',ports:'',project:'',service:''});
  const runtime = {
    status:() => ({connected:true,generation:1}),
    readDocker:async () => ({stdout:[container(1),container(2)].map(value => JSON.stringify(value)).join('\n'),stderr:'',exitCode:0,truncated:false}),
  };
  const docker = new ServerDockerManager({workspaceStore:a.store,serverRuntime:runtime});
  t.after(() => docker.dispose());
  a.service.serverDocker = docker;
  const scope = {projectId:p.projectId,environmentId:'env-test',pluginInstanceId:'server-test'};
  const otherScope = {...scope,projectId:other.projectId};
  const first = await docker.read('renderer:test',{...scope,kind:'list',limit:1});
  const otherFirst = await docker.read('renderer:test',{...otherScope,kind:'list',limit:1});
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  runtime.readDocker = async (_plugin,_request,options) => {
    signal = options.signal;
    started();
    return new Promise(resolve => signal.addEventListener('abort',() => resolve({stdout:'',stderr:'',exitCode:0,truncated:false}),{once:true}));
  };
  const pending = docker.read('renderer:test',{...scope,kind:'logs',containerId:container(1).id});
  const cancelled = assert.rejects(pending,{code:'DOCKER_CANCELLED'});
  await ready;
  assert.equal((await download(a,p.projectId)).results[0].status,'imported');
  await cancelled;
  assert.equal(signal.aborted,true);
  await assert.rejects(docker.read('renderer:test',{...scope,kind:'list',cursor:first.nextCursor,limit:1}),{code:'DOCKER_CURSOR_EXPIRED'});
  const otherPage = await docker.read('renderer:test',{...otherScope,kind:'list',cursor:otherFirst.nextCursor,limit:1});
  assert.equal(otherPage.items.length,1);
});

test('云导入使当前项目的 Redis 浏览游标失效，并保留其他项目与 Key 范围',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a), other = await project(a,'other-project');
  await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId);
  const sessions = new Map(), closed = [];
  const runtime = {
    require(plugin) {
      if (!sessions.has(plugin.projectId)) sessions.set(plugin.projectId,{});
      return sessions.get(plugin.projectId);
    },
    workspaceReader(plugin) {
      return {
        closed:false,open:async () => {},
        command:async args => {
          assert.equal(args[0],'SCAN');
          assert.equal(args[3],'sample:*');
          return [Buffer.from('0'),['sample:first','outside:denied','sample:second'].map(key => Buffer.from(key))];
        },
        close() { this.closed = true; closed.push(plugin.projectId); },
      };
    },
  };
  const manager = new RedisWorkspaceManager(runtime);
  t.after(() => manager.dispose());
  a.service.v2Service = {redisWorkspaceManager:manager};
  const plugin = await a.store.getPlugin(p.projectId,'env-test','redis-test');
  const otherPlugin = await a.store.getPlugin(other.projectId,'env-test','redis-test');
  const query = {patternId:'sample-range',limit:1};
  const first = await manager.execute('renderer:test',plugin,'scan',query);
  const otherFirst = await manager.execute('renderer:test',otherPlugin,'scan',query);
  assert.deepEqual(first.keys,['sample:first']);
  assert.equal((await download(a,p.projectId)).results[0].status,'imported');
  assert.deepEqual(closed,[p.projectId]);
  const imported = await a.store.getPlugin(p.projectId,'env-test','redis-test');
  assert.equal((await a.vault.load(imported)).password,'synthetic-redis-secret');
  await assert.rejects(manager.execute('renderer:test',imported,'scan',{...query,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
  const otherPage = await manager.execute('renderer:test',otherPlugin,'scan',{...query,cursor:otherFirst.nextCursor});
  assert.deepEqual(otherPage.keys,['sample:second']);
});

test('云同步禁止并发写入，但不阻止已持有删除门禁的项目删除',async t => {
  const a = await device(t,new CloudConfigClient()), p = await project(a);
  a.coordinator.cloudProjects.add(p.projectId);
  await assert.rejects(a.store.updateProject(p.projectId,{name:'不能写入'}),{code:'CLOUD_PROJECT_BUSY'});
  assert.throws(() => a.coordinator.beginProjectDelete(p.projectId),{code:'CLOUD_PROJECT_BUSY'});
  a.coordinator.cloudProjects.delete(p.projectId);
  a.coordinator.beginProjectDelete(p.projectId);
  await a.store.deleteProject(p.projectId);
  assert.equal((await a.store.listProjects()).length,0);
});

test('云快照加密认证绑定仓库与父版本并拒绝篡改',async () => {
  const meta = newCloudMeta(), keys = await deriveCloudKeys(PASSWORD,meta);
  const payload = {schemaVersion:1,projects:[]};
  const encrypted = encryptCloudSnapshot(payload,meta,keys.encryption);
  assert.deepEqual(decryptCloudSnapshot(encrypted,meta,keys.encryption),payload);
  assert.notEqual(keys.auth,keys.encryption.toString('base64url'));
  assert.throws(() => decryptCloudSnapshot({...encrypted,parentId:crypto.randomUUID()},meta,keys.encryption),{code:'CLOUD_DECRYPT_FAILED'});
  assert.throws(() => decryptCloudSnapshot({...encrypted,tag:Buffer.alloc(16).toString('base64')},meta,keys.encryption),{code:'CLOUD_DECRYPT_FAILED'});
  assert.throws(() => decryptCloudSnapshot(encrypted,newCloudMeta(),keys.encryption),{code:'CLOUD_SCOPE_MISMATCH'});
  assert.throws(() => validateCloudMeta({...meta,kdf:{...meta.kdf,N:2**25}}),{code:'CLOUD_FORMAT_UNSUPPORTED'});
});

test('跨设备同步配置、密码、TLS、依赖及历史版本，不同步审计与会话',async t => {
  const remote = await cloud(t,2), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a);
  await a.store.appendAudit(p.projectId,{type:'synthetic-local-audit'});
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD,remember:true});
  const first = await upload(a,p.projectId);
  await b.call('bind',{url:created.url,password:PASSWORD});
  const result = await download(b,p.projectId);
  assert.equal(result.results[0].status,'imported');
  const importedServer = await b.store.getPlugin(p.projectId,'env-test','server-test');
  assert.equal(importedServer.target.dockerSocket,'/run/user/1000/docker.sock');
  assert.equal((await b.vault.load(importedServer)).password,'synthetic-ssh-secret');
  const imported = await b.store.getPlugin(p.projectId,'env-test','mysql-test');
  assert.equal(imported.transport.serverPluginInstanceId,'server-test');
  assert.equal((await b.vault.load(imported)).password,'synthetic-mysql-secret');
  assert.equal((await b.vault.load(imported)).clientKeyPem,'synthetic-client-key');
  const redis = await b.store.getPlugin(p.projectId,'env-test','redis-test');
  assert.equal(redis.patterns[0].pattern,'sample:*');
  assert.equal((await b.store.readRunbook(p.projectId,'env-test')).content,'# 合成环境\n仅用于测试。');
  assert.equal((await b.store.listAudit(p.projectId)).entries.some(e => e.type === 'synthetic-local-audit'),false);
  assert.deepEqual(b.events,['context','approval']);
  const disk = await fs.readFile(b.vault.file,'utf8');
  assert.ok(!disk.includes('synthetic-mysql-secret'));
  const yaml = await fs.readFile(b.store.pluginPath(p.projectId,'env-test','mysql-test'),'utf8');
  assert.ok(!yaml.includes('synthetic-mysql-secret'));
  assert.notEqual(await fs.readFile(a.vault.file,'utf8'),disk);
  await a.store.updateProject(p.projectId,{name:'更新后的合成项目'});
  await upload(a,p.projectId);
  const plan = await b.call('prepare',{direction:'download',projectIds:[p.projectId]});
  assert.equal(plan.rows[0].conflict,false);
  assert.ok(!JSON.stringify(plan).includes('synthetic-ssh-secret'));
  const restored = await download(b,p.projectId,first.snapshotId);
  assert.equal(restored.results[0].status,'imported');
  const backups = (await b.call('status')).backups;
  assert.ok(backups.length >= 1);
  const localRestore = await b.call('prepareRestore',{backupId:backups[0].backupId});
  assert.equal((await b.call('confirm',{planId:localRestore.planId,choices:{[p.projectId]:'cloud'}})).results[0].status,'imported');
});

test('同名无关联项目不会被覆盖，并发上传及陈旧预览不会写入',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a); await project(b);
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId); await b.call('bind',{url:created.url,password:PASSWORD});
  const imported = await download(b,p.projectId);
  const localId = imported.results[0].projectId;
  assert.notEqual(localId,p.projectId);
  assert.equal((await b.store.listProjects()).length,2);
  const stale = await a.call('prepare',{direction:'upload',projectIds:[p.projectId]});
  await upload(b,localId);
  await assert.rejects(a.call('confirm',{planId:stale.planId,choices:{[p.projectId]:'local'}}),{code:'CLOUD_CONFLICT'});
  const preview = await b.call('prepare',{direction:'download',projectIds:[p.projectId]});
  await b.store.updateProject(localId,{name:'本地另有修改'});
  const result = await b.call('confirm',{planId:preview.planId,choices:{[p.projectId]:'cloud'}});
  assert.equal(result.results[0].error.code,'CLOUD_STALE');
  const conflict = await b.call('prepare',{direction:'download',projectIds:[p.projectId]});
  assert.equal(conflict.rows[0].conflict,true);
  const kept = await b.call('confirm',{planId:conflict.planId,choices:{[p.projectId]:'local'}});
  assert.equal(kept.results[0].status,'skipped');
  assert.equal((await b.store.getProject(localId)).name,'本地另有修改');
});

test('SSH 私钥从文件迁移到目标设备凭据库且既有凭据绑定保持兼容',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await a.store.createProject({projectId:'key-project',name:'私钥测试',environmentId:'key-env'});
  const {privateKey} = crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const keyPath = path.join(a.root,'synthetic-key.pem'); await fs.writeFile(keyPath,privateKey);
  const plugin = await a.store.createPlugin(p.projectId,'key-env',{pluginType:'server',pluginInstanceId:'key-server',displayName:'私钥服务器',target:{host:'key.example.invalid'},auth:{type:'privateKey',username:'tester',privateKeyPath:keyPath}});
  assert.equal(Object.hasOwn(pluginCredentialInternals.bindingProjection(plugin),'privateKeySource'),false);
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId); await b.call('bind',{url:created.url,password:PASSWORD});
  const result = await download(b,p.projectId); assert.equal(result.results[0].status,'imported');
  const imported = await b.store.getPlugin(p.projectId,'key-env','key-server');
  assert.equal(imported.configState,'ready');
  assert.equal(imported.auth.privateKeySource,'vault'); assert.equal(imported.auth.privateKeyPath,undefined);
  assert.equal((await b.vault.load(imported)).privateKeyPem,privateKey);
  assert.ok(!(await fs.readFile(b.vault.file,'utf8')).includes('BEGIN RSA PRIVATE KEY'));
  assert.deepEqual(await exportCloudProject(a.store,a.vault,p.projectId),await exportCloudProject(b.store,b.vault,p.projectId));
});

test('项目事务失败回滚并可在重新启动时恢复，其他项目凭据保持不变',async t => {
  const a = await device(t,new CloudConfigClient()); const p = await project(a); const other = await project(a,'other-project');
  const before = await a.workspace.capture(p.projectId), otherBefore = await a.vault.captureProjectEntries(other.projectId);
  const portable = await exportCloudProject(a.store,a.vault,p.projectId); portable.name = '替换项目';
  const after = await a.workspace.materialize(portable,p.projectId,before);
  const original = a.vault.restoreProjectEntries.bind(a.vault); let attempts = 0;
  a.vault.restoreProjectEntries = async (...args) => { if (++attempts === 1) throw new Error('synthetic write failure'); return original(...args); };
  await assert.rejects(a.workspace.commit(before,after));
  assert.equal(snapshotDigest(await a.workspace.capture(p.projectId)),snapshotDigest(before));
  assert.deepEqual(await a.vault.captureProjectEntries(other.projectId),otherBefore);
  a.vault.restoreProjectEntries = async () => { throw new Error('synthetic persistent failure'); };
  await assert.rejects(a.workspace.commit(before,after),{code:'CLOUD_RECOVERY_REQUIRED'});
  assert.throws(() => a.coordinator.assertProjectAvailable(p.projectId),{code:'CLOUD_RECOVERY_REQUIRED'});
  a.vault.restoreProjectEntries = original;
  const recovered = new CloudConfigWorkspace(a.store,a.vault,a.secure); await recovered.recoverAll();
  assert.equal(recovered.hasUnresolved(),false);
  assert.equal(snapshotDigest(await recovered.capture(p.projectId)),snapshotDigest(before));
});

test('错误密码、链接协议、恶意本机路径、未知插件与缺失依赖均被拒绝',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a);
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await assert.rejects(b.call('bind',{url:created.url,password:'incorrect-password-long-enough'}),{code:'CLOUD_AUTH_FAILED'});
  assert.equal(new CloudConfigClient().repository(created.url).url,created.url);
  assert.throws(() => new CloudConfigClient().repository('https://user:password@example.invalid/r/'+crypto.randomUUID()),{code:'CLOUD_URL_INVALID'});
  const snapshot = {schemaVersion:1,projects:[await exportCloudProject(a.store,a.vault,p.projectId)]};
  const badPath = structuredClone(snapshot); badPath.projects[0].environments[0].plugins[0].config.auth.privateKeyPath = '/local/secret';
  assert.throws(() => normalizeCloudSnapshot(badPath,a.vault),{code:'CLOUD_FORMAT_INVALID'});
  const unknown = structuredClone(snapshot); unknown.projects[0].environments[0].plugins[0].config.pluginType = 'unknown';
  assert.throws(() => normalizeCloudSnapshot(unknown,a.vault),{code:'CLOUD_FORMAT_UNSUPPORTED'});
  snapshot.projects[0].environments[0].plugins.shift();
  assert.throws(() => normalizeCloudSnapshot(snapshot,a.vault),{code:'CLOUD_DEPENDENCY_INVALID'});
});

test('云配置 IPC 拒绝非主窗口与未知请求，不泄露错误详情',async () => {
  const handlers = new Map();
  const sender = {id:1,mainFrame:{},once(){},on(){}};
  registerCloudConfigIpc({handle:(name,fn) => handlers.set(name,fn)},{isWorkspaceRenderer:() => true,cloudConfigService:{invoke:async () => { throw Object.assign(new Error('synthetic-secret'),{details:'synthetic-secret'}); },closeOwner(){}}});
  const call = handlers.get('v2:cloud-config');
  assert.equal((await call({}, {action:'status'})).error.code,'CLOUD_ACCESS_DENIED');
  const event = {sender,senderFrame:sender.mainFrame};
  assert.equal((await call(event,{action:'constructor'})).error.code,'CLOUD_INVALID_ARGUMENT');
  assert.equal((await call(event,{action:'status',password:'synthetic-secret'})).error.code,'CLOUD_INVALID_ARGUMENT');
  assert.ok(!JSON.stringify(await call(event,{action:'status'})).includes('synthetic-secret'));
});

test('活动编辑、活动传输与系统加密不可用时不覆盖项目',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a);
  await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId);
  const before = snapshotDigest(await a.workspace.capture(p.projectId));
  let plan = await a.call('prepare',{direction:'download',projectIds:[p.projectId]});
  a.coordinator.installEnvironmentEditFence(p.projectId,'env-test','synthetic-edit',[]);
  let result = await a.call('confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}});
  assert.equal(result.results[0].error.code,'CLOUD_PROJECT_BUSY');
  a.coordinator.releaseEnvironmentFence('synthetic-edit');
  plan = await a.call('prepare',{direction:'download',projectIds:[p.projectId]});
  a.service.serverWorkspaceFiles = {activeProjectTransfers:() => true};
  result = await a.call('confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}});
  assert.equal(result.results[0].error.code,'CLOUD_PROJECT_BUSY');
  a.service.serverWorkspaceFiles = null;
  plan = await a.call('prepare',{direction:'download',projectIds:[p.projectId]});
  a.secure.isEncryptionAvailable = () => false;
  result = await a.call('confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}});
  assert.equal(result.results[0].status,'failed');
  a.secure.isEncryptionAvailable = () => true;
  assert.equal(snapshotDigest(await a.workspace.capture(p.projectId)),before);
  assert.deepEqual(a.events,[]);
});

test('凭据预览变更、失效确认、跨窗口确认均拒绝且保留未选择项目',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a), other = await project(a,'other-project');
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId); await upload(a,other.projectId);
  await b.call('bind',{url:created.url,password:PASSWORD});
  await download(b,p.projectId);
  assert.equal((await b.store.listProjects()).length,1);
  const plan = await b.call('prepare',{direction:'download',projectIds:[p.projectId]});
  await assert.rejects(b.service.invoke('different-window','confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}}),{code:'CLOUD_PLAN_EXPIRED'});
  const plugin = await b.store.getPlugin(p.projectId,'env-test','server-test');
  await b.vault.save(plugin,{password:'synthetic-changed-password'});
  const failed = await b.call('confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}});
  assert.equal(failed.results[0].error.code,'CLOUD_STALE');
  await assert.rejects(b.call('confirm',{planId:plan.planId,choices:{[p.projectId]:'cloud'}}),{code:'CLOUD_PLAN_EXPIRED'});
  assert.equal((await b.vault.load(plugin)).password,'synthetic-changed-password');
  const otherBefore = snapshotDigest((await a.call('catalog')).projects.find(v => v.projectId === other.projectId));
  await upload(b,p.projectId);
  assert.equal(snapshotDigest((await a.call('catalog')).projects.find(v => v.projectId === other.projectId)),otherBefore);
});

test('恢复已提交事务保留新配置，记住凭据重启后可用且不记住时保持锁定',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a);
  const created = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD,remember:true});
  await upload(a,p.projectId);
  a.service.closeOwner('test-owner');
  assert.equal((await a.call('catalog')).projects.length,1);
  const before = await a.workspace.capture(p.projectId);
  const portable = await exportCloudProject(a.store,a.vault,p.projectId); portable.name = '已提交的新配置';
  const after = await a.workspace.materialize(portable,p.projectId,before);
  const id = crypto.randomUUID();
  await a.workspace.replace(after,before);
  await a.workspace.writeSealed(path.join(a.workspace.directory,'transactions',id+'.json'),{schemaVersion:1,id,projectId:p.projectId,createdAt:new Date().toISOString(),phase:'committed',before,after});
  const recovered = new CloudConfigWorkspace(a.store,a.vault,a.secure); await recovered.recoverAll();
  assert.equal((await a.store.getProject(p.projectId)).name,'已提交的新配置');
  await a.call('bind',{url:created.url,password:PASSWORD,remember:false});
  a.service.closeOwner('test-owner');
  await assert.rejects(a.call('catalog'),{code:'CLOUD_LOCKED'});
  const saved = await fs.readFile(a.service.stateFile,'utf8');
  assert.ok(!saved.includes(PASSWORD));
});

test('多仓库复制生成独立 ID，检测不写配置，隐藏只改变本机显示，解除单仓库保留数据',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a);
  const one = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD,remember:true,name:'合成仓库一'});
  await a.call('sync',{repositoryId:one.repositoryId,direction:'upload',projectId:p.projectId});
  const two = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD,remember:true,name:'合成仓库二'});
  await a.call('sync',{repositoryId:two.repositoryId,direction:'upload',projectId:p.projectId});
  const before = snapshotDigest(await a.workspace.capture(p.projectId));
  const status = await a.call('check');
  assert.equal(status.repositories.length,2);
  const first = status.cloudProjects.find(p => p.repositoryId === one.repositoryId), second = status.cloudProjects.find(p => p.repositoryId === two.repositoryId);
  assert.notEqual(first.projectId,second.projectId);
  assert.match(first.projectId,/^project-[a-f0-9-]{36}$/);
  assert.equal(second.downloaded,false);
  assert.equal(second.localId,null);
  assert.equal((await a.store.listProjects()).length,1);
  assert.equal(snapshotDigest(await a.workspace.capture(p.projectId)),before);
  assert.equal((await a.call('sync',{repositoryId:two.repositoryId,direction:'download',projectId:second.projectId})).results[0].status,'imported');
  assert.equal((await a.store.listProjects()).length,2);
  await a.store.updateProject(second.projectId,{name:'独立副本'});
  assert.equal((await a.store.getProject(p.projectId)).name,'合成测试项目');
  await a.call('visibility',{repositoryId:one.repositoryId,projectIds:[first.projectId],visible:false});
  const hidden = await a.call('check');
  assert.equal(hidden.cloudProjects.find(p => p.repositoryId === one.repositoryId).visible,false);
  assert.equal(hidden.cloudProjects.find(p => p.repositoryId === two.repositoryId).visible,true);
  assert.equal((await a.store.listProjects()).length,2);
  await assert.rejects(a.call('visibility',{repositoryId:two.repositoryId,projectIds:[first.projectId],visible:false}),{code:'CLOUD_INVALID_ARGUMENT'});
  await assert.rejects(a.call('sync',{repositoryId:crypto.randomUUID(),direction:'upload',projectId:p.projectId}),{code:'CLOUD_NOT_FOUND'});
  const reloaded = await device(t,remote.client);
  await reloaded.workspace.writeSealed(reloaded.service.stateFile,a.service.state);
  await reloaded.service.init();
  assert.equal((await reloaded.call('status')).repositories.length,2);
  await a.call('unbind',{repositoryId:one.repositoryId});
  const unbound = await a.call('status');
  assert.equal(unbound.repositories.length,1);
  assert.equal(unbound.cloudProjects[0].repositoryId,two.repositoryId);
  assert.equal((await a.store.listProjects()).length,2);
  assert.ok(!JSON.stringify(status).includes('synthetic-ssh-secret'));
  assert.ok(!JSON.stringify(status).includes('digest'));
});

test('显式更新直接覆盖已知旧版本，未知修改需一次性确认，检测及取消不覆盖',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a);
  const one = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  await upload(a,p.projectId);
  const two = await b.call('bind',{url:one.url,password:PASSWORD});
  const sync = (device,repositoryId,direction) => device.call('sync',{repositoryId,direction,projectId:p.projectId});
  await sync(b,two.repositoryId,'download');
  await a.store.updateProject(p.projectId,{name:'云端第二版'});
  await sync(a,one.repositoryId,'upload');
  assert.equal((await b.call('check')).cloudProjects[0].syncStatus,'behind');
  assert.equal((await b.store.getProject(p.projectId)).name,'合成测试项目');
  const clean = await sync(b,two.repositoryId,'download');
  assert.equal(clean.planId,undefined);
  assert.equal(clean.results[0].status,'imported');
  assert.equal((await b.store.getProject(p.projectId)).name,'云端第二版');
  await b.store.updateProject(p.projectId,{name:'仅在本地修改'});
  assert.equal((await b.call('check')).cloudProjects[0].syncStatus,'modified');
  const conflict = await sync(b,two.repositoryId,'download');
  assert.ok(conflict.planId);
  assert.equal(conflict.rows[0].conflict,true);
  assert.equal((await b.store.getProject(p.projectId)).name,'仅在本地修改');
  const confirmed = await b.call('confirm',{planId:conflict.planId,choices:{[conflict.rows[0].rowId]:'cloud'}});
  assert.equal(confirmed.results[0].status,'imported');
  await assert.rejects(b.call('confirm',{planId:conflict.planId,choices:{[conflict.rows[0].rowId]:'cloud'}}),{code:'CLOUD_PLAN_EXPIRED'});
  // 回到更早的、不是最近同步基线的云端版本，也应通过哈希识别后直接更新。
  await b.service.saveRepository({...b.service.repository(two.repositoryId),hashes:{}});
  await b.store.updateProject(p.projectId,{name:'合成测试项目'});
  const old = await sync(b,two.repositoryId,'download');
  assert.equal(old.planId,undefined);
  assert.equal(old.results[0].status,'imported');
  assert.equal((await b.store.getProject(p.projectId)).name,'云端第二版');
});

test('单项目上传硬覆盖并保留其他云项目，整库更新包含隐藏项目且不下载未打开项目',async t => {
  const remote = await cloud(t), a = await device(t,remote.client), b = await device(t,remote.client);
  const p = await project(a), other = await project(a,'other-project');
  const one = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  for (const item of [p,other]) await upload(a,item.projectId);
  const two = await b.call('bind',{url:one.url,password:PASSWORD});
  await b.call('check');
  await b.call('sync',{repositoryId:two.repositoryId,direction:'download',projectId:p.projectId});
  await b.call('visibility',{repositoryId:two.repositoryId,projectIds:[p.projectId],visible:false});
  await a.store.updateProject(p.projectId,{name:'来自设备一'});
  await a.call('sync',{repositoryId:one.repositoryId,direction:'upload',projectId:p.projectId});
  await b.store.updateProject(p.projectId,{name:'强制上传设备二'});
  const uploaded = await b.call('sync',{repositoryId:two.repositoryId,direction:'upload',projectId:p.projectId});
  assert.equal(uploaded.planId,undefined);
  assert.equal(uploaded.results[0].status,'uploaded');
  const catalog = await b.call('catalog',{repositoryId:two.repositoryId});
  assert.equal(catalog.projects.length,2);
  assert.equal(catalog.projects.find(item => item.projectId === p.projectId).name,'强制上传设备二');
  await a.call('sync',{repositoryId:one.repositoryId,direction:'upload',projectId:p.projectId});
  const bulk = await b.call('sync',{repositoryId:two.repositoryId,direction:'download'});
  assert.equal(bulk.results.length,1);
  assert.equal(bulk.results[0].status,'imported');
  assert.equal((await b.store.listProjects()).length,1);
  assert.equal((await b.store.getProject(p.projectId)).name,'来自设备一');
  assert.equal((await b.call('status')).cloudProjects.find(item => item.projectId === p.projectId).visible,false);
  await assert.rejects(b.call('sync',{repositoryId:two.repositoryId,direction:'upload'}),{code:'CLOUD_INVALID_ARGUMENT'});
});

test('旧单仓库状态自动迁移且保留关联、密码与旧版本更新基线',async t => {
  const remote = await cloud(t), a = await device(t,remote.client);
  const p = await project(a);
  await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD,remember:true});
  await upload(a,p.projectId);
  const {repositoryId, ...repository} = a.service.state.repositories[0];
  const mappings = a.service.state.mappings.map(({repositoryId,...mapping}) => mapping);
  await a.workspace.writeSealed(a.service.stateFile,{schemaVersion:1,repository,mappings});
  a.service.closeOwner('test-owner');
  await a.service.init();
  assert.equal(a.service.state.schemaVersion,2);
  const status = await a.call('check');
  assert.equal(status.repositories.length,1);
  assert.equal(status.repositories[0].remembered,true);
  assert.equal(status.cloudProjects[0].syncStatus,'synced');
  assert.equal(status.cloudProjects[0].localId,p.projectId);
  assert.notEqual(status.repositories[0].repositoryId,repositoryId);
});

test('手动硬上传在条件提交冲突后读取新版本重试，保留并发设备对其他项目的更新',async t => {
  const remote = await cloud(t), a = await device(t,new CloudConfigClient()), b = await device(t,new CloudConfigClient());
  const p = await project(a), other = await project(a,'other-project');
  const one = await a.call('create',{serviceUrl:remote.origin,adminToken:ADMIN,password:PASSWORD});
  for (const item of [p,other]) await upload(a,item.projectId);
  const two = await b.call('bind',{url:one.url,password:PASSWORD});
  await b.call('sync',{repositoryId:two.repositoryId,direction:'download',projectId:other.projectId});
  await b.store.updateProject(other.projectId,{name:'并发设备更新其他项目'});
  await a.store.updateProject(p.projectId,{name:'当前设备手动硬上传'});
  const original = a.service.client.call.bind(a.service.client);
  let raced = false;
  a.service.client.call = async (session,resource,options) => {
    if (!raced && resource === 'snapshots' && options?.method === 'POST') {
      raced = true;
      await b.call('sync',{repositoryId:two.repositoryId,direction:'upload',projectId:other.projectId});
    }
    return original(session,resource,options);
  };
  const result = await a.call('sync',{repositoryId:one.repositoryId,direction:'upload',projectId:p.projectId});
  assert.equal(raced,true);
  assert.equal(result.results[0].status,'uploaded');
  const catalog = await a.call('catalog',{repositoryId:one.repositoryId});
  assert.equal(catalog.projects.find(item => item.projectId === p.projectId).name,'当前设备手动硬上传');
  assert.equal(catalog.projects.find(item => item.projectId === other.projectId).name,'并发设备更新其他项目');
});
