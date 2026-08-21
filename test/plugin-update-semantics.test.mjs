import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import {
  pluginAgentFingerprint,
  pluginConnectionFingerprint,
} from '../src/plugin-change-classifier.mjs';
import { PluginConfigTransactionJournal } from '../src/plugin-config-transaction.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-plugin-update-semantics-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  return root;
}

function plainEncryption() {
  return {
    isEncryptionAvailable:() => true,
    encryptString:(value) => Buffer.from(value, 'utf8'),
    decryptString:(value) => Buffer.from(value).toString('utf8'),
  };
}

async function createMysqlFixture(t) {
  const root = await temporaryRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Semantic updates',environmentName:'Production'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'mysql',pluginInstanceId:'orders-db',displayName:'Orders DB',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'required'},
    policy:{describe:'auto',select:'auto',explain:'auto'},
  });
  return {root,store,project,environment,plugin};
}

function registerUpdateHarness(store, overrides = {}) {
  const handlers = new Map();
  const counters = {
    beginConfigurationMutation:0,
    configurationChanged:0,
    vaultLoads:0,
    vaultWrites:0,
    journalPrepares:0,
    contextInvalidations:0,
    confirmationInvalidations:0,
  };
  const connectionManager = {
    on:() => undefined,
    snapshot:() => ({plugins:{}}),
    beginConfigurationMutation:() => {
      counters.beginConfigurationMutation += 1;
      return `fence-${counters.beginConfigurationMutation}`;
    },
    endConfigurationMutation:() => true,
    configurationChanged:async () => {
      counters.configurationChanged += 1;
      return {};
    },
    ...overrides.connectionManager,
  };
  const credentialVaultStub = {
    load:async () => {
      counters.vaultLoads += 1;
      return {password:'saved'};
    },
    saveMerged:async () => {
      counters.vaultWrites += 1;
      return {saved:false,preserved:true};
    },
  };
  const credentialVault = overrides.credentialVault ?? credentialVaultStub;
  const contextManager = {
    invalidateEnvironment:() => { counters.contextInvalidations += 1; },
    ...overrides.contextManager,
  };
  const confirmationManager = {
    on:() => undefined,
    invalidatePlugin:() => { counters.confirmationInvalidations += 1; },
    ...overrides.confirmationManager,
  };
  const configTransactionJournalStub = {
    assertPluginAvailable:() => undefined,
    assertEnvironmentAvailable:() => undefined,
    prepare:async () => {
      counters.journalPrepares += 1;
      return null;
    },
    complete:async () => undefined,
  };
  const configTransactionJournal = overrides.configTransactionJournal ?? configTransactionJournalStub;
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore:store,
    connectionManager,
    credentialVault,
    configTransactionJournal,
    contextManager,
    confirmationManager,
    pluginManager:{},
    mysqlRuntime:{},
    ...overrides.services,
  });
  return {handlers,counters};
}

test('legacy no-op update returns before YAML, vault, journal, runtime, and Agent side effects', async (t) => {
  const {store,project,environment,plugin} = await createMysqlFixture(t);
  const file = store.pluginPath(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  const yamlBefore = await fs.readFile(file);
  const statBefore = await fs.stat(file);
  let pluginWrites = 0;
  const writeYaml = store.writeYaml.bind(store);
  store.writeYaml = async (target,value) => {
    if (target === file) pluginWrites += 1;
    return writeYaml(target,value);
  };
  const {handlers,counters} = registerUpdateHarness(store);

  const result = await handlers.get('v2:plugin-update')({}, {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
    expectedRevision:plugin.revision,
    patch:{
      displayName:' Orders DB ',
      target:{...plugin.target,port:'3306'},
      auth:{...plugin.auth},
      transport:{...plugin.transport},
      tls:{...plugin.tls},
      policy:{...plugin.policy},
      limits:{...plugin.limits},
    },
    secrets:{password:'',tlsPassphrase:null},
  });

  assert.equal(result.ok,true);
  assert.equal(result.data.revision,plugin.revision);
  assert.equal(pluginWrites,0);
  assert.deepEqual(await fs.readFile(file),yamlBefore);
  assert.equal((await fs.stat(file)).mtimeMs,statBefore.mtimeMs);
  assert.deepEqual(counters,{
    beginConfigurationMutation:0,
    configurationChanged:0,
    vaultLoads:0,
    vaultWrites:0,
    journalPrepares:0,
    contextInvalidations:0,
    confirmationInvalidations:0,
  });
});

test('modern and compatibility connection update channels reject incomplete formal saves', async (t) => {
  const {store,project,environment,plugin} = await createMysqlFixture(t);
  const file = store.pluginPath(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  const yamlBefore = await fs.readFile(file);
  const {handlers,counters} = registerUpdateHarness(store);
  const payload = {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
    expectedRevision:plugin.revision,
    patch:{target:{...plugin.target,database:''}},
  };

  for (const channel of ['v2:plugin-connection-update','v2:plugin-update']) {
    const result = await handlers.get(channel)({},payload);
    assert.equal(result.ok,false,channel);
    assert.equal(result.error.code,'PLUGIN_CONFIGURATION_INCOMPLETE',channel);
    assert.equal(result.error.details.issues[0].field,'target.database',channel);
  }
  assert.deepEqual(await fs.readFile(file),yamlBefore);
  assert.equal((await store.getPlugin(
    project.projectId,environment.environmentId,plugin.pluginInstanceId,
  )).revision,plugin.revision);
  assert.deepEqual(counters,{
    beginConfigurationMutation:0,
    configurationChanged:0,
    vaultLoads:0,
    vaultWrites:0,
    journalPrepares:0,
    contextInvalidations:0,
    confirmationInvalidations:0,
  });
});

test('metadata and Agent update channels enforce allow-lists and isolate side effects', async (t) => {
  const {store,project,environment,plugin} = await createMysqlFixture(t);
  const {handlers,counters} = registerUpdateHarness(store);
  const scope = {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
  };
  const metadata = handlers.get('v2:plugin-metadata-update');
  const agent = handlers.get('v2:plugin-agent-configuration-update');
  const connection = handlers.get('v2:plugin-connection-update');
  assert.equal(typeof metadata,'function');
  assert.equal(typeof agent,'function');
  assert.equal(typeof connection,'function');

  const metadataResult = await metadata({}, {
    ...scope,expectedRevision:plugin.revision,
    patch:{displayName:'Orders primary',description:'Production orders',tags:['prod'],displayOrder:7},
  });
  assert.equal(metadataResult.ok,true);
  assert.equal(metadataResult.data.displayName,'Orders primary');
  assert.equal(metadataResult.data.description,'Production orders');
  assert.deepEqual(metadataResult.data.tags,['prod']);
  assert.equal(metadataResult.data.displayOrder,7);
  assert.equal(pluginConnectionFingerprint(metadataResult.data),pluginConnectionFingerprint(plugin));
  assert.equal(pluginAgentFingerprint(metadataResult.data),pluginAgentFingerprint(plugin));
  assert.equal(counters.beginConfigurationMutation,0);
  assert.equal(counters.configurationChanged,0);
  assert.equal(counters.vaultLoads,0);
  assert.equal(counters.vaultWrites,0);
  assert.equal(counters.contextInvalidations,0);
  assert.equal(counters.confirmationInvalidations,0);

  const agentResult = await agent({}, {
    ...scope,expectedRevision:metadataResult.data.revision,
    patch:{policy:{...metadataResult.data.policy,select:'confirm'}},
  });
  assert.equal(agentResult.ok,true);
  assert.equal(pluginConnectionFingerprint(agentResult.data),pluginConnectionFingerprint(metadataResult.data));
  assert.notEqual(pluginAgentFingerprint(agentResult.data),pluginAgentFingerprint(metadataResult.data));
  assert.equal(counters.beginConfigurationMutation,0);
  assert.equal(counters.configurationChanged,0);
  assert.equal(counters.vaultLoads,0);
  assert.equal(counters.vaultWrites,0);
  assert.equal(counters.contextInvalidations,1);
  assert.equal(counters.confirmationInvalidations,1);

  for (const [handler,payload] of [
    [metadata,{...scope,expectedRevision:agentResult.data.revision,patch:{target:{host:'other.internal'}}}],
    [metadata,{...scope,expectedRevision:agentResult.data.revision,patch:{displayName:'Orders primary'},secrets:{password:'smuggled'}}],
    [agent,{...scope,expectedRevision:agentResult.data.revision,patch:{tls:{mode:'disabled'}}}],
    [agent,{...scope,expectedRevision:agentResult.data.revision,patch:{policy:{select:'confirm'}},credentialIntent:'rebind-existing'}],
    [connection,{...scope,expectedRevision:agentResult.data.revision,patch:{displayName:'smuggled'}}],
    [connection,{...scope,expectedRevision:agentResult.data.revision,patch:{target:{host:'db.internal',password:'smuggled'}}}],
  ]) {
    const rejected = await handler({},payload);
    assert.equal(rejected.ok,false);
    assert.equal(rejected.error.code,'INVALID_ARGUMENT');
  }
  const current = await store.getPlugin(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  assert.equal(current.revision,agentResult.data.revision);
  assert.equal(current.target.host,'db.internal');
  assert.equal(current.tls.mode,'required');
});

test('legacy Redis default DB remains semantic zero without no-op or metadata migration writes', async (t) => {
  const root = await temporaryRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Legacy Redis',environmentName:'Production'});
  const [environment] = await store.listEnvironments(project.projectId);
  const created = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'redis',pluginInstanceId:'cache',displayName:'Cache',
    target:{host:'redis.internal',port:6379,db:0,addressFamily:'ipv4Only'},
    auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},
  });
  const file = store.pluginPath(project.projectId,environment.environmentId,created.pluginInstanceId);
  const legacy = parse(await fs.readFile(file,'utf8'));
  delete legacy.target.db;
  await store.writeYaml(file,legacy);
  const yamlBefore = await fs.readFile(file);
  let pluginWrites = 0;
  const writeYaml = store.writeYaml.bind(store);
  store.writeYaml = async (target,value) => {
    if (target === file) pluginWrites += 1;
    return writeYaml(target,value);
  };
  const {handlers,counters} = registerUpdateHarness(store);
  const scope = {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:created.pluginInstanceId,
  };

  const noOp = await handlers.get('v2:plugin-update')({}, {
    ...scope,expectedRevision:created.revision,patch:{},secrets:{password:''},
  });
  assert.equal(noOp.ok,true);
  assert.equal(noOp.data.revision,created.revision);
  assert.equal('db' in noOp.data.target,false);
  assert.equal(pluginWrites,0);
  assert.deepEqual(await fs.readFile(file),yamlBefore);
  assert.equal(counters.beginConfigurationMutation,0);
  assert.equal(counters.vaultWrites,0);

  const renamed = await handlers.get('v2:plugin-metadata-update')({}, {
    ...scope,expectedRevision:created.revision,patch:{displayName:'Primary cache'},
  });
  assert.equal(renamed.ok,true);
  assert.equal(renamed.data.displayName,'Primary cache');
  assert.equal('db' in renamed.data.target,false,'metadata must not materialize the legacy default DB');
  assert.equal(pluginConnectionFingerprint(renamed.data),pluginConnectionFingerprint(noOp.data));
  assert.equal(counters.beginConfigurationMutation,0);
  assert.equal(counters.vaultWrites,0);
});

test('server connection candidates clear fingerprints for a new address and preserve the committed address on cancel', async (t) => {
  const root = await temporaryRoot(t);
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'SSH fingerprint',environmentName:'Production'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId,environment.environmentId,{
    pluginType:'server',pluginInstanceId:'server-1',displayName:'Server',
    target:{host:'old.internal',port:22,addressFamily:'ipv4Only',hostKeyFingerprint:'SHA256:old'},
    auth:{type:'password',username:'ops'},uplink:{type:'direct'},
  });
  const file = store.pluginPath(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  const yamlBefore = await fs.readFile(file);

  const changed = await store.preparePluginConnectionUpdate(
    project.projectId,environment.environmentId,plugin.pluginInstanceId,
    {target:{host:'new.internal',port:22,hostKeyFingerprint:'SHA256:old'}},
    plugin.revision,
  );
  assert.equal(changed.candidate.target.host,'new.internal');
  assert.equal('hostKeyFingerprint' in changed.candidate.target,false);
  assert.equal('hostKeyFingerprint' in changed.after.target,false);

  const reverted = await store.preparePluginConnectionUpdate(
    project.projectId,environment.environmentId,plugin.pluginInstanceId,
    {target:{host:'old.internal',port:22}},
    plugin.revision,
  );
  assert.equal(reverted.change.kind,'none');
  assert.equal(reverted.candidate.target.hostKeyFingerprint,'SHA256:old');
  assert.deepEqual(await fs.readFile(file),yamlBefore,'preparing and cancelling leave committed YAML untouched');
  const committed = await store.getPlugin(project.projectId,environment.environmentId,plugin.pluginInstanceId);
  assert.equal(committed.target.hostKeyFingerprint,'SHA256:old');
});

test('database-only connection update rebinds every saved secret without password re-entry', async (t) => {
  const {root,store,project,environment,plugin} = await createMysqlFixture(t);
  const vault = new PluginCredentialVault(root,plainEncryption());
  const secrets = {
    password:'saved-password',
    tlsPassphrase:'saved-passphrase',
    caPem:'saved-ca',
    clientCertPem:'saved-cert',
    clientKeyPem:'saved-key',
  };
  await vault.save(plugin,secrets);
  const journal = new PluginConfigTransactionJournal(root,store,vault);
  const {handlers,counters} = registerUpdateHarness(store,{
    credentialVault:vault,
    configTransactionJournal:journal,
  });
  const result = await handlers.get('v2:plugin-connection-update')({}, {
    projectId:project.projectId,
    environmentId:environment.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
    expectedRevision:plugin.revision,
    patch:{target:{...plugin.target,database:'orders_archive'}},
    credentialIntent:'unchanged',
    temporarySecrets:{},
  });

  assert.equal(result.ok,true);
  assert.equal(result.data.target.database,'orders_archive');
  assert.deepEqual(await vault.load(result.data),secrets);
  assert.equal(counters.beginConfigurationMutation,1);
  assert.equal(counters.configurationChanged,1);
  assert.equal(counters.contextInvalidations,1);
});
