import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { V2Service } from '../src/v2-service.mjs';

test('environment context binds runbook and exact plugin configuration', async () => {
  let hash='docs-1'; let revision=1;
  const plugin={projectId:'p1',environmentId:'e1',pluginInstanceId:'db1',pluginType:'mysql',revision:1};
  const store={getEnvironment:async()=>({projectId:'p1',environmentId:'e1',revision}),readRunbook:async()=>({content:'runbook',hash,empty:false}),listPlugins:async()=>[plugin],pluginBindingHash:(p)=>`plugin-${p.revision}`};
  const manager=new EnvironmentContextManager(store);
  const opened=await manager.open('p1','e1','test');
  assert.equal((await manager.verifyEnvironment('p1','e1',opened.contextToken,'test')).environment.environmentId,'e1');
  assert.equal((await manager.verify('p1','e1','db1',opened.contextToken,'test')).plugin.pluginInstanceId,'db1');
  await assert.rejects(()=>manager.verify('p1','e1','db1',opened.contextToken,'another-client'),(error)=>error.code==='CLIENT_CONTEXT_MISMATCH');
  hash='docs-2';
  await assert.rejects(()=>manager.verify('p1','e1','db1',opened.contextToken,'test'),(error)=>error.code==='CONTEXT_STALE');
});

test('Agent can add one disconnected plugin without credentials or network activity', async () => {
  let createdInput; let createdOptions; let changed = false; let invalidated = false; const audits = [];
  const plugin = { projectId:'p1', environmentId:'e1', pluginInstanceId:'orders-db', pluginType:'mysql', displayName:'订单库', configState:'ready', revision:1, target:{ database:'orders' }, policy:{}, limits:{} };
  const service = new V2Service({
    workspaceStore: {
      createPlugin: async (_projectId,_environmentId,input,options) => { createdInput=input; createdOptions=options; return plugin; },
      publicPlugin: (value) => ({ pluginInstanceId:value.pluginInstanceId, configState:value.configState }),
      appendAudit: async (_projectId,entry) => { audits.push(entry); },
    },
    contextManager: {
      verifyEnvironment: async () => ({ environment:{ environmentId:'e1', revision:7 } }),
      invalidateEnvironment: () => { invalidated = true; },
    },
    connectionManager: { configurationChanged: async () => { changed = true; } },
  });
  const result = await service.addPlugin({
    projectId:'p1', environmentId:'e1', contextToken:'token', clientInstanceId:'agent-a', pluginType:'mysql', displayName:'订单库',
    configuration:{ host:'db.internal', port:3306, username:'reader', database:'orders', connectionMode:'direct' },
  });
  assert.deepEqual(createdInput.auth,{ username:'reader' });
  assert.equal('password' in createdInput.auth,false);
  assert.deepEqual(createdOptions,{ expectedEnvironmentRevision:7 });
  assert.equal(changed,true);
  assert.equal(invalidated,true);
  assert.equal(result.connection,'disconnected');
  assert.equal(result.contextStale,true);
  assert.equal(audits[0].actor,'agent');
  assert.equal(audits[0].type,'plugin-added');
  await assert.rejects(() => service.addPlugin({
    projectId:'p1', environmentId:'e1', contextToken:'token-2', clientInstanceId:'agent-a', pluginType:'mysql', displayName:'危险输入',
    configuration:{ password:'must-not-pass' },
  }), (error) => error.code === 'INVALID_ARGUMENT');
});

test('identical confirmation requests are deduplicated and include a human summary', () => {
  const manager = new ConfirmationManager();
  const scope = { projectId:'p1', environmentId:'e1', pluginInstanceId:'db1' };
  const first = manager.request(scope, 'select', { sql:'SELECT 1' }, '查询会员主库');
  const second = manager.request(scope, 'select', { sql:'SELECT 1' }, '查询会员主库');
  assert.equal(second.requestId, first.requestId);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].summary, '查询会员主库');
});

test('an oversized runbook is rejected before a context token is issued', async () => {
  let opened = false;
  const service = new V2Service({
    workspaceStore: { readRunbook: async () => ({ content:'x'.repeat(70 * 1024), hash:'large', empty:false }) },
    contextManager: { open: async () => { opened = true; return {}; } },
  });
  await assert.rejects(() => service.openEnvironment({ projectId:'p1', environmentId:'e1', clientInstanceId:'c1' }), (error) => error.code === 'RUNBOOK_TOO_LARGE');
  assert.equal(opened, false);
});
