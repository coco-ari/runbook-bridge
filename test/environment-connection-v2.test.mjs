import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';

function plugin(id, type, transport = { kind: 'direct' }) { return { projectId:'p1',environmentId:'e1',pluginInstanceId:id,pluginType:type,displayName:id,revision:1,configState:'ready',transport }; }

test('environment connection honors tunnel dependencies and preserves successful plugins on partial failure', async () => {
  const server=plugin('server','server'); const mysql=plugin('mysql','mysql',{kind:'serverTunnel',serverPluginInstanceId:'server'}); const redis=plugin('redis','redis');
  const plugins=[server,mysql,redis]; const calls=[];
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>plugins,getPlugin:async(_p,_e,id)=>plugins.find((x)=>x.pluginInstanceId===id),appendAudit:async()=>{}};
  const runtime={connect:async(p)=>{calls.push(`start:${p.pluginInstanceId}`);if(p===server)await new Promise(r=>setTimeout(r,20));if(p===mysql)throw Object.assign(new Error('auth'),{code:'AUTHENTICATION_FAILED'});calls.push(`end:${p.pluginInstanceId}`);return{connectedAt:'now'};},disconnect:async()=>{},closeAll:async()=>{}};
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  const result=await manager.connect('p1','e1');
  assert.equal(result.phase,'partial');assert.equal(result.connectedCount,2);assert.equal(result.plugins.mysql.phase,'error');assert.equal(result.plugins.mysql.retryable,false);
  assert.ok(calls.indexOf('start:mysql')>calls.indexOf('end:server'),'tunnel database starts after its provider is connected');
  assert.equal(manager.snapshot('p1','e1').desiredConnected,true);
  await manager.disconnect('p1','e1');assert.equal(manager.snapshot('p1','e1').desiredConnected,false);
});

test('opening or inspecting an environment never connects it', () => {
  const manager=new EnvironmentConnectionManager({},{});
  const state=manager.snapshot('p1','e1');
  assert.equal(state.phase,'disconnected');assert.equal(state.desiredConnected,false);
});

