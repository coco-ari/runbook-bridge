import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerV2Ipc } from '../src/ipc-v2.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function ipcHarness(services) {
  const handlers = new Map();
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore:{},
    connectionManager:{on:() => undefined},
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
    ...services,
  });
  return handlers;
}

function event(id = 73) {
  const sent = [];
  const destroyed = [];
  return {
    sent,destroyed,
    value:{sender:{
      id,isDestroyed:() => false,
      send:(...args) => sent.push(args),
      once:(name,callback) => destroyed.push([name,callback]),
    }},
  };
}

test('edit IPC methods bind every request to its renderer owner and expose matching preload APIs', async () => {
  const calls = [];
  const pluginEditSessionManager = {
    preparePluginConnectionEdit:async (payload) => { calls.push(['prepare',payload]); return {prepareToken:'prepare-1'}; },
    beginPluginConnectionEdit:async (payload) => { calls.push(['begin',payload]); return {editSessionId:'edit-1'}; },
    validatePluginDraft:async (payload) => { calls.push(['validate',payload]); return {state:'valid'}; },
    cancelPluginValidation:(payload) => { calls.push(['cancel-validation',payload]); return {state:'cancelled'}; },
    cancelPluginConnectionEdit:async (payload) => { calls.push(['cancel-edit',payload]); return {cancelled:true}; },
    invalidateOwner:(ownerId) => calls.push(['destroyed',ownerId]),
  };
  const handlers = ipcHarness({pluginEditSessionManager});
  const renderer = event();

  await handlers.get('v2:plugin-connection-edit-prepare')(renderer.value,{projectId:'p1',environmentId:'e1',pluginInstanceId:'db1'});
  await handlers.get('v2:plugin-connection-edit-begin')(renderer.value,{prepareToken:'prepare-1'});
  await handlers.get('v2:plugin-draft-validate')(renderer.value,{editSessionId:'edit-1'});
  await handlers.get('v2:plugin-validation-cancel')(renderer.value,{editSessionId:'edit-1',operationId:'operation-1'});
  await handlers.get('v2:plugin-connection-edit-cancel')(renderer.value,{editSessionId:'edit-1'});

  assert.deepEqual(calls.map(([name]) => name),['prepare','begin','validate','cancel-validation','cancel-edit']);
  for (const [,payload] of calls) assert.equal(payload.ownerId,'renderer:73');
  assert.equal(renderer.destroyed.length,1,'one renderer teardown hook owns every session from that window');
  renderer.destroyed[0][1]();
  assert.deepEqual(calls.at(-1),['destroyed','renderer:73']);

  const preload = await fs.readFile(path.join(root,'..','src','preload.cjs'),'utf8');
  for (const method of [
    'preparePluginConnectionEdit','beginPluginConnectionEdit','validatePluginDraft',
    'cancelPluginValidation','savePluginConnectionEdit','cancelPluginConnectionEdit',
    'confirmConnectionChallenge',
  ]) assert.match(preload,new RegExp(`${method}:`,'u'));
});

test('probe IPC derives renderer ownership, forwards progress, cancellation, and teardown cleanup', async () => {
  const calls = [];
  const pluginProbeManager = {
    probePluginDraft:async (payload,options) => {
      calls.push(['probe',payload,options.ownerId]);
      options.onProgress({requestId:payload.requestId,state:'running'});
      return {requestId:payload.requestId,state:'valid',result:{databases:['orders']}};
    },
    cancelPluginProbe:(payload,options) => {
      calls.push(['cancel',payload,options.ownerId]);
      return {requestId:payload.requestId,state:'cancelled'};
    },
    invalidateOwner:(ownerId) => calls.push(['destroyed',ownerId]),
  };
  const handlers = ipcHarness({pluginProbeManager});
  const renderer = event(91);
  const probePayload = {
    projectId:'p1',environmentId:'e1',formInstanceId:'form-1',requestId:'request-1',
    purpose:'resource-discovery',draftGeneration:1,sequence:3,draft:{pluginType:'mysql'},
  };

  const probed = await handlers.get('v2:plugin-probe')(renderer.value,probePayload);
  const cancelled = await handlers.get('v2:plugin-probe-cancel')(
    renderer.value,{requestId:'request-1',formInstanceId:'form-1'},
  );

  assert.equal(probed.ok,true);
  assert.equal(cancelled.ok,true);
  assert.deepEqual(calls.slice(0,2).map(([name,,ownerId]) => [name,ownerId]),[
    ['probe','renderer:91'],['cancel','renderer:91'],
  ]);
  assert.deepEqual(renderer.sent,[['v2:plugin-probe-progress',{requestId:'request-1',state:'running'}]]);
  assert.equal(renderer.destroyed.length,1);
  renderer.destroyed[0][1]();
  assert.deepEqual(calls.at(-1),['destroyed','renderer:91']);

  const preload = await fs.readFile(path.join(root,'..','src','preload.cjs'),'utf8');
  for (const method of ['probePluginDraft','cancelPluginProbe','onPluginProbeProgress']) {
    assert.match(preload,new RegExp(`${method}:`,'u'));
  }
});

test('host-key challenge commits trust with saved credentials before resuming the original plan', async () => {
  const before = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',pluginType:'server',displayName:'Server',
    revision:4,configState:'ready',target:{host:'server.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'},transport:{kind:'direct'},
  };
  const after = {...before,revision:5,target:{...before.target,hostKeyFingerprint:'SHA256:observed'}};
  const challenge = {
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',expectedRevision:4,
    generation:1,digest:'digest-1',host:'server.internal',port:22,
    algorithm:'ssh-ed25519',fingerprint:'SHA256:observed',expiresAt:'2026-08-18T12:00:00.000Z',
  };
  const calls = {validate:0,prepare:0,commit:0,vault:0,resume:0,audit:0};
  const handlers = ipcHarness({
    workspaceStore:{
      preparePluginConnectionUpdate:async (_projectId,_environmentId,_pluginInstanceId,patch,expectedRevision,credentialMutation) => {
        calls.prepare += 1;
        assert.equal(expectedRevision,4);
        assert.equal(credentialMutation,'rebind-existing');
        assert.equal(patch.target.hostKeyFingerprint,'SHA256:observed');
        return {before,after,change:{kind:'session-affecting',credentialMutation}};
      },
      commitPluginSnapshot:async () => { calls.commit += 1; return after; },
      restorePluginSnapshot:async () => before,
      publicPlugin:(value) => value,
      appendAudit:async (_projectId,entry) => {
        calls.audit += 1;
        assert.equal(entry.type,'server-host-key-trusted');
        assert.equal(JSON.stringify(entry).includes('password'),false);
      },
    },
    credentialVault:{
      saveMerged:async (previous,next,secrets) => {
        calls.vault += 1;
        assert.equal(previous,before);
        assert.equal(next,after);
        assert.deepEqual(secrets,{});
      },
    },
    connectionManager:{
      on:() => undefined,
      validateConnectionChallenge:async (payload) => {
        calls.validate += 1;
        assert.equal(payload.decision,'trust-host-key');
        return challenge;
      },
      resumeConnectionChallenge:async (payload,options) => {
        calls.resume += 1;
        assert.equal(payload.challengeId,'challenge-1');
        assert.deepEqual(options.plugin,after);
        return {outcome:'started',planId:'plan-1',actions:[],snapshot:{phase:'connected',plugins:{}}};
      },
      beginConfigurationMutation:() => 'mutation-1',
      endConfigurationMutation:() => true,
      configurationChanged:async () => ({}),
    },
  });

  const result = await handlers.get('v2:connection-challenge-confirm')({}, {
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',
    expectedRevision:4,decision:'trust-host-key',
  });

  assert.equal(result.ok,true);
  assert.equal(result.data.committed,true);
  assert.equal(result.data.plugin.revision,5);
  assert.equal(result.data.connectionPlan.planId,'plan-1');
  assert.equal(result.data.runtimeWarning,null);
  assert.equal(calls.validate,2);
  assert.deepEqual({...calls,validate:0},{validate:0,prepare:1,commit:1,vault:1,resume:1,audit:1});
});

test('host-key trust storage failure preserves retryability and post-commit connection failure is explicit', async () => {
  const before = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',pluginType:'server',displayName:'Server',
    revision:4,configState:'ready',target:{host:'server.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'},transport:{kind:'direct'},
  };
  const after = {...before,revision:5,target:{...before.target,hostKeyFingerprint:'SHA256:observed'}};
  const challenge = {
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',expectedRevision:4,
    generation:1,digest:'digest-1',host:'server.internal',port:22,
    algorithm:'ssh-ed25519',fingerprint:'SHA256:observed',expiresAt:'2026-08-18T12:00:00.000Z',
  };
  let failVault = true;
  let resumeCalls = 0;
  let rollbackCalls = 0;
  const handlers = ipcHarness({
    workspaceStore:{
      preparePluginConnectionUpdate:async () => ({before,after,change:{kind:'session-affecting',credentialMutation:'rebind-existing'}}),
      commitPluginSnapshot:async () => after,
      restorePluginSnapshot:async () => { rollbackCalls += 1; return before; },
      publicPlugin:(value) => value,
      appendAudit:async () => undefined,
    },
    credentialVault:{saveMerged:async () => {
      if (failVault) throw Object.assign(new Error('vault unavailable'),{code:'EIO'});
    }},
    connectionManager:{
      on:() => undefined,
      validateConnectionChallenge:async () => challenge,
      resumeConnectionChallenge:async () => {
        resumeCalls += 1;
        return {
          outcome:'needs-action',planId:'plan-1',
          actions:[{code:'SSH_AUTH_FAILED',message:'saved credential rejected'}],
          snapshot:{phase:'error',plugins:{}},
        };
      },
      beginConfigurationMutation:() => 'mutation-1',
      endConfigurationMutation:() => true,
      configurationChanged:async () => ({}),
    },
  });
  const payload = {
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',
    expectedRevision:4,decision:'trust-host-key',
  };

  const failed = await handlers.get('v2:connection-challenge-confirm')({},payload);
  assert.equal(failed.ok,false);
  assert.equal(resumeCalls,0,'a failed trust transaction must not consume the challenge');
  assert.equal(rollbackCalls,1);

  failVault = false;
  const saved = await handlers.get('v2:connection-challenge-confirm')({},payload);
  assert.equal(saved.ok,true);
  assert.equal(saved.data.committed,true);
  assert.equal(saved.data.connectionPlan.planId,'plan-1');
  assert.match(saved.data.runtimeWarning.message,/配置和密码已保存，但连接失败/u);
  assert.equal(resumeCalls,1);
});

function committedPlugin(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'db1',pluginType:'mysql',displayName:'Orders',
    revision:4,updatedAt:'2026-01-01T00:00:00.000Z',configState:'ready',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    policy:{select:'auto'},limits:{maxRows:100,timeoutMs:1000},
    ...overrides,
  };
}

test('formal create and edit IPC reject incomplete configuration before persistence', async () => {
  const createCalls = {store:0,vault:0};
  const createHandlers = ipcHarness({
    workspaceStore:{
      createPlugin:async () => { createCalls.store += 1; throw new Error('must not persist'); },
    },
    credentialVault:{save:async () => { createCalls.vault += 1; }},
  });
  const created = await createHandlers.get('v2:plugin-create')({}, {
    projectId:'p1',environmentId:'e1',
    input:{pluginType:'mysql',displayName:'Incomplete DB',target:{host:'db.internal'},auth:{username:'reader'}},
    secrets:{password:'temporary'},
  });
  assert.equal(created.ok,false);
  assert.equal(created.error.code,'PLUGIN_CONFIGURATION_INCOMPLETE');
  assert.deepEqual(createCalls,{store:0,vault:0});

  const before = committedPlugin();
  const incomplete = committedPlugin({
    revision:5,
    configState:'draft',
    target:{...before.target,database:''},
  });
  const editCalls = {commit:0,vault:0,failed:0};
  const editHandlers = ipcHarness({
    pluginEditSessionManager:{
      beginSave:() => ({phase:'saving'}),
      commitMaterial:() => ({
        scope:{projectId:'p1',environmentId:'e1',pluginInstanceId:'db1'},
        baseRecordRevision:4,credentialIntent:'unchanged',temporarySecrets:{},
      }),
      saveFailed:() => { editCalls.failed += 1; },
    },
    workspaceStore:{
      preparePluginConnectionUpdate:async () => ({
        before,after:incomplete,candidate:incomplete,
        change:{kind:'session-affecting',credentialMutation:'none'},
      }),
      commitPluginSnapshot:async () => { editCalls.commit += 1; return incomplete; },
    },
    credentialVault:{saveMerged:async () => { editCalls.vault += 1; }},
  });
  const edited = await editHandlers.get('v2:plugin-connection-edit-save')(event().value,{
    editSessionId:'edit-1',expectedRevision:4,patch:{target:incomplete.target},
  });
  assert.equal(edited.ok,false);
  assert.equal(edited.error.code,'PLUGIN_CONFIGURATION_INCOMPLETE');
  assert.deepEqual(editCalls,{commit:0,vault:0,failed:1});
});

test('edit save no-op exits through restore handoff without touching YAML, vault, or runtime mutation', async () => {
  const plugin = committedPlugin();
  const calls = {prepare:0,commit:0,vault:0,beginMutation:0,changed:0,completed:0,failed:0};
  const pluginEditSessionManager = {
    beginSave:() => ({phase:'saving'}),
    commitMaterial:() => ({scope:{projectId:'p1',environmentId:'e1',pluginInstanceId:'db1'},baseRecordRevision:4,credentialIntent:'unchanged',temporarySecrets:{}}),
    completeSave:async () => { calls.completed += 1; return {outcome:'started',actions:[]}; },
    saveFailed:() => { calls.failed += 1; },
  };
  const handlers = ipcHarness({
    pluginEditSessionManager,
    workspaceStore:{
      preparePluginConnectionUpdate:async () => { calls.prepare += 1; return {before:plugin,after:plugin,change:{kind:'none',credentialMutation:'none'}}; },
      publicPlugin:(value) => value,
    },
    credentialVault:{saveMerged:async () => { calls.vault += 1; }},
    connectionManager:{
      on:() => undefined,
      beginConfigurationMutation:() => { calls.beginMutation += 1; },
      configurationChanged:async () => { calls.changed += 1; },
    },
  });

  const result = await handlers.get('v2:plugin-connection-edit-save')(event().value,{
    editSessionId:'edit-1',expectedRevision:4,patch:{target:{...plugin.target}},afterCommit:'restore-pre-edit-set',
  });

  assert.equal(result.ok,true);
  assert.equal(result.data.committed,true);
  assert.equal(result.data.changed,false);
  assert.equal(result.data.changeKind,'none');
  assert.equal(calls.prepare,1);
  assert.deepEqual({...calls,prepare:0,completed:0},{prepare:0,commit:0,vault:0,beginMutation:0,changed:0,completed:0,failed:0});
  assert.equal(calls.completed,1);
});

test('edit save failure keeps the session alive, while restore failure after commit is a runtime warning', async () => {
  const plugin = committedPlugin();
  let failCommit = true;
  const calls = {vault:0,failed:0,completed:0};
  const pluginEditSessionManager = {
    beginSave:() => ({phase:'saving'}),
    commitMaterial:() => ({
      scope:{projectId:'p1',environmentId:'e1',pluginInstanceId:'db1'},
      baseRecordRevision:4,
      credentialIntent:'replace',temporarySecrets:{password:'temporary'},
    }),
    saveFailed:() => { calls.failed += 1; },
    completeSave:async () => {
      calls.completed += 1;
      return {outcome:'needs-action',actions:[{code:'AUTHENTICATION_FAILED',message:'bad password'}]};
    },
  };
  const after = committedPlugin({revision:5,target:{...plugin.target,database:'billing'}});
  const handlers = ipcHarness({
    pluginEditSessionManager,
    workspaceStore:{
      preparePluginConnectionUpdate:async () => ({before:plugin,after,change:{kind:'session-affecting',credentialMutation:'replace'}}),
      commitPluginSnapshot:async () => {
        if (failCommit) throw new Error('yaml failed');
        return after;
      },
      restorePluginSnapshot:async () => plugin,
      publicPlugin:(value) => value,
    },
    credentialVault:{saveMerged:async () => { calls.vault += 1; }},
    connectionManager:{
      on:() => undefined,
      beginConfigurationMutation:() => 'mutation-1',
      endConfigurationMutation:() => true,
      configurationChanged:async () => ({}),
    },
  });
  const payload = {editSessionId:'edit-1',expectedRevision:4,patch:{target:after.target},afterCommit:'restore-pre-edit-set'};

  const failed = await handlers.get('v2:plugin-connection-edit-save')(event().value,payload);
  assert.equal(failed.ok,false);
  assert.equal(calls.failed,1);
  assert.equal(calls.vault,0);

  failCommit = false;
  const saved = await handlers.get('v2:plugin-connection-edit-save')(event().value,payload);
  assert.equal(saved.ok,true);
  assert.equal(saved.data.committed,true);
  assert.equal(saved.data.changed,true);
  assert.equal(saved.data.plugin.revision,5);
  assert.equal(saved.data.connectionPlan.outcome,'needs-action');
  assert.match(saved.data.runtimeWarning.message,/配置和密码已保存，但连接失败/u);
  assert.equal(calls.completed,1);
});
