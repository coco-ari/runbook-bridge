import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rotateBrokerToken } from '../src/broker-auth.mjs';
import { BrokerServer } from '../src/broker-server.mjs';
import { AppError } from '../src/errors.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

function plugin(id,type = 'mysql',overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:id,pluginType:type,
    displayName:id,revision:1,configState:'ready',
    target:type === 'server'
      ? {host:`${id}.example.test`,port:22,addressFamily:'ipv4Only'}
      : type === 'mysql'
        ? {host:`${id}.example.test`,port:3306,database:'app',addressFamily:'ipv4Only'}
        : {host:`${id}.example.test`,port:6379,db:0,addressFamily:'ipv4Only'},
    auth:type === 'server' ? {type:'password',username:'root'} : {username:'app'},
    transport:{kind:'direct'},
    tls:type === 'server' ? undefined : {mode:'disabled'},
    ...overrides,
  };
}

function fixture(plugins = [plugin('orders')],{connect = async () => ({connectedAt:'now'})} = {}) {
  const state = {
    plugins,environment:{projectId:'p1',environmentId:'e1',name:'测试环境',revision:7},
    runbook:{content:'仅用于内存夹具的环境说明。',hash:'runbook-1',empty:false},now:1_000,
  };
  const calls = [];
  const audits = [];
  const intents = [];
  const workspaceStore = {
    getEnvironment:async () => structuredClone(state.environment),
    readRunbook:async () => structuredClone(state.runbook),
    listPlugins:async () => structuredClone(state.plugins),
    getPlugin:async (_projectId,_environmentId,id) => structuredClone(state.plugins.find((item) => item.pluginInstanceId === id)),
    publicPlugin:(item) => ({pluginInstanceId:item.pluginInstanceId,pluginType:item.pluginType,displayName:item.displayName}),
    appendAudit:async (_projectId,entry) => { audits.push(structuredClone(entry)); },
  };
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  const runtime = {
    connect:async (item,secrets,options) => {
      calls.push({plugin:item,secrets:structuredClone(secrets)});
      return connect(item,secrets,options);
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  };
  const connectionManager = new EnvironmentConnectionManager(workspaceStore,runtime,{retryDelays:[],mutationCoordinator});
  const requestConnectionIntent = connectionManager.requestConnectionIntent.bind(connectionManager);
  connectionManager.requestConnectionIntent = (params) => {
    intents.push(structuredClone(params));
    return requestConnectionIntent(params);
  };
  const contextManager = new EnvironmentContextManager(workspaceStore,{ttlMs:1_000,now:() => state.now});
  const forbidden = () => assert.fail('连接不应发起写操作或自动批准');
  const service = new V2Service({
    workspaceStore,connectionManager,contextManager,mutationCoordinator,
    confirmationManager:{request:forbidden,approve:forbidden,consume:forbidden},
    serverOperations:{invoke:forbidden},
  });
  const open = async (clientInstanceId = 'agent-a') => {
    const opened = await service.openEnvironment({projectId:'p1',environmentId:'e1',clientInstanceId});
    return {projectId:'p1',environmentId:'e1',clientInstanceId,contextToken:opened.contextToken};
  };
  return {service,connectionManager,contextManager,mutationCoordinator,state,calls,audits,intents,open};
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('等待连接测试条件超时');
}

test('opening an Agent environment issues context without connecting to infrastructure', async () => {
  const f = fixture();
  const params = await f.open();
  assert.ok(params.contextToken);
  assert.equal(f.calls.length,0);
  assert.equal(f.intents.length,0);
  assert.equal(f.connectionManager.snapshot('p1','e1').plugins.orders.phase,'disconnected');
});

test('Agent plugin connection includes only the requested plugin and its same-environment tunnel provider', async () => {
  const f = fixture([
    plugin('server','server'),
    plugin('orders','mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'server'}}),
    plugin('unrelated','redis'),
  ]);
  const result = await f.service.connectPlugin({...await f.open(),pluginInstanceId:'orders'});
  assert.deepEqual(f.calls.map((call) => call.plugin.pluginInstanceId),['server','orders']);
  assert.ok(f.calls.every((call) => call.plugin.projectId === 'p1' && call.plugin.environmentId === 'e1'));
  assert.ok(f.calls.every((call) => Object.keys(call.secrets).length === 0));
  assert.equal(result.projectId,'p1');
  assert.equal(result.environmentId,'e1');
  assert.equal(result.pluginInstanceId,'orders');
  assert.equal(result.outcome,'started');
  assert.ok(result.planId);
  assert.ok(result.operationId);
  assert.equal(result.connection.plugins.orders.phase,'connected');
  assert.notEqual(result.connection.plugins.unrelated.phase,'connected');
  assert.deepEqual(result.actions,[]);
  assert.equal(f.intents[0].intent,'connect');
  assert.equal(f.intents[0].source,'agent');
  assert.equal(f.intents[0].actor,'agent');
  assert.equal(f.intents[0].expectedRevision,7);
  assert.equal('secretsByPlugin' in f.intents[0],false);
  assert.ok(f.audits.some((entry) => entry.type === 'plugin-connected'));
  assert.ok(f.audits.every((entry) => entry.actor === 'agent'));
});

test('Agent connection verifies context before and after networking while holding an environment operation', async () => {
  for (const method of ['connectEnvironment','connectPlugin']) {
    const f = fixture();
    const params = await f.open();
    const verifications = [];
    const verifyEnvironment = f.contextManager.verifyEnvironment.bind(f.contextManager);
    f.contextManager.verifyEnvironment = async (...args) => {
      assert.equal(f.mutationCoordinator.environmentActivitySnapshot('p1','e1').readers,1);
      verifications.push(f.calls.length);
      return verifyEnvironment(...args);
    };
    await f.service[method]({...params,...(method === 'connectPlugin' ? {pluginInstanceId:'orders'} : {})});
    assert.deepEqual(verifications,[0,1]);
    assert.equal(f.mutationCoordinator.environmentActivitySnapshot('p1','e1').readers,0);
  }
});

test('Agent environment connection preserves successful branches and reports drafts and credential failures', async () => {
  const f = fixture([
    plugin('orders'),plugin('cache','redis'),
    plugin('draft','server',{configState:'draft',target:{host:'',port:22,addressFamily:'ipv4Only'}}),
  ],{connect:async (item) => {
    if (item.pluginInstanceId === 'cache') throw new AppError('CREDENTIAL_UNAVAILABLE','请在桌面应用补充已保存凭据。');
    return {connectedAt:'now'};
  }});
  const result = await f.service.connectEnvironment(await f.open());
  assert.equal(result.outcome,'needs-action');
  assert.equal(result.connection.plugins.orders.phase,'connected');
  assert.equal(result.connection.plugins.cache.phase,'error');
  assert.notEqual(result.connection.plugins.draft.phase,'connected');
  assert.deepEqual(f.calls.map((call) => call.plugin.pluginInstanceId).sort(),['cache','orders']);
  assert.deepEqual(result.actions.map((action) => action.rootPluginInstanceId).sort(),['cache','draft']);
  assert.equal(result.actions.find((action) => action.rootPluginInstanceId === 'cache').action,'open-desktop');
  assert.ok(result.actions.every((action) => !('details' in action)));
});

test('Agent host-key challenges require desktop action and never expose an approval challenge', async () => {
  const f = fixture([plugin('server','server')],{connect:async () => {
    throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','请在桌面应用确认主机密钥。',{
      fingerprint:'SHA256:test-observed-key',algorithm:'ssh-ed25519',
    });
  }});
  const result = await f.service.connectPlugin({...await f.open(),pluginInstanceId:'server'});
  assert.equal(result.outcome,'needs-action');
  assert.equal(result.actions[0].code,'SSH_HOST_KEY_CONFIRM_REQUIRED');
  assert.equal(result.actions[0].action,'open-desktop');
  assert.equal('details' in result.actions[0],false);
  assert.equal(JSON.stringify(result).includes('challengeId'),false);
  assert.equal(f.calls.length,1);
  assert.equal(f.state.plugins[0].target.hostKeyFingerprint,undefined);
});

test('Agent connection is idempotent for already connected plugins', async () => {
  const f = fixture();
  const params = {...await f.open(),pluginInstanceId:'orders'};
  await f.service.connectPlugin(params);
  const repeated = await f.service.connectPlugin(params);
  assert.equal(repeated.outcome,'already-satisfied');
  assert.equal(repeated.connection.plugins.orders.phase,'connected');
  assert.equal(f.calls.length,1);
});

test('concurrent Agent connection requests share the same runtime operation', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture([plugin('orders')],{connect:async () => { await pending; return {connectedAt:'now'}; }});
  const params = {...await f.open(),pluginInstanceId:'orders'};
  const first = f.service.connectPlugin(params);
  await waitFor(() => f.calls.length === 1);
  const second = f.service.connectPlugin(params);
  try {
    await waitFor(() => f.connectionManager.activeConnectionOperations('p1','e1')[0]?.subscriberCount === 2);
  } finally { release(); }
  const results = await Promise.all([first,second]);
  assert.equal(f.calls.length,1);
  assert.equal(results[0].operationId,results[1].operationId);
  assert.notEqual(results[0].planId,results[1].planId);
  assert.ok(results.every((result) => result.connection.plugins.orders.phase === 'connected'));
});

test('Agent connection rejects missing, expired, foreign, and stale contexts before networking', async (t) => {
  const cases = [
    ['missing context','CONTEXT_REQUIRED',(_f,params) => { delete params.contextToken; }],
    ['expired context','CONTEXT_REQUIRED',(f) => { f.state.now += 1_001; }],
    ['other client','CLIENT_CONTEXT_MISMATCH',(_f,params) => { params.clientInstanceId = 'agent-b'; }],
    ['other project','SCOPE_MISMATCH',(_f,params) => { params.projectId = 'p2'; }],
    ['other environment','SCOPE_MISMATCH',(_f,params) => { params.environmentId = 'e2'; }],
    ['changed connection','CONTEXT_STALE',(f) => { f.state.plugins[0].target.host = 'changed.example.test'; }],
    ['changed runbook','CONTEXT_STALE',(f) => { f.state.runbook.hash = 'runbook-2'; }],
  ];
  for (const method of ['connectEnvironment','connectPlugin']) {
    for (const [name,code,change] of cases) {
      await t.test(`${method}: ${name}`,async () => {
        const f = fixture();
        const params = {...await f.open(),...(method === 'connectPlugin' ? {pluginInstanceId:'orders'} : {})};
        change(f,params);
        await assert.rejects(() => f.service[method](params),(error) => error.code === code);
        assert.equal(f.calls.length,0);
        assert.equal(f.intents.length,0);
      });
    }
  }
});

test('Agent connection rejects unknown plugins instead of widening to the environment', async () => {
  const f = fixture();
  const params = await f.open();
  await assert.rejects(
    () => f.service.connectPlugin({...params,pluginInstanceId:'missing'}),
    (error) => error.code === 'CAPABILITY_NOT_GRANTED',
  );
  assert.equal(f.calls.length,0);
  assert.equal(f.intents.length,0);
});

test('Agent connection rejects invalid scopes, empty plugin IDs, and extra sensitive or control fields', async () => {
  const f = fixture();
  const params = await f.open();
  for (const value of [undefined,null,'','   ',[],{}]) {
    await assert.rejects(() => f.service.connectPlugin({...params,pluginInstanceId:value}),(error) => error.code === 'INVALID_ARGUMENT');
  }
  for (const key of ['projectId','environmentId']) {
    await assert.rejects(() => f.service.connectEnvironment({...params,[key]:''}),(error) => error.code === 'INVALID_ARGUMENT');
  }
  const extras = {
    password:'test-secret-must-not-pass',secrets:{password:'test-secret-must-not-pass'},
    secretsByPlugin:{orders:{password:'test-secret-must-not-pass'}},force:true,trust:true,
    trustHostKey:true,fenceOwnerId:'edit-owner',actor:'user',source:'renderer',
    pluginInstanceIds:['orders'],expectedRevision:1,requestId:'agent-selected-id',
  };
  for (const method of ['connectEnvironment','connectPlugin']) {
    for (const [key,value] of Object.entries(extras)) {
      await assert.rejects(
        () => f.service[method]({...params,...(method === 'connectPlugin' ? {pluginInstanceId:'orders'} : {}),[key]:value}),
        (error) => error.code === 'INVALID_ARGUMENT' && !JSON.stringify(error).includes('test-secret-must-not-pass'),
      );
    }
  }
  await assert.rejects(() => f.service.connectEnvironment({...params,pluginInstanceId:'orders'}),(error) => error.code === 'INVALID_ARGUMENT');
  assert.equal(f.calls.length,0);
  assert.equal(f.intents.length,0);
});

test('Agent connection supports the default unknown client without rebinding an existing client context', async () => {
  const f = fixture();
  const params = await f.open('unknown');
  delete params.clientInstanceId;
  const result = await f.service.connectEnvironment(params);
  assert.equal(result.connection.plugins.orders.phase,'connected');
});

test('Agent connection rejects an active desktop edit fence before starting a plan', async () => {
  const f = fixture();
  const params = await f.open();
  f.mutationCoordinator.installEnvironmentEditFence('p1','e1','desktop-edit',['orders']);
  for (const method of ['connectEnvironment','connectPlugin']) {
    await assert.rejects(
      () => f.service[method]({...params,...(method === 'connectPlugin' ? {pluginInstanceId:'orders'} : {})}),
      (error) => error.code === 'PLUGIN_EDIT_BUSY',
    );
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.intents.length,0);
});

test('Agent connection does not return success after context is invalidated during networking', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture([plugin('orders')],{connect:async () => { await pending; return {connectedAt:'now'}; }});
  const connection = f.service.connectPlugin({...await f.open(),pluginInstanceId:'orders'});
  await waitFor(() => f.calls.length === 1);
  f.contextManager.invalidateEnvironment('p1','e1');
  release();
  await assert.rejects(() => connection,(error) => error.code === 'CONTEXT_REQUIRED');
  assert.equal(f.mutationCoordinator.environmentActivitySnapshot('p1','e1').readers,0);
});

test('Agent connection does not expose raw runtime errors or credential material in results and audit records', async () => {
  const secret = 'synthetic-test-password-must-not-escape';
  const f = fixture([plugin('orders')],{connect:async () => { throw new Error(`driver rejected password=${secret}`); }});
  const result = await f.service.connectPlugin({...await f.open(),pluginInstanceId:'orders'});
  assert.equal(result.outcome,'needs-action');
  assert.equal(result.actions[0].code,'INTERNAL_ERROR');
  assert.equal(JSON.stringify({result,audits:f.audits}).includes(secret),false);
  assert.equal(JSON.stringify(result).includes('driver rejected'),false);
  assert.ok(result.actions.every((action) => !('details' in action)));
  assert.ok(f.audits.some((entry) => entry.type === 'plugin-connected' && entry.result === 'error' && entry.actor === 'agent'));
});

test('MCP stdio connects through Broker using a real scoped service without widening or accepting secrets', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'runbook-agent-connect-')));
  const f = fixture([plugin('orders'),plugin('cache','redis')]);
  let client;
  let broker;
  t.after(async () => {
    await client?.close();
    await broker?.stop();
    f.contextManager.clear();
    const checked = await fs.realpath(root);
    assert.equal(checked,path.resolve(root));
    assert.equal(path.dirname(checked),await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('runbook-agent-connect-'));
    await fs.rm(checked,{recursive:true,force:true});
  });
  broker = new BrokerServer({dataRoot:root,token:await rotateBrokerToken(root),v2Service:f.service});
  await broker.start();
  client = new Client({name:'agent-connect-regression',version:'1.0.0'});
  await client.connect(new StdioClientTransport({
    command:process.execPath,args:[path.resolve('src/mcp-v2.mjs')],env:{AI_OPS_DATA_DIR:root},stderr:'pipe',
  }));
  const call = async (name,args) => (await client.callTool({name,arguments:args})).structuredContent;
  const scope = {projectId:'p1',environmentId:'e1'};
  const opened = await call('open_environment',scope);
  assert.ok(opened.contextToken);
  assert.equal(f.calls.length,0);
  const params = {...scope,contextToken:opened.contextToken};
  for (const [name,args] of [
    ['connect_plugin',params],
    ['connect_plugin',{...params,pluginInstanceId:''}],
    ['connect_plugin',{...params,pluginInstanceId:'orders',secrets:{password:'synthetic-rejected-password'}}],
    ['connect_environment',{...params,secretsByPlugin:{orders:{password:'synthetic-rejected-password'}}}],
  ]) {
    const rejected = await call(name,args);
    assert.equal(rejected.error?.code,'INVALID_ARGUMENT');
    assert.equal(JSON.stringify(rejected).includes('synthetic-rejected-password'),false);
  }
  assert.equal(f.calls.length,0);
  const connected = await call('connect_plugin',{...params,pluginInstanceId:'orders'});
  assert.equal(connected.outcome,'started');
  assert.equal(connected.connection.plugins.orders.phase,'connected');
  assert.notEqual(connected.connection.plugins.cache.phase,'connected');
  assert.deepEqual(f.calls.map((entry) => entry.plugin.pluginInstanceId),['orders']);
  const repeated = await call('connect_plugin',{...params,pluginInstanceId:'orders'});
  assert.equal(repeated.outcome,'already-satisfied');
  assert.equal(f.calls.length,1);
  const all = await call('connect_environment',params);
  assert.equal(all.outcome,'started');
  assert.equal(all.connection.plugins.orders.phase,'connected');
  assert.equal(all.connection.plugins.cache.phase,'connected');
  assert.deepEqual(f.calls.map((entry) => entry.plugin.pluginInstanceId),['orders','cache']);
  assert.ok(f.calls.every((entry) => Object.keys(entry.secrets).length === 0));
  assert.ok(f.audits.every((entry) => entry.actor === 'agent'));
});
