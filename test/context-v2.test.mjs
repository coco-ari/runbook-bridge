import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

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
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(manager.list().length, 1);
  assert.equal('deduplicated' in manager.list()[0], false);
  assert.equal(manager.list()[0].summary, '查询会员主库');
});

test('confirmation presentation exposes operation facts without file contents', () => {
  const service = new V2Service({});
  const plugin = { pluginType:'server', displayName:'应用服务器' };
  const presentation = service.confirmationPresentation(plugin,'fs.write',{
    path:'/srv/app/config.json', content:'must-not-reach-renderer', overwrite:true,
    _precondition:{ bytes:18, newSha256:'a'.repeat(64) },
  });
  assert.deepEqual(presentation,{
    kind:'file-write', target:'应用服务器', destination:'/srv/app/config.json', bytes:18, sha256:'a'.repeat(64), overwrite:true,
  });
  assert.equal('content' in presentation,false);
});

test('confirmed operation keeps its confirmation id through actual execution', async () => {
  const confirmationManager = new ConfirmationManager();
  const audits = [];
  const changes = [];
  const plugin = { projectId:'p1', environmentId:'e1', pluginInstanceId:'s1', pluginType:'server', displayName:'应用服务器', sources:[] };
  const service = new V2Service({
    workspaceStore:{
      getProject:async () => ({name:'示例项目'}),
      getPlugin:async () => plugin,
      appendAudit:async (_projectId,entry) => { audits.push(entry); },
    },
    connectionManager:{snapshot:() => ({plugins:{s1:{phase:'connected'}}})},
    contextManager:{verify:async () => ({plugin,environment:{name:'生产环境'},runbook:{content:''}})},
    confirmationManager,
    serverOperations:{prepareMutation:async (_plugin,_capability,args) => args,mutate:async () => ({ok:true})},
    workspaceChanged:(change) => changes.push(change),
  });
  const params = {projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',clientInstanceId:'agent-a',contextToken:'ctx'};
  await assert.rejects(() => service.invoke(params,'service.control',{action:'restart',unit:'orders.service'}),(error) => error.code === 'CONFIRMATION_REQUIRED');
  const pending = confirmationManager.list()[0];
  assert.deepEqual(pending.presentation,{kind:'service-control',target:'应用服务器',action:'restart',unit:'orders.service'});
  await assert.rejects(() => service.invoke(params,'service.control',{action:'restart',unit:'orders.service'}),(error) => error.code === 'CONFIRMATION_REQUIRED');
  assert.equal(audits.filter((entry) => entry.type === 'plugin-operation-decision' && entry.result === 'pending-confirmation').length,1);
  assert.equal(audits.find((entry) => entry.type === 'plugin-operation-decision').confirmationId,pending.requestId);
  confirmationManager.approve(pending.requestId);
  assert.deepEqual(await service.invoke(params,'service.control',{action:'restart',unit:'orders.service'}),{ok:true});
  const executed = audits.filter((entry) => entry.type === 'plugin-operation-started' || entry.type === 'plugin-operation');
  assert.deepEqual(executed.map((entry) => entry.confirmationId),[pending.requestId,pending.requestId]);
  assert.deepEqual(changes.map((entry) => [entry.status,entry.confirmationId]),[['running',pending.requestId],['success',pending.requestId]]);
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

test('an edit fence blocks new Agent context, operations, and plugin creation before they can touch runtime or storage', async () => {
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  mutationCoordinator.installEnvironmentEditFence('p1','e1','edit-1',['db1']);
  const touched = {open:0,verify:0,create:0};
  const service = new V2Service({
    workspaceStore:{
      readRunbook:async () => ({content:'runbook',hash:'h1',empty:false}),
      createPlugin:async () => { touched.create += 1; },
    },
    contextManager:{
      open:async () => { touched.open += 1; },
      verifyEnvironment:async () => { touched.verify += 1; },
    },
    connectionManager:{assertConfigurationStable:() => undefined},
    mutationCoordinator,
  });

  await assert.rejects(
    () => service.openEnvironment({projectId:'p1',environmentId:'e1',clientInstanceId:'agent-a'}),
    (error) => error.code === 'PLUGIN_EDIT_BUSY',
  );
  await assert.rejects(
    () => service.invoke({projectId:'p1',environmentId:'e1'},'describe',{}),
    (error) => error.code === 'PLUGIN_EDIT_BUSY',
  );
  await assert.rejects(
    () => service.addPlugin({projectId:'p1',environmentId:'e1'}),
    (error) => error.code === 'PLUGIN_EDIT_BUSY',
  );
  assert.deepEqual(touched,{open:0,verify:0,create:0});
});
