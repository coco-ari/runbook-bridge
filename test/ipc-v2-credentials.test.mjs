import test from 'node:test';
import assert from 'node:assert/strict';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { AppError } from '../src/errors.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';

function createHarness() {
  const handlers = new Map();
  const existing = {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-1', pluginType:'mysql',
    displayName:'MySQL', target:{host:'old.internal',port:3306,database:'app',addressFamily:'ipv4Preferred'},
    auth:{username:'reader'}, transport:{kind:'direct'}, tls:{mode:'disabled'},
  };
  let receivedSecrets;
  const ipcMain = {
    handle: (name, handler) => handlers.set(name, handler),
    on: () => undefined,
  };
  const services = {
    workspaceStore: {
      getEnvironment: async () => ({ projectId:'p1', environmentId:'e1' }),
      getPlugin: async () => existing,
    },
    connectionManager: { on: () => undefined },
    credentialVault: {
      load: async () => { throw new AppError('CREDENTIAL_BINDING_MISMATCH', '保存的凭据不匹配。'); },
    },
    contextManager: {}, confirmationManager: { on: () => undefined }, pluginManager: {},
    mysqlRuntime: {
      listDatabases: async (_plugin, secrets) => {
        receivedSecrets = secrets;
        return { databases:['app'], truncated:false };
      },
    },
  };
  registerV2Ipc(ipcMain, services);
  return { handlers, getReceivedSecrets: () => receivedSecrets };
}

const payload = {
  projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-1',
  input:{
    pluginType:'mysql', displayName:'MySQL', target:{host:'new.internal',port:3306,database:'',addressFamily:'ipv4Preferred'},
    auth:{username:'reader'}, transport:{kind:'direct'}, tls:{mode:'disabled'},
  },
};

test('database discovery uses a newly entered password when the saved credential binding is stale', async () => {
  const harness = createHarness();
  const result = await harness.handlers.get('v2:plugin-databases')({}, { ...payload, secrets:{password:'new-secret'} });
  assert.deepEqual(result, { ok:true, data:{databases:['app'],truncated:false} });
  assert.deepEqual(harness.getReceivedSecrets(), { password:'new-secret' });
});

test('database discovery still reports a stale saved credential when no replacement password was entered', async () => {
  const harness = createHarness();
  const result = await harness.handlers.get('v2:plugin-databases')({}, { ...payload, secrets:{} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CREDENTIAL_BINDING_MISMATCH');
});

test('deleting a provider with dependents has no connection or credential side effects', async () => {
  const handlers=new Map();
  let disconnects=0;
  let clears=0;
  let deletes=0;
  const ipcMain={handle:(name,handler)=>handlers.set(name,handler),on:()=>undefined};
  registerV2Ipc(ipcMain,{
    workspaceStore:{
      preflightDeletePlugin:async()=>{throw new AppError('PLUGIN_HAS_DEPENDENTS','会员主库仍复用此隧道。');},
      deletePlugin:async()=>{deletes+=1;},
    },
    connectionManager:{on:()=>undefined},
    credentialVault:{clear:async()=>{clears+=1;}},
    contextManager:{}, confirmationManager:{on:()=>undefined},
    pluginManager:{disconnect:async()=>{disconnects+=1;}},
  });
  const result=await handlers.get('v2:plugin-delete')({}, {projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1'});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'PLUGIN_HAS_DEPENDENTS');
  assert.equal(disconnects,0);
  assert.equal(clears,0);
  assert.equal(deletes,0);
});

function createPluginTestHarness({ connectError = null } = {}) {
  const handlers = new Map();
  const progress = [];
  const calls = [];
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',displayName:'MySQL',revision:1,configState:'ready',
    target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Preferred'},auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},limits:{maxRows:100,timeoutMs:10000},
  };
  const ipcMain = { handle:(name,handler) => handlers.set(name,handler),on:() => undefined };
  registerV2Ipc(ipcMain,{
    workspaceStore:{getEnvironment:async() => ({projectId:'p1',environmentId:'e1'}),getPlugin:async() => plugin},
    connectionManager:{snapshot:() => ({plugins:{}}),on:() => undefined},
    credentialVault:{load:async() => ({password:'saved-secret'})},
    contextManager:{},confirmationManager:{on:() => undefined},mysqlRuntime:{},
    pluginManager:{
      connect:async(_plugin,secrets) => { calls.push(['connect',secrets]); if (connectError) throw connectError; },
      health:async() => { calls.push(['health']); return {connected:true}; },
      disconnect:async() => { calls.push(['disconnect']); },
    },
  });
  const event = {sender:{isDestroyed:() => false,send:(channel,payload) => progress.push({channel,...payload})}};
  return {handlers,event,progress,calls};
}

test('plugin connection check runs configuration, connection and protocol checks in order with timings', async () => {
  const harness = createPluginTestHarness();
  const result = await harness.handlers.get('v2:plugin-test')(harness.event,{projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',requestId:7});
  assert.equal(result.ok,true);
  assert.deepEqual(result.data.checks.map((check) => [check.id,check.status]),[['configuration','success'],['connection','success'],['protocol','success']]);
  assert.ok(result.data.checks.every((check) => Number.isInteger(check.elapsedMs) && check.elapsedMs >= 0));
  assert.ok(Number.isInteger(result.data.totalElapsedMs) && result.data.totalElapsedMs >= 0);
  assert.deepEqual(harness.progress.map((entry) => [entry.channel,entry.requestId,entry.check.id]),[
    ['v2:plugin-test-progress',7,'configuration'],
    ['v2:plugin-test-progress',7,'connection'],
    ['v2:plugin-test-progress',7,'protocol'],
  ]);
  assert.deepEqual(harness.calls,[['connect',{password:'saved-secret'}],['health'],['disconnect']]);
});

test('plugin connection check stops after the first failed stage', async () => {
  const harness = createPluginTestHarness({connectError:new AppError('CONNECTION_FAILED','数据库拒绝连接。')});
  const result = await harness.handlers.get('v2:plugin-test')(harness.event,{projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',requestId:8});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'CONNECTION_FAILED');
  assert.deepEqual(result.error.details.diagnostic.checks.map((check) => [check.id,check.status]),[['configuration','success'],['connection','failure']]);
  assert.deepEqual(harness.calls,[['connect',{password:'saved-secret'}]]);
});

test('server form diagnostics use the in-memory configuration without looking up the temporary plugin id', async () => {
  let storeReads = 0;
  let inspectedPlugin = null;
  const runtime = new ServerPluginRuntime(
    {getPlugin:async() => { storeReads += 1; throw new AppError('PLUGIN_NOT_FOUND','插件不存在。'); }},
    {load:async() => null},
    {resolver:{resolve:async() => [{address:'127.0.0.1',family:4}]},vpnGuard:{}},
  );
  runtime.createUplinkSocket = async () => ({destroy:() => undefined});
  runtime.broker = {
    connect:async(key) => { inspectedPlugin = await runtime.adapter.get(key); return {connected:true}; },
    disconnect:async() => ({connected:false}),
  };
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'diagnostic-form-check',pluginType:'server',displayName:'待测服务器',configState:'ready',revision:1,
    target:{host:'new.internal',port:22,addressFamily:'ipv4Only'},auth:{username:'root',type:'password'},uplink:{type:'direct'},limits:{timeoutMs:10000},
  };
  await runtime.connect(plugin,{password:'form-secret'});
  assert.equal(inspectedPlugin?.ssh.host,'new.internal');
  assert.equal(storeReads,0);
  await runtime.disconnect(plugin,'diagnostic-complete');
  assert.equal(runtime.adapter.overrides.size,0);
});
