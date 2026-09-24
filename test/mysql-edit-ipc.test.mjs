import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerMysqlEditIpc } from '../src/mysql-edit-ipc.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { AppError } from '../src/errors.mjs';
import { OperationGate } from '../src/operation-gate.mjs';
const scope={projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-mysql'};

test('数据库编辑 IPC 仅接受受信任桌面主框架，并在导航后作废旧窗口任务',async()=>{
  const handlers=new Map(),closed=[],calls=[];
  let trusted=true,hold,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const services={isWorkspaceRenderer:()=>trusted,v2Service:{mysqlEditor:{closeOwner:owner=>closed.push(owner)},invokeDesktopMysqlEdit:async(owner,payload,operation,assertOwner)=>{
    calls.push({owner,payload,operation});assertOwner();
    if(operation==='open'){started();await new Promise(resolve=>{hold=resolve;});assertOwner();}
    return {released:true};
  }}};
  registerMysqlEditIpc({handle:(name,fn)=>handlers.set(name,fn)},services);
  const sender=new EventEmitter();Object.assign(sender,{id:42,mainFrame:{},isDestroyed:()=>false});
  const event={sender,senderFrame:sender.mainFrame},payload={...scope,sql:'SELECT * FROM items'};
  const open=handlers.get('v2:mysql-edit-open');
  assert.equal((await open({...event,senderFrame:{}},payload)).error.code,'WORKSPACE_ACCESS_DENIED');
  trusted=false;assert.equal((await open(event,payload)).error.code,'WORKSPACE_ACCESS_DENIED');trusted=true;
  assert.equal(calls.length,0);
  const pending=open(event,payload);await waiting;
  sender.emit('did-start-navigation',{},'file://fixture',false,true);hold();
  assert.equal((await pending).error.code,'MYSQL_EDIT_STALE');
  assert.deepEqual(closed,['renderer:42']);
});

test('桌面编辑服务核验连接、配置和完整作用域，状态查询可在断连后核实',async()=>{
  const plugin={...scope,pluginType:'mysql',configState:'ready',target:{host:'database.fixture.invalid',port:3306,database:'fixture',addressFamily:'ipv4Only'},auth:{username:'fixture'},transport:{kind:'direct'},tls:{mode:'required'},limits:{maxRows:100,maxBytes:65536,timeoutMs:3000},revision:1};
  const calls=[];
  let connected=true,stable=true;
  const receiver={workspaceStore:{getPlugin:async()=>plugin},connectionManager:{assertConfigurationStable(){if(!stable)throw new AppError('CONFIGURATION_CHANGED','配置变化');}},
    assertPluginConnected(){if(!connected)throw new AppError('PLUGIN_NOT_CONNECTED','未连接');},
    mysqlEditor:{open:async()=>{calls.push('open');return {};},status:()=>{calls.push('status');return {};}}};
  const invoke=(operation,payload)=>V2Service.prototype.invokeDesktopMysqlEdit.call(receiver,'fixture-window',{...scope,...payload},operation);
  connected=false;
  await assert.rejects(invoke('open',{sql:'SELECT * FROM items'}),{code:'PLUGIN_NOT_CONNECTED'});
  await invoke('status',{editId:'11111111-1111-1111-1111-111111111111',planId:'22222222-2222-2222-2222-222222222222'});
  connected=true;stable=false;
  await assert.rejects(invoke('open',{sql:'SELECT * FROM items'}),{code:'CONFIGURATION_CHANGED'});
  stable=true;plugin.environmentId='other';
  await assert.rejects(invoke('open',{sql:'SELECT * FROM items'}),{code:'SCOPE_MISMATCH'});
  assert.deepEqual(calls,['status']);
});

test('Agent 数据库写入能力继续被操作策略拒绝',()=>{
  const gate=new OperationGate();
  assert.throws(()=>gate.authorize({plugin:{...scope,pluginType:'mysql',agent:{}},capability:'update',args:{sql:'UPDATE items SET label=1'},origin:'agent'}));
});

test('SQL 文件导出拒绝子框架、陌生窗口及保存对话框期间的导航',async()=>{
  const handlers=new Map();let trusted=true,release,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  registerMysqlEditIpc({handle:(name,fn)=>handlers.set(name,fn)},{
    isWorkspaceRenderer:()=>trusted,
    pickMysqlExportPath:async()=>{started();return new Promise(resolve=>{release=resolve;});},
  });
  const sender=new EventEmitter();Object.assign(sender,{id:99,mainFrame:{},isDestroyed:()=>false});
  const event={sender,senderFrame:sender.mainFrame},payload={fileName:'selected.sql',sql:'SELECT 1;'};
  const save=handlers.get('v2:mysql-export-save');
  assert.equal((await save({...event,senderFrame:{}},payload)).error.code,'WORKSPACE_ACCESS_DENIED');
  trusted=false;assert.equal((await save(event,payload)).error.code,'WORKSPACE_ACCESS_DENIED');trusted=true;
  const pending=save(event,payload);await waiting;
  sender.emit('did-start-navigation',{},'file://fixture',false,true);release('must-not-write.sql');
  assert.equal((await pending).error.code,'WORKSPACE_ACCESS_DENIED');
});
