import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { AppError } from '../src/errors.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { PluginConfigTransactionJournal } from '../src/plugin-config-transaction.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function temporaryRoot(t, prefix = 'ai-ops-connection-characterization-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}

function plainEncryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

async function committedMysqlFixture(t) {
  const root = await temporaryRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({ migrateLegacy:false });
  const project = await store.createProject({ name:'Characterization', environmentName:'Production' });
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType:'mysql',
    pluginInstanceId:'orders-db',
    displayName:'Orders database',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},
    transport:{kind:'direct'},
    tls:{mode:'required'},
    password:'must-not-reach-yaml',
    secrets:{password:'must-not-reach-yaml'},
    ciphertext:'must-not-reach-yaml',
  });
  return {root,store,project,environment,plugin};
}

test('committed plugin YAML is allow-listed and preparing an update has no disk side effects', async (t) => {
  const {store,project,environment,plugin} = await committedMysqlFixture(t);
  const file = store.pluginPath(project.projectId, environment.environmentId, plugin.pluginInstanceId);
  const before = await fs.readFile(file);
  const beforeStat = await fs.stat(file);
  const document = parse(before.toString('utf8'));

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.revision, 1);
  assert.equal(document.configState, 'ready');
  assert.equal(document.target.database, 'orders');
  assert.equal('password' in document, false);
  assert.equal('secrets' in document, false);
  assert.equal('ciphertext' in document, false);
  assert.doesNotMatch(before.toString('utf8'), /must-not-reach-yaml/u);

  const prepared = await store.preparePluginUpdate(
    project.projectId,
    environment.environmentId,
    plugin.pluginInstanceId,
    {displayName:'Renamed database'},
    plugin.revision,
  );
  assert.equal(prepared.before.revision, 1);
  assert.equal(prepared.after.revision, 2);
  assert.equal(prepared.after.displayName, 'Renamed database');
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mtimeMs, beforeStat.mtimeMs);
});

test('credential reads merge independently durable slots without rewriting either slot', async (t) => {
  const root = await temporaryRoot(t, 'ai-ops-vault-slots-');
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',
    displayName:'Server',revision:1,target:{host:'server.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'},uplink:{type:'http',host:'proxy.internal',port:8080,username:'proxy'},
  };
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {
    password:'old-primary',
    proxyPassword:'backup-only-proxy',
    privateKeyPassphrase:'backup-only-key',
  });

  const primaryEnvelope = JSON.parse(await fs.readFile(vault.file, 'utf8'));
  const resource = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
  primaryEnvelope.entries[resource].ciphertext = Buffer.from(JSON.stringify({
    schemaVersion:1,
    secrets:{password:'new-primary'},
  }), 'utf8').toString('base64');
  await fs.writeFile(vault.file, JSON.stringify(primaryEnvelope, null, 2), 'utf8');
  const primaryBefore = await fs.readFile(vault.file);
  const backupBefore = await fs.readFile(vault.backupFile);

  assert.deepEqual(await vault.load(plugin), {
    password:'new-primary',
    proxyPassword:'backup-only-proxy',
    privateKeyPassphrase:'backup-only-key',
  });
  assert.deepEqual(await fs.readFile(vault.file), primaryBefore);
  assert.deepEqual(await fs.readFile(vault.backupFile), backupBefore);
});

test('a pending journal cleanup keeps the committed YAML and credential binding authoritative', async (t) => {
  const {root,store,project,environment,plugin} = await committedMysqlFixture(t);
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {password:'old-password',tlsPassphrase:'preserved-passphrase'});
  const journal = new PluginConfigTransactionJournal(root, store, vault);
  journal.complete = async () => {
    throw new AppError(
      'CONFIG_TRANSACTION_CLEANUP_PENDING',
      '配置和密码已安全保存，但提交记录暂时无法清理。',
    );
  };

  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined}, {
    workspaceStore:store,
    credentialVault:vault,
    configTransactionJournal:journal,
    connectionManager:{
      on:() => undefined,
      beginConfigurationMutation:() => 'fence-1',
      endConfigurationMutation:() => true,
      configurationChanged:async () => ({}),
    },
    contextManager:{invalidateEnvironment:() => undefined},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
  });

  const result = await handlers.get('v2:plugin-update')({}, {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
    expectedRevision:plugin.revision,
    patch:{target:{...plugin.target,host:'db-new.internal'}},
    secrets:{password:'new-password'},
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.revision, 2);
  assert.equal(result.data.persistenceWarning.code, 'CONFIG_TRANSACTION_CLEANUP_PENDING');
  const committed = await store.getPlugin(project.projectId, environment.environmentId, plugin.pluginInstanceId);
  assert.equal(committed.target.host, 'db-new.internal');
  assert.deepEqual(await vault.load(committed), {
    password:'new-password',
    tlsPassphrase:'preserved-passphrase',
  });
  await assert.rejects(() => vault.load(plugin), (error) => error.code === 'CREDENTIAL_BINDING_MISMATCH');
  const journalFiles = await fs.readdir(journal.directory);
  assert.equal(journalFiles.length, 1);
});

test('unexpected IPC failures use the stable redacted public error envelope', async () => {
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined}, {
    workspaceStore:{listProjects:async () => { throw new Error('password=do-not-leak'); }},
    connectionManager:{on:() => undefined},
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
  });

  const result = await handlers.get('v2:project-list')({});
  assert.deepEqual(result, {
    ok:false,
    error:{code:'INTERNAL_ERROR',message:'操作失败，请查看本地诊断日志。'},
  });
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|password=/u);
});

test('runtime snapshots are detached, complete, and advance a monotonic sequence', async () => {
  const server = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',
    displayName:'Server',revision:1,configState:'ready',transport:{kind:'direct'},
  };
  const redis = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'redis-1',pluginType:'redis',
    displayName:'Redis',revision:1,configState:'ready',transport:{kind:'direct'},
  };
  const plugins = [server,redis];
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async () => plugins,
    getPlugin:async (_projectId,_environmentId,id) => plugins.find((item) => item.pluginInstanceId === id),
    appendAudit:async () => undefined,
  };
  const runtime = {
    connect:async () => ({connectedAt:'now'}),
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store, runtime, {retryDelays:[]});
  const connected = await manager.connect('p1','e1');
  assert.deepEqual(Object.keys(connected.plugins).sort(), ['redis-1','server-1']);
  const connectedSequence = connected.sequence;

  connected.plugins['server-1'].phase = 'tampered';
  connected.manualDisconnected['server-1'] = true;
  const untouched = manager.snapshot('p1','e1');
  assert.equal(untouched.plugins['server-1'].phase, 'connected');
  assert.equal(untouched.manualDisconnected['server-1'], undefined);

  const disconnected = await manager.disconnect('p1','e1');
  assert.ok(disconnected.sequence > connectedSequence);
  assert.deepEqual(Object.keys(disconnected.plugins).sort(), ['redis-1','server-1']);
});

test('a late timed-out connection attempt cannot disconnect the newer owner', async () => {
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',
    displayName:'MySQL',revision:1,configState:'ready',limits:{timeoutMs:5_000},
  };
  let releaseFirst;
  let calls = 0;
  const attemptTokens = [];
  const forceDisconnects = [];
  const manager = new EnvironmentConnectionManager({}, {
    connect:async (_plugin,_secrets,{attemptToken}) => {
      calls += 1;
      attemptTokens.push(attemptToken);
      if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return {connectedAt:`attempt-${calls}`};
    },
    disconnect:async () => ({connected:false}),
    forceDisconnect:async (_plugin,reason,{attemptToken} = {}) => {
      forceDisconnects.push({reason,attemptToken});
      return {connected:false,forced:true};
    },
  }, {connectDeadlineMs:20,retryDelays:[]});

  await assert.rejects(
    () => manager.connectRuntime(plugin),
    (error) => error.code === 'CONNECT_TIMEOUT',
  );
  const second = await manager.connectRuntime(plugin);
  assert.equal(second.connectedAt, 'attempt-2');
  releaseFirst();
  await delay(20);

  assert.deepEqual(attemptTokens, [1,2]);
  assert.deepEqual(forceDisconnects, []);
  assert.equal(manager.runtimeConnectAttempts.size, 0);
});
