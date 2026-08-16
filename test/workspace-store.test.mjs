import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';
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
  const gray = await store.createEnvironment(project.projectId, { name: '灰度一组' });
  assert.notEqual(gray.environmentId, east.environmentId);
  assert.equal((await store.readRunbook(project.projectId, gray.environmentId)).empty, false);
  assert.equal((await store.listPlugins(project.projectId, gray.environmentId)).length, 0);
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
  assert.equal(disk.includes('very-secret'), false);
  const changed = { ...mysql, target: { ...mysql.target, host: 'other.internal' } };
  await assert.rejects(() => vault.load(changed), (error) => error.code === 'CREDENTIAL_BINDING_MISMATCH');
});
