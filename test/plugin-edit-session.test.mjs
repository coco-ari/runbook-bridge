import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { PluginEditSessionManager } from '../src/plugin-edit-session-manager.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve,milliseconds));

function plugin(id,type = 'mysql',overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:id,pluginType:type,displayName:id,
    revision:1,updatedAt:'2026-01-01T00:00:00.000Z',configState:'ready',
    target:type === 'server'
      ? {host:'server.internal',port:22,addressFamily:'ipv4Only'}
      : type === 'mysql'
        ? {host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Only'}
        : {host:'cache.internal',port:6379,db:0,addressFamily:'ipv4Only'},
    auth:type === 'server' ? {type:'password',username:'root'} : {username:'app'},
    transport:{kind:'direct'},
    tls:type === 'server' ? undefined : {mode:'disabled'},
    ...overrides,
  };
}

async function waitFor(predicate,message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail(message);
}

function fixture({plugins = [plugin('orders')],runtime = null,validationRuntime = null,credentialUseResolver:providedCredentialUseResolver = null,drainTimeoutMs = 100} = {}) {
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  const byId = new Map(plugins.map((item) => [item.pluginInstanceId,item]));
  let snapshot = runtime ?? {
    projectId:'p1',environmentId:'e1',phase:'connected',desiredConnected:true,sequence:1,
    plugins:Object.fromEntries(plugins.map((item) => [item.pluginInstanceId,{phase:'connected'}])),
  };
  const disconnects = [];
  const planRequests = [];
  const store = {
    getPlugin:async (_projectId,_environmentId,id) => structuredClone(byId.get(id)),
    listPlugins:async () => [...byId.values()].map((item) => structuredClone(item)),
  };
  const connectionManager = {
    snapshot:() => structuredClone(snapshot),
    activeConnectionOperations:() => [],
    waitForConnectionOperations:async () => ({drained:true}),
    disconnectForConfigurationEdit:async (_projectId,_environmentId,affected,{ownerId}) => {
      disconnects.push([...affected]);
      mutationCoordinator.assertEnvironmentAvailable('p1','e1',{ownerId});
      const connectedBefore = affected.filter((id) => snapshot.plugins[id]?.phase === 'connected');
      for (const id of affected) snapshot.plugins[id] = {phase:'disconnected',reason:'CONFIGURATION_EDIT'};
      snapshot = {...snapshot,phase:'disconnected',desiredConnected:false,sequence:snapshot.sequence + 1};
      return {snapshot:structuredClone(snapshot),connectedBefore};
    },
    requestConnectionIntent:(payload) => {
      planRequests.push(payload);
      const fence = mutationCoordinator.environmentFence('p1','e1');
      assert.equal(fence.kind,'connection-plan');
      assert.equal(fence.ownerId,payload.planId);
      payload.onPlanStarted?.({planId:payload.planId});
      return Promise.resolve({outcome:'started',planId:payload.planId,operationId:null,actions:[],snapshot:structuredClone(snapshot)});
    },
  };
  const resolvedSecrets = [];
  const credentialUseResolver = providedCredentialUseResolver ?? {
    resolve:async (input) => {
      resolvedSecrets.push(input);
      return {source:Object.keys(input.temporarySecrets ?? {}).length ? 'temporary' : 'saved',secrets:{...(input.temporarySecrets ?? {})}};
    },
    revokeSession:() => undefined,
  };
  const manager = new PluginEditSessionManager({
    workspaceStore:store,
    connectionManager,
    mutationCoordinator,
    credentialUseResolver,
    validationRuntime:validationRuntime ?? {validate:async () => ({ok:true}),cleanup:async () => undefined},
    drainTimeoutMs,
  });
  return {manager,store,connectionManager,mutationCoordinator,byId,disconnects,planRequests,resolvedSecrets,getSnapshot:() => snapshot};
}

test('begin installs the edit fence before draining existing Agent work and disconnects the exact affected set afterward', async () => {
  const server = plugin('server','server');
  const orders = plugin('orders','mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'server'}});
  const values = fixture({plugins:[server,orders]});
  let releaseReader;
  const reader = values.mutationCoordinator.runEnvironmentOperation('p1','e1',async () => {
    await new Promise((resolve) => { releaseReader = resolve; });
  });
  const prepared = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',expectedRevision:1,
  });
  const beginning = values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  await waitFor(() => values.mutationCoordinator.environmentFence('p1','e1'));

  await assert.rejects(
    () => values.mutationCoordinator.runEnvironmentOperation('p1','e1',async () => undefined),
    (error) => error.code === 'PLUGIN_EDIT_BUSY',
  );
  assert.equal(values.disconnects.length,0,'disconnect must wait until the pre-existing reader drains');
  releaseReader();
  await reader;
  const session = await beginning;

  assert.deepEqual(session.affectedIds,['orders','server']);
  assert.deepEqual(session.preEditConnectedSet,['orders','server']);
  assert.deepEqual(values.disconnects,[['orders','server']]);
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1').ownerId,session.editSessionId);
});

test('drain timeout releases the fence and leaves every formal connection untouched', async () => {
  const values = fixture({drainTimeoutMs:20});
  let releaseReader;
  const reader = values.mutationCoordinator.runEnvironmentOperation('p1','e1',async () => {
    await new Promise((resolve) => { releaseReader = resolve; });
  });
  const prepared = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1});

  await assert.rejects(
    () => values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken}),
    (error) => error.code === 'PLUGIN_EDIT_DRAIN_TIMEOUT',
  );
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1'),null);
  assert.equal(values.disconnects.length,0);
  assert.equal(values.getSnapshot().plugins.orders.phase,'connected');
  releaseReader();
  await reader;
});

test('begin rejects a stale prepare preview, releases its fence, and returns the refreshed impact', async () => {
  const values = fixture();
  const prepared = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1});
  values.byId.set('orders',{...values.byId.get('orders'),revision:2,displayName:'renamed'});

  await assert.rejects(
    () => values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken}),
    (error) => error.code === 'PLUGIN_EDIT_SESSION_STALE' && error.details?.preview?.baseRecordRevision === 2,
  );
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1'),null);
  assert.equal(values.disconnects.length,0);
});

test('validation cancel is immediate and a late ignored-abort result cannot replace the newer generation', async () => {
  const completions = [];
  const validationRuntime = {
    validate:({draftGeneration,signal}) => new Promise((resolve) => completions.push({draftGeneration,signal,resolve})),
    cleanup:async () => undefined,
  };
  const values = fixture({validationRuntime});
  const prepared = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1});
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  const first = values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,requestId:'first',purpose:'health-check',draftGeneration:0,
    draft:session.plugin,credentialIntent:'replace',temporarySecrets:{password:'temporary-only'},
  });
  await waitFor(() => completions.length === 1);
  const operationId = values.manager.sessionSummary(session.editSessionId).validationsByPurpose['health-check'].operationId;
  const cancelled = values.manager.cancelPluginValidation({editSessionId:session.editSessionId,operationId});
  assert.equal(cancelled.state,'cancelled');
  assert.equal(completions[0].signal.aborted,true);

  const second = values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,requestId:'second',purpose:'health-check',draftGeneration:1,
    draft:session.plugin,credentialIntent:'unchanged',temporarySecrets:{},
  });
  await waitFor(() => completions.length === 2);
  completions[1].resolve({validated:'new'});
  const accepted = await second;
  completions[0].resolve({validated:'late'});
  await assert.rejects(first,(error) => ['PLUGIN_VALIDATION_CANCELLED','PLUGIN_VALIDATION_STALE'].includes(error.code));

  assert.equal(accepted.result.validated,'new');
  assert.equal(accepted.draftGeneration,1);
  assert.equal(values.manager.sessionSummary(session.editSessionId).validationsByPurpose['health-check'].state,'valid');
  assert.equal(values.getSnapshot().sequence,2,'draft validation cannot publish a formal runtime snapshot');
  assert.equal(values.resolvedSecrets[0].temporarySecrets.password,'temporary-only');
});

test('cancel hands the edit fence directly to an exact restore plan and clears session secrets', async () => {
  const values = fixture();
  const prepared = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1});
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  await values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,requestId:'remember-secret',purpose:'health-check',draftGeneration:0,
    draft:session.plugin,credentialIntent:'replace',temporarySecrets:{password:'ephemeral'},
  });
  assert.equal(values.manager.sessionSummary(session.editSessionId).hasTemporarySecrets,true);

  const result = await values.manager.cancelPluginConnectionEdit({
    editSessionId:session.editSessionId,restorePreEditConnections:true,
  });

  assert.deepEqual(values.planRequests[0].pluginInstanceIds,['orders']);
  assert.equal(values.planRequests[0].fenceOwnerId,values.planRequests[0].planId);
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1'),null);
  assert.equal(values.manager.sessionSummary(session.editSessionId),null);
  assert.equal(result.connectionPlan.outcome,'started');
});

test('save failure returns the live session to editing without clearing temporary credentials', async () => {
  const values = fixture();
  const prepared = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1});
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  values.manager.captureCredentialIntent(session.editSessionId,{credentialIntent:'replace',temporarySecrets:{password:'retry-me'}});
  const saving = values.manager.beginSave(session.editSessionId);
  assert.equal(saving.phase,'saving');
  values.manager.saveFailed(session.editSessionId);

  const summary = values.manager.sessionSummary(session.editSessionId);
  assert.equal(summary.phase,'editing');
  assert.equal(summary.hasTemporarySecrets,true);
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1').ownerId,session.editSessionId);
});

test('prepare, begin, validation, and cancel enforce renderer session ownership', async () => {
  const values = fixture();
  const prepared = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1,ownerId:'window-a',
  });
  await assert.rejects(
    () => values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken,ownerId:'window-b'}),
    (error) => error.code === 'PLUGIN_EDIT_SESSION_STALE',
  );
  const refreshed = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1,ownerId:'window-a',
  });
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:refreshed.prepareToken,ownerId:'window-a'});
  await assert.rejects(
    () => values.manager.validatePluginDraft({
      editSessionId:session.editSessionId,ownerId:'window-b',requestId:'wrong-owner',
      purpose:'health-check',draftGeneration:0,draft:session.plugin,
    }),
    (error) => error.code === 'PLUGIN_EDIT_SESSION_STALE',
  );
  await assert.rejects(
    () => values.manager.cancelPluginConnectionEdit({editSessionId:session.editSessionId,ownerId:'window-b'}),
    (error) => error.code === 'PLUGIN_EDIT_SESSION_STALE',
  );
  assert.ok(values.manager.sessionSummary(session.editSessionId));
});

test('failed validation reports correlation metadata and keeps an observed host key only in the edit session', async () => {
  const observed = 'SHA256:temporary-host-key';
  let validationAttempt = 0;
  const values = fixture({
    plugins:[plugin('server','server')],
    validationRuntime:{
      validate:async () => {
        validationAttempt += 1;
        if (validationAttempt === 1) throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','confirm host key',{fingerprint:observed});
        return {connected:true};
      },
      cleanup:async () => undefined,
    },
  });
  const prepared = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server',expectedRevision:1,
  });
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});

  await assert.rejects(
    () => values.manager.validatePluginDraft({
      editSessionId:session.editSessionId,requestId:'host-key',purpose:'server-auth',
      draftGeneration:0,draft:session.plugin,credentialIntent:'replace',temporarySecrets:{password:'secret'},
    }),
    (error) => error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED'
      && error.details?.editSessionId === session.editSessionId
      && typeof error.details?.operationId === 'string'
      && error.details?.draftGeneration === 0
      && /^[a-f0-9]{64}$/u.test(error.details?.configDigest ?? ''),
  );
  assert.equal(values.manager.sessionSummary(session.editSessionId).temporaryHostKey.fingerprint,observed);

  await values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,requestId:'new-host',purpose:'server-auth',draftGeneration:1,
    draft:{...session.plugin,target:{...session.plugin.target,host:'new.internal'}},
    credentialIntent:'replace',temporarySecrets:{password:'secret'},
  });
  assert.equal(values.manager.sessionSummary(session.editSessionId).temporaryHostKey,null);
});

test('scope deletion invalidates editing sessions and secrets but cannot interrupt a pending save', async () => {
  const values = fixture();
  const prepared = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1,
  });
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});
  values.manager.captureCredentialIntent(session.editSessionId,{
    credentialIntent:'replace',temporarySecrets:{password:'temporary'},
  });
  values.manager.beginSave(session.editSessionId);

  assert.equal(values.manager.invalidatePlugin('p1','e1','orders'),0);
  assert.equal(values.manager.sessionSummary(session.editSessionId).phase,'saving');
  values.manager.saveFailed(session.editSessionId);
  assert.equal(values.manager.invalidatePlugin('p1','e1','orders'),1);
  assert.equal(values.manager.sessionSummary(session.editSessionId),null);
  assert.equal(values.mutationCoordinator.environmentFence('p1','e1'),null);
});

test('a stale SSH challenge cannot repopulate the host key after a newer draft validation',async () => {
  let rejectOld;
  const values = fixture({
    plugins:[plugin('server','server')],
    validationRuntime:{
      validate:async ({draftGeneration}) => {
        if (draftGeneration === 0) return new Promise((_resolve,reject) => { rejectOld = reject; });
        return {connected:true};
      },
      cleanup:async () => undefined,
    },
  });
  const preview = await values.manager.preparePluginConnectionEdit({projectId:'p1',environmentId:'e1',pluginInstanceId:'server',expectedRevision:1});
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:preview.prepareToken});
  const older = values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,purpose:'server-auth',draftGeneration:0,draft:session.plugin,
  });
  const rejected = assert.rejects(older,(error) => ['PLUGIN_VALIDATION_CANCELLED','PLUGIN_VALIDATION_STALE'].includes(error.code));
  await waitFor(() => rejectOld);
  await values.manager.validatePluginDraft({
    editSessionId:session.editSessionId,purpose:'server-auth',draftGeneration:1,
    draft:{...session.plugin,target:{...session.plugin.target,host:'new.invalid'}},
  });
  rejectOld(new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','Old host challenge.',{fingerprint:'SHA256:stale-key'}));
  await rejected;
  assert.equal(values.manager.sessionSummary(session.editSessionId).temporaryHostKey,null);
});

test('credential resolution failure completes the correlated validation operation without starting a runtime', async () => {
  let runtimeCalls = 0;
  const values = fixture({
    credentialUseResolver:{
      resolve:async () => { throw new AppError('CREDENTIAL_REBIND_REQUIRED','explicit rebind required'); },
      revokeSession:() => undefined,
    },
    validationRuntime:{
      validate:async () => { runtimeCalls += 1; },
      cleanup:async () => undefined,
    },
  });
  const prepared = await values.manager.preparePluginConnectionEdit({
    projectId:'p1',environmentId:'e1',pluginInstanceId:'orders',expectedRevision:1,
  });
  const session = await values.manager.beginPluginConnectionEdit({prepareToken:prepared.prepareToken});

  await assert.rejects(
    () => values.manager.validatePluginDraft({
      editSessionId:session.editSessionId,requestId:'credential-failure',purpose:'health-check',
      draftGeneration:0,draft:session.plugin,credentialIntent:'unchanged',temporarySecrets:{},
    }),
    (error) => error.code === 'CREDENTIAL_REBIND_REQUIRED'
      && typeof error.details?.operationId === 'string'
      && error.details?.editSessionId === session.editSessionId,
  );
  const validation = values.manager.sessionSummary(session.editSessionId).validationsByPurpose['health-check'];
  assert.equal(validation.state,'failed');
  assert.equal(runtimeCalls,0);
});
