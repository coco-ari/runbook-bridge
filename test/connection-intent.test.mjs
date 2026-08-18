import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve,milliseconds));

function plugin(id,type = 'mysql',overrides = {}) {
  return {
    projectId:'p1',
    environmentId:'e1',
    pluginInstanceId:id,
    pluginType:type,
    displayName:id,
    revision:1,
    configState:'ready',
    target:type === 'server'
      ? {host:`${id}.internal`,port:22,addressFamily:'ipv4Only'}
      : type === 'mysql'
        ? {host:`${id}.internal`,port:3306,database:'app',addressFamily:'ipv4Only'}
        : {host:`${id}.internal`,port:6379,db:0,addressFamily:'ipv4Only'},
    auth:type === 'server' ? {type:'password',username:'root'} : {username:'app'},
    transport:{kind:'direct'},
    tls:type === 'server' ? undefined : {mode:'disabled'},
    ...overrides,
  };
}

function fixture(plugins,runtime,{audits = null} = {}) {
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async () => plugins,
    getPlugin:async (_projectId,_environmentId,id) => plugins.find((item) => item.pluginInstanceId === id),
    appendAudit:async (_projectId,entry) => { audits?.push(structuredClone(entry)); },
  };
  return new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
}

async function waitFor(predicate,message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail(message);
}

test('Connect All connects independent ready branches and returns incomplete plugins as needs-action', async () => {
  const readyA = plugin('orders');
  const incompleteB = plugin('server-draft','server',{configState:'draft',target:{host:'',port:22,addressFamily:'ipv4Only'}});
  const readyC = plugin('cache','redis');
  const calls = [];
  const manager = fixture([readyA,incompleteB,readyC],{
    connect:async (item) => { calls.push(item.pluginInstanceId); return {connectedAt:'now'}; },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const result = await manager.requestConnectionIntent({
    requestId:'request-all',planId:'plan-all',projectId:'p1',environmentId:'e1',intent:'connect',source:'environment',
  });

  assert.equal(result.outcome,'needs-action');
  assert.equal(result.planId,'plan-all');
  assert.deepEqual(calls.sort(),['cache','orders']);
  assert.equal(result.snapshot.plugins.orders.phase,'connected');
  assert.equal(result.snapshot.plugins.cache.phase,'connected');
  assert.equal(result.snapshot.plugins['server-draft'].phase,'disconnected');
  assert.deepEqual(result.actions.map((action) => action.rootPluginInstanceId),['server-draft']);
  assert.deepEqual(result.actions[0].affectedPluginInstanceIds,['server-draft']);
});

test('unified connection plans audit every terminal plugin operation with correlation ids', async () => {
  const target = plugin('orders');
  const audits = [];
  const manager = fixture([target],{
    connect:async () => ({connectedAt:'now'}),
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  },{audits});

  const result = await manager.requestConnectionIntent({
    requestId:'audit-request',planId:'audit-plan',operationId:'audit-operation',
    projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',intent:'connect',source:'renderer-plugin',
  });

  assert.equal(result.outcome,'started');
  const terminal = audits.find((entry) => entry.type === 'plugin-connected');
  assert.deepEqual(terminal,{
    type:'plugin-connected',projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',
    pluginNameSnapshot:'orders',actor:'user',planId:'audit-plan',operationId:'audit-operation',
    result:'success',durationMs:terminal.durationMs,
  });
  assert.ok(Number.isFinite(terminal.durationMs));
  assert.ok(audits.some((entry) => entry.type === 'connection-plan-completed' && entry.planId === 'audit-plan'));
});

test('formal SSH host-key challenge is operation-bound and resumes the same plan after trust commit', async () => {
  let server = plugin('server','server');
  const calls = [];
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async () => [server],
    getPlugin:async () => server,
    appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store,{
    connect:async (value) => {
      calls.push(value.target.hostKeyFingerprint ?? null);
      if (!value.target.hostKeyFingerprint) {
        throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','confirm host key',{
          fingerprint:'SHA256:observed',algorithm:'ssh-ed25519',
        });
      }
      return {connectedAt:'now'};
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  },{retryDelays:[]});

  const first = await manager.requestConnectionIntent({
    requestId:'host-key-request',planId:'host-key-plan',projectId:'p1',environmentId:'e1',
    pluginInstanceId:'server',intent:'connect',source:'renderer-plugin',
  });
  assert.equal(first.outcome,'needs-action');
  const action = first.actions[0];
  assert.equal(action.action,'confirm-host-key');
  assert.equal(action.code,'SSH_HOST_KEY_CONFIRM_REQUIRED');
  assert.deepEqual(action.details.hostKeyChallenge,{
    challengeId:action.details.hostKeyChallenge.challengeId,
    planId:'host-key-plan',
    operationId:first.operationId,
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',
    expectedRevision:1,
    generation:1,
    digest:action.details.hostKeyChallenge.digest,
    host:'server.internal',port:22,algorithm:'ssh-ed25519',fingerprint:'SHA256:observed',
    expiresAt:action.details.hostKeyChallenge.expiresAt,
  });

  await assert.rejects(
    () => manager.validateConnectionChallenge({
      ...action.details.hostKeyChallenge,
      operationId:'stale-operation',
      decision:'trust-host-key',
    }),
    (error) => error.code === 'CONNECTION_CHALLENGE_STALE',
  );
  for (const stale of [
    {digest:'stale-digest'},
    {host:'other.internal'},
    {port:2222},
    {expectedRevision:2},
    {generation:2},
  ]) {
    await assert.rejects(
      () => manager.validateConnectionChallenge({
        ...action.details.hostKeyChallenge,
        ...stale,
        decision:'trust-host-key',
      }),
      (error) => error.code === 'CONNECTION_CHALLENGE_STALE',
    );
  }

  const challenge = await manager.validateConnectionChallenge({
    ...action.details.hostKeyChallenge,
    decision:'trust-host-key',
  });
  server = {
    ...server,
    revision:2,
    target:{...server.target,hostKeyFingerprint:challenge.fingerprint},
  };
  const resumed = await manager.resumeConnectionChallenge({
    ...action.details.hostKeyChallenge,
    decision:'trust-host-key',
  },{plugin:server});

  assert.equal(resumed.planId,'host-key-plan');
  assert.equal(resumed.outcome,'started');
  assert.equal(resumed.snapshot.plugins.server.phase,'connected');
  assert.deepEqual(calls,[null,'SHA256:observed']);
  await assert.rejects(
    () => manager.resumeConnectionChallenge({
      ...action.details.hostKeyChallenge,
      decision:'trust-host-key',
    },{plugin:server}),
    (error) => error.code === 'CONNECTION_CHALLENGE_STALE',
  );
});

test('a newer connection plan invalidates an unconsumed host-key challenge in the same scope', async () => {
  const server = plugin('server','server');
  const manager = fixture([server],{
    connect:async () => {
      throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','confirm host key',{
        fingerprint:'SHA256:observed',algorithm:'ssh-ed25519',
      });
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });
  const first = await manager.requestConnectionIntent({
    requestId:'challenge-first',planId:'challenge-plan-first',projectId:'p1',environmentId:'e1',
    pluginInstanceId:'server',intent:'connect',source:'renderer-plugin',
  });
  const firstChallenge = first.actions[0].details.hostKeyChallenge;
  await manager.requestConnectionIntent({
    requestId:'challenge-second',planId:'challenge-plan-second',projectId:'p1',environmentId:'e1',
    pluginInstanceId:'server',intent:'connect',source:'renderer-plugin',
  });
  await assert.rejects(
    () => manager.validateConnectionChallenge({...firstChallenge,decision:'trust-host-key'}),
    (error) => error.code === 'CONNECTION_CHALLENGE_STALE',
  );
});

test('an unavailable tunnel provider blocks only its dependency subtree and is grouped as one root cause', async () => {
  const provider = plugin('server','server',{configState:'draft',target:{host:'',port:22,addressFamily:'ipv4Only'}});
  const dependent = plugin('orders','mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'server'}});
  const independent = plugin('cache','redis');
  const calls = [];
  const manager = fixture([provider,dependent,independent],{
    connect:async (item) => { calls.push(item.pluginInstanceId); return {connectedAt:'now'}; },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const result = await manager.requestConnectionIntent({
    requestId:'request-provider-blocked',planId:'plan-provider-blocked',projectId:'p1',environmentId:'e1',intent:'connect',source:'environment',
  });

  assert.equal(result.outcome,'needs-action');
  assert.deepEqual(calls,['cache']);
  assert.equal(result.snapshot.plugins.cache.phase,'connected');
  assert.equal(result.snapshot.plugins.orders.phase,'blocked');
  assert.equal(result.actions.length,1);
  assert.equal(result.actions[0].rootPluginInstanceId,'server');
  assert.deepEqual(result.actions[0].affectedPluginInstanceIds.sort(),['orders','server']);
});

test('runtime credential failures are returned as actionable preparation items', async () => {
  const target = plugin('orders');
  const manager = fixture([target],{
    connect:async () => { throw new AppError('CREDENTIAL_UNAVAILABLE','saved credential is unavailable'); },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const result = await manager.requestConnectionIntent({
    requestId:'credential-failure',planId:'plan-credential-failure',projectId:'p1',environmentId:'e1',intent:'connect',source:'plugin',pluginInstanceId:'orders',
  });

  assert.equal(result.outcome,'needs-action');
  assert.equal(result.actions.length,1);
  assert.equal(result.actions[0].code,'CREDENTIAL_UNAVAILABLE');
  assert.equal(result.actions[0].action,'configure-credential');
  assert.equal(result.snapshot.plugins.orders.phase,'error');
});

test('a metadata-only revision change does not invalidate a matching connection fingerprint', async () => {
  const original = plugin('orders');
  const renamed = {...original,revision:2,displayName:'Renamed orders database'};
  let disconnects = 0;
  const store = {
    getEnvironment:async () => ({revision:1}),
    listPlugins:async () => [original],
    getPlugin:async () => renamed,
    appendAudit:async () => undefined,
  };
  const manager = new EnvironmentConnectionManager(store,{
    connect:async () => ({connectedAt:'now'}),
    disconnect:async () => { disconnects += 1; return {connected:false}; },
    closeAll:async () => undefined,
  },{retryDelays:[]});

  const result = await manager.requestConnectionIntent({
    requestId:'metadata-change',planId:'plan-metadata-change',projectId:'p1',environmentId:'e1',intent:'connect',source:'plugin',pluginInstanceId:'orders',
  });

  assert.equal(result.outcome,'started');
  assert.equal(result.snapshot.plugins.orders.phase,'connected');
  assert.equal(disconnects,0);
});

test('single-plugin and Connect All plans share provider operations and plan cancellation removes only its subscriber', async () => {
  const provider = plugin('server','server');
  const dependent = plugin('orders','mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'server'}});
  const calls = [];
  let releaseProvider;
  let providerSignal;
  const providerPending = new Promise((resolve) => { releaseProvider = resolve; });
  const manager = fixture([provider,dependent],{
    connect:async (item,_secrets,{signal} = {}) => {
      calls.push(item.pluginInstanceId);
      if (item.pluginInstanceId === 'server') {
        providerSignal = signal;
        await providerPending;
      }
      return {connectedAt:'now'};
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const connectAll = manager.requestConnectionIntent({
    requestId:'all',planId:'plan-all',projectId:'p1',environmentId:'e1',intent:'connect',source:'environment',
  });
  await waitFor(() => calls.includes('server'));
  const connectOne = manager.requestConnectionIntent({
    requestId:'one',planId:'plan-one',projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',intent:'connect',source:'plugin',
  });
  await waitFor(() => manager.connectionPlans?.get('plan-one')?.nodes?.get('server')?.operationId);

  const cancelled = await manager.requestConnectionIntent({
    requestId:'cancel-all',projectId:'p1',environmentId:'e1',intent:'cancel',source:'environment',planId:'plan-all',
  });
  assert.equal(cancelled.outcome,'cancelled');
  assert.equal(providerSignal.aborted,false,'the single-plugin subscriber still owns the shared provider mutation');

  releaseProvider();
  const [allResult,oneResult] = await Promise.all([connectAll,connectOne]);
  assert.equal(allResult.outcome,'cancelled');
  assert.equal(oneResult.outcome,'started');
  assert.equal(calls.filter((id) => id === 'server').length,1);
  assert.equal(calls.filter((id) => id === 'orders').length,1);
  assert.equal(oneResult.snapshot.plugins.orders.phase,'connected');
});

test('cancelling a plan stops unfinished nodes without rolling back a successful independent node', async () => {
  const completed = plugin('orders');
  const pending = plugin('cache','redis');
  let pendingSignal;
  const manager = fixture([completed,pending],{
    connect:async (item,_secrets,{signal} = {}) => {
      if (item.pluginInstanceId === 'orders') return {connectedAt:'now'};
      pendingSignal = signal;
      await new Promise((resolve,reject) => {
        signal.addEventListener('abort',() => reject(Object.assign(new Error('cancelled'),{code:'CONNECT_CANCELLED'})),{once:true});
      });
      return {connectedAt:'never'};
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const connecting = manager.requestConnectionIntent({
    requestId:'partial',planId:'plan-partial',projectId:'p1',environmentId:'e1',intent:'connect',source:'environment',
  });
  await waitFor(() => manager.snapshot('p1','e1').plugins.orders?.phase === 'connected' && pendingSignal);
  const cancelled = await manager.requestConnectionIntent({
    requestId:'cancel-partial',projectId:'p1',environmentId:'e1',intent:'cancel',source:'environment',planId:'plan-partial',
  });
  const result = await connecting;

  assert.equal(cancelled.outcome,'cancelled');
  assert.equal(result.outcome,'cancelled');
  assert.equal(pendingSignal.aborted,true);
  assert.equal(manager.snapshot('p1','e1').plugins.orders.phase,'connected');
  assert.notEqual(manager.snapshot('p1','e1').plugins.cache.phase,'connected');
});

test('cancelling one node leaves another independent node in the same plan running', async () => {
  const cancelledNode = plugin('orders');
  const successfulNode = plugin('cache','redis');
  let releaseCache;
  const cachePending = new Promise((resolve) => { releaseCache = resolve; });
  const manager = fixture([cancelledNode,successfulNode],{
    connect:async (item,_secrets,{signal} = {}) => {
      if (item.pluginInstanceId === 'cache') {
        await cachePending;
        return {connectedAt:'now'};
      }
      await new Promise((_resolve,reject) => {
        signal.addEventListener('abort',() => reject(new AppError('CONNECT_CANCELLED','cancelled')),{once:true});
      });
      return {connectedAt:'never'};
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const connecting = manager.requestConnectionIntent({
    requestId:'node-cancel',planId:'plan-node-cancel',projectId:'p1',environmentId:'e1',intent:'connect',source:'environment',
  });
  await waitFor(() => manager.snapshot('p1','e1').plugins.orders?.operationId && manager.snapshot('p1','e1').plugins.cache?.operationId);
  const operationId = manager.snapshot('p1','e1').plugins.orders.operationId;
  const cancelled = await manager.requestConnectionIntent({
    requestId:'cancel-orders',planId:'plan-node-cancel',operationId,pluginInstanceId:'orders',projectId:'p1',environmentId:'e1',intent:'cancel',source:'plugin',
  });
  assert.equal(cancelled.outcome,'cancelled');
  releaseCache();
  const result = await connecting;

  assert.equal(result.snapshot.plugins.cache.phase,'connected');
  assert.notEqual(result.snapshot.plugins.orders.phase,'connected');
  assert.equal(result.outcome,'needs-action');
});

test('environment retry preserves plugins that the user manually disconnected', async () => {
  const orders = plugin('orders');
  const cache = plugin('cache','redis');
  const calls = [];
  const manager = fixture([orders,cache],{
    connect:async (item) => { calls.push(item.pluginInstanceId); return {connectedAt:'now'}; },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });
  await manager.connectPlugin('p1','e1','orders');
  assert.equal(manager.snapshot('p1','e1').plugins.cache.reason,'USER_DISCONNECTED');

  await manager.retryFailed('p1','e1',{source:'system'});

  assert.deepEqual(calls,['orders']);
  assert.equal(manager.snapshot('p1','e1').plugins.orders.phase,'connected');
  assert.equal(manager.snapshot('p1','e1').plugins.cache.reason,'USER_DISCONNECTED');
});

test('an edit restore plan connects only the exact pre-edit set plus required providers', async () => {
  const provider = plugin('server','server');
  const restoredLeaf = plugin('orders','mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'server'}});
  const unrelated = plugin('cache','redis');
  const calls = [];
  const manager = fixture([provider,restoredLeaf,unrelated],{
    connect:async (item) => { calls.push(item.pluginInstanceId); return {connectedAt:'now'}; },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const result = await manager.requestConnectionIntent({
    requestId:'restore-request',planId:'restore-plan',projectId:'p1',environmentId:'e1',
    pluginInstanceIds:['orders'],intent:'connect',source:'edit-cancel-restore',
  });

  assert.equal(result.outcome,'started');
  assert.deepEqual(calls,['server','orders']);
  assert.equal(result.snapshot.plugins.orders.phase,'connected');
  assert.notEqual(result.snapshot.plugins.cache.phase,'connected');
});

test('stale operation ids cannot cancel a newer owner and force cancel terminates all current subscribers', async () => {
  const target = plugin('orders');
  const signals = [];
  const manager = fixture([target],{
    connect:async (_item,_secrets,{signal} = {}) => {
      signals.push(signal);
      await new Promise((resolve,reject) => {
        signal.addEventListener('abort',() => reject(Object.assign(new Error('cancelled'),{code:'CONNECT_CANCELLED'})),{once:true});
      });
      return {connectedAt:'never'};
    },
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });

  const first = manager.requestConnectionIntent({
    requestId:'first',planId:'plan-first',projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',intent:'connect',source:'plugin',
  });
  await waitFor(() => manager.snapshot('p1','e1').plugins.orders?.operationId);
  const firstRuntime = manager.snapshot('p1','e1').plugins.orders;
  const staleOperationId = firstRuntime.operationId;
  assert.equal(firstRuntime.planId,'plan-first');
  assert.equal(firstRuntime.generation,1);
  assert.match(firstRuntime.digest,/^[a-f0-9]{64}$/u);
  await manager.requestConnectionIntent({
    requestId:'cancel-first',planId:'plan-first',operationId:staleOperationId,projectId:'p1',environmentId:'e1',intent:'cancel',source:'plugin',
  });
  await first;
  await waitFor(() => manager.connectionOperations?.size === 0);

  const second = manager.requestConnectionIntent({
    requestId:'second',planId:'plan-second',projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',intent:'connect',source:'plugin',
  });
  await waitFor(() => signals.length === 2 && manager.snapshot('p1','e1').plugins.orders?.operationId !== staleOperationId);
  const currentOperationId = manager.snapshot('p1','e1').plugins.orders.operationId;
  assert.equal(manager.snapshot('p1','e1').plugins.orders.generation,2);
  const staleCancel = await manager.requestConnectionIntent({
    requestId:'stale-cancel',planId:'plan-first',operationId:staleOperationId,projectId:'p1',environmentId:'e1',intent:'cancel',source:'plugin',
  });
  assert.equal(staleCancel.outcome,'blocked');
  assert.equal(signals[1].aborted,false);

  const forced = await manager.requestConnectionIntent({
    requestId:'force-current',operationId:currentOperationId,projectId:'p1',environmentId:'e1',intent:'cancel',source:'plugin',force:true,
  });
  assert.equal(forced.outcome,'cancelled');
  assert.equal(signals[1].aborted,true);
  assert.equal((await second).outcome,'cancelled');
});

test('IPC exposes the unified command and keeps legacy channels as snapshot wrappers', async () => {
  const handlers = new Map();
  const calls = [];
  const snapshot = {projectId:'p1',environmentId:'e1',phase:'connected',plugins:{}};
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore:{},
    connectionManager:{
      on:() => undefined,
      requestConnectionIntent:async (payload) => {
        calls.push(payload);
        return {outcome:'started',planId:payload.planId ?? 'generated',operationId:null,actions:[],snapshot};
      },
    },
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
  });

  const unified = await handlers.get('v2:connection-intent')({}, {
    requestId:'request-unified',planId:'plan-unified',projectId:'p1',environmentId:'e1',intent:'connect',source:'test',
  });
  const legacy = await handlers.get('v2:environment-connect')({}, {
    projectId:'p1',environmentId:'e1',expectedRevision:3,
  });

  assert.equal(unified.ok,true);
  assert.equal(unified.data.planId,'plan-unified');
  assert.deepEqual(legacy,{ok:true,data:snapshot});
  assert.deepEqual(calls.map((payload) => payload.intent),['connect','connect']);
  assert.equal(calls[1].source,'legacy-environment');
});

test('completed intent histories are bounded without evicting active ownership', async () => {
  const target = plugin('orders');
  const manager = fixture([target],{
    connect:async () => ({connectedAt:'now'}),
    disconnect:async () => ({connected:false}),
    closeAll:async () => undefined,
  });
  for (let index = 0; index < 520; index += 1) {
    await manager.requestConnectionIntent({
      requestId:`history-request-${index}`,
      planId:`history-plan-${index}`,
      projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',intent:'connect',source:'test',
    });
  }

  assert.ok(manager.connectionPlans.size <= 512);
  assert.ok(manager.connectionIntentCoordinator.requests.size <= 512);
  assert.equal(manager.snapshot('p1','e1').plugins.orders.phase,'connected');
});
