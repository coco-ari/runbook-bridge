import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.mjs';
import { WorkspaceStore, workspaceInternals } from '../src/workspace-store.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyStore = new ProjectStore(root);
  const store = new WorkspaceStore(root, { legacyStore });
  await store.init();
  return { root, legacyStore, store };
}

test('workspace creates independent environments and database-granular plugins', async (t) => {
  const { store } = await fixture(t);
  const project = await store.createProject({ name: '会员服务', environmentName: '华东正式' });
  const [east] = await store.listEnvironments(project.projectId);
  const server = await store.createPlugin(project.projectId, east.environmentId, {
    pluginType: 'server',
    pluginInstanceId: 'app-server',
    displayName: '应用服务器',
    target: { host: '10.0.0.10', port: 22 },
    auth: { type: 'password', username: 'reader' },
  });
  const mysql = await store.createPlugin(project.projectId, east.environmentId, {
    pluginType: 'mysql',
    pluginInstanceId: 'member-db',
    displayName: '会员主库',
    target: { host: '127.0.0.1', port: 3306, database: 'member' },
    auth: { username: 'member_reader' },
    transport: { kind: 'serverTunnel', serverPluginInstanceId: server.pluginInstanceId },
  });
  assert.equal(mysql.target.database, 'member');
  assert.equal('databases' in mysql, false);
  assert.equal(mysql.transport.serverPluginInstanceId, server.pluginInstanceId);
  const [overviewEnvironment] = await store.listEnvironments(project.projectId);
  assert.deepEqual(overviewEnvironment.resourcePreview.map((item) => item.displayName), ['应用服务器','会员主库']);
  assert.deepEqual(overviewEnvironment.resourcePreview.map((item) => item.resource), [{host:'10.0.0.10',port:22},{database:'member'}]);
  assert.doesNotMatch(JSON.stringify(overviewEnvironment.resourcePreview), /auth|password|username|reader/i);
  const gray = await store.createEnvironment(project.projectId, { name: '灰度一组' });
  assert.notEqual(gray.environmentId, east.environmentId);
  assert.equal((await store.readRunbook(project.projectId, gray.environmentId)).empty, false);
  assert.equal((await store.listPlugins(project.projectId, gray.environmentId)).length, 0);
});

test('projects can be renamed and deleted with all nested workspace data', async (t) => {
  const { root, store } = await fixture(t);
  const project = await store.createProject({ name:'旧项目名称', environmentName:'生产环境' });
  const [environment] = await store.listEnvironments(project.projectId);
  await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType:'server', displayName:'应用服务器', target:{host:'127.0.0.1'}, auth:{username:'reader'},
  });
  const renamed = await store.updateProject(project.projectId, { name:'新项目名称' }, project.revision);
  assert.equal(renamed.name, '新项目名称');
  const deleted = await store.deleteProject(project.projectId);
  assert.deepEqual({ name:deleted.name, environmentCount:deleted.environmentCount, pluginCount:deleted.pluginCount }, { name:'新项目名称', environmentCount:1, pluginCount:1 });
  await assert.rejects(() => store.getProject(project.projectId), (error) => error.code === 'PROJECT_NOT_FOUND');
  await assert.rejects(() => fs.access(path.join(root, 'projects', project.projectId)));
});

test('operation records can be cleared by current plugin or environment without touching other scopes', async (t) => {
  const { store } = await fixture(t);
  const project = await store.createProject({ name:'审计范围', environmentName:'生产环境' });
  const [production] = await store.listEnvironments(project.projectId);
  const staging = await store.createEnvironment(project.projectId,{ name:'预发环境' });
  const server = await store.createPlugin(project.projectId, production.environmentId, {
    pluginType:'server',displayName:'应用服务器',target:{host:'server.internal'},auth:{username:'reader'},
  });
  const database = await store.createPlugin(project.projectId, production.environmentId, {
    pluginType:'mysql',displayName:'业务数据库',target:{host:'db.internal',database:'orders'},auth:{username:'reader'},
  });
  await store.appendAudit(project.projectId,{ environmentId:production.environmentId, pluginInstanceId:server.pluginInstanceId, type:'plugin-operation', result:'success' });
  await store.appendAudit(project.projectId,{ environmentId:production.environmentId, pluginInstanceId:database.pluginInstanceId, type:'plugin-operation', result:'success' });
  await store.appendAudit(project.projectId,{ environmentId:production.environmentId, type:'environment-disconnected', result:'success' });
  await store.appendAudit(project.projectId,{ environmentId:staging.environmentId, type:'environment-disconnected', result:'success' });

  const pluginResult = await store.clearAudit(project.projectId,{ environmentId:production.environmentId, pluginInstanceId:server.pluginInstanceId });
  assert.equal(pluginResult.deletedCount,1);
  assert.deepEqual((await store.listAudit(project.projectId,{ environmentId:production.environmentId })).entries.map((entry) => entry.pluginInstanceId ?? null),[null,database.pluginInstanceId]);

  const environmentResult = await store.clearAudit(project.projectId,{ environmentId:production.environmentId });
  assert.equal(environmentResult.deletedCount,2);
  assert.equal((await store.listAudit(project.projectId,{ environmentId:production.environmentId })).entries.length,0);
  assert.equal((await store.listAudit(project.projectId,{ environmentId:staging.environmentId })).entries.length,1);
});

test('formal creation rejects incomplete plugins while legacy draft snapshots remain readable', async (t) => {
  const { store } = await fixture(t);
  const project = await store.createProject({ name:'越南项目', environmentName:'测试环境' });
  const [environment] = await store.listEnvironments(project.projectId);
  for (const [pluginType, displayName] of [['server','应用服务器'],['mysql','业务数据库'],['redis','业务缓存']]) {
    await assert.rejects(
      () => store.createPlugin(project.projectId,environment.environmentId,{pluginType,displayName}),
      (error) => error.code === 'PLUGIN_CONFIGURATION_INCOMPLETE',
    );
  }
  assert.equal((await store.listPlugins(project.projectId,environment.environmentId)).length,0);

  const legacy = workspaceInternals.normalizePlugin(
    {pluginType:'server',pluginInstanceId:'legacy-server',displayName:'旧版待配置服务器'},
    {projectId:project.projectId,environmentId:environment.environmentId},
  );
  assert.equal(legacy.configState,'draft');
  await store.commitNewPluginSnapshot(legacy);
  assert.equal(
    (await store.getPlugin(project.projectId,environment.environmentId,legacy.pluginInstanceId)).configState,
    'draft',
  );
});

test('formal connection updates cannot persist an incomplete candidate', async (t) => {
  const {store} = await fixture(t);
  const project = await store.createProject({name:'订单服务',environmentName:'生产环境'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'mysql',pluginInstanceId:'orders-db',displayName:'订单库',
    target:{host:'db.internal',database:'orders'},auth:{username:'reader'},transport:{kind:'direct'},
  });
  const file = store.pluginPath(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  const before = await fs.readFile(file);

  await assert.rejects(
    () => store.preparePluginConnectionUpdate(
      project.projectId,environment.environmentId,plugin.pluginInstanceId,
      {target:{...plugin.target,database:''}},plugin.revision,
    ),
    (error) => error.code === 'PLUGIN_CONFIGURATION_INCOMPLETE'
      && error.details?.issues?.[0]?.field === 'target.database',
  );
  assert.deepEqual(await fs.readFile(file),before);
  assert.equal((await store.getPlugin(project.projectId,environment.environmentId,plugin.pluginInstanceId)).revision,plugin.revision);
});

test('workspace rejects cross-environment tunnel references and protects providers', async (t) => {
  const { store } = await fixture(t);
  const project = await store.createProject({ name: '订单服务', environmentName: '环境 A' });
  const [environmentA] = await store.listEnvironments(project.projectId);
  const environmentB = await store.createEnvironment(project.projectId, { name: '环境 B' });
  const server = await store.createPlugin(project.projectId, environmentA.environmentId, {
    pluginType: 'server', pluginInstanceId: 'server-a', displayName: 'Server A',
    target: { host: '127.0.0.1' }, auth: { username: 'reader' },
  });
  await assert.rejects(
    () => store.createPlugin(project.projectId, environmentB.environmentId, {
      pluginType: 'mysql', pluginInstanceId: 'db-b', displayName: 'DB B',
      target: { host: '127.0.0.1', database: 'orders' }, auth: { username: 'reader' },
      transport: { kind: 'serverTunnel', serverPluginInstanceId: server.pluginInstanceId },
    }),
    (error) => ['PLUGIN_NOT_FOUND', 'SCOPE_MISMATCH'].includes(error.code),
  );
  await store.createPlugin(project.projectId, environmentA.environmentId, {
    pluginType: 'redis', pluginInstanceId: 'cache-a', displayName: 'Cache A',
    target: { host: '127.0.0.1', db: 2 },
    transport: { kind: 'serverTunnel', serverPluginInstanceId: server.pluginInstanceId },
  });
  await assert.rejects(
    () => store.deletePlugin(project.projectId, environmentA.environmentId, server.pluginInstanceId),
    (error) => error.code === 'PLUGIN_HAS_DEPENDENTS',
  );
});

test('legacy projects are materialized without overwriting project.yaml', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-migrate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyStore = new ProjectStore(root);
  const legacy = await legacyStore.create({
    id: 'legacy-project', name: '旧项目',
    ssh: { host: '10.0.0.8', port: 2202, username: 'deploy' },
    auth: { type: 'password' }, proxy: { type: 'direct' },
  });
  const originalYaml = await fs.readFile(path.join(legacyStore.projectDir(legacy.id), 'project.yaml'), 'utf8');
  const store = new WorkspaceStore(root, { legacyStore });
  const migrated = await store.init();
  assert.equal(migrated, undefined);
  const [environment] = await store.listEnvironments(legacy.id);
  const [plugin] = await store.listPlugins(legacy.id, environment.environmentId);
  assert.equal(plugin.pluginType, 'server');
  assert.equal(plugin.legacyProjectId, legacy.id);
  assert.equal(plugin.target.host, '10.0.0.8');
  assert.equal(await fs.readFile(path.join(legacyStore.projectDir(legacy.id), 'project.yaml'), 'utf8'), originalYaml);
});

test('plugin credentials are encrypted and bound to the exact resource', async (t) => {
  const { root, store } = await fixture(t);
  const project = await store.createProject({ name: '支付中心' });
  const [environment] = await store.listEnvironments(project.projectId);
  const mysql = await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType: 'mysql', pluginInstanceId: 'pay-db', displayName: '支付库',
    target: { host: 'db.internal', database: 'payment' }, auth: { username: 'reader' },
  });
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '').replace(/.+/, (encoded) => Buffer.from(encoded, 'base64').toString()),
  };
  const vault = new PluginCredentialVault(root, encryption);
  await vault.save(mysql, { password: 'very-secret' });
  assert.deepEqual(await vault.load(mysql), { password: 'very-secret' });
  const disk = await fs.readFile(path.join(root, 'credentials', 'plugins.enc.json'), 'utf8');
  const backup = await fs.readFile(path.join(root, 'credentials', 'plugins.enc.backup.json'), 'utf8');
  assert.equal(disk.includes('very-secret'), false);
  assert.equal(backup.includes('very-secret'), false);
  await fs.writeFile(path.join(root, 'credentials', 'plugins.enc.json'), '{broken', 'utf8');
  assert.deepEqual(await vault.load(mysql), { password: 'very-secret' });
  assert.deepEqual(await vault.clear(mysql), { cleared:false, preserved:true });
  assert.deepEqual(await vault.load(mysql), { password: 'very-secret' });
  const changed = { ...mysql, target: { ...mysql.target, host: 'other.internal' } };
  await assert.rejects(() => vault.load(changed), (error) => error.code === 'CREDENTIAL_BINDING_MISMATCH');
});

test('credential updates merge fields and rebind saved secrets to an edited target', async (t) => {
  const { root, store } = await fixture(t);
  const project = await store.createProject({ name: '网关服务' });
  const [environment] = await store.listEnvironments(project.projectId);
  const server = await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType: 'server', pluginInstanceId: 'gateway-server', displayName: '网关服务器',
    target: { host: 'old.internal', port: 22 }, auth: { type: 'password', username: 'reader' },
    uplink: { type: 'http', host: 'proxy.internal', port: 8080, username: 'proxy-user' },
  });
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '').replace(/.+/, (encoded) => Buffer.from(encoded, 'base64').toString()),
  };
  const vault = new PluginCredentialVault(root, encryption);
  await vault.save(server, { password: 'ssh-secret', proxyPassword: 'old-proxy-secret' });
  const changed = { ...server, target: { ...server.target, host: 'new.internal' }, revision: server.revision + 1 };
  await vault.saveMerged(server, changed, { proxyPassword: 'new-proxy-secret' });
  assert.deepEqual(await vault.load(changed), { password: 'ssh-secret', proxyPassword: 'new-proxy-secret' });
});
