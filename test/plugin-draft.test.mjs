import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { PluginDraftStore } from '../src/plugin-draft-store.mjs';
import { PluginDraftCredentialVault } from '../src/plugin-draft-credential-vault.mjs';
import { PluginDraftPromotionJournal } from '../src/plugin-draft-promotion-journal.mjs';
import { PluginDraftService } from '../src/plugin-draft-service.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

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

async function promotionFixture(t,{failurePoint = null} = {}) {
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
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,
    draftStore,
    draftCredentialVault:draftVault,
    credentialVault:activeVault,
    promotionJournal:journal,
    failureInjector:failurePoint ? async (point) => {
      if (point === failurePoint) throw Object.assign(new Error(`crash at ${point}`),{code:'SIMULATED_CRASH'});
    } : null,
  });
  return {...values,activeVault,unrelated,unrelatedBefore,draftVault,draftStore,draft,journal,service};
}

for (const failurePoint of ['after-config-write','after-vault-commit','after-draft-cleanup']) {
  test(`draft promotion recovers a complete formal plugin after ${failurePoint}`, async (t) => {
    const values = await promotionFixture(t,{failurePoint});
    await assert.rejects(
      () => values.service.promote({
        projectId:values.draft.projectId,
        environmentId:values.draft.environmentId,
        draftId:values.draft.draftId,
        expectedDraftRevision:values.draft.revision,
        afterCommit:'stay-disconnected',
      }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
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
    const service = new PluginDraftService({
      workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
      credentialVault:activeVault,promotionJournal:journal,
      failureInjector:async (point) => {
        if (point === failurePoint) throw Object.assign(new Error(`crash at ${point}`),{code:'SIMULATED_CRASH'});
      },
    });
    await assert.rejects(
      () => service.promote({
        projectId:draft.projectId,environmentId:draft.environmentId,draftId:draft.draftId,
        expectedDraftRevision:draft.revision,expectedBaseRevision:base.revision,
      }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
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

test('draft promotion detects a base revision conflict without changing config or active credentials', async (t) => {
  const values = await fixture(t);
  const activeVault = new PluginCredentialVault(values.root,encryption());
  const base = await values.workspaceStore.createPlugin(
    values.project.projectId,values.environment.environmentId,
    mysqlDraft({displayName:'Existing orders',pluginInstanceId:'orders-db'}),
  );
  await activeVault.save(base,{password:'existing-password'});
  const activeBefore = await fs.readFile(activeVault.file);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const draft = await draftStore.save({
    projectId:base.projectId,environmentId:base.environmentId,
    basePluginInstanceId:base.pluginInstanceId,baseRevision:base.revision,
    pluginType:'mysql',sanitizedDraft:{...base,description:'draft description'},
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  const concurrent = await values.workspaceStore.updatePlugin(
    base.projectId,base.environmentId,base.pluginInstanceId,
    {displayName:'Concurrent rename'},base.revision,
  );
  const journal = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,draftStore,draftVault,activeVault,
  );
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:activeVault,promotionJournal:journal,
  });
  await assert.rejects(
    () => service.promote({
      projectId:draft.projectId,environmentId:draft.environmentId,draftId:draft.draftId,
      expectedDraftRevision:draft.revision,expectedBaseRevision:base.revision,
    }),
    (error) => error.code === 'CONFIG_REVISION_CONFLICT',
  );
  assert.equal((await values.workspaceStore.getPlugin(base.projectId,base.environmentId,base.pluginInstanceId)).displayName,concurrent.displayName);
  assert.deepEqual(await activeVault.load(concurrent),{password:'existing-password'});
  assert.deepEqual(await fs.readFile(activeVault.file),activeBefore);
  assert.equal((await draftStore.resume(draft)).draftId,draft.draftId);
  assert.deepEqual(await fs.readdir(journal.directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)),[]);
});

for (const scenario of [
  {
    label:'MySQL database',
    plugin:mysqlDraft({displayName:'Orders database',pluginInstanceId:'orders-db'}),
    patch:(plugin) => ({...plugin,target:{...plugin.target,database:'orders_archive'}}),
    expected:(plugin) => plugin.target.database === 'orders_archive',
  },
  {
    label:'Redis logical DB',
    plugin:{
      pluginType:'redis',pluginInstanceId:'sessions-cache',displayName:'Sessions cache',
      target:{host:'cache.internal',port:6379,db:0,addressFamily:'ipv4Only'},
      auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},
    },
    patch:(plugin) => ({...plugin,target:{...plugin.target,db:5}}),
    expected:(plugin) => plugin.target.db === 5,
  },
]) {
  test(`promoting a draft that only changes ${scenario.label} reuses the saved active credential`, async (t) => {
    const values = await fixture(t);
    const activeVault = new PluginCredentialVault(values.root,encryption());
    const base = await values.workspaceStore.createPlugin(
      values.project.projectId,values.environment.environmentId,scenario.plugin,
    );
    await activeVault.save(base,{password:'saved-password'});
    const draftVault = new PluginDraftCredentialVault(values.root,encryption());
    const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
    const draft = await draftStore.save({
      projectId:base.projectId,environmentId:base.environmentId,
      basePluginInstanceId:base.pluginInstanceId,baseRevision:base.revision,
      pluginType:base.pluginType,sanitizedDraft:scenario.patch(base),
      credentialIntent:'unchanged',temporarySecrets:{password:''},
    });
    const journal = new PluginDraftPromotionJournal(
      values.root,values.workspaceStore,draftStore,draftVault,activeVault,
    );
    const service = new PluginDraftService({
      workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
      credentialVault:activeVault,promotionJournal:journal,
    });
    const promoted = await service.promote({
      projectId:draft.projectId,environmentId:draft.environmentId,draftId:draft.draftId,
      expectedDraftRevision:draft.revision,expectedBaseRevision:base.revision,
    });
    assert.equal(scenario.expected(promoted),true);
    assert.deepEqual(await activeVault.load(promoted),{password:'saved-password'});
    await assert.rejects(() => draftStore.resume(draft),(error) => error.code === 'PLUGIN_DRAFT_NOT_FOUND');
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

test('persistent draft validation enforces ownership, sequence, cancel, and late-result fences', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const saved = await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft(),credentialIntent:'replace',
    temporarySecrets:{password:'draft-only-password'},
  });
  let release;
  let receivedSecrets = null;
  const validationRuntime = {
    validate:async ({resolvedSecrets}) => {
      receivedSecrets = resolvedSecrets;
      await new Promise((resolve) => { release = resolve; });
      return {connected:true};
    },
    cleanup:async () => undefined,
  };
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:new PluginCredentialVault(values.root,encryption()),
    promotionJournal:{},validationRuntime,
  });
  const session = await service.resumeForOwner(saved,'renderer-a');
  assert.throws(
    () => service.requireSession(session.draftSessionId,'renderer-b',session),
    (error) => error.code === 'PLUGIN_DRAFT_SESSION_STALE',
  );
  let running;
  const validation = service.validate({
    ...session,purpose:'resource-access',requestId:'request-1',draftGeneration:0,sequence:1,
    draft:session.sanitizedDraft,temporarySecrets:{},credentialIntent:'unchanged',
  },{ownerId:'renderer-a',onProgress:(progress) => { if (progress.state === 'running') running = progress; }});
  while (!running) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(receivedSecrets,{password:'draft-only-password'});
  const cancelled = service.cancelValidation({
    ...session,operationId:running.operationId,
  },{ownerId:'renderer-a'});
  assert.equal(cancelled.state,'cancelled');
  release();
  await assert.rejects(validation,(error) => error.code === 'PLUGIN_VALIDATION_STALE');
  await assert.rejects(
    () => service.validate({
      ...session,purpose:'resource-access',requestId:'request-old',draftGeneration:0,sequence:1,
      draft:session.sanitizedDraft,temporarySecrets:{},
    },{ownerId:'renderer-a'}),
    (error) => error.code === 'PLUGIN_VALIDATION_STALE',
  );
});

test('expired persistent draft sessions reject late validation results and release validation records', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const saved = await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft(),credentialIntent:'replace',
    temporarySecrets:{password:'draft-timeout-password'},
  });
  let currentTime = 1_000;
  let release;
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:new PluginCredentialVault(values.root,encryption()),promotionJournal:{},
    now:() => currentTime,sessionTtlMs:10_000,
    validationRuntime:{
      validate:async () => new Promise((resolve) => { release = resolve; }),
      cleanup:async () => undefined,
    },
  });
  const session = await service.resumeForOwner(saved,'renderer-timeout');
  const validation = service.validate({
    ...session,purpose:'resource-access',requestId:'timeout-result',draftGeneration:0,sequence:1,
    draft:session.sanitizedDraft,temporarySecrets:{},credentialIntent:'unchanged',
  },{ownerId:'renderer-timeout'});
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  currentTime += 10_001;
  release({connected:true});
  await assert.rejects(validation,(error) => error.code === 'PLUGIN_VALIDATION_STALE');
  assert.equal(service.sessions.has(session.draftSessionId),false);
  assert.equal(service.validations.size,0);
});

test('persistent draft validation never sends an inactive old-identity credential to a changed target', async (t) => {
  const values = await fixture(t);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const first = await draftStore.save({
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft(),credentialIntent:'replace',
    temporarySecrets:{password:'old-target-password'},
  });
  const changed = await draftStore.save({
    ...first,expectedDraftRevision:first.revision,
    sanitizedDraft:mysqlDraft({target:{...mysqlDraft().target,host:'new.internal'}}),
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  let runtimeCalls = 0;
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:new PluginCredentialVault(values.root,encryption()),promotionJournal:{},
    validationRuntime:{validate:async () => { runtimeCalls += 1; },cleanup:async () => undefined},
  });
  const session = await service.resumeForOwner(changed,'renderer-a');
  await assert.rejects(
    () => service.validate({
      ...session,purpose:'resource-access',requestId:'identity-change',draftGeneration:0,sequence:1,
      draft:session.sanitizedDraft,temporarySecrets:{},credentialIntent:'unchanged',
    },{ownerId:'renderer-a'}),
    (error) => error.code === 'DRAFT_CREDENTIAL_INACTIVE',
  );
  assert.equal(runtimeCalls,0);
});

test('draft IPC persists only the sidecar namespace and augments summaries without polluting plugin-list', async (t) => {
  const values = await fixture(t);
  const auditEntries = [];
  values.workspaceStore.appendAudit = async (_projectId,entry) => { auditEntries.push(entry); };
  const activeVault = new PluginCredentialVault(values.root,encryption());
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const promotionJournal = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,draftStore,draftVault,activeVault,
  );
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:activeVault,promotionJournal,
  });
  const handlers = new Map();
  const broadcasts = [];
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore:values.workspaceStore,
    credentialVault:activeVault,
    pluginDraftService:service,
    connectionManager:{
      on:() => undefined,
      snapshot:(projectId,environmentId) => ({projectId,environmentId,phase:'disconnected',sequence:0,plugins:{}}),
      status:async (projectId,environmentId) => ({projectId,environmentId,phase:'disconnected',sequence:0,eligibleCount:0,connectedCount:0,plugins:{}}),
    },
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
    broadcast:(channel,payload) => broadcasts.push({channel,payload}),
  });
  const event = {sender:{id:41,isDestroyed:() => false,once:() => undefined,send:() => undefined}};
  const payload = {
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
    pluginType:'mysql',sanitizedDraft:mysqlDraft({target:{...mysqlDraft().target,database:''}}),
    credentialIntent:'replace',temporarySecrets:{password:'ipc-draft-password'},
  };
  const savedResult = await handlers.get('v2:plugin-draft-save')(event,payload);
  assert.equal(savedResult.ok,true);
  assert.equal(savedResult.data.credentialState,'stored-active');
  await assert.rejects(() => fs.access(activeVault.file),(error) => error.code === 'ENOENT');
  const sidecar = await fs.readFile(draftStore.fileFor(savedResult.data),'utf8');
  assert.doesNotMatch(sidecar,/ipc-draft-password|ciphertext/);

  const environmentResult = await handlers.get('v2:environment-list')(event,values.project.projectId);
  assert.equal(environmentResult.data.pluginCount,undefined);
  assert.equal(environmentResult.data[0].pluginCount,1);
  assert.equal(environmentResult.data[0].readyPluginCount,0);
  assert.equal(environmentResult.data[0].sidecarDraftCount,1);
  assert.equal(environmentResult.data[0].draftCount,1);
  const pluginResult = await handlers.get('v2:plugin-list')(event,{
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
  });
  assert.deepEqual(pluginResult.data,[]);
  const draftResult = await handlers.get('v2:plugin-draft-list')(event,{
    projectId:values.project.projectId,environmentId:values.environment.environmentId,
  });
  assert.equal(draftResult.data.length,1);
  assert.equal(draftResult.data[0].draftId,savedResult.data.draftId);

  const resumed = await handlers.get('v2:plugin-draft-resume')(event,{
    projectId:savedResult.data.projectId,environmentId:savedResult.data.environmentId,
    draftId:savedResult.data.draftId,
  });
  const noOpResult = await handlers.get('v2:plugin-draft-save')(event,{
    projectId:resumed.data.projectId,environmentId:resumed.data.environmentId,draftId:resumed.data.draftId,
    draftSessionId:resumed.data.draftSessionId,expectedDraftRevision:resumed.data.revision,
    pluginType:resumed.data.pluginType,sanitizedDraft:resumed.data.sanitizedDraft,
    credentialIntent:'unchanged',temporarySecrets:{},keepEditSession:true,
  });
  assert.equal(noOpResult.ok,true);
  assert.equal(noOpResult.data.revision,savedResult.data.revision);
  assert.equal(noOpResult.data.changed,false);
  assert.equal(auditEntries.length,1);
  assert.equal(broadcasts.length,1);
});

test('draft IPC mutation uses the edit session id that owns the installed environment fence', async (t) => {
  const values = await fixture(t);
  const base = await values.workspaceStore.createPlugin(
    values.project.projectId,values.environment.environmentId,
    mysqlDraft({displayName:'Fenced base',pluginInstanceId:'fenced-base'}),
  );
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  mutationCoordinator.installEnvironmentEditFence(
    base.projectId,base.environmentId,'edit-fence-owner',[base.pluginInstanceId],
  );
  let savedPayload = null;
  const pluginDraftService = {
    draftStore:{count:async () => 0},
    save:async (payload) => {
      savedPayload = payload;
      return {
        schemaVersion:1,draftId:'draft-00000000-0000-4000-8000-000000000010',
        projectId:payload.projectId,environmentId:payload.environmentId,
        basePluginInstanceId:base.pluginInstanceId,baseRevision:base.revision,
        pluginType:base.pluginType,revision:1,sanitizedDraft:payload.sanitizedDraft,
        credentialIntent:'unchanged',credentialState:'absent',validationState:'stale',
      };
    },
  };
  const pluginEditSessionManager = {
    captureCredentialIntent:() => undefined,
    beginSave:() => undefined,
    commitMaterial:() => ({
      scope:{projectId:base.projectId,environmentId:base.environmentId,pluginInstanceId:base.pluginInstanceId},
      baseRecordRevision:base.revision,credentialIntent:'unchanged',temporarySecrets:{},
    }),
    saveFailed:() => undefined,
  };
  const handlers = new Map();
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),on:() => undefined,
  },{
    workspaceStore:values.workspaceStore,pluginDraftService,pluginEditSessionManager,mutationCoordinator,
    credentialVault:new PluginCredentialVault(values.root,encryption()),
    connectionManager:{
      on:() => undefined,snapshot:() => ({phase:'disconnected',plugins:{}}),
      status:async () => ({phase:'disconnected',plugins:{}}),
    },
    contextManager:{},confirmationManager:{on:() => undefined},pluginManager:{},mysqlRuntime:{},
  });
  const event = {sender:{id:73,isDestroyed:() => false,once:() => undefined,send:() => undefined}};
  const result = await handlers.get('v2:plugin-draft-save')(event,{
    projectId:base.projectId,environmentId:base.environmentId,pluginType:base.pluginType,
    sanitizedDraft:{...base,description:'saved behind the edit fence'},
    credentialIntent:'unchanged',temporarySecrets:{},editSessionId:'edit-fence-owner',keepEditSession:true,
  });
  assert.equal(result.ok,true);
  assert.equal(savedPayload.basePluginInstanceId,base.pluginInstanceId);
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
  await assert.rejects(
    () => values.service.promote({
      projectId:values.draft.projectId,environmentId:values.draft.environmentId,draftId:values.draft.draftId,
      expectedDraftRevision:values.draft.revision,
    }),
    (error) => error.code === 'SIMULATED_CRASH',
  );
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
  const values = await promotionFixture(t,{failurePoint:'after-config-write'});
  await assert.rejects(() => values.service.promote({
    projectId:values.draft.projectId,environmentId:values.draft.environmentId,draftId:values.draft.draftId,
    expectedDraftRevision:values.draft.revision,
  }));
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

test('unreadable active credentials block database-only promotion before config or journal writes', async (t) => {
  const values = await fixture(t);
  const control = {unreadable:false};
  const activeVault = new PluginCredentialVault(values.root,encryption(control));
  const base = await values.workspaceStore.createPlugin(
    values.project.projectId,values.environment.environmentId,
    mysqlDraft({displayName:'Unreadable active',pluginInstanceId:'unreadable-db'}),
  );
  await activeVault.save(base,{password:'must-remain'});
  const activeBefore = {
    primary:await fs.readFile(activeVault.file),backup:await fs.readFile(activeVault.backupFile),
  };
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const draft = await draftStore.save({
    projectId:base.projectId,environmentId:base.environmentId,
    basePluginInstanceId:base.pluginInstanceId,baseRevision:base.revision,pluginType:'mysql',
    sanitizedDraft:{...base,target:{...base.target,database:'other_database'}},
    credentialIntent:'unchanged',temporarySecrets:{},
  });
  const journal = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,draftStore,draftVault,activeVault,
  );
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:activeVault,promotionJournal:journal,
  });
  control.unreadable = true;
  await assert.rejects(
    () => service.promote({
      projectId:draft.projectId,environmentId:draft.environmentId,draftId:draft.draftId,
      expectedDraftRevision:draft.revision,expectedBaseRevision:base.revision,
    }),
    (error) => error.code === 'CREDENTIAL_DECRYPT_FAILED',
  );
  assert.equal((await values.workspaceStore.getPlugin(base.projectId,base.environmentId,base.pluginInstanceId)).target.database,'orders');
  assert.deepEqual(await fs.readFile(activeVault.file),activeBefore.primary);
  assert.deepEqual(await fs.readFile(activeVault.backupFile),activeBefore.backup);
  assert.equal((await draftStore.resume(draft)).draftId,draft.draftId);
  assert.deepEqual(await fs.readdir(journal.directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)),[]);
});

test('promotion never overwrites retained active-vault bytes for a deleted plugin id', async (t) => {
  const values = await fixture(t);
  const activeVault = new PluginCredentialVault(values.root,encryption());
  const deleted = await values.workspaceStore.createPlugin(
    values.project.projectId,values.environment.environmentId,
    mysqlDraft({displayName:'Reused name',pluginInstanceId:'reused-name'}),
  );
  await activeVault.save(deleted,{password:'historical-password'});
  await values.workspaceStore.deletePlugin(deleted.projectId,deleted.environmentId,deleted.pluginInstanceId,{expectedRevision:deleted.revision});
  const activeBefore = await fs.readFile(activeVault.file);
  const draftVault = new PluginDraftCredentialVault(values.root,encryption());
  const draftStore = new PluginDraftStore(values.workspaceStore,draftVault);
  const draft = await draftStore.save({
    projectId:deleted.projectId,environmentId:deleted.environmentId,pluginType:'mysql',
    sanitizedDraft:mysqlDraft({displayName:'Reused name',pluginInstanceId:'reused-name',target:{...mysqlDraft().target,host:'new.internal'}}),
    credentialIntent:'replace',temporarySecrets:{password:'new-password'},
  });
  const journal = new PluginDraftPromotionJournal(
    values.root,values.workspaceStore,draftStore,draftVault,activeVault,
  );
  const service = new PluginDraftService({
    workspaceStore:values.workspaceStore,draftStore,draftCredentialVault:draftVault,
    credentialVault:activeVault,promotionJournal:journal,
  });
  await assert.rejects(
    () => service.promote({
      projectId:draft.projectId,environmentId:draft.environmentId,draftId:draft.draftId,
      expectedDraftRevision:draft.revision,
    }),
    (error) => error.code === 'PLUGIN_CREDENTIAL_RESOURCE_CONFLICT',
  );
  assert.deepEqual(await fs.readFile(activeVault.file),activeBefore);
  assert.deepEqual(await values.workspaceStore.listPlugins(deleted.projectId,deleted.environmentId),[]);
  assert.equal((await draftStore.resume(draft)).draftId,draft.draftId);
});
