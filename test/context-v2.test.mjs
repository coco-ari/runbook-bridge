import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentContextManager } from '../src/context-manager.mjs';

test('environment context binds runbook and exact plugin configuration', async () => {
  let hash='docs-1'; let revision=1;
  const plugin={projectId:'p1',environmentId:'e1',pluginInstanceId:'db1',pluginType:'mysql',revision:1};
  const store={getEnvironment:async()=>({projectId:'p1',environmentId:'e1',revision}),readRunbook:async()=>({content:'runbook',hash,empty:false}),listPlugins:async()=>[plugin],pluginBindingHash:(p)=>`plugin-${p.revision}`};
  const manager=new EnvironmentContextManager(store);
  const opened=await manager.open('p1','e1','test');
  assert.equal((await manager.verify('p1','e1','db1',opened.contextToken)).plugin.pluginInstanceId,'db1');
  hash='docs-2';
  await assert.rejects(()=>manager.verify('p1','e1','db1',opened.contextToken),(error)=>error.code==='CONTEXT_STALE');
});

