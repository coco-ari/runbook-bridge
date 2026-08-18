import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { V2Service } from '../src/v2-service.mjs';

function server(overrides = {}) {
  return {
    schemaVersion:1,projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',
    displayName:'Application Server',revision:3,configState:'ready',
    target:{host:'app.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'deploy'},uplink:{type:'direct'},tunnelProvider:true,
    policy:{status:'auto'},limits:{timeoutMs:10_000},...overrides,
  };
}

function mysql(overrides = {}) {
  return {
    schemaVersion:1,projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',
    displayName:'Orders Database',revision:5,configState:'ready',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'},
    tls:{mode:'required'},policy:{select:'auto'},limits:{maxRows:100,timeoutMs:10_000},...overrides,
  };
}

function publicPlugin(plugin) {
  return {
    pluginInstanceId:plugin.pluginInstanceId,
    pluginType:plugin.pluginType,
    displayName:plugin.displayName,
    configState:plugin.configState,
    revision:plugin.revision,
  };
}

function harness() {
  const plugins = [server(),mysql()];
  let networkCalls = 0;
  let vaultCalls = 0;
  let writeCalls = 0;
  const workspaceStore = {
    getEnvironment:async () => ({projectId:'p1',environmentId:'e1',revision:2}),
    listPlugins:async () => plugins,
    getPlugin:async (_projectId,_environmentId,pluginInstanceId) => {
      const plugin = plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
      if (!plugin) throw Object.assign(new Error('not found'),{code:'PLUGIN_NOT_FOUND'});
      return plugin;
    },
    publicPlugin,
    listProjectOverviews:async () => [{
      projectId:'p1',name:'Project',revision:1,
      environments:[{
        projectId:'p1',environmentId:'e1',name:'Production',revision:2,
        pluginCount:2,readyPluginCount:2,resourcePreview:[publicPlugin(plugins[0])],
      }],
    }],
    appendAudit:async () => { writeCalls += 1; },
  };
  const pluginManager = {
    connect:async () => { networkCalls += 1; },
    disconnect:async () => { networkCalls += 1; },
  };
  const credentialVault = new Proxy({}, {
    get() {
      return async () => { vaultCalls += 1; throw new Error('assessment must not access active vault'); };
    },
  });
  const connectionManager = new EnvironmentConnectionManager(workspaceStore,pluginManager);
  return {
    plugins,workspaceStore,pluginManager,credentialVault,connectionManager,
    counters:() => ({networkCalls,vaultCalls,writeCalls}),
  };
}

function assertStructuredAssessment(assessment, pluginInstanceId) {
  assert.equal(assessment.scope.pluginInstanceId,pluginInstanceId);
  assert.match(assessment.connectionFingerprint,/^[a-f0-9]{64}$/u);
  assert.match(assessment.agentFingerprint,/^[a-f0-9]{64}$/u);
  assert.ok(assessment.configuration);
  assert.ok(assessment.credential);
  assert.ok(assessment.dependency);
  assert.ok(assessment.resourceScope);
  assert.ok(assessment.runtime);
  assert.ok(assessment.agent);
  assert.ok(assessment.primaryStatus);
  assert.ok(['ready','draft'].includes(assessment.configState));
  assert.equal(typeof assessment.phase,'string');
}

test('environment status and snapshot expose structured assessments without connecting', async () => {
  const value = harness();
  const status = await value.connectionManager.status('p1','e1');
  assertStructuredAssessment(status.plugins['server-1'],'server-1');
  assertStructuredAssessment(status.plugins['mysql-1'],'mysql-1');
  assert.equal(status.plugins['mysql-1'].dependency.state,'ready');
  assert.deepEqual(status.plugins['mysql-1'].resourceScope,{
    state:'selected-unverified',kind:'mysql-database',value:'orders',
  });
  assert.equal(status.plugins['mysql-1'].runtime.phase,'disconnected');
  assert.equal(status.plugins['mysql-1'].phase,'disconnected');

  const snapshot = value.connectionManager.snapshot('p1','e1');
  assert.deepEqual(snapshot.plugins['mysql-1'],status.plugins['mysql-1']);
  assert.deepEqual(value.connectionManager.listStates(),{},'read-only assessment must not create formal runtime state');
  await value.connectionManager.configurationChanged('p1','e1','server-1');
  assert.deepEqual(value.connectionManager.listStates(),{},'assessment must not make a later save look connected');
  assert.deepEqual(value.counters(),{networkCalls:0,vaultCalls:0,writeCalls:0});
});

test('a late status read cannot roll back a newer runtime sequence', async () => {
  let releasePlugins;
  const plugins = new Promise((resolve) => { releasePlugins = () => resolve([server()]); });
  const manager = new EnvironmentConnectionManager({listPlugins:() => plugins},{});
  const pendingStatus = manager.status('p1','e1');
  const connected = structuredClone(manager.state('p1','e1'));
  connected.desiredConnected = true;
  connected.phase = 'connected';
  connected.plugins['server-1'] = {
    pluginInstanceId:'server-1',pluginType:'server',displayName:'Application Server',
    providerPluginInstanceId:null,phase:'connected',reason:null,retryable:false,attempt:1,
    updatedAt:connected.updatedAt,
  };
  manager.publish(connected);
  const publishedSequence = manager.state('p1','e1').sequence;
  releasePlugins();
  const status = await pendingStatus;
  assert.equal(status.sequence,publishedSequence);
  assert.equal(status.plugins['server-1'].runtime.phase,'connected');
  assert.equal(manager.snapshot('p1','e1').sequence,publishedSequence);
  assert.equal(manager.snapshot('p1','e1').plugins['server-1'].runtime.phase,'connected');
});

test('IPC assessment, list, overview, and Agent directory share one assessment shape', async () => {
  const value = harness();
  const handlers = new Map();
  const ipcMain = {handle:(name,handler) => handlers.set(name,handler),on:() => undefined};
  registerV2Ipc(ipcMain,{
    ...value,
    contextManager:{},
    confirmationManager:{on:() => undefined},
    mysqlRuntime:{},
  });

  const scope = {projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1'};
  const assessed = await handlers.get('v2:plugin-assess')({},scope);
  const listed = await handlers.get('v2:plugin-list')({},scope);
  const overview = await handlers.get('v2:workspace-overview')({});
  assert.equal(assessed.ok,true);
  assert.equal(listed.ok,true);
  assert.equal(overview.ok,true);
  const listedAssessment = listed.data.find((item) => item.pluginInstanceId === 'mysql-1').assessment;
  assert.deepEqual(listedAssessment,assessed.data);
  assertStructuredAssessment(listedAssessment,'mysql-1');

  const previewRuntime = overview.data[0].environments[0].runtime;
  assert.equal(previewRuntime.pluginsPartial,true);
  assert.deepEqual(Object.keys(previewRuntime.plugins),['server-1']);
  assertStructuredAssessment(previewRuntime.plugins['server-1'],'server-1');
  assert.deepEqual(
    overview.data[0].environments[0].resourcePreview[0].assessment,
    previewRuntime.plugins['server-1'].assessment,
  );

  const contextManager = {
    open:async () => ({
      environment:{projectId:'p1',environmentId:'e1',name:'Production'},
      runbook:{content:'Runbook',hash:'runbook-hash',empty:false},
      plugins:value.plugins,contextToken:'context-token',expiresAt:'later',
    }),
  };
  const service = new V2Service({
    workspaceStore:{...value.workspaceStore,readRunbook:async () => ({content:'Runbook',hash:'runbook-hash',empty:false})},
    connectionManager:value.connectionManager,
    contextManager,
  });
  const agentList = await service.listEnvironmentPlugins(scope);
  const opened = await service.openEnvironment({...scope,clientInstanceId:'agent-1'});
  const agentListAssessment = agentList.plugins.find((item) => item.pluginInstanceId === 'mysql-1').assessment;
  const openedAssessment = opened.plugins.find((item) => item.pluginInstanceId === 'mysql-1').assessment;
  assert.deepEqual(agentListAssessment,assessed.data);
  assert.deepEqual(openedAssessment,assessed.data);
  assert.deepEqual(value.counters(),{networkCalls:0,vaultCalls:0,writeCalls:0});
});

test('draft assessment rejects secret-bearing input before any infrastructure side effect', async () => {
  const value = harness();
  const handlers = new Map();
  registerV2Ipc(
    {handle:(name,handler) => handlers.set(name,handler),on:() => undefined},
    {...value,contextManager:{},confirmationManager:{on:() => undefined},mysqlRuntime:{}},
  );
  const result = await handlers.get('v2:plugin-assess')({}, {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',editSessionId:'edit-1',
    draft:{...value.plugins[0],auth:{...value.plugins[0].auth,password:'must-not-pass'}},
  });
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'INVALID_ARGUMENT');
  assert.doesNotMatch(JSON.stringify(result),/must-not-pass/u);
  assert.deepEqual(value.counters(),{networkCalls:0,vaultCalls:0,writeCalls:0});
});
