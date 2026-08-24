import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { CredentialStore, legacyCredentialConfigForPlugin, migrateLegacyCredentialForPlugin } from '../src/credential-store.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { NetworkChangeWatcher } from '../src/network-change-watcher.mjs';
import { PluginCredentialVault, pluginCredentialInternals } from '../src/plugin-credential-vault.mjs';
import { PluginConfigTransactionJournal } from '../src/plugin-config-transaction.mjs';
import { AddressResolver, RouteManager } from '../src/route-manager.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { ProjectStore } from '../src/project-store.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function connectionPlugin(id, type = 'mysql') {
  return {
    projectId:'p1', environmentId:'e1', pluginInstanceId:id, pluginType:type,
    displayName:id, revision:1, configState:'ready', transport:{kind:'direct'},
    limits:{timeoutMs:5_000},
  };
}

function plainEncryption(control = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => {
      if (control.failDecrypt) throw new Error('temporary decrypt failure');
      return Buffer.from(value).toString('utf8');
    },
  };
}

function vaultPlugin(overrides = {}) {
  return {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'server-1', pluginType:'server',
    displayName:'Server', revision:1,
    target:{host:'old.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'}, uplink:{type:'http',host:'proxy.internal',port:8080,username:'proxy'},
    tls:{mode:'disabled'},
    ...overrides,
  };
}

async function tempRoot(t, prefix = 'ai-ops-resilience-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}

test('cancelling an environment removes queued connection permits before they start', async () => {
  const plugins = Array.from({ length:6 }, (_, index) => connectionPlugin(`db-${index + 1}`));
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const starts = [];
  const disconnects = new Map();
  const audits = [];
  const runtime = {
    connect: async (plugin) => {
      starts.push(plugin.pluginInstanceId);
      if (plugin === plugins[0]) await firstPending;
      return { connectedAt:'now' };
    },
    disconnect: async (plugin) => { disconnects.set(plugin.pluginInstanceId, (disconnects.get(plugin.pluginInstanceId) ?? 0) + 1); return { connected:false }; },
    forceDisconnect: async () => ({ connected:false, forced:true }),
    closeAll: async () => undefined,
  };
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async () => plugins,
    getPlugin:async (_projectId, _environmentId, id) => plugins.find((plugin) => plugin.pluginInstanceId === id),
    appendAudit:async (_projectId, entry) => { audits.push(entry); },
  };
  const manager = new EnvironmentConnectionManager(store, runtime, { maxConcurrency:1, retryDelays:[] });
  const connecting = manager.connect('p1', 'e1');
  while (starts.length === 0) await delay(1);
  manager.cancel('p1', 'e1');
  await Promise.race([
    connecting,
    delay(500).then(() => { throw new Error('cancel did not release queued permits'); }),
  ]);
  assert.deepEqual(starts, ['db-1']);
  assert.equal(manager.snapshot('p1', 'e1').desiredConnected, false);
  while (manager.cancelCleanups.size) await delay(1);
  assert.equal(manager.connectWaiters.length, 0);
  assert.deepEqual([...disconnects.values()], [1,1,1,1,1,1]);
  const cancellationAudits = audits.filter((entry) => entry.type === 'environment-connect-cancelled');
  const nodeAudits = audits.filter((entry) => entry.type === 'plugin-connected');
  assert.equal(cancellationAudits.length, 1);
  assert.equal(nodeAudits.length, plugins.length);
  assert.ok(nodeAudits.every((entry) => entry.planId && entry.operationId));
  releaseFirst();
  await delay(5);
  assert.deepEqual([...disconnects.values()], [1,1,1,1,1,1], 'late success uses the force fence, not a second graceful cleanup');
});

test('cancel followed immediately by reconnect queues stale cleanup before the new session', async () => {
  const plugin = connectionPlugin('db-1');
  let connectCalls = 0;
  let liveSession = null;
  const disconnectReasons = [];
  const runtime = {
    connect:async (_plugin, _secrets, {signal} = {}) => {
      connectCalls += 1;
      const generation = connectCalls;
      if (generation === 1) {
        await new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('cancelled'), {code:'CONNECT_CANCELLED'}));
          signal?.addEventListener('abort', abort, {once:true});
        });
      }
      liveSession = generation;
      return {connectedAt:`session-${generation}`};
    },
    disconnect:async (_plugin, reason) => { disconnectReasons.push(reason); liveSession = null; return {connected:false}; },
    forceDisconnect:async () => { liveSession = null; return {connected:false,forced:true}; },
    closeAll:async () => undefined,
  };
  const store = {
    getEnvironment:async () => ({revision:1}),listPlugins:async () => [plugin],getPlugin:async () => plugin,appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store, runtime, {retryDelays:[]});
  const first = manager.connect('p1','e1');
  while (connectCalls === 0) await delay(1);
  manager.cancel('p1','e1');
  const second = manager.connect('p1','e1');
  await first;
  const connected = await second;
  assert.equal(connected.phase, 'connected');
  assert.equal(liveSession, 2);
  assert.deepEqual(disconnectReasons, ['user-cancel']);
});

test('an aborted SSH connect waiting in the broker queue never starts', async () => {
  const broker = new SshBroker({});
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const first = broker.runConnectionOperation('server-1', () => firstPending);
  let connectCalls = 0;
  broker.connectUnlocked = async () => {
    connectCalls += 1;
    return { connectedAt:'unexpected' };
  };
  const controller = new AbortController();
  const queued = broker.connect('server-1', {}, {signal:controller.signal});
  controller.abort();
  releaseFirst();
  await first;
  await assert.rejects(
    queued,
    (error) => error.code === 'SSH_CONNECTION_CANCELLED',
  );
  assert.equal(connectCalls,0);
  assert.equal(broker.connectionOperations.size,0);
});

test('cancelling an active SSH handshake settles the broker queue', async () => {
  let announceConnect;
  const connectStarted = new Promise((resolve) => { announceConnect = resolve; });
  const client = new EventEmitter();
  client.connect = () => announceConnect();
  client.end = () => queueMicrotask(() => client.emit('close'));
  const broker = new SshBroker({
    get:async () => ({
      ssh:{host:'server.internal',port:22,username:'root'},
      auth:{type:'password'},proxy:{type:'direct'},
    }),
  }, {clientFactory:() => client});
  const socket = {destroyed:false,destroy(){ this.destroyed = true; }};
  const controller = new AbortController();
  const connecting = broker.connect(
    'server-1',
    {password:'saved'},
    {sock:socket,signal:controller.signal},
  );
  await connectStarted;
  controller.abort();
  await assert.rejects(
    Promise.race([
      connecting,
      delay(200).then(() => { throw new Error('cancelled SSH handshake did not settle'); }),
    ]),
    (error) => error.code === 'SSH_CONNECTION_CANCELLED',
  );
  assert.equal(socket.destroyed,true);
  assert.equal(broker.pendingConnections.size,0);
  assert.equal(broker.connectionOperations.size,0);
});

test('server runtime forwards cancellation to the SSH broker', async () => {
  const plugin = vaultPlugin({configState:'ready',uplink:{type:'direct'}});
  const runtime = new ServerPluginRuntime(
    {},
    {load:async () => ({password:'saved'})},
    {resolver:{},vpnGuard:{}},
  );
  const socket = {destroyed:false,destroy(){ this.destroyed = true; }};
  runtime.createUplinkSocket = async () => socket;
  const controller = new AbortController();
  runtime.broker.connect = async (_resource,_secrets,options) => {
    assert.equal(options.sock,socket);
    assert.equal(options.signal,controller.signal);
    return {connectedAt:'now'};
  };
  await runtime.connect(plugin,{}, {signal:controller.signal,attemptToken:1});
});

test('a slow cancellation audit cannot suppress cleanup for a later cancelled attempt', async () => {
  const plugin = connectionPlugin('db-1');
  let connectCalls = 0;
  let liveSession = null;
  let announceSecondStarted;
  const secondStarted = new Promise((resolve) => { announceSecondStarted = resolve; });
  let releaseFirstAudit;
  const firstAuditPending = new Promise((resolve) => { releaseFirstAudit = resolve; });
  const cancellationAudits = [];
  const disconnectReasons = [];
  const runtime = {
    connect:async (_plugin, _secrets, {signal} = {}) => {
      connectCalls += 1;
      const generation = connectCalls;
      if (generation === 2) {
        liveSession = generation;
        announceSecondStarted();
      }
      await new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('cancelled'), {code:'CONNECT_CANCELLED'}));
        signal?.addEventListener('abort', abort, {once:true});
      });
    },
    disconnect:async (_plugin, reason) => {
      disconnectReasons.push(reason);
      liveSession = null;
      return {connected:false};
    },
    forceDisconnect:async () => ({connected:false,forced:true}),
    closeAll:async () => undefined,
  };
  const store = {
    getEnvironment:async () => ({revision:1}),listPlugins:async () => [plugin],getPlugin:async () => plugin,
    appendAudit:async (_projectId, entry) => {
      if (entry.type !== 'environment-connect-cancelled') return;
      cancellationAudits.push(entry);
      if (cancellationAudits.length === 1) await firstAuditPending;
    },
  };
  const manager = new EnvironmentConnectionManager(store, runtime, {retryDelays:[]});
  const first = manager.connect('p1','e1');
  while (connectCalls === 0) await delay(1);
  manager.cancel('p1','e1');
  const second = manager.connect('p1','e1');
  await first;
  await secondStarted;
  manager.cancel('p1','e1');
  await second;
  for (let attempts = 0; liveSession !== null && attempts < 100; attempts += 1) await delay(1);
  assert.equal(liveSession, null, 'the second cancelled attempt is cleaned even while the first audit is pending');
  assert.deepEqual(disconnectReasons, ['user-cancel','user-cancel']);
  releaseFirstAudit();
  while (manager.cancelCleanups.size) await delay(1);
  assert.equal(cancellationAudits.length, 2);
  assert.notEqual(cancellationAudits[0].connectAttemptId, cancellationAudits[1].connectAttemptId);
});

test('disconnect has a hard deadline and published snapshots have monotonic sequence numbers', async () => {
  const plugin = connectionPlugin('db-1');
  let forced = 0;
  const runtime = {
    connect:async () => ({connectedAt:'now'}),
    disconnect:async () => new Promise(() => undefined),
    forceDisconnect:async () => { forced += 1; return {connected:false,forced:true}; },
    closeAll:async () => undefined,
  };
  const store = {
    getEnvironment:async () => ({revision:1}), listPlugins:async () => [plugin], getPlugin:async () => plugin, appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store, runtime, { retryDelays:[], disconnectDeadlineMs:100 });
  const sequences = [];
  manager.on('changed', (state) => sequences.push(state.sequence));
  await manager.connect('p1', 'e1');
  const started = Date.now();
  const result = await manager.disconnect('p1', 'e1');
  assert.ok(Date.now() - started < 500, 'disconnect must not wait forever for a driver');
  assert.equal(result.phase, 'disconnected');
  assert.equal(forced, 1);
  assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]));
});

test('network watcher debounces bursts and never overlaps callbacks', async () => {
  let release;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const watcher = new NetworkChangeWatcher(async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    active -= 1;
  }, { intervalMs:60_000, debounceMs:0, networkInterfaces:() => ({}) });
  watcher.setActive(true);
  watcher.scheduleCallback();
  watcher.scheduleCallback();
  while (calls === 0) await delay(1);
  watcher.scheduleCallback();
  watcher.scheduleCallback();
  await delay(5);
  release();
  for (let index = 0; index < 50 && calls < 2; index += 1) await delay(2);
  watcher.stop();
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('address resolver queries only the required family and coalesces identical in-flight DNS', async () => {
  let resolve4Calls = 0;
  let resolve6Calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const resolver = new AddressResolver({ resolver:{
    resolve4:async () => { resolve4Calls += 1; await pending; return ['192.0.2.10']; },
    resolve6:async () => { resolve6Calls += 1; return ['2001:db8::10']; },
  } });
  const first = resolver.resolve('db.internal', 'ipv4Only');
  const second = resolver.resolve('db.internal', 'ipv4Only');
  await delay(1);
  assert.equal(resolve4Calls, 1);
  assert.equal(resolve6Calls, 0);
  release();
  assert.deepEqual(await first, [{address:'192.0.2.10',family:4}]);
  assert.deepEqual(await second, [{address:'192.0.2.10',family:4}]);
});

test('address resolver falls back to the operating-system resolver when Electron DNS is refused', async () => {
  let lookupCalls = 0;
  const refused = Object.assign(new Error('queryA refused'),{code:'ECONNREFUSED'});
  const resolver = new AddressResolver({resolver:{
    resolve4:async()=>{ throw refused; },
    resolve6:async()=>{ throw Object.assign(new Error('no data'),{code:'ENODATA'}); },
    lookup:async(_host,options)=>{
      lookupCalls += 1;
      assert.deepEqual(options,{all:true,verbatim:true});
      return [{address:'192.0.2.209',family:4}];
    },
  }});

  assert.deepEqual(await resolver.resolve('db.example.test','ipv4Preferred'),[
    {address:'192.0.2.209',family:4},
  ]);
  assert.equal(lookupCalls,1);
});

test('workspace overview isolates a corrupt project and keeps healthy projects usable', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const healthy = await store.createProject({name:'健康项目'});
  const broken = await store.createProject({name:'损坏项目'});
  await fs.writeFile(store.workspacePath(broken.projectId), '{broken', 'utf8');
  const projects = await store.listProjectOverviews();
  const healthyOverview = projects.find((project) => project.projectId === healthy.projectId);
  const brokenOverview = projects.find((project) => project.projectId === broken.projectId);
  assert.equal(healthyOverview.environments.length, 1);
  assert.equal(brokenOverview.environments.length, 0);
  assert.equal(brokenOverview.configurationError.code, 'PROJECT_CONFIG_INVALID');
  assert.equal(brokenOverview.configurationError.source, `projects/${broken.projectId}`);
  assert.equal(path.isAbsolute(brokenOverview.configurationError.source), false);
});

test('workspace overview does not mislabel transient filesystem failures as corrupt projects', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'临时 I/O'});
  const getProject = store.getProject.bind(store);
  store.getProject = async (projectId) => {
    if (projectId === project.projectId) throw Object.assign(new Error('temporarily busy'), {code:'EBUSY'});
    return getProject(projectId);
  };
  await assert.rejects(() => store.listProjectOverviews(), (error) => error.code === 'EBUSY');
});

test('workspace atomic writes remove temporary files after a failed rename', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  const destination = path.join(root, 'already-a-directory');
  await fs.mkdir(destination, {recursive:true});
  await assert.rejects(() => store.atomicWrite(destination, 'content'));
  const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('audit pagination reads newest matching records with cursor semantics and skips corrupt lines', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'大审计日志'});
  const auditFile = path.join(store.projectDir(project.projectId),'audit','operations-v3.jsonl');
  await fs.mkdir(path.dirname(auditFile),{recursive:true});
  const records = Array.from({length:20_000}, (_, index) => JSON.stringify({
    schemaVersion:3,time:new Date(index).toISOString(),environmentId:index % 2 === 0 ? 'e1' : 'e2',
    pluginInstanceId:index % 3 === 0 ? 'db-1' : 'server-1',sequence:index,summary:`记录-${index}`,
  }));
  records.splice(19_990,0,'{corrupt-line');
  await fs.writeFile(auditFile,`${records.join('\n')}\n`,'utf8');
  const page = await store.listAudit(project.projectId,{environmentId:'e1',cursor:123,limit:25});
  assert.equal(page.entries.length,25);
  assert.equal(page.entries[0].sequence,19_752);
  assert.equal(page.entries.at(-1).sequence,19_704);
  assert.equal(page.nextCursor,'148');
});

test('credential merge preserves empty fields and serializes concurrent field updates', async (t) => {
  const root = await tempRoot(t);
  const plugin = vaultPlugin();
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {password:'ssh-old',proxyPassword:'proxy-old'});
  await vault.saveMerged(plugin, plugin, {password:'',proxyPassword:null});
  assert.deepEqual(await vault.load(plugin), {password:'ssh-old',proxyPassword:'proxy-old'});
  await Promise.all([
    vault.saveMerged(plugin, plugin, {password:'ssh-new'}),
    vault.saveMerged(plugin, plugin, {proxyPassword:'proxy-new'}),
  ]);
  assert.deepEqual(await vault.load(plugin), {password:'ssh-new',proxyPassword:'proxy-new'});
});

test('metadata-only plugin edits do not decrypt or rewrite an unchanged credential binding', async (t) => {
  const root = await tempRoot(t);
  const control = {failDecrypt:false};
  const plugin = vaultPlugin();
  const vault = new PluginCredentialVault(root, plainEncryption(control));
  await vault.save(plugin, {password:'ssh-old',proxyPassword:'proxy-old'});
  const before = await fs.readFile(vault.file);
  const beforeStat = await fs.stat(vault.file);
  control.failDecrypt = true;
  const renamed = {...plugin,displayName:'Renamed',revision:2,limits:{timeoutMs:20_000},sources:[{sourceId:'logs'}]};
  assert.deepEqual(await vault.saveMerged(plugin, renamed, {password:'',proxyPassword:''}), {saved:false,preserved:true});
  const after = await fs.readFile(vault.file);
  const afterStat = await fs.stat(vault.file);
  assert.deepEqual(after, before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('unreadable credentials reject every replacement and preserve inactive historical fields', async (t) => {
  const root = await tempRoot(t);
  const control = {failDecrypt:false};
  const server = vaultPlugin();
  const vault = new PluginCredentialVault(root, plainEncryption(control));
  await vault.save(server, {password:'ssh-old',proxyPassword:'proxy-old',privateKeyPassphrase:'inactive-key-passphrase'});
  const before = await fs.readFile(vault.file, 'utf8');
  const backupBefore = await fs.readFile(vault.backupFile, 'utf8');
  control.failDecrypt = true;
  await assert.rejects(
    () => vault.saveMerged(server, server, {password:'ssh-replacement'}),
    (error) => error.code === 'CREDENTIAL_REPLACEMENT_INCOMPLETE',
  );
  assert.equal(await fs.readFile(vault.file, 'utf8'), before);
  await assert.rejects(
    () => vault.saveMerged(server, server, {password:'ssh-replacement',proxyPassword:'proxy-replacement',privateKeyPassphrase:'replacement-key'}),
    (error) => error.code === 'CREDENTIAL_REPLACEMENT_INCOMPLETE',
  );
  assert.equal(await fs.readFile(vault.file, 'utf8'), before);
  assert.equal(await fs.readFile(vault.backupFile, 'utf8'), backupBefore);
  control.failDecrypt = false;
  assert.deepEqual(await vault.load(server), {password:'ssh-old',proxyPassword:'proxy-old',privateKeyPassphrase:'inactive-key-passphrase'});

  const mysql = vaultPlugin({
    pluginInstanceId:'mysql-1', pluginType:'mysql', target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Only'},
    auth:{username:'reader'}, transport:{kind:'direct'}, uplink:undefined, tls:{mode:'disabled'},
  });
  await vault.save(mysql, {password:'mysql-old',tlsPassphrase:'inactive-tls',caPem:'inactive-ca'});
  const mysqlBefore = await fs.readFile(vault.file, 'utf8');
  const mysqlBackupBefore = await fs.readFile(vault.backupFile, 'utf8');
  control.failDecrypt = true;
  await assert.rejects(
    () => vault.saveMerged(mysql, mysql, {password:'mysql-new'}),
    (error) => error.code === 'CREDENTIAL_REPLACEMENT_INCOMPLETE',
  );
  assert.equal(await fs.readFile(vault.file, 'utf8'), mysqlBefore);
  assert.equal(await fs.readFile(vault.backupFile, 'utf8'), mysqlBackupBefore);
  control.failDecrypt = false;
  assert.deepEqual(await vault.load(mysql), {password:'mysql-old',tlsPassphrase:'inactive-tls',caPem:'inactive-ca'});
});

test('a failed primary credential commit leaves the prior envelope authoritative', async (t) => {
  const root = await tempRoot(t);
  const plugin = vaultPlugin();
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {password:'ssh-old',proxyPassword:'proxy-old'});
  const atomicWrite = vault.atomicWrite.bind(vault);
  let failPrimary = true;
  vault.atomicWrite = async (file, content) => {
    if (failPrimary && file === vault.file) throw new Error('simulated primary write failure');
    return atomicWrite(file, content);
  };
  await assert.rejects(() => vault.saveMerged(plugin, plugin, {password:'ssh-new'}));
  failPrimary = false;
  assert.deepEqual(await vault.load(plugin), {password:'ssh-old',proxyPassword:'proxy-old'});
});

test('credential two-slot failures never destroy the last usable envelope', async (t) => {
  const root = await tempRoot(t);
  const plugin = vaultPlugin();
  const changed = {...plugin,revision:2,target:{...plugin.target,host:'new.internal'}};
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {password:'ssh-old',proxyPassword:'proxy-old'});
  await fs.writeFile(vault.file, '{broken-primary', 'utf8');
  const backupBefore = await fs.readFile(vault.backupFile, 'utf8');
  const atomicWrite = vault.atomicWrite.bind(vault);
  let failPrimary = true;
  vault.atomicWrite = async (file, content) => {
    if (failPrimary && file === vault.file) throw new Error('primary locked');
    return atomicWrite(file, content);
  };
  await assert.rejects(() => vault.saveMerged(plugin, changed, {}));
  assert.equal(await fs.readFile(vault.backupFile, 'utf8'), backupBefore);
  failPrimary = false;
  assert.deepEqual(await vault.load(plugin), {password:'ssh-old',proxyPassword:'proxy-old'});

  let failBackup = true;
  vault.atomicWrite = async (file, content) => {
    if (failBackup && file === vault.backupFile) throw new Error('backup locked');
    return atomicWrite(file, content);
  };
  assert.deepEqual(await vault.saveMerged(plugin, changed, {}), {saved:true});
  failBackup = false;
  assert.deepEqual(await vault.load(changed), {password:'ssh-old',proxyPassword:'proxy-old'});
});

test('deleting plugin, environment and project metadata never deletes its credential envelope', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'凭据保留',environmentName:'保留环境'});
  const disposable = await store.createEnvironment(project.projectId, {name:'待删环境'});
  const plugin = await store.createPlugin(project.projectId, disposable.environmentId, {
    pluginType:'server',displayName:'待删服务器',target:{host:'server.internal'},auth:{type:'password',username:'root'},
  });
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(plugin, {password:'must-survive'});
  await store.deletePlugin(project.projectId, disposable.environmentId, plugin.pluginInstanceId);
  assert.deepEqual(await vault.load(plugin), {password:'must-survive'});
  await store.deleteEnvironment(project.projectId, disposable.environmentId);
  assert.deepEqual(await vault.load(plugin), {password:'must-survive'});
  await store.deleteProject(project.projectId);
  assert.deepEqual(await vault.load(plugin), {password:'must-survive'});
});

test('credential status decrypts the envelope once and workspace overview sends preview runtime only', async () => {
  const handlers = new Map();
  let credentialLoads = 0;
  let overviewLoads = 0;
  const plugin = vaultPlugin();
  const environment = {
    projectId:'p1',environmentId:'e1',name:'生产',pluginCount:7,readyPluginCount:7,
    resourcePreview:[{pluginInstanceId:'server-1',pluginType:'server',displayName:'Server'}],
  };
  registerV2Ipc({handle:(name, handler) => handlers.set(name, handler),on:() => undefined}, {
    workspaceStore:{
      getPlugin:async () => plugin,
      listProjectOverviews:async () => { overviewLoads += 1; return [{projectId:'p1',name:'P1',environments:[environment]}]; },
    },
    connectionManager:{
      on:() => undefined,
      snapshot:() => ({projectId:'p1',environmentId:'e1',phase:'connected',sequence:10,eligibleCount:7,connectedCount:7,manualDisconnected:{},plugins:{
        'server-1':{phase:'connected'}, 'hidden-db':{phase:'connected',error:{message:'large diagnostic'}},
      }}),
    },
    credentialVault:{load:async () => { credentialLoads += 1; return {password:'secret'}; }},
    contextManager:{}, confirmationManager:{on:() => undefined}, pluginManager:{}, mysqlRuntime:{},
  });
  const status = await handlers.get('v2:plugin-credential-status')({}, {projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1'});
  assert.equal(status.ok, true);
  assert.equal(credentialLoads, 1);
  const overview = await handlers.get('v2:workspace-overview')({});
  assert.equal(overview.ok, true);
  assert.equal(overviewLoads, 1);
  assert.deepEqual(Object.keys(overview.data[0].environments[0].runtime.plugins), ['server-1']);
  assert.equal(overview.data[0].environments[0].runtime.pluginsPartial, true);
  assert.equal(overview.data[0].environments[0].runtime.sequence, 10);
});

test('legacy credential confirmation fills only missing fields and preserves active values and source bytes', async (t) => {
  const root = await tempRoot(t,'ai-ops-legacy-confirm-');
  const legacyStore = new ProjectStore(root);
  const legacyProject = await legacyStore.create({
    id:'legacy-confirm',name:'旧项目',ssh:{host:'old.internal',port:22,username:'deploy'},
    auth:{type:'password'},proxy:{type:'direct'},
  });
  const legacyCredentials = new CredentialStore(legacyStore,plainEncryption());
  await legacyCredentials.save(legacyProject.id,{
    password:'legacy-password',privateKeyPassphrase:'legacy-key-passphrase',proxyPassword:'legacy-proxy',
  },legacyProject);
  const sourceBefore = await fs.readFile(legacyCredentials.filePath(legacyProject.id));

  const store = new WorkspaceStore(root,{legacyStore});
  await store.init();
  const initial = await store.getPlugin(legacyProject.id,'default','server-primary');
  const plugin = await store.updatePlugin(legacyProject.id,'default','server-primary',{
    target:{...initial.target,host:'new.internal'},
  },initial.revision);
  const vault = new PluginCredentialVault(root,plainEncryption());
  await vault.save(plugin,{password:'active-password'});
  const candidate = await legacyCredentials.readMigrationCandidate(
    legacyProject.id,
    legacyCredentialConfigForPlugin(plugin),
  );
  assert.equal(candidate.status,'confirmation-required');
  legacyCredentials.rememberMigration(plugin,candidate,{
    expectedRevision:plugin.revision,
    pluginBindingHash:pluginCredentialInternals.bindingHash(plugin),
  });

  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,credentialVault:vault,legacyCredentialStore:legacyCredentials,
    connectionManager:{on:() => undefined},contextManager:{},confirmationManager:{on:() => undefined},
    pluginManager:{},mysqlRuntime:{},
  });
  const status = await handlers.get('v2:plugin-credential-status')({},plugin);
  assert.equal(status.ok,true);
  assert.equal(status.data.saved,true,'an active primary value does not hide a partial migration');
  assert.deepEqual(status.data.fields,{primary:true,proxy:false});
  assert.equal(status.data.migration.status,'confirmation-required');
  assert.deepEqual(status.data.migration.missingFields,{
    password:false,privateKeyPassphrase:true,proxyPassword:true,
  });
  assert.doesNotMatch(JSON.stringify(status.data),/legacy-password|legacy-key-passphrase|legacy-proxy|ciphertext/u);

  const stale = await handlers.get('v2:plugin-credential-migration-confirm')({}, {
    ...plugin,expectedRevision:plugin.revision + 1,sourceSha256:candidate.sourceSha256,
  });
  assert.equal(stale.ok,false);
  assert.equal(stale.error.code,'CREDENTIAL_MIGRATION_CHANGED');
  assert.deepEqual(await vault.load(plugin),{password:'active-password'});

  const confirmed = await handlers.get('v2:plugin-credential-migration-confirm')({}, {
    ...plugin,expectedRevision:plugin.revision,sourceSha256:candidate.sourceSha256,
  });
  assert.equal(confirmed.ok,true);
  assert.equal(confirmed.data.imported,true);
  assert.deepEqual(await vault.load(plugin),{
    password:'active-password',privateKeyPassphrase:'legacy-key-passphrase',proxyPassword:'legacy-proxy',
  });
  assert.deepEqual(await fs.readFile(legacyCredentials.filePath(legacyProject.id)),sourceBefore);
  const complete = await handlers.get('v2:plugin-credential-status')({},plugin);
  assert.equal(complete.ok,true);
  assert.equal('migration' in complete.data,false);
});

test('startup legacy migration imports v1 and exact v2 idempotently without touching source files', async (t) => {
  const root = await tempRoot(t,'ai-ops-startup-legacy-migration-');
  const legacyStore = new ProjectStore(root);
  const v1Project = await legacyStore.create({
    id:'legacy-v1-auto',name:'Legacy V1',ssh:{host:'v1.internal',port:22,username:'deploy'},
    auth:{type:'password'},proxy:{type:'direct'},
  });
  const v2Project = await legacyStore.create({
    id:'legacy-v2-auto',name:'Legacy V2',ssh:{host:'v2.internal',port:2202,username:'ops'},
    auth:{type:'password'},proxy:{type:'direct'},
  });
  const legacyCredentials = new CredentialStore(legacyStore,plainEncryption());
  const v1Ciphertext = Buffer.from(JSON.stringify({
    password:'legacy-v1-password',privateKeyPassphrase:'legacy-v1-key',proxyPassword:'legacy-v1-proxy',
  }),'utf8');
  await fs.writeFile(legacyCredentials.filePath(v1Project.id),JSON.stringify({version:1,ciphertext:v1Ciphertext.toString('base64')}));
  await legacyCredentials.save(v2Project.id,{password:'legacy-v2-password',proxyPassword:'legacy-v2-proxy'},v2Project);
  const sourceBefore = new Map();
  for (const projectId of [v1Project.id,v2Project.id]) {
    const file = legacyCredentials.filePath(projectId);
    sourceBefore.set(projectId,{bytes:await fs.readFile(file),mtimeMs:(await fs.stat(file)).mtimeMs});
  }

  const store = new WorkspaceStore(root,{legacyStore});
  await store.init();
  const v1Plugin = await store.getPlugin(v1Project.id,'default','server-primary');
  const v2Plugin = await store.getPlugin(v2Project.id,'default','server-primary');
  const vault = new PluginCredentialVault(root,plainEncryption());
  await vault.save(v1Plugin,{password:'active-v1-password'});
  const migrate = (plugin) => migrateLegacyCredentialForPlugin({
    legacyCredentialStore:legacyCredentials,credentialVault:vault,plugin,
    pluginBindingHash:pluginCredentialInternals.bindingHash(plugin),
  });
  assert.equal((await migrate(v1Plugin)).status,'imported');
  assert.equal((await migrate(v2Plugin)).status,'imported');
  assert.deepEqual(await vault.load(v1Plugin),{
    password:'active-v1-password',privateKeyPassphrase:'legacy-v1-key',proxyPassword:'legacy-v1-proxy',
  });
  assert.deepEqual(await vault.load(v2Plugin),{password:'legacy-v2-password',proxyPassword:'legacy-v2-proxy'});
  const vaultAfterFirstPass = await fs.readFile(vault.file);
  assert.equal((await migrate(v1Plugin)).status,'already-complete');
  assert.equal((await migrate(v2Plugin)).status,'already-complete');
  assert.deepEqual(await fs.readFile(vault.file),vaultAfterFirstPass,'a second startup performs no vault rewrite');
  for (const projectId of [v1Project.id,v2Project.id]) {
    const before = sourceBefore.get(projectId);
    const file = legacyCredentials.filePath(projectId);
    assert.deepEqual(await fs.readFile(file),before.bytes);
    assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
  }
});

test('plugin update reports an incomplete config-credential transaction when rollback also fails', async () => {
  const handlers = new Map();
  const before = vaultPlugin({revision:1});
  const after = {...before,revision:2,target:{...before.target,host:'new.internal'}};
  registerV2Ipc({handle:(name, handler) => handlers.set(name, handler),on:() => undefined}, {
    workspaceStore:{
      getPlugin:async () => before,
      updatePlugin:async () => after,
      restorePluginSnapshot:async () => { throw new Error('disk remains locked'); },
    },
    connectionManager:{on:() => undefined},
    credentialVault:{saveMerged:async () => { throw Object.assign(new Error('vault write failed'), {code:'EIO'}); }},
    contextManager:{}, confirmationManager:{on:() => undefined}, pluginManager:{}, mysqlRuntime:{},
  });
  const result = await handlers.get('v2:plugin-update')({}, {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',patch:{target:{host:'new.internal'}},expectedRevision:1,secrets:{},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_CREDENTIAL_TRANSACTION_INCOMPLETE');
  assert.equal(result.error.details.previousRevision, 1);
  assert.equal(result.error.details.attemptedRevision, 2);
  assert.equal(result.error.details.credentialError.code, 'INTERNAL_ERROR');
  assert.equal(result.error.details.rollbackError.code, 'INTERNAL_ERROR');
});

test('plugin credential transactions serialize config revisions and never expose a transient binding', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'并发凭据',environmentName:'测试'});
  const [environment] = await store.listEnvironments(project.projectId);
  const initial = await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType:'mysql',displayName:'并发数据库',
    target:{host:'v1.internal',port:3306,database:'app',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
  });
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(initial, {password:'v1-password'});

  const atomicWrite = vault.atomicWrite.bind(vault);
  let releaseFailedWrite;
  let announceFailedWrite;
  const failedWriteStarted = new Promise((resolve) => { announceFailedWrite = resolve; });
  const failedWriteRelease = new Promise((resolve) => { releaseFailedWrite = resolve; });
  let failNextPrimary = true;
  vault.atomicWrite = async (file, content) => {
    if (failNextPrimary && file === vault.file) {
      failNextPrimary = false;
      announceFailedWrite();
      await failedWriteRelease;
      throw new Error('simulated delayed vault failure');
    }
    return atomicWrite(file, content);
  };

  const handlers = new Map();
  registerV2Ipc({handle:(name, handler) => handlers.set(name, handler),on:() => undefined}, {
    workspaceStore:store,credentialVault:vault,
    connectionManager:{on:() => undefined,snapshot:() => ({plugins:{}}),configurationChanged:async () => undefined},
    contextManager:{invalidateEnvironment:() => undefined},confirmationManager:{on:() => undefined},
    pluginManager:{disconnect:async () => undefined},mysqlRuntime:{},
  });
  const update = handlers.get('v2:plugin-update');
  const first = update({}, {
    projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:initial.pluginInstanceId,
    patch:{target:{...initial.target,host:'v2.internal'}},expectedRevision:1,secrets:{},
  });
  await failedWriteStarted;
  const second = update({}, {
    projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:initial.pluginInstanceId,
    patch:{target:{...initial.target,host:'v3.internal'}},expectedRevision:2,secrets:{password:'v3-password'},
  });
  releaseFailedWrite();

  const [failed, stale] = await Promise.all([first, second]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'INTERNAL_ERROR');
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'CONFIG_REVISION_CONFLICT');
  const current = await store.getPlugin(project.projectId, environment.environmentId, initial.pluginInstanceId);
  assert.equal(current.revision, 1);
  assert.equal(current.target.host, 'v1.internal');
  assert.deepEqual(await vault.load(current), {password:'v1-password'});
});

test('directory pagination stops at the 10k cap while still reporting source truncation', async () => {
  let maxResolved = 0;
  const runtime = {
    listRemoteDirectory:async (_plugin, _remotePath, {offset,limit}) => {
      const available = 10_000;
      const count = Math.max(0, Math.min(limit, available - offset));
      maxResolved = Math.max(maxResolved, count);
      const entries = Array.from({length:count}, (_, index) => ({
        name:`entry-${String(offset + index).padStart(5,'0')}`,canonicalPath:`/large/entry-${offset + index}`,
        size:1,mtime:1,mode:0,isFile:true,isDirectory:false,isSymbolicLink:false,
      }));
      entries.pageOffset = offset;
      entries.hasMoreWithinCap = offset + count < available;
      entries.sourceTruncated = true;
      entries.truncated = true;
      return entries;
    },
  };
  const operations = new ServerOperations(runtime, {});
  const plugin = connectionPlugin('server-1', 'server');
  let cursor = '0';
  let pages = 0;
  let finalPage;
  do {
    finalPage = await operations.listDirectory(plugin, {path:'/large',cursor,limit:500});
    cursor = finalPage.nextCursor;
    pages += 1;
    assert.ok(pages <= 20, 'cursor must terminate at the 10k cap');
  } while (cursor !== null);
  assert.equal(pages, 20);
  assert.equal(finalPage.truncated, true);
  assert.equal(finalPage.nextCursor, null);
  assert.ok(maxResolved <= 501, 'only the current page plus lookahead should be resolved');
});

test('context and confirmation natural entry points prune large expired maps', async () => {
  let current = 1_000;
  const contextStore = {
    getEnvironment:async () => ({projectId:'p1',environmentId:'e1',revision:1}),
    readRunbook:async () => ({content:'',hash:'docs',empty:true}),
    listPlugins:async () => [],
    pluginBindingHash:() => 'binding',
  };
  const contexts = new EnvironmentContextManager(contextStore,{ttlMs:10,now:() => current});
  for (let index = 0; index < 300; index += 1) await contexts.open('p1','e1',`client-${index}`);
  assert.equal(contexts.contexts.size,300);
  current += 11;
  await contexts.open('p1','e1','fresh');
  assert.equal(contexts.contexts.size,1);

  const confirmations = new ConfirmationManager({ttlMs:10,now:() => current});
  for (let index = 0; index < 300; index += 1) {
    const pending = confirmations.request({projectId:'p1'},'write',{index});
    confirmations.approve(pending.requestId);
  }
  assert.equal(confirmations.approved.size,300);
  for (let index = 0; index < 300; index += 1) confirmations.request({projectId:'p1'},'delete',{index});
  assert.equal(confirmations.pending.size,300);
  current += 11;
  confirmations.request({projectId:'p1'},'fresh',{});
  assert.equal(confirmations.approved.size,0);
  assert.equal(confirmations.pending.size,1);
});

async function journalFixture(t) {
  const root = await tempRoot(t, 'ai-ops-journal-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Crash journal',environmentName:'Production'});
  const [environment] = await store.listEnvironments(project.projectId);
  const before = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'server',displayName:'Gateway',target:{host:'old.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'},uplink:{type:'direct'},
  });
  const vault = new PluginCredentialVault(root, plainEncryption());
  await vault.save(before,{password:'old-password'});
  const {after} = await store.preparePluginUpdate(project.projectId,environment.environmentId,before.pluginInstanceId,{
    target:{...before.target,host:'new.internal'},
  },before.revision);
  const journal = new PluginConfigTransactionJournal(root,store,vault);
  return {root,store,project,environment,before,after,vault,journal};
}

test('config transaction recovery rolls YAML back when a crash precedes the vault commit', async (t) => {
  const fixture = await journalFixture(t);
  await fixture.journal.prepare(fixture.before,fixture.after);
  await fixture.store.commitPluginSnapshot(fixture.after,fixture.before.revision);

  const recovered = new PluginConfigTransactionJournal(fixture.root,fixture.store,fixture.vault);
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,true);
  assert.equal(result.action,'config-rolled-back');
  const current = await fixture.store.getPlugin(fixture.project.projectId,fixture.environment.environmentId,fixture.before.pluginInstanceId);
  assert.equal(current.revision,fixture.before.revision);
  assert.equal(current.target.host,'old.internal');
  assert.deepEqual(await fixture.vault.load(current),{password:'old-password'});
});

test('config transaction recovery commits the recorded YAML when the vault commit survived', async (t) => {
  const fixture = await journalFixture(t);
  await fixture.journal.prepare(fixture.before,fixture.after,{hasExplicitSecrets:true});
  // Simulate the conservative crash matrix where the durable YAML appears old
  // but the vault primary already contains the new binding.
  await fixture.vault.saveMerged(fixture.before,fixture.after,{password:'new-password'});

  const recovered = new PluginConfigTransactionJournal(fixture.root,fixture.store,fixture.vault);
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,true);
  assert.equal(result.action,'committed-config-preserved');
  const current = await fixture.store.getPlugin(fixture.project.projectId,fixture.environment.environmentId,fixture.before.pluginInstanceId);
  assert.equal(current.revision,fixture.after.revision);
  assert.equal(current.target.host,'new.internal');
  assert.deepEqual(await fixture.vault.load(current),{password:'new-password'});
});

test('ambiguous crash recovery preserves every byte and blocks connection and diagnostic paths', async (t) => {
  const fixture = await journalFixture(t);
  const record = await fixture.journal.prepare(fixture.before,fixture.after);
  await fixture.store.commitPluginSnapshot(fixture.after,fixture.before.revision);
  const configFile = fixture.store.pluginPath(fixture.project.projectId,fixture.environment.environmentId,fixture.before.pluginInstanceId);
  const beforeBytes = {
    config:await fs.readFile(configFile),
    primary:await fs.readFile(fixture.vault.file),
    backup:await fs.readFile(fixture.vault.backupFile),
    journal:await fs.readFile(record.file),
  };
  fixture.vault.encryption = plainEncryption({failDecrypt:true});

  const recovered = new PluginConfigTransactionJournal(fixture.root,fixture.store,fixture.vault);
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,false);
  assert.equal(result.action,'credential-state-unresolved');
  assert.deepEqual(await fs.readFile(configFile),beforeBytes.config);
  assert.deepEqual(await fs.readFile(fixture.vault.file),beforeBytes.primary);
  assert.deepEqual(await fs.readFile(fixture.vault.backupFile),beforeBytes.backup);
  assert.deepEqual(await fs.readFile(record.file),beforeBytes.journal);
  assert.throws(
    () => recovered.assertEnvironmentAvailable(fixture.project.projectId,fixture.environment.environmentId),
    (error) => error.code === 'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
  );

  let runtimeConnects = 0;
  const manager = new EnvironmentConnectionManager(fixture.store,{
    connect:async () => { runtimeConnects += 1; return {connectedAt:'now'}; },
    disconnect:async () => ({connected:false}),forceDisconnect:async () => ({connected:false}),closeAll:async () => undefined,
  },{retryDelays:[],configurationJournal:recovered});
  await assert.rejects(
    () => manager.connect(fixture.project.projectId,fixture.environment.environmentId),
    (error) => error.code === 'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
  );

  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:fixture.store,credentialVault:fixture.vault,configTransactionJournal:recovered,
    connectionManager:manager,contextManager:{},confirmationManager:{on:() => undefined},
    pluginManager:{connect:async () => { runtimeConnects += 1; }},mysqlRuntime:{listDatabases:async () => { runtimeConnects += 1; }},
  });
  const databases = await handlers.get('v2:plugin-databases')({}, {
    projectId:fixture.project.projectId,environmentId:fixture.environment.environmentId,
    pluginInstanceId:fixture.before.pluginInstanceId,input:{},secrets:{},
  });
  assert.equal(databases.ok,false);
  assert.equal(databases.error.code,'CONFIG_TRANSACTION_RECOVERY_REQUIRED');
  assert.equal(runtimeConnects,0);
});

test('invalid or secret-bearing journals are retained and globally fenced without touching YAML', async (t) => {
  const fixture = await journalFixture(t);
  const leakyBefore = {...fixture.before,password:'TOP-LEVEL-SECRET',secrets:{password:'NESTED-SECRET'}};
  const leakyAfter = {...fixture.after,ciphertext:'OPAQUE-BUT-WRONG-LOCATION'};
  const record = await fixture.journal.prepare(leakyBefore,leakyAfter);
  const cleanText = await fs.readFile(record.file,'utf8');
  assert.equal(cleanText.includes('TOP-LEVEL-SECRET'),false);
  assert.equal(cleanText.includes('NESTED-SECRET'),false);
  assert.equal(cleanText.includes('OPAQUE-BUT-WRONG-LOCATION'),false);

  const tampered = JSON.parse(cleanText);
  tampered.after.password = 'MUST-NOT-REACH-YAML';
  await fs.writeFile(record.file,JSON.stringify(tampered),'utf8');
  const configFile = fixture.store.pluginPath(fixture.project.projectId,fixture.environment.environmentId,fixture.before.pluginInstanceId);
  const configBefore = await fs.readFile(configFile);
  const recovered = new PluginConfigTransactionJournal(fixture.root,fixture.store,fixture.vault);
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,false);
  assert.equal(result.action,'invalid-journal');
  assert.equal(recovered.hasUnresolved(),true);
  assert.deepEqual(await fs.readFile(configFile),configBefore);
  assert.equal(await fs.readFile(record.file,'utf8'),JSON.stringify(tampered));
  assert.throws(
    () => recovered.assertPluginAvailable(fixture.project.projectId,fixture.environment.environmentId,fixture.before.pluginInstanceId),
    (error) => error.code === 'CONFIG_TRANSACTION_RECOVERY_REQUIRED',
  );
});

test('concurrent same-id project creation never lets a failed owner remove the successful project', async (t) => {
  const root = await tempRoot(t,'ai-ops-project-race-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const writeYaml = store.writeYaml.bind(store);
  let announceOriginalWrite;
  const originalWriteStarted = new Promise((resolve) => { announceOriginalWrite = resolve; });
  let releaseOriginalFailure;
  const originalFailure = new Promise((resolve) => { releaseOriginalFailure = resolve; });
  store.writeYaml = async (file,value) => {
    if (value?.schemaVersion === 2 && value.projectId === 'shared-project') {
      announceOriginalWrite();
      await originalFailure;
      throw new Error('simulated first owner failure');
    }
    return writeYaml(file,value);
  };
  const failed = store.createProject({name:'First',projectId:'shared-project'});
  await originalWriteStarted;
  const successful = await store.createProject({name:'Second',projectId:'shared-project'});
  releaseOriginalFailure();
  await assert.rejects(failed,/simulated first owner failure/);
  assert.notEqual(successful.projectId,'shared-project');
  assert.equal((await store.getProject(successful.projectId)).name,'Second');
});

test('deleting a migrated project archives the complete legacy credential envelope byte-for-byte', async (t) => {
  const root = await tempRoot(t,'ai-ops-legacy-archive-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Legacy archive',projectId:'legacy-archive'});
  const legacyConfig = 'version: 1\nid: legacy-archive\nname: Legacy archive\n';
  const credentialBytes = Buffer.from('{"version":2,"ciphertext":"DO-NOT-DELETE"}','utf8');
  await fs.writeFile(path.join(store.projectDir(project.projectId),'project.yaml'),legacyConfig,'utf8');
  await fs.writeFile(path.join(store.projectDir(project.projectId),'credentials.enc.json'),credentialBytes);
  const deleted = await store.deleteProject(project.projectId);
  assert.ok(deleted.credentialArchive);
  assert.deepEqual(await fs.readFile(path.join(deleted.credentialArchive,'credentials.enc.json')),credentialBytes);
  assert.equal(await fs.readFile(path.join(deleted.credentialArchive,'project.yaml'),'utf8'),legacyConfig);
  await assert.rejects(() => store.getProject(project.projectId),(error) => error.code === 'PROJECT_NOT_FOUND');
});

test('configuration mutation fences a changed provider and every tunnel dependent before vault I/O', async (t) => {
  const root = await tempRoot(t,'ai-ops-config-fence-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Configuration fence',environmentName:'Production'});
  const [environment] = await store.listEnvironments(project.projectId);
  const server = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'server',displayName:'Tunnel provider',target:{host:'old.internal'},
    auth:{type:'password',username:'root'},uplink:{type:'direct'},
  });
  const mysql = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'mysql',displayName:'Dependent database',target:{host:'db.internal',database:'app'},
    auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:server.pluginInstanceId},tls:{mode:'disabled'},
  });
  const vault = new PluginCredentialVault(root,plainEncryption());
  await vault.save(server,{password:'old-password'});
  const runtime = {
    connect:async (plugin) => ({connectedAt:`connected-${plugin.pluginInstanceId}`}),
    disconnect:async () => ({connected:false}),forceDisconnect:async () => ({connected:false}),
    closeAll:async () => undefined,invoke:async () => ({unexpected:true}),
  };
  const journal = new PluginConfigTransactionJournal(root,store,vault);
  const manager = new EnvironmentConnectionManager(store,runtime,{retryDelays:[],configurationJournal:journal});
  await manager.connect(project.projectId,environment.environmentId);
  assert.equal(manager.snapshot(project.projectId,environment.environmentId).phase,'connected');

  const saveMerged = vault.saveMerged.bind(vault);
  let announceVault;
  const vaultStarted = new Promise((resolve) => { announceVault = resolve; });
  let releaseVault;
  const vaultRelease = new Promise((resolve) => { releaseVault = resolve; });
  vault.saveMerged = async (...args) => {
    announceVault();
    await vaultRelease;
    return saveMerged(...args);
  };
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,credentialVault:vault,configTransactionJournal:journal,connectionManager:manager,
    contextManager:{invalidateEnvironment:() => undefined},confirmationManager:{on:() => undefined},
    pluginManager:runtime,mysqlRuntime:{},
  });
  const saving = handlers.get('v2:plugin-update')({}, {
    projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:server.pluginInstanceId,
    patch:{target:{...server.target,host:'new.internal'}},expectedRevision:server.revision,secrets:{},
  });
  await vaultStarted;
  const snapshot = manager.snapshot(project.projectId,environment.environmentId);
  assert.equal(snapshot.plugins[server.pluginInstanceId].phase,'error');
  assert.equal(snapshot.plugins[server.pluginInstanceId].reason,'MANUAL_RECONNECT_REQUIRED');
  assert.equal(snapshot.plugins[mysql.pluginInstanceId].phase,'error');
  assert.equal(snapshot.plugins[mysql.pluginInstanceId].reason,'MANUAL_RECONNECT_REQUIRED');
  await assert.rejects(
    () => manager.connect(project.projectId,environment.environmentId),
    (error) => error.code === 'CONFIGURATION_UPDATING',
  );
  await assert.rejects(
    () => manager.retryFailed(project.projectId,environment.environmentId),
    (error) => error.code === 'CONFIGURATION_UPDATING',
  );
  const service = new V2Service({
    workspaceStore:store,connectionManager:manager,pluginManager:runtime,
    contextManager:{verify:async () => ({plugin:mysql,environment})},
    confirmationManager:{},serverOperations:{},credentialVault:vault,
  });
  await assert.rejects(
    () => service.requireCallable({
      projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:mysql.pluginInstanceId,
      contextToken:'new-context-during-save',clientInstanceId:'agent',
    }),
    (error) => error.code === 'PLUGIN_UNAVAILABLE',
  );
  releaseVault();
  const saved = await saving;
  assert.equal(saved.ok,true);
});

test('project deletion gate rejects new connections and writes after preflight and leaves no runtime', async (t) => {
  const root = await tempRoot(t,'ai-ops-project-delete-gate-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Delete gate',projectId:'delete-gate'});
  const [environment] = await store.listEnvironments(project.projectId);
  let announceCleanup;
  const cleanupStarted = new Promise((resolve) => { announceCleanup = resolve; });
  let releaseCleanup;
  const cleanupRelease = new Promise((resolve) => { releaseCleanup = resolve; });
  let runtimeConnects = 0;
  const manager = {
    on:() => undefined,snapshot:() => ({desiredConnected:false,phase:'disconnected',plugins:{}}),
    beginConfigurationMutation:() => 'delete-token',endConfigurationMutation:() => undefined,
    disconnect:async () => { announceCleanup(); await cleanupRelease; return {phase:'disconnected'}; },
    forgetProject:async () => undefined,
    connect:async () => { runtimeConnects += 1; return {phase:'connected'}; },
  };
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,connectionManager:manager,credentialVault:{},contextManager:{invalidateProject:() => undefined},
    confirmationManager:{on:() => undefined,invalidateProject:() => undefined},pluginManager:{connect:async () => { runtimeConnects += 1; }},mysqlRuntime:{},
  });
  const deleting = handlers.get('v2:project-delete')({}, {projectId:project.projectId});
  await cleanupStarted;
  const connect = await handlers.get('v2:environment-connect')({}, {projectId:project.projectId,environmentId:environment.environmentId});
  assert.equal(connect.ok,false);
  assert.equal(connect.error.code,'PROJECT_DELETING');
  const create = await handlers.get('v2:environment-create')({}, {projectId:project.projectId,input:{name:'Too late'}});
  assert.equal(create.ok,false);
  assert.equal(create.error.code,'PROJECT_DELETING');
  const runbook = await handlers.get('v2:runbook-save')({}, {projectId:project.projectId,environmentId:environment.environmentId,content:'late'});
  assert.equal(runbook.ok,false);
  assert.equal(runbook.error.code,'PROJECT_DELETING');
  assert.equal(runtimeConnects,0);
  releaseCleanup();
  const deleted = await deleting;
  assert.equal(deleted.ok,true);
  await assert.rejects(() => store.getProject(project.projectId),(error) => error.code === 'PROJECT_NOT_FOUND');
});

test('network notifications coalesce an initial burst but retain one real change during active work', async () => {
  const plugin = connectionPlugin('db-1');
  const runtime = {
    connect:async () => ({connectedAt:'now'}),disconnect:async () => ({connected:false}),
    forceDisconnect:async () => ({connected:false}),closeAll:async () => undefined,
  };
  const store = {
    getEnvironment:async () => ({revision:1}),listPlugins:async () => [plugin],getPlugin:async () => plugin,appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store,runtime,{retryDelays:[],networkDebounceMs:10});
  await manager.connect('p1','e1');
  let calls = 0;
  manager.disconnectForReconnect = async () => { calls += 1; };
  await Promise.all([
    manager.networkChanged('watcher'),manager.networkChanged('renderer'),manager.networkChanged('resume'),
  ]);
  assert.equal(calls,1);

  calls = 0;
  let announceProcessing;
  const processingStarted = new Promise((resolve) => { announceProcessing = resolve; });
  let releaseProcessing;
  const processingRelease = new Promise((resolve) => { releaseProcessing = resolve; });
  manager.disconnectForReconnect = async () => {
    calls += 1;
    if (calls === 1) { announceProcessing(); await processingRelease; }
  };
  const active = manager.networkChanged('first-real-change');
  await processingStarted;
  manager.networkChanged('second-real-change');
  releaseProcessing();
  await active;
  assert.equal(calls,2);
});

test('a late audit append cannot recreate a project directory after delete commit', async (t) => {
  const root = await tempRoot(t,'ai-ops-late-audit-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Late audit',projectId:'late-audit'});
  await store.appendAudit(project.projectId,{type:'before-delete',result:'success'});
  await store.deleteProject(project.projectId);
  await assert.rejects(
    () => store.appendAudit(project.projectId,{type:'too-late',result:'success'}),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  );
  await assert.rejects(() => fs.access(store.projectDir(project.projectId)),(error) => error.code === 'ENOENT');
});

test('a timed-out MySQL attempt cannot overwrite or close the retry session and relay when it resolves late', async () => {
  const plugin = {
    ...connectionPlugin('mysql-1'),pluginType:'mysql',
    target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},limits:{timeoutMs:5_000},
  };
  let relaySequence = 0;
  let activeRelay = null;
  const routeManager = {
    createRelay:async () => {
      const generation = ++relaySequence;
      activeRelay = generation;
      return {host:'127.0.0.1',port:40_000 + generation,generation};
    },
    closeRelay:async (_plugin,expected = null) => {
      if (expected !== null && activeRelay !== expected) return {closed:false,stale:true};
      const closed = activeRelay !== null;
      activeRelay = null;
      return {closed,stale:false};
    },
  };
  let releaseFirstConnection;
  const firstConnectionRelease = new Promise((resolve) => { releaseFirstConnection = resolve; });
  let createCalls = 0;
  const connections = [];
  const makeConnection = (name) => {
    const connection = {
      name,destroyed:false,ended:false,
      query:async ({sql}) => sql === 'SELECT DATABASE() AS ai_ops_database'
        ? [[{ai_ops_database:'app'}]]
        : [[{ai_ops_health:1}]],
      end:async () => { connection.ended = true; },
      destroy:() => { connection.destroyed = true; },
      on:() => undefined,
    };
    connections.push(connection);
    return connection;
  };
  const client = {
    createConnection:async () => {
      createCalls += 1;
      if (createCalls === 1) {
        await firstConnectionRelease;
        return makeConnection('late-A');
      }
      return makeConnection('retry-B');
    },
  };
  const mysqlRuntime = new MysqlPluginRuntime(routeManager,{load:async () => ({password:'saved'})},{client});
  const store = {
    getEnvironment:async () => ({revision:1}),listPlugins:async () => [plugin],getPlugin:async () => plugin,appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store,mysqlRuntime,{retryDelays:[],connectDeadlineMs:25});
  const timedOut = await manager.connect('p1','e1');
  assert.equal(timedOut.phase,'failed');
  assert.equal(timedOut.plugins['mysql-1'].reason,'CONNECT_TIMEOUT');
  const retry = await manager.connect('p1','e1');
  assert.equal(retry.phase,'connected');
  assert.equal(mysqlRuntime.require(plugin).connection.name,'retry-B');
  const retryRelay = activeRelay;

  releaseFirstConnection();
  for (let index = 0; index < 100 && connections.length < 2; index += 1) await delay(2);
  await delay(10);
  assert.equal(mysqlRuntime.require(plugin).connection.name,'retry-B');
  assert.equal(activeRelay,retryRelay);
  assert.equal(connections.find((item) => item.name === 'late-A')?.ended,true);
  assert.equal(connections.find((item) => item.name === 'retry-B')?.destroyed,false);
  assert.equal(manager.snapshot('p1','e1').phase,'connected');
});

test('a permanently pending MySQL graceful disconnect is force-owned and a later reconnect remains healthy', async () => {
  const plugin = {
    ...connectionPlugin('mysql-1'),pluginType:'mysql',
    target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},limits:{timeoutMs:5_000},
  };
  let relaySequence = 0;
  let activeRelay = null;
  const routeManager = {
    createRelay:async () => {
      const generation = ++relaySequence;
      activeRelay = generation;
      return {host:'127.0.0.1',port:41_000 + generation,generation};
    },
    closeRelay:async (_plugin,expected = null) => {
      if (expected !== null && activeRelay !== expected) return {closed:false,stale:true};
      activeRelay = null;
      return {closed:true,stale:false};
    },
  };
  let createCalls = 0;
  const connections = [];
  const client = {createConnection:async () => {
    createCalls += 1;
    const connection = {
      name:createCalls === 1 ? 'closing-A' : 'reconnect-C',destroyed:false,
      query:async ({sql}) => sql === 'SELECT DATABASE() AS ai_ops_database'
        ? [[{ai_ops_database:'app'}]]
        : [[{ai_ops_health:1}]],on:() => undefined,
      destroy:() => { connection.destroyed = true; },
      end:createCalls === 1 ? async () => new Promise(() => undefined) : async () => undefined,
    };
    connections.push(connection);
    return connection;
  }};
  const mysqlRuntime = new MysqlPluginRuntime(routeManager,{load:async () => ({password:'saved'})},{client});
  const store = {
    getEnvironment:async () => ({revision:1}),listPlugins:async () => [plugin],getPlugin:async () => plugin,appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store,mysqlRuntime,{retryDelays:[],disconnectDeadlineMs:100});
  await manager.connect('p1','e1');
  const disconnected = await manager.disconnect('p1','e1');
  assert.equal(disconnected.phase,'disconnected');
  for (let index = 0; index < 100 && !connections[0].destroyed; index += 1) await delay(2);
  assert.equal(connections[0].destroyed,true);
  assert.equal(mysqlRuntime.sessions.size,0);
  const reconnected = await manager.connect('p1','e1');
  assert.equal(reconnected.phase,'connected');
  assert.equal(mysqlRuntime.require(plugin).connection.name,'reconnect-C');
  assert.equal(connections[1].destroyed,false);
  assert.equal(activeRelay,2);
});

test('transient diagnostic route and SSH generations are reclaimed instead of growing without bound', async () => {
  const routeManager = new RouteManager();
  for (let index = 0; index < 2_000; index += 1) {
    const plugin = connectionPlugin(`diagnostic-route-${index}`,'mysql');
    const generation = routeManager.bumpGeneration(plugin);
    await routeManager.closeRelay(plugin,generation);
  }
  assert.equal(routeManager.generations.size,0);

  const broker = new SshBroker({appendAudit:async () => undefined});
  for (let index = 0; index < 500; index += 1) {
    const resource = `diagnostic-ssh-${index}`;
    const generation = ++broker.generationSequence;
    let close;
    const client = {
      once:(_event,callback) => { close = callback; },
      end:() => queueMicrotask(() => close?.()),
    };
    broker.generations.set(resource,generation);
    broker.sessions.set(resource,{client,generation,connectedAt:'now'});
    await broker.disconnect(resource,'diagnostic-complete');
  }
  assert.equal(broker.generations.size,0);
  assert.equal(broker.sessions.size,0);
});

test('shared mutation gate makes project delete wait for Agent addPlugin and rejects later additions', async (t) => {
  const root = await tempRoot(t,'ai-ops-agent-add-gate-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Agent add gate',projectId:'agent-add-gate'});
  const [environment] = await store.listEnvironments(project.projectId);
  const coordinator = new WorkspaceMutationCoordinator();
  let announceReconcile;
  const reconcileStarted = new Promise((resolve) => { announceReconcile = resolve; });
  let releaseReconcile;
  const reconcileRelease = new Promise((resolve) => { releaseReconcile = resolve; });
  const connectionManager = {
    on:() => undefined,
    snapshot:() => ({desiredConnected:false,phase:'disconnected',plugins:{}}),
    beginConfigurationMutation:() => 'agent-add-token',endConfigurationMutation:() => undefined,
    configurationChanged:async () => { announceReconcile(); await reconcileRelease; return {}; },
    disconnect:async () => ({phase:'disconnected'}),forgetProject:async () => undefined,
  };
  const contextManager = {
    verifyEnvironment:async () => ({environment:await store.getEnvironment(project.projectId,environment.environmentId)}),
    invalidateEnvironment:() => undefined,invalidateProject:() => undefined,
  };
  const confirmationManager = {on:() => undefined,invalidateProject:() => undefined};
  const service = new V2Service({
    workspaceStore:store,connectionManager,pluginManager:{},contextManager,confirmationManager,
    serverOperations:{},credentialVault:{},mutationCoordinator:coordinator,
  });
  const addParams = {
    projectId:project.projectId,environmentId:environment.environmentId,contextToken:'context',clientInstanceId:'agent',
    pluginType:'redis',displayName:'Agent Redis',configuration:{host:'redis.internal',port:6379,logicalDb:0,username:'reader'},
  };
  const adding = service.addPlugin(addParams);
  await reconcileStarted;

  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,connectionManager,credentialVault:{},contextManager,confirmationManager,
    pluginManager:{},mysqlRuntime:{},mutationCoordinator:coordinator,
  });
  let deleteSettled = false;
  const deleting = handlers.get('v2:project-delete')({}, {projectId:project.projectId}).finally(() => { deleteSettled = true; });
  await delay(10);
  assert.equal(deleteSettled,false,'delete waits for the already-started Agent mutation');
  await assert.rejects(
    () => service.addPlugin({...addParams,displayName:'Too late'}),
    (error) => error.code === 'PROJECT_DELETING',
  );
  releaseReconcile();
  const added = await adding;
  assert.equal(added.plugin.displayName,'Agent Redis');
  const deleted = await deleting;
  assert.equal(deleted.ok,true);
  await assert.rejects(() => store.getProject(project.projectId),(error) => error.code === 'PROJECT_NOT_FOUND');
});

test('shared operation gate drains an Agent invoke before delete and prevents orphan operations', async (t) => {
  const root = await tempRoot(t,'ai-ops-agent-invoke-gate-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Agent invoke gate',projectId:'agent-invoke-gate'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'mysql',displayName:'Orders DB',target:{host:'db.internal',database:'orders'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
  });
  const coordinator = new WorkspaceMutationCoordinator();
  let phase = 'connected';
  let announceInvoke;
  const invokeStarted = new Promise((resolve) => { announceInvoke = resolve; });
  let releaseInvoke;
  const invokeRelease = new Promise((resolve) => { releaseInvoke = resolve; });
  const connectionManager = {
    on:() => undefined,
    snapshot:() => ({desiredConnected:phase === 'connected',phase:phase === 'connected' ? 'connected' : 'disconnected',plugins:{[plugin.pluginInstanceId]:{phase}}}),
    assertConfigurationStable:() => undefined,
    beginConfigurationMutation:() => 'delete-token',endConfigurationMutation:() => undefined,
    disconnect:async () => ({phase:'disconnected'}),forgetProject:async () => undefined,
  };
  const contextManager = {
    verify:async () => ({plugin,environment,runbook:{content:''}}),invalidateProject:() => undefined,
  };
  const confirmationManager = {on:() => undefined,invalidateProject:() => undefined};
  const pluginManager = {invoke:async () => {
    phase = 'disconnected';
    announceInvoke();
    await invokeRelease;
    return {rows:[]};
  }};
  const service = new V2Service({
    workspaceStore:store,connectionManager,pluginManager,contextManager,confirmationManager,
    serverOperations:{},credentialVault:{},mutationCoordinator:coordinator,
  });
  const params = {
    projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:plugin.pluginInstanceId,
    contextToken:'context',clientInstanceId:'agent',requestId:'active-operation',
  };
  const invoking = service.invoke(params,'describe',{table:'orders'});
  await invokeStarted;
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,connectionManager,credentialVault:{},contextManager,confirmationManager,
    pluginManager,mysqlRuntime:{},mutationCoordinator:coordinator,
  });
  let deleteSettled = false;
  const deleting = handlers.get('v2:project-delete')({}, {projectId:project.projectId}).finally(() => { deleteSettled = true; });
  await delay(10);
  assert.equal(deleteSettled,false);
  await assert.rejects(
    () => service.invoke({...params,requestId:'orphan-operation'},'describe',{table:'orders'}),
    (error) => error.code === 'PROJECT_DELETING',
  );
  releaseInvoke();
  assert.deepEqual(await invoking,{rows:[]});
  const deleted = await deleting;
  assert.equal(deleted.ok,true);
  await assert.rejects(() => store.appendAudit(project.projectId,{type:'orphan'}),(error) => error.code === 'PROJECT_NOT_FOUND');
});

test('connection preparation rechecks the configuration fence before starting a runtime', async () => {
  const plugin = connectionPlugin('db-prepare-fence');
  let announcePrepare;
  const prepareStarted = new Promise((resolve) => { announcePrepare = resolve; });
  let releasePrepare;
  const prepareRelease = new Promise((resolve) => { releasePrepare = resolve; });
  let runtimeStarts = 0;
  const manager = new EnvironmentConnectionManager({
    getEnvironment:async () => { announcePrepare(); await prepareRelease; return {revision:1}; },
    listPlugins:async () => [plugin],
    getPlugin:async () => plugin,
    appendAudit:async () => undefined,
  },{
    connect:async () => { runtimeStarts += 1; return {connectedAt:'now'}; },
    disconnect:async () => undefined,forceDisconnect:async () => undefined,
  });
  const connecting = manager.connect('p1','e1');
  await prepareStarted;
  const token = manager.beginConfigurationMutation('p1','e1',plugin.pluginInstanceId);
  releasePrepare();
  await assert.rejects(connecting,(error) => error.code === 'CONFIGURATION_UPDATING');
  assert.equal(runtimeStarts,0);
  manager.endConfigurationMutation('p1','e1',token);
});

test('project deletion drains an active database discovery and rejects later transient work', async (t) => {
  const root = await tempRoot(t,'ai-ops-database-operation-gate-');
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Database discovery gate'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'mysql',displayName:'Orders',target:{host:'db.internal',database:'orders'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
  });
  const coordinator = new WorkspaceMutationCoordinator();
  let announceDiscovery;
  const discoveryStarted = new Promise((resolve) => { announceDiscovery = resolve; });
  let releaseDiscovery;
  const discoveryRelease = new Promise((resolve) => { releaseDiscovery = resolve; });
  const connectionManager = {
    on:() => undefined,snapshot:() => ({desiredConnected:false,phase:'disconnected',plugins:{}}),
    disconnect:async () => undefined,forgetProject:async () => undefined,
    beginConfigurationMutation:() => 'delete-token',endConfigurationMutation:() => undefined,
  };
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,connectionManager,credentialVault:{load:async () => null},
    contextManager:{invalidateProject:() => undefined},confirmationManager:{on:() => undefined,invalidateProject:() => undefined},
    pluginManager:{},mysqlRuntime:{listDatabases:async () => { announceDiscovery(); await discoveryRelease; return ['orders']; }},
    mutationCoordinator:coordinator,
  });
  const payload = {
    projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:plugin.pluginInstanceId,
    input:plugin,secrets:{},
  };
  const discovery = handlers.get('v2:plugin-databases')({},payload);
  await discoveryStarted;
  let deleteSettled = false;
  const deleting = handlers.get('v2:project-delete')({}, {projectId:project.projectId}).finally(() => { deleteSettled = true; });
  await delay(10);
  assert.equal(deleteSettled,false);
  const blocked = await handlers.get('v2:plugin-databases')({},payload);
  assert.equal(blocked.ok,false);
  assert.equal(blocked.error.code,'PROJECT_DELETING');
  releaseDiscovery();
  assert.deepEqual((await discovery).data,['orders']);
  assert.equal((await deleting).ok,true);
});

test('active project and environment deletion preflights do not wait behind a long Agent reader', async () => {
  const coordinator = new WorkspaceMutationCoordinator();
  let announceReader;
  const readerStarted = new Promise((resolve) => { announceReader = resolve; });
  let releaseReader;
  const readerRelease = new Promise((resolve) => { releaseReader = resolve; });
  const reader = coordinator.runEnvironmentOperation('p-fast','e-fast',async () => {
    announceReader();
    await readerRelease;
  });
  await readerStarted;
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:{listEnvironments:async () => [{projectId:'p-fast',environmentId:'e-fast',name:'生产环境'}]},
    connectionManager:{on:() => undefined,snapshot:() => ({desiredConnected:true,phase:'connected',plugins:{}})},
    credentialVault:{},contextManager:{},confirmationManager:{on:() => undefined},pluginManager:{},mysqlRuntime:{},
    mutationCoordinator:coordinator,
  });
  const projectResult = await Promise.race([
    handlers.get('v2:project-delete')({}, {projectId:'p-fast'}),
    delay(100).then(() => ({timeout:true})),
  ]);
  assert.equal(projectResult.timeout,undefined);
  assert.equal(projectResult.ok,false);
  assert.equal(projectResult.error.code,'PROJECT_CONNECTED');
  const environmentResult = await Promise.race([
    handlers.get('v2:environment-delete')({}, {projectId:'p-fast',environmentId:'e-fast'}),
    delay(100).then(() => ({timeout:true})),
  ]);
  assert.equal(environmentResult.timeout,undefined);
  assert.equal(environmentResult.ok,false);
  assert.equal(environmentResult.error.code,'ENVIRONMENT_CONNECTED');
  releaseReader();
  await reader;
});
