import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginValidationRuntime } from '../src/plugin-validation-runtime.mjs';

function mysqlDraft() {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'diagnostic-edit-operation-1',
    pluginType:'mysql',displayName:'MySQL draft',configState:'ready',revision:1,
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    limits:{timeoutMs:1000,maxRows:100},
  };
}

test('temporary validation connects and cleans only its diagnostic namespace without a formal manager snapshot', async () => {
  const calls = [];
  const pluginManager = {
    connect:async (plugin,secrets,options) => { calls.push(['connect',plugin.pluginInstanceId,secrets,options.attemptToken]); return {connected:true}; },
    health:async (plugin) => { calls.push(['health',plugin.pluginInstanceId]); return {connected:true}; },
    forceDisconnect:async (plugin,reason,options) => { calls.push(['cleanup',plugin.pluginInstanceId,reason,options.attemptToken]); },
  };
  const runtime = new PluginValidationRuntime({pluginManager,mysqlRuntime:{}});
  const draft = mysqlDraft();
  const result = await runtime.validate({
    pluginType:'mysql',draft,purpose:'resource-access',resolvedSecrets:{password:'temporary'},
    signal:new AbortController().signal,editSessionId:'edit-1',operationId:'operation-1',
    draftGeneration:2,configDigest:'a'.repeat(64),
  });
  await runtime.cleanup(draft,'validation-complete','operation-1');

  assert.equal(result.connected,true);
  assert.deepEqual(calls.map((item) => item[0]),['connect','health','cleanup']);
  assert.ok(calls.every((item) => item[1] === 'diagnostic-edit-operation-1'));
});

test('resource discovery uses the MySQL discovery path and preserves correlation metadata', async () => {
  let received;
  const runtime = new PluginValidationRuntime({
    pluginManager:{forceDisconnect:async () => undefined},
    mysqlRuntime:{listDatabases:async (draft,secrets,options) => {
      received = {draft,secrets,options};
      return {databases:['orders'],truncated:false};
    }},
  });
  const draft = mysqlDraft();
  const result = await runtime.validate({
    pluginType:'mysql',draft,purpose:'resource-discovery',resolvedSecrets:{password:'temporary'},
    signal:new AbortController().signal,editSessionId:'edit-1',operationId:'operation-2',
    draftGeneration:3,configDigest:'b'.repeat(64),
  });

  assert.deepEqual(result,{databases:['orders'],truncated:false});
  assert.equal(received.options.operationId,'operation-2');
  assert.equal(received.options.editSessionId,'edit-1');
  assert.equal(received.options.draftGeneration,3);
  assert.equal(received.options.configDigest,'b'.repeat(64));
});

test('cleanup force-fences a pending driver that ignores AbortSignal before its late result arrives', async () => {
  let release;
  const calls = [];
  const pending = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const draft = mysqlDraft();
  const runtime = new PluginValidationRuntime({
    pluginManager:{
      connect:async () => pending,
      health:async () => { calls.push('health'); return {connected:true}; },
      forceDisconnect:async (_plugin,reason,{attemptToken}) => calls.push(['cleanup',reason,attemptToken]),
    },
    mysqlRuntime:{},
  });
  const validating = runtime.validate({
    pluginType:'mysql',draft,purpose:'health-check',resolvedSecrets:{password:'temporary'},
    signal:controller.signal,editSessionId:'edit-1',operationId:'operation-late',
    draftGeneration:4,configDigest:'c'.repeat(64),
  });
  controller.abort();
  await runtime.cleanup(draft,'validation-cancelled','operation-late');
  release({connected:true});

  await assert.rejects(validating,(error) => error.code === 'PLUGIN_VALIDATION_CANCELLED');
  assert.deepEqual(calls,[['cleanup','validation-cancelled','operation-late']]);
});
