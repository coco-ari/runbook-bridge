import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { CredentialUseResolver } from '../src/credential-use-resolver.mjs';
import { PluginProbeManager } from '../src/plugin-probe-manager.mjs';
import { PluginValidationRuntime } from '../src/plugin-validation-runtime.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

function mysqlDraft(overrides = {}) {
  return {
    pluginType:'mysql',displayName:'Orders',
    target:{host:'db.internal',port:3306,database:'',addressFamily:'ipv4Only'},
    auth:{username:'root'},transport:{kind:'direct'},tls:{mode:'disabled'},
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',formInstanceId:'form-1',requestId:'request-1',
    purpose:'resource-discovery',draftGeneration:2,sequence:4,
    draft:mysqlDraft(),temporarySecrets:{password:'temporary'},
    ...overrides,
  };
}

function fakeResolver(validate = async () => ({databases:['orders'],truncated:false})) {
  const calls = [];
  return {
    calls,
    value:{resolve:async (input) => {
      calls.push(input);
      return {source:Object.keys(input.temporarySecrets).length ? 'temporary' : 'none',secrets:{...input.temporarySecrets}};
    }},
    runtime:{validate,cleanup:async () => ({cleaned:true})},
  };
}

function manager({resolver,runtime,store = null,coordinator = null} = {}) {
  return new PluginProbeManager({
    workspaceStore:store ?? {getEnvironment:async () => ({projectId:'p1',environmentId:'e1'})},
    mutationCoordinator:coordinator ?? new WorkspaceMutationCoordinator(),
    credentialUseResolver:resolver,
    validationRuntime:runtime,
  });
}

test('resource discovery is transient, uses the diagnostic runtime, and never loads committed credentials', async () => {
  let vaultLoads = 0;
  let environmentReads = 0;
  const credentialUseResolver = new CredentialUseResolver({
    normalizeSecrets:(_plugin,secrets) => ({...secrets}),
    load:async () => { vaultLoads += 1; throw new Error('must not load'); },
  });
  const validationRuntime = new PluginValidationRuntime({
    pluginManager:{},
    mysqlRuntime:{listDatabases:async (draft,secrets,options) => {
      assert.match(draft.pluginInstanceId,/^diagnostic-edit-/u);
      assert.equal(secrets.password,'temporary');
      assert.equal(options.draftGeneration,2);
      return {databases:['orders','billing'],truncated:false};
    }},
  });
  const probe = manager({
    resolver:credentialUseResolver,
    runtime:validationRuntime,
    store:{getEnvironment:async () => { environmentReads += 1; return {projectId:'p1'}; }},
  });

  const result = await probe.probePluginDraft(payload(),{ownerId:'renderer:7'});

  assert.equal(result.state,'valid');
  assert.deepEqual(result.result,{databases:['orders','billing'],truncated:false});
  assert.deepEqual({
    projectId:result.projectId,environmentId:result.environmentId,
    formInstanceId:result.formInstanceId,requestId:result.requestId,
    purpose:result.purpose,draftGeneration:result.draftGeneration,sequence:result.sequence,
  },{
    projectId:'p1',environmentId:'e1',formInstanceId:'form-1',requestId:'request-1',
    purpose:'resource-discovery',draftGeneration:2,sequence:4,
  });
  assert.equal(typeof result.operationId,'string');
  assert.equal(result.configDigest.length,64);
  assert.equal(vaultLoads,0);
  assert.equal(environmentReads,1);
  assert.equal(validationRuntime.operations.size,0,'operation cleanup is complete before the response resolves');
});

test('a newer same-group request aborts its predecessor and starts only after predecessor cleanup', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];
  const values = fakeResolver(async ({requestId}) => {
    order.push(`validate:${requestId}`);
    if (requestId === 'request-1') await firstGate;
    return {databases:[requestId],truncated:false};
  });
  values.runtime.cleanup = async (_draft,_reason,operationId) => {
    order.push(`cleanup:${operationId}`);
    return {cleaned:true};
  };
  const probe = manager({resolver:values.value,runtime:values.runtime});
  const progress = [];
  const first = probe.probePluginDraft(payload(),{
    ownerId:'renderer:7',onProgress:(value) => progress.push(value),
  });
  const rejected = assert.rejects(first,(error) => error.code === 'PLUGIN_VALIDATION_STALE');
  await new Promise((resolve) => setImmediate(resolve));

  const second = probe.probePluginDraft(payload({requestId:'request-2',sequence:5}),{
    ownerId:'renderer:7',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order,['validate:request-1']);
  assert.equal(progress.at(-1).state,'stale');

  releaseFirst();
  await rejected;
  const result = await second;
  const firstCleanup = order.findIndex((item) => item.startsWith('cleanup:'));
  assert.ok(firstCleanup >= 0);
  assert.ok(firstCleanup < order.indexOf('validate:request-2'));
  assert.equal(result.result.databases[0],'request-2');
});

test('cancel is owner-bound, can verify form identity, and owner invalidation aborts all owned probes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const values = fakeResolver(async () => { await gate; return {connected:true}; });
  const probe = manager({resolver:values.value,runtime:values.runtime});
  const running = probe.probePluginDraft(payload({purpose:'tls-probe'}),{ownerId:'renderer:7'});
  const rejected = assert.rejects(running,(error) => (
    error.code === 'PLUGIN_VALIDATION_CANCELLED'
      && error.details.formInstanceId === 'form-1'
      && error.details.sequence === 4
  ));
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => probe.cancelPluginProbe({requestId:'request-1'},{ownerId:'renderer:8'}),
    (error) => error.code === 'PLUGIN_VALIDATION_STALE',
  );
  assert.throws(
    () => probe.cancelPluginProbe({requestId:'request-1',formInstanceId:'another-form'},{ownerId:'renderer:7'}),
    (error) => error.code === 'PLUGIN_VALIDATION_STALE',
  );
  assert.equal(probe.invalidateOwner('renderer:7'),1);
  release();
  await rejected;
});

test('SSH host-key challenge preserves the safe fingerprint and complete correlation context', async () => {
  const observed = 'SHA256:observed';
  const values = fakeResolver(async () => {
    throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','需要确认 SSH 主机指纹。',{
      fingerprint:observed,algorithm:'ssh-ed25519',host:'server.internal',port:22,
    });
  });
  const probe = manager({resolver:values.value,runtime:values.runtime});
  const serverDraft = {
    pluginType:'server',displayName:'Server',
    target:{host:'server.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'root'},uplink:{type:'direct'},
  };

  await assert.rejects(
    probe.probePluginDraft(payload({
      purpose:'server-auth',draft:serverDraft,temporarySecrets:{password:'temporary'},
    }),{ownerId:'renderer:7'}),
    (error) => {
      assert.equal(error.code,'SSH_HOST_KEY_CONFIRM_REQUIRED');
      assert.equal(error.details.fingerprint,observed);
      assert.equal(error.details.algorithm,'ssh-ed25519');
      assert.equal(error.details.projectId,'p1');
      assert.equal(error.details.environmentId,'e1');
      assert.equal(error.details.formInstanceId,'form-1');
      assert.equal(error.details.requestId,'request-1');
      assert.equal(error.details.sequence,4);
      assert.equal(error.details.state,'failed');
      return true;
    },
  );
});

test('probe rejects credential-reuse controls and secret-bearing draft fields', () => {
  const values = fakeResolver();
  const probe = manager({resolver:values.value,runtime:values.runtime});
  assert.throws(
    () => probe.probePluginDraft(payload({credentialIntent:'rebind-existing'}),{ownerId:'renderer:7'}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => probe.probePluginDraft(payload({draft:mysqlDraft({password:'embedded'})}),{ownerId:'renderer:7'}),
    (error) => error.code === 'INVALID_ARGUMENT' && error.details.field === 'password',
  );
});

test('probe enforces an explicit plugin capability matrix', () => {
  const values = fakeResolver();
  const probe = manager({resolver:values.value,runtime:values.runtime});
  const serverDraft = {
    pluginType:'server',displayName:'Server',target:{host:'server.internal',port:22},
    auth:{type:'password',username:'root'},uplink:{type:'direct'},
  };
  const redisDraft = {
    pluginType:'redis',displayName:'Cache',target:{host:'redis.internal',port:6379,db:0},
    auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},
  };
  for (const value of [
    payload({purpose:'server-auth'}),
    payload({purpose:'resource-access',draft:serverDraft}),
    payload({purpose:'tls-probe',draft:serverDraft}),
    payload({purpose:'resource-discovery',draft:redisDraft}),
    payload({purpose:'server-auth',draft:redisDraft}),
  ]) {
    assert.throws(
      () => probe.probePluginDraft(value,{ownerId:'renderer:7'}),
      (error) => error.code === 'PLUGIN_VALIDATION_UNAVAILABLE',
    );
  }
});
