import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerRedisEditIpc } from '../src/redis-edit-ipc.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { AppError } from '../src/errors.mjs';
import { OperationGate } from '../src/operation-gate.mjs';
const scope={projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-redis'};

test('Redis编辑 IPC 仅接受受信任桌面主框架，并在导航后作废旧窗口任务',async()=>{
  const handlers=new Map(),closed=[],calls=[];
  let trusted=true,hold,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const services={isWorkspaceRenderer:()=>trusted,v2Service:{redisEditor:{closeOwner:owner=>closed.push(owner)},invokeDesktopRedisEdit:async(owner,payload,operation,assertOwner)=>{
    calls.push({owner,payload,operation});assertOwner();
    if(operation==='open'){started();await new Promise(resolve=>{hold=resolve;});assertOwner();}
    return {released:true};
  }}};
  registerRedisEditIpc({handle:(name,fn)=>handlers.set(name,fn)},services);
  const sender=new EventEmitter();Object.assign(sender,{id:42,mainFrame:{},isDestroyed:()=>false});
  const event={sender,senderFrame:sender.mainFrame},payload={...scope,patternId:'fixture',key:'fixture:key',mode:'update'};
  const open=handlers.get('v2:redis-edit-open');
  assert.equal((await open({...event,senderFrame:{}},payload)).error.code,'WORKSPACE_ACCESS_DENIED');
  trusted=false;assert.equal((await open(event,payload)).error.code,'WORKSPACE_ACCESS_DENIED');trusted=true;
  assert.equal(calls.length,0);
  const pending=open(event,payload);await waiting;
  sender.emit('did-start-navigation',{},'file://fixture',false,true);hold();
  assert.equal((await pending).error.code,'REDIS_EDIT_STALE');
  assert.deepEqual(closed,['renderer:42']);
});

test('桌面编辑服务核验连接、配置和完整作用域，状态查询可在断连后核实',async()=>{
  const plugin={...scope,pluginType:'redis',configState:'ready',target:{host:'redis.fixture.invalid',port:6379,db:0,addressFamily:'ipv4Only'},auth:{username:'fixture'},transport:{kind:'direct'},tls:{mode:'required'},patterns:[{patternId:'fixture',pattern:'fixture:*'}],limits:{maxKeys:100,maxValueBytes:65536,timeoutMs:3000},revision:1};
  const calls=[];
  let connected=true,stable=true;
  const receiver={workspaceStore:{getPlugin:async()=>plugin},connectionManager:{assertConfigurationStable(){if(!stable)throw new AppError('CONFIGURATION_CHANGED','配置变化');}},
    assertPluginConnected(){if(!connected)throw new AppError('PLUGIN_NOT_CONNECTED','未连接');},
    redisEditor:{open:async()=>{calls.push('open');return {};},status:()=>{calls.push('status');return {};}}};
  const invoke=(operation,payload)=>V2Service.prototype.invokeDesktopRedisEdit.call(receiver,'fixture-window',{...scope,...payload},operation);
  connected=false;
  await assert.rejects(invoke('open',{patternId:'fixture',key:'fixture:key',mode:'update'}),{code:'PLUGIN_NOT_CONNECTED'});
  await invoke('status',{editId:'11111111-1111-1111-1111-111111111111',planId:'22222222-2222-2222-2222-222222222222'});
  connected=true;stable=false;
  await assert.rejects(invoke('open',{patternId:'fixture',key:'fixture:key',mode:'update'}),{code:'CONFIGURATION_CHANGED'});
  stable=true;plugin.environmentId='other';
  await assert.rejects(invoke('open',{patternId:'fixture',key:'fixture:key',mode:'update'}),{code:'SCOPE_MISMATCH'});
  assert.deepEqual(calls,['status']);
});

test('Agent Redis写入能力继续被操作策略拒绝',()=>{
  const gate=new OperationGate();
  assert.throws(()=>gate.authorize({plugin:{...scope,pluginType:'redis',agent:{}},capability:'set',args:{key:'fixture:key',value:'value'},origin:'agent'}));
});
