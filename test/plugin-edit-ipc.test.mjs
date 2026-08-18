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
  ]) assert.match(preload,new RegExp(`${method}:`,'u'));
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
