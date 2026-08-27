import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore,workspaceInternals } from '../src/workspace-store.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { PluginDraftStore } from '../src/plugin-draft-store.mjs';
import { PluginDraftCredentialVault } from '../src/plugin-draft-credential-vault.mjs';
import { PluginDraftPromotionJournal } from '../src/plugin-draft-promotion-journal.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';

function encryption(control = {}) {
  return {
    isEncryptionAvailable:() => true,
    encryptString:(value) => Buffer.from(String(value),'utf8'),
    decryptString:(value) => {
      if (control.unreadable) throw new Error('decrypt unavailable');
      return Buffer.from(value).toString('utf8');
    },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-plugin-draft-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const workspaceStore = new WorkspaceStore(root);
  await workspaceStore.init({migrateLegacy:false});
  const project = await workspaceStore.createProject({name:'Draft project',environmentName:'Production'});
  const [environment] = await workspaceStore.listEnvironments(project.projectId);
  return {root,workspaceStore,project,environment};
}

function mysqlDraft(overrides = {}) {
  return {
    pluginType:'mysql',displayName:'Orders draft',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    ...overrides,
  };
}

test('saved plugin drafts survive restart without persisting plaintext or touching the active vault', async (t) => {
  const values = await fixture(t);
  const active = await values.workspaceStore.createPlugin(values.project.projectId,values.environment.environmentId,mysqlDraft({displayName:'Existing active'}));
  const activeVault = new PluginCredentialVault(values.root,encryption());
  await activeVault.save(active,{password:'active-password'});
  const activeBefore = await fs.readFile(activeVault.file);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const store = new PluginDraftStore(values.workspaceStore,draftVault);

  const saved = await store.save({
    projectId:values.project.projectId,
    environmentId:values.environment.environmentId,
    pluginType:'mysql',
    sanitizedDraft:mysqlDraft(),
    credentialIntent:'replace',
    temporarySecrets:{password:'draft-password'},
  });
  assert.equal(saved.credentialState,'stored-active');
  assert.equal(saved.validationState,'stale');
  const sidecar = await fs.readFile(store.fileFor(saved),'utf8');
  assert.doesNotMatch(sidecar,/draft-password|active-password|ciphertext/);

  const restarted = new PluginDraftStore(values.workspaceStore,new PluginDraftCredentialVault(values.root,encryption()));
  const resumed = await restarted.resume({
    projectId:values.project.projectId,
    environmentId:values.environment.environmentId,
    draftId:saved.draftId,
  });
  assert.equal(resumed.draftId,saved.draftId);
  assert.equal(resumed.sanitizedDraft.target.database,'orders');
  assert.equal(resumed.credentialState,'stored-active');
  assert.equal(resumed.validationState,'stale');
  assert.deepEqual(await activeVault.load(active),{password:'active-password'});
  assert.deepEqual(await fs.readFile(activeVault.file),activeBefore);
});

test('draft identity changes retain the old encrypted candidate as inactive and never send it to the new target', async (t) => {
  const values = await fixture(t);
  const vault = new PluginDraftCredentialVault(values.root,encryption());
  const store = new PluginDraftStore(values.workspaceStore,vault);
  const first = await store.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft(),temporarySecrets:{password:'old-target-password'},
    credentialIntent:'replace',
  });
  const changed = await store.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    draftId:first.draftId,expectedDraftRevision:first.revision,pluginType:'mysql',
    sanitizedDraft:mysqlDraft({target:{...mysqlDraft().target,host:'other.internal'}}),
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  assert.equal(changed.credentialState,'stored-inactive');
  await assert.rejects(
    () => vault.loadActive(changed,changed.sanitizedDraft),
    (error) => error.code === 'DRAFT_CREDENTIAL_INACTIVE',
  );
  const envelope = await vault.readEnvelope();
  const entry = envelope.entries[vault.resourceKey(changed)];
  assert.equal(Object.keys(entry.candidates).length,1);
  assert.equal(JSON.stringify(envelope).includes('old-target-password'),false);
});

test('unreadable draft credentials remain byte-for-byte intact across ordinary save and delete', async (t) => {
  const values = await fixture(t);
  const control = {unreadable:false};
  const vault = new PluginDraftCredentialVault(values.root,encryption(control));
  const store = new PluginDraftStore(values.workspaceStore,vault);
  const first = await store.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'redis',
    sanitizedDraft:{
      pluginType:'redis',displayName:'Cache draft',
      target:{host:'cache.internal',port:6379,db:0,addressFamily:'ipv4Only'},
      auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},
    },
    credentialIntent:'replace',temporarySecrets:{password:'preserve-me'},
  });
  const beforePrimary = await fs.readFile(vault.file);
  const beforeBackup = await fs.readFile(vault.backupFile);
  control.unreadable = true;

  const ordinary = await store.save({
    projectId:first.projectId,environmentId:first.environmentId,draftId:first.draftId,
    expectedDraftRevision:first.revision,pluginType:'redis',
    sanitizedDraft:{...first.sanitizedDraft,description:'still editable'},
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  assert.equal(ordinary.credentialState,'unreadable');
  assert.deepEqual(await fs.readFile(vault.file),beforePrimary);
  assert.deepEqual(await fs.readFile(vault.backupFile),beforeBackup);
  await assert.rejects(
    () => store.save({
      projectId:first.projectId,environmentId:first.environmentId,draftId:first.draftId,
      expectedDraftRevision:ordinary.revision,pluginType:'redis',
      sanitizedDraft:ordinary.sanitizedDraft,credentialIntent:'replace',
      temporarySecrets:{password:'must-not-overwrite'},
    }),
    (error) => error.code === 'DRAFT_CREDENTIAL_REPLACEMENT_INCOMPLETE',
  );
  await store.delete({projectId:first.projectId,environmentId:first.environmentId,draftId:first.draftId});
  await assert.rejects(
    () => store.resume({projectId:first.projectId,environmentId:first.environmentId,draftId:first.draftId}),
    (error) => error.code === 'PLUGIN_DRAFT_NOT_FOUND',
  );
  assert.deepEqual(await fs.readFile(vault.file),beforePrimary);
  assert.deepEqual(await fs.readFile(vault.backupFile),beforeBackup);
});

async function promotionFixture(t) {
  const values = await fixture(t);
  const activeVault = new PluginCredentialVault(values.root,encryption());
  const unrelated = await values.workspaceStore.createPlugin(
    values.project.projectId,
    values.environment.environmentId,
    mysqlDraft({displayName:'Unrelated active',pluginInstanceId:'unrelated-db'}),
  );
  await activeVault.save(unrelated,{password:'unrelated-password'});
  const unrelatedBefore = {
    primary:await fs.readFile(activeVault.file),
    backup:await fs.readFile(activeVault.backupFile),
  };
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const draft = await draftStore.save({
    projectId:values.project.projectId,
    environmentId:values.environment.environmentId,
    pluginType:'mysql',
    sanitizedDraft:mysqlDraft({displayName:'Promoted orders',pluginInstanceId:'promoted-orders'}),
    credentialIntent:'replace',
    temporarySecrets:{password:'promoted-password'},
  });
  const journal = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,draftStore,draftVault,activeVault,
  );
  return {...values,activeVault,unrelated,unrelatedBefore,draftVault,draftStore,draft,journal};
}

async function persistPromotionPhase({
  journal,draft,before = null,after = draft.sanitizedDraft,
  credentialMode = 'copy-draft',beforeHadCredential = false,phase,
}) {
  const transaction = await journal.prepare(
    draft,before,after,{credentialMode,beforeHadCredential},
  );
  await journal.commitConfig(transaction,before);
  if (phase !== 'after-config-write') await journal.commitCredential(transaction,draft);
  if (phase === 'after-draft-cleanup') await journal.deleteDraftIfPresent(transaction);
  journal.markUnresolved(transaction);
  return transaction;
}

for (const failurePoint of ['after-config-write','after-vault-commit','after-draft-cleanup']) {
  test(`draft promotion recovers a complete formal plugin after ${failurePoint}`, async (t) => {
    const values = await promotionFixture(t);
    await persistPromotionPhase({...values,phase:failurePoint});
    assert.equal(values.journal.hasUnresolved(),true);
    assert.throws(
      () => values.journal.assertEnvironmentAvailable(values.draft.projectId,values.draft.environmentId),
      (error) => error.code === 'DRAFT_PROMOTION_RECOVERY_REQUIRED',
    );

    const recoveredJournal = new PluginDraftPromotionJournal(
      values.root,values.workspaceStore,values.draftStore,values.draftVault,values.activeVault,
    );
    const [result] = await recoveredJournal.recoverAll();
    assert.equal(result.recovered,true);
    const promoted = await values.workspaceStore.getPlugin(
      values.draft.projectId,values.draft.environmentId,values.draft.sanitizedDraft.pluginInstanceId,
    );
    assert.equal(promoted.configState,'ready');
    assert.deepEqual(await values.activeVault.load(promoted),{password:'promoted-password'});
    await assert.rejects(
      () => values.draftStore.resume(values.draft),
      (error) => error.code === 'PLUGIN_DRAFT_NOT_FOUND',
    );
    assert.deepEqual(await values.activeVault.load(values.unrelated),{password:'unrelated-password'});
    const journalFiles = await fs.readdir(recoveredJournal.directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.deepEqual(journalFiles,[]);
  });
}

for (const failurePoint of ['after-config-write','after-vault-commit']) {
  test(`draft promotion recovery commits replacement credentials for an existing binding after ${failurePoint}`, async (t) => {
    const values = await fixture(t);
    const activeVault = new PluginCredentialVault(values.root,encryption());
    const base = await values.workspaceStore.createPlugin(
      values.project.projectId,values.environment.environmentId,
      mysqlDraft({displayName:'Existing credential target',pluginInstanceId:'existing-credential-target'}),
    );
    await activeVault.save(base,{password:'old-password',tlsPassphrase:'preserved-tls-passphrase'});
    const draftVault = new PluginDraftCredentialVault(values.root,encryption());
    const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
    const draft = await draftStore.save({
      projectId:base.projectId,environmentId:base.environmentId,
      basePluginInstanceId:base.pluginInstanceId,baseRevision:base.revision,
      pluginType:base.pluginType,sanitizedDraft:{...base,description:'credential replacement draft'},
      credentialIntent:'replace',temporarySecrets:{password:'new-password'},
    });
    const journal = new PluginDraftPromotionJournal(
      values.root,values.workspaceStore,draftStore,draftVault,activeVault,
    );
    const after = workspaceInternals.materializePluginCandidate(draft.sanitizedDraft,base);
    await persistPromotionPhase({journal,draft,before:base,after,phase:failurePoint});
    const recovered = new PluginDraftPromotionJournal(
      values.root,values.workspaceStore,draftStore,draftVault,activeVault,
    );
    const [result] = await recovered.recoverAll();
    assert.equal(result.recovered,true);
    const plugin = await values.workspaceStore.getPlugin(base.projectId,base.environmentId,base.pluginInstanceId);
    assert.deepEqual(await activeVault.load(plugin),{
      password:'new-password',tlsPassphrase:'preserved-tls-passphrase',
    });
  });
}

test('sidecar drafts count as needs-action but never enter the committed plugin catalog', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft({target:{...mysqlDraft().target,database:''}}),
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  assert.equal(await draftStore.count(values.project.projectId,values.environment.environmentId),1);
  assert.deepEqual(await values.workspaceStore.listPlugins(values.project.projectId,values.environment.environmentId),[]);
});

test('legacy sidecar drafts are not exposed through IPC or environment summaries', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  await draftStore.save({
    projectId:values.project.projectId,
    environmentId:values.environment.environmentId,
    pluginType:'mysql',
    sanitizedDraft:mysqlDraft({target:{...mysqlDraft().target,database:''}}),
    credentialIntent:'replace',
    temporarySecrets:{password:'legacy-draft-password'},
  });
  const handlers = new Map();
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore:values.workspaceStore,
    credentialVault:new PluginCredentialVault(values.root,encryption()),
    connectionManager:{
      on:() => undefined,
      snapshot:(projectId,environmentId) => ({projectId,environmentId,phase:'disconnected',sequence:0,plugins:{}}),
      status:async (projectId,environmentId) => ({projectId,environmentId,phase:'disconnected',sequence:0,eligibleCount:0,connectedCount:0,plugins:{}}),
    },
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
  });
  const event = {sender:{id:41,isDestroyed:() => false,once:() => undefined,send:() => undefined}};
  const environmentResult = await handlers.get('v2:environment-list')(event,values.project.projectId);
  assert.equal(environmentResult.data[0].pluginCount,0);
  assert.equal(environmentResult.data[0].readyPluginCount,0);
  assert.equal(environmentResult.data[0].sidecarDraftCount,undefined);
  const pluginResult = await handlers.get('v2:plugin-list')(event,{
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
  });
  assert.deepEqual(pluginResult.data,[]);
  for (const channel of ['list','save','resume','edit-cancel','delete','promote']) {
    assert.equal(handlers.has(`v2:plugin-draft-${channel}`),false);
  }
});

test('an unchanged draft save is a true no-op with no revision, sidecar, or draft-vault access', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const saved = await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft(),credentialIntent:'replace',
    temporarySecrets:{password:'no-op-password'},
  });
  const before = {
    sidecar:await fs.readFile(draftStore.fileFor(saved)),
    primary:await fs.readFile(draftVault.file),
    backup:await fs.readFile(draftVault.backupFile),
  };
  let vaultAccesses = 0;
  const state = draftVault.state.bind(draftVault);
  draftVault.state = async (...args) => { vaultAccesses += 1; return state(...args); };
  const result = await draftStore.save({
    projectId:saved.projectId,environmentId:saved.environmentId,draftId:saved.draftId,
    expectedDraftRevision:saved.revision,pluginType:saved.pluginType,
    sanitizedDraft:saved.sanitizedDraft,credentialIntent:'unchanged',temporarySecrets:{password:''},
  });
  assert.equal(result.revision,saved.revision);
  assert.equal(vaultAccesses,0);
  assert.deepEqual(await fs.readFile(draftStore.fileFor(saved)),before.sidecar);
  assert.deepEqual(await fs.readFile(draftVault.file),before.primary);
  assert.deepEqual(await fs.readFile(draftVault.backupFile),before.backup);
});

test('an incomplete identity can replace its own inactive candidate without making it connectable', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const incomplete = mysqlDraft({target:{...mysqlDraft().target,host:''}});
  const first = await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:incomplete,credentialIntent:'replace',
    temporarySecrets:{password:'inactive-v1'},
  });
  const second = await draftStore.save({
    ...first,expectedDraftRevision:first.revision,sanitizedDraft:first.sanitizedDraft,
    credentialIntent:'replace',temporarySecrets:{password:'inactive-v2'},
  });
  assert.equal(second.credentialState,'stored-inactive');
  await assert.rejects(
    () => draftVault.loadActive(second,second.sanitizedDraft),
    (error) => error.code === 'DRAFT_CREDENTIAL_INACTIVE',
  );
  const candidate = (await draftVault.readEnvelope()).entries[draftVault.resourceKey(second)]
    .candidates[draftVault.identityHash(second.sanitizedDraft)];
  assert.match(Buffer.from(candidate.ciphertext,'base64').toString('utf8'),/inactive-v2/);
});

test('promotion recovery repairs a new plugin orphaned between YAML write and environment indexing', async (t) => {
  const values = await promotionFixture(t);
  const environmentFile = values.workspaceStore.environmentPath(values.draft.projectId,values.draft.environmentId);
  const writeYaml = values.workspaceStore.writeYaml.bind(values.workspaceStore);
  let failIndex = true;
  values.workspaceStore.writeYaml = async (file,value) => {
    if (failIndex && file === environmentFile) throw Object.assign(new Error('index write crash'),{code:'SIMULATED_CRASH'});
    return writeYaml(file,value);
  };
  const transaction = await values.journal.prepare(
    values.draft,null,values.draft.sanitizedDraft,{credentialMode:'copy-draft'},
  );
  await assert.rejects(
    () => values.journal.commitConfig(transaction,null),
    (error) => error.code === 'SIMULATED_CRASH',
  );
  values.journal.markUnresolved(transaction);
  failIndex = false;
  const recovered = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,values.draftStore,values.draftVault,values.activeVault,
  );
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,true);
  const catalog = await values.workspaceStore.listPlugins(values.draft.projectId,values.draft.environmentId);
  assert.equal(catalog.some((plugin) => plugin.pluginInstanceId === values.draft.sanitizedDraft.pluginInstanceId),true);
});

test('a secret-bearing promotion journal is retained byte-for-byte and globally fenced', async (t) => {
  const values = await promotionFixture(t);
  await persistPromotionPhase({...values,phase:'after-config-write'});
  const [name] = await fs.readdir(values.journal.directory);
  const file = path.join(values.journal.directory,name);
  const tampered = JSON.parse(await fs.readFile(file,'utf8'));
  tampered.secrets = {password:'must-never-enter-a-journal'};
  await fs.writeFile(file,JSON.stringify(tampered),'utf8');
  const before = await fs.readFile(file);
  const recovered = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,values.draftStore,values.draftVault,values.activeVault,
  );
  const [result] = await recovered.recoverAll();
  assert.equal(result.recovered,false);
  assert.equal(result.action,'invalid-journal');
  assert.equal(recovered.hasUnresolved(),true);
  assert.deepEqual(await fs.readFile(file),before);
  assert.throws(
    () => recovered.assertEnvironmentAvailable(values.draft.projectId,values.draft.environmentId),
    (error) => error.code === 'DRAFT_PROMOTION_RECOVERY_REQUIRED',
  );
});

test('the obsolete persistent draft service remains absent', async () => {
  await assert.rejects(
    fs.access(new URL('../src/plugin-draft-service.mjs',import.meta.url)),
    {code:'ENOENT'},
  );
});
