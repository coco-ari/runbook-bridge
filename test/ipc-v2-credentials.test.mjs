import test from 'node:test';
import assert from 'node:assert/strict';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { AppError } from '../src/errors.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { randomBytes } from 'node:crypto';

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

test('database discovery requires an explicit rebind when the credential identity changed', async () => {
  const harness = createHarness();
  const result = await harness.handlers.get('v2:plugin-databases')({}, { ...payload, secrets:{} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CREDENTIAL_REBIND_REQUIRED');
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

function createRevealHarness({pluginType = 'mysql',authType = 'password',load} = {}) {
  const handlers = new Map();
  const plugin = {projectId:'p1',environmentId:'e1',pluginInstanceId:'plugin-1',pluginType,auth:{type:authType}};
  const sender = {id:1,mainFrame:{},isDestroyed:() => false};
  const event = {sender,senderFrame:sender.mainFrame};
  let loads = 0;
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:{getPlugin:async (projectId,environmentId,pluginInstanceId) => {
      if (projectId !== plugin.projectId || environmentId !== plugin.environmentId || pluginInstanceId !== plugin.pluginInstanceId) {
        throw new AppError('PLUGIN_NOT_FOUND','插件不存在。');
      }
      return plugin;
    }},
    connectionManager:{on:() => undefined},confirmationManager:{on:() => undefined},contextManager:{},pluginManager:{},
    credentialVault:{load:async (record) => {loads += 1; assert.equal(record,plugin); return load?.();}},
    isWorkspaceRenderer:(candidate) => candidate === sender,
  });
  return {
    event,sender,getLoads:() => loads,
    invoke:(input = {},caller = event) => handlers.get('v2:plugin-credential-reveal')(caller,{
      projectId:'p1',environmentId:'e1',pluginInstanceId:'plugin-1',field:'password',...input,
    }),
  };
}

test('desktop credential viewing supports only saved password fields for the exact plugin', async () => {
  const value = randomBytes(24).toString('hex');
  for (const [pluginType,authType,field] of [
    ['mysql','password','password'],['redis','password','password'],
    ['server','password','password'],['server','privateKey','privateKeyPassphrase'],
    ['server','agent','proxyPassword'],
  ]) {
    const harness = createRevealHarness({pluginType,authType,load:() => ({[field]:value})});
    const result = await harness.invoke({field});
    assert.equal(result.ok,true);
    assert.equal(result.data.value === value,true,'仅在受信任桌面请求中返回指定字段');
    assert.deepEqual(Object.keys(result.data),['value']);
    assert.equal(harness.getLoads(),1);
  }
});

test('desktop credential viewing denies untrusted senders and subframes before loading secrets', async () => {
  const harness = createRevealHarness();
  for (const event of [{},{sender:harness.sender,senderFrame:{}},{sender:{...harness.sender},senderFrame:harness.sender.mainFrame}]) {
    const result = await harness.invoke({},event);
    assert.equal(result.ok,false);
    assert.equal(result.error.code,'ACCESS_DENIED');
  }
  assert.equal(harness.getLoads(),0);
});

test('desktop credential viewing rejects extra parameters, wrong scopes and non-password material', async () => {
  const harness = createRevealHarness();
  for (const input of [{field:'privateKeyPem'},{field:'proxyPassword'},{field:'clientKeyPem'},{extra:true},{projectId:''}]) {
    const result = await harness.invoke(input);
    assert.equal(result.error.code,'INVALID_ARGUMENT');
  }
  for (const input of [{projectId:'p2'},{environmentId:'e2'},{pluginInstanceId:'plugin-2'}]) {
    assert.equal((await harness.invoke(input)).error.code,'PLUGIN_NOT_FOUND');
  }
  assert.equal(harness.getLoads(),0);
  for (const [pluginType,authType,field] of [['server','agent','password'],['server','privateKey','password'],['unknown','password','password']]) {
    const other = createRevealHarness({pluginType,authType});
    assert.equal((await other.invoke({field})).error.code,'INVALID_ARGUMENT');
    assert.equal(other.getLoads(),0);
  }
});

test('desktop credential viewing fails safely for missing or unreadable credentials', async () => {
  const value = randomBytes(24).toString('hex');
  assert.equal((await createRevealHarness().invoke()).error.code,'CREDENTIAL_NOT_FOUND');
  for (const code of ['CREDENTIAL_BINDING_MISMATCH','CREDENTIAL_DECRYPT_FAILED','UNEXPECTED']) {
    const harness = createRevealHarness({load:() => {throw new AppError(code,value,{value});}});
    const result = await harness.invoke();
    assert.equal(result.error.code,code === 'UNEXPECTED' ? 'CREDENTIAL_REVEAL_FAILED' : code);
    assert.equal(JSON.stringify(result).includes(value),false,'错误结果不得包含凭据或原始异常详情');
  }
});

test('desktop credential viewing discards decrypted results after the trusted frame changes', async () => {
  let finish;
  const harness = createRevealHarness({load:() => new Promise(resolve => {finish = resolve;})});
  const pending = harness.invoke();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  harness.sender.mainFrame = {};
  finish({password:randomBytes(24).toString('hex')});
  const result = await pending;
  assert.equal(result.error.code,'ACCESS_DENIED');
  assert.equal(result.data,undefined);
});
