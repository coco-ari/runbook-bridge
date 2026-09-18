import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { withReferencedDeadline } from './helpers/referenced-deadline.mjs';

function plugin(id, type, transport = { kind: 'direct' }) { return { projectId:'p1',environmentId:'e1',pluginInstanceId:id,pluginType:type,displayName:id,revision:1,configState:'ready',transport }; }

test('environment connection honors tunnel dependencies and preserves successful plugins on partial failure', async () => {
  const server=plugin('server','server'); const mysql=plugin('mysql','mysql',{kind:'serverTunnel',serverPluginInstanceId:'server'}); const redis=plugin('redis','redis');
  const plugins=[server,mysql,redis]; const calls=[];
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>plugins,getPlugin:async(_p,_e,id)=>plugins.find((x)=>x.pluginInstanceId===id),appendAudit:async()=>{}};
  const runtime={connect:async(p)=>{calls.push(`start:${p.pluginInstanceId}`);if(p===server)await new Promise(r=>setTimeout(r,20));if(p===mysql)throw Object.assign(new Error('auth'),{code:'AUTHENTICATION_FAILED'});calls.push(`end:${p.pluginInstanceId}`);return{connectedAt:'now'};},disconnect:async()=>{},closeAll:async()=>{}};
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  const published=[];
  manager.on('changed',(state)=>published.push(state));
  const result=await manager.connect('p1','e1');
  assert.equal(result.phase,'partial');assert.equal(result.connectedCount,2);assert.equal(result.plugins.mysql.phase,'error');assert.equal(result.plugins.mysql.retryable,false);
  const connecting=published.find((state)=>state.phase==='connecting');
  assert.equal(connecting.eligibleCount,3,'connecting state must publish the real denominator before any plugin finishes');
  assert.equal(connecting.connectedCount,0);
  assert.ok(calls.indexOf('start:mysql')>calls.indexOf('end:server'),'tunnel database starts after its provider is connected');
  assert.equal(manager.snapshot('p1','e1').desiredConnected,true);
  await manager.disconnect('p1','e1');assert.equal(manager.snapshot('p1','e1').desiredConnected,false);
});

test('opening or inspecting an environment never connects it', () => {
  const manager=new EnvironmentConnectionManager({},{});
  const state=manager.snapshot('p1','e1');
  assert.equal(state.phase,'disconnected');assert.equal(state.desiredConnected,false);
});

test('status reports saved ready plugins without opening network connections', async () => {
  const server=plugin('server','server');
  const draft={...plugin('mysql','mysql'),pluginInstanceId:'draft',configState:'draft'};
  let connectCalls=0;
  const store={listPlugins:async()=>[server,draft]};
  const runtime={connect:async()=>{connectCalls+=1;}};
  const manager=new EnvironmentConnectionManager(store,runtime);
  const state=await manager.status('p1','e1');
  assert.equal(state.phase,'disconnected');
  assert.equal(state.desiredConnected,false);
  assert.equal(state.eligibleCount,1);
  assert.equal(state.draftCount,1);
  assert.equal(state.plugins.server.phase,'disconnected');
  assert.equal(state.plugins.draft.reason,'PLUGIN_CONFIG_INCOMPLETE');
  assert.equal(connectCalls,0);
});

test('a new application runtime never restores a previous connection intent', async () => {
  const server=plugin('server','server');
  let connectCalls=0;
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>[server],getPlugin:async()=>server,appendAudit:async()=>{}};
  const runtime={connect:async()=>{connectCalls++;return{connectedAt:'now'};},disconnect:async()=>{},closeAll:async()=>{}};
  const first=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  await first.connect('p1','e1');
  assert.equal(first.snapshot('p1','e1').desiredConnected,true);
  const restarted=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  const state=restarted.snapshot('p1','e1');
  assert.equal(state.phase,'disconnected');
  assert.equal(state.desiredConnected,false);
  assert.equal(connectCalls,1,'constructing or inspecting the restarted runtime must not open a connection');
});

test('cancel changes connection intent immediately and fences a late connect result', async () => {
  const server=plugin('server','server');
  let release;
  const pending=new Promise((resolve)=>{release=resolve;});
  let disconnects=0;
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>[server],getPlugin:async()=>server,appendAudit:async()=>{}};
  const runtime={connect:async()=>{await pending;return{connectedAt:'late'};},disconnect:async()=>{disconnects+=1;},closeAll:async()=>{}};
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  const connecting=manager.connect('p1','e1');
  while(manager.snapshot('p1','e1').phase!=='connecting') await new Promise((resolve)=>setTimeout(resolve,1));
  const cancelled=manager.cancel('p1','e1');
  assert.equal(cancelled.desiredConnected,false);
  assert.equal(cancelled.phase,'disconnecting');
  release();
  await connecting;
  for(let index=0;index<50&&manager.snapshot('p1','e1').phase!=='disconnected';index+=1) await new Promise((resolve)=>setTimeout(resolve,2));
  assert.equal(manager.snapshot('p1','e1').phase,'disconnected');
  assert.ok(disconnects>=1);
});

test('single plugin controls connect tunnel dependencies and preserve manual disconnects', async () => {
  const server=plugin('server','server');
  const mysql=plugin('mysql','mysql',{kind:'serverTunnel',serverPluginInstanceId:'server'});
  const redis=plugin('redis','redis');
  const plugins=[server,mysql,redis];
  const calls=[];
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>plugins,getPlugin:async(_p,_e,id)=>plugins.find((item)=>item.pluginInstanceId===id),appendAudit:async()=>{}};
  const runtime={connect:async(item)=>{calls.push(`connect:${item.pluginInstanceId}`);return{connectedAt:'now'};},disconnect:async(item)=>{calls.push(`disconnect:${item.pluginInstanceId}`);},closeAll:async()=>{}};
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  const connected=await manager.connectPlugin('p1','e1','mysql');
  assert.deepEqual(calls.slice(0,2),['connect:server','connect:mysql']);
  assert.equal(connected.phase,'connected','a deliberately selected subset is healthy, not partially failed');
  assert.equal(connected.errorCount,0);
  assert.equal(connected.blockedCount,0);
  assert.equal(connected.plugins.mysql.phase,'connected');
  assert.equal(connected.plugins.redis.reason,'USER_DISCONNECTED');
  const disconnected=await manager.disconnectPlugin('p1','e1','server');
  assert.ok(calls.indexOf('disconnect:mysql')<calls.indexOf('disconnect:server'));
  assert.equal(disconnected.plugins.mysql.reason,'USER_DISCONNECTED');
  assert.equal(disconnected.desiredConnected,false);
});

test('a stalled single-plugin connection times out and releases the environment queue', async () => {
  const mysql={...plugin('mysql','mysql'),limits:{timeoutMs:5000}};
  const plugins=[mysql];
  let connectCalls=0;
  let disconnectCalls=0;
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>plugins,getPlugin:async()=>mysql,appendAudit:async()=>{}};
  const runtime={
    connect:async()=>{ connectCalls+=1; return new Promise(()=>{}); },
    disconnect:async()=>{ disconnectCalls+=1; },
    closeAll:async()=>{},
  };
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays:[],connectDeadlineMs:20});
  const failed=await withReferencedDeadline(()=>manager.connectPlugin('p1','e1','mysql'));
  assert.equal(failed.phase,'failed');
  assert.equal(failed.plugins.mysql.phase,'error');
  assert.equal(failed.plugins.mysql.reason,'CONNECT_TIMEOUT');
  assert.equal(connectCalls,1);

  const disconnected=await manager.disconnectPlugin('p1','e1','mysql');
  assert.equal(disconnected.phase,'disconnected','the timeout must release the environment queue');
  assert.equal(disconnectCalls,1);
});

test('正式连接的状态摘要可供 Agent 使用，断开后恢复不可用', async () => {
  const server = {...plugin('server','server'),target:{host:'example.invalid',port:22,addressFamily:'ipv4Only'},auth:{type:'password',username:'fixture'},uplink:{type:'direct'},tunnelProvider:true,policy:{status:'auto'},limits:{timeoutMs:1000}};
  const store = {getEnvironment:async()=>({revision:1}),listPlugins:async()=>[server],getPlugin:async()=>server,appendAudit:async()=>{}};
  const runtime = {connect:async()=>({connectedAt:'fixture'}),disconnect:async()=>{},closeAll:async()=>{}};
  const manager = new EnvironmentConnectionManager(store,runtime,{retryDelays:[]});
  assert.equal((await manager.status('p1','e1')).plugins.server.assessment.agent.availability,'unavailable');
  const connected = await manager.connect('p1','e1');
  assert.equal(connected.plugins.server.assessment.runtime.phase,'connected');
  assert.equal(connected.plugins.server.assessment.agent.availability,'ready');
  assert.deepEqual(connected.plugins.server.assessment.agent.issues,[]);
  await manager.disconnect('p1','e1');
  assert.equal((await manager.status('p1','e1')).plugins.server.assessment.agent.availability,'unavailable');
});

async function reconnectFixture(t, retryDelays) {
  const server=plugin('server','server');
  let failure=null;
  let attempts=0;
  const store={getEnvironment:async()=>({revision:1}),listPlugins:async()=>[server],getPlugin:async()=>server,appendAudit:async()=>{}};
  const runtime={connect:async()=>{attempts++;if(failure)throw Object.assign(new Error('模拟连接故障'),{code:failure});return{connectedAt:'now'};},disconnect:async()=>{},closeAll:async()=>{}};
  const manager=new EnvironmentConnectionManager(store,runtime,{retryDelays});
  t.after(()=>manager.closeAll());
  await manager.connect('p1','e1');
  return {manager,fail:code=>{failure=code;},attempts:()=>attempts};
}
async function waitForReconnect(check) {
  for(let index=0;index<500;index++) {
    if(check())return;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  assert.fail('重连状态未在预期时间内到达');
}

test('自动重连发布真实等待时间、执行次数和耗尽状态', async (t) => {
  const f=await reconnectFixture(t,[15,20]);
  f.fail('ROUTE_UNAVAILABLE');
  const snapshots=[];
  f.manager.on('changed',snapshot=>snapshots.push(snapshot));
  await f.manager.pluginLost('p1','e1','server',Object.assign(new Error('模拟断线'),{code:'ROUTE_UNAVAILABLE'}));
  const waiting=f.manager.snapshot('p1','e1').reconnect;
  assert.equal(waiting.phase,'waiting');
  assert.equal(waiting.attempt,1);
  assert.equal(waiting.maxAttempts,2);
  assert.ok(waiting.nextRetryAt>0);
  assert.deepEqual(waiting.pluginInstanceIds,['server']);
  await waitForReconnect(()=>f.manager.snapshot('p1','e1').reconnect?.phase==='exhausted');
  assert.equal(f.attempts(),3);
  assert.equal(f.manager.snapshot('p1','e1').reconnect.attempt,2);
  assert.equal(f.manager.snapshot('p1','e1').reconnect.nextRetryAt,null);
  assert.deepEqual(snapshots.filter(item=>item.reconnect?.phase==='waiting').map(item=>item.reconnect.attempt),[1,2]);
  assert.ok(snapshots.some(item=>item.reconnect?.phase==='connecting'));
  assert.equal(f.manager.retryTimers.size,0);
});

test('自动重连成功清理进度，认证错误立即停止后续重试', async (t) => {
  for(const code of [null,'SSH_AUTH_FAILED','SSH_HOST_KEY_CHANGED']) {
    await t.test(String(code),async child=>{
      const f=await reconnectFixture(child,[5,10]);
      f.fail(code);
      await f.manager.pluginLost('p1','e1','server');
      await waitForReconnect(()=>f.attempts()===2 && !f.manager.snapshot('p1','e1').reconnect);
      await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(f.attempts(),2);
      assert.equal(f.manager.snapshot('p1','e1').plugins.server.phase,code?'error':'connected');
    });
  }
});

test('主动断开取消重试倒计时，恢复计数不会重新建立连接', async (t) => {
  const f=await reconnectFixture(t,[40,50]);
  f.fail('ROUTE_UNAVAILABLE');
  await f.manager.pluginLost('p1','e1','server');
  await f.manager.disconnect('p1','e1');
  assert.equal(f.manager.snapshot('p1','e1').reconnect,null);
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(f.attempts(),1);
});
