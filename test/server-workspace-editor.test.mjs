import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AppError } from '../src/errors.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';
import { sameTextSnapshot, textHash, textBytes, editPath } from '../src/server-text-edit.mjs';

const scope = {projectId:'fixture-project',environmentId:'fixture-env',pluginInstanceId:'fixture-server'};
const owner = 'renderer:1';
function fixture(t) {
  const plugin = {...scope,pluginType:'server',configState:'ready',revision:1,displayName:'Fixture'};
  const state = {content:'port = 8080\n',generation:1,connected:true,writes:0,now:100,failAudit:false,unknown:false,beforeCommit:null};
  const snapshot = () => ({content:state.content,size:Buffer.byteLength(state.content),sha256:textHash(state.content),mtime:1,mode:0o100640,uid:1,gid:1});
  const runtime = new EventEmitter(), audits=[];
  runtime.status = () => ({connected:state.connected,generation:state.generation});
  runtime.readWorkspaceText = async () => snapshot();
  runtime.writeWorkspaceText = async (_plugin, args, options) => {
    await state.beforeCommit?.(); await options.beforeCommit();
    if (!sameTextSnapshot(args.expected,snapshot())) throw new AppError('FILE_EDIT_CONFLICT','changed');
    options.onCommitting(); state.writes++; state.content=args.content;
    if (state.unknown) throw new AppError('SFTP_OPERATION_TIMEOUT','timeout');
  };
  const files = new ServerWorkspaceFiles({workspaceStore:{getPlugin:async()=>({...plugin}),appendAudit:async(_,audit)=>{if(state.failAudit)throw new Error('audit');audits.push(audit);}},serverRuntime:runtime,serverOperations:{},now:()=>state.now});
  t.after(()=>files.dispose());
  const run = input => files.editFile(owner,{...scope,...input});
  const open = async () => (await run({operation:'open',path:'/srv/example.conf'})).edit;
  const prepare = async (edit,content='port = 9090\n') => (await run({operation:'prepare',editId:edit.editId,content})).plan;
  const commit = (edit,plan) => run({operation:'commit',editId:edit.editId,planId:plan.planId});
  return {plugin,state,runtime,files,audits,run,open,prepare,commit};
}

test('文件编辑只在单次确认后写入，恢复先载入草稿，审计不含正文',async t=>{
  const f=fixture(t), edit=await f.open(), plan=await f.prepare(edit);
  assert.equal(f.state.writes,0); assert.equal(plan.before,edit.content);
  const saved=(await f.commit(edit,plan)).edit;
  assert.equal(saved.content,'port = 9090\n');assert.equal(saved.canRestore,true);
  await assert.rejects(f.commit(edit,plan),{code:'FILE_EDIT_EXPIRED'});
  assert.equal((await f.run({operation:'restore',editId:edit.editId})).restoreContent,edit.content);
  assert.equal(f.state.writes,1);
  assert.deepEqual(f.audits.map(x=>x.result),['started','completed']);
  assert.equal(JSON.stringify(f.audits).includes('9090'),false);
});
test('窗口、项目、参数、过期确认和远端同长度内容变化均不能绕过检查',async t=>{
  const f=fixture(t), edit=await f.open();
  await assert.rejects(f.files.editFile('renderer:2',{...scope,operation:'verify',editId:edit.editId}),{code:'FILE_EDIT_EXPIRED'});
  await assert.rejects(f.run({operation:'verify',projectId:'another',editId:edit.editId}),{code:'FILE_EDIT_EXPIRED'});
  await assert.rejects(f.run({operation:'toString'}),{code:'INVALID_ARGUMENT'});
  const plan=await f.prepare(edit);
  await assert.rejects(f.run({operation:'commit',editId:edit.editId,planId:plan.planId,content:'changed'}),{code:'INVALID_ARGUMENT'});
  f.state.now=plan.expiresAt;await assert.rejects(f.commit(edit,plan),{code:'FILE_EDIT_EXPIRED'});
  f.state.content='port = 7070\n';await assert.rejects(f.prepare(edit),{code:'FILE_EDIT_CONFLICT'});
  assert.equal(f.state.writes,0);
});
test('确认后外部修改、配置变化、审计失败时不写入',async t=>{
  for(const fault of ['remote','revision','audit']) {
    const f=fixture(t), edit=await f.open(), plan=await f.prepare(edit);
    if(fault==='remote') f.state.beforeCommit=()=>{f.state.content='port = 7070\n';};
    if(fault==='revision') f.plugin.revision++;
    if(fault==='audit') f.state.failAudit=true;
    await assert.rejects(f.commit(edit,plan));assert.equal(f.state.writes,0);
  }
});
test('断线保留编辑会话，重连重新检查，旧确认不能跨连接提交',async t=>{
  const f=fixture(t), edit=await f.open(), plan=await f.prepare(edit);
  await f.run({operation:'dirty',editId:edit.editId,dirty:true,sequence:1});
  assert.equal(f.files.editor.exitSummary(),1);assert.equal(f.files.activeProjectTransfers(scope.projectId),true);
  f.state.connected=false;f.runtime.emit('lifecycle',{...scope,type:'lost'});
  await assert.rejects(f.commit(edit,plan),{code:'FILE_EDIT_EXPIRED'});
  await assert.rejects(f.prepare(edit),{code:'NOT_CONNECTED'});
  f.state.connected=true;f.state.generation++;
  await f.commit(edit,await f.prepare(edit));assert.equal(f.state.writes,1);
  assert.equal(f.files.editor.exitSummary(),0);
});
test('保存结果不确定时禁止重发，可核实已写入并恢复上一版本',async t=>{
  const f=fixture(t), edit=await f.open();f.state.unknown=true;
  assert.equal((await f.commit(edit,await f.prepare(edit))).edit.status,'unknown');
  await assert.rejects(f.prepare(edit),{code:'FILE_EDIT_UNKNOWN'});
  await assert.rejects(f.run({operation:'restore',editId:edit.editId}),{code:'FILE_EDIT_NO_BACKUP'});
  assert.equal(f.files.editor.exitSummary(),1);
  const verified=(await f.run({operation:'verify',editId:edit.editId})).edit;
  assert.equal(verified.status,'ready');assert.equal(verified.canRestore,true);assert.equal(f.state.writes,1);
  assert.equal((await f.run({operation:'restore',editId:edit.editId})).restoreContent,edit.content);
});
test('结果不确定后检测到第三方修改仍保留待核实状态',async t=>{
  const f=fixture(t),edit=await f.open();f.state.unknown=true;
  await f.commit(edit,await f.prepare(edit));f.state.content='external content';
  await assert.rejects(f.run({operation:'verify',editId:edit.editId}),{code:'FILE_EDIT_CONFLICT'});
  assert.equal(f.files.editor.exitSummary(),1);assert.equal(f.state.writes,1);
});
test('关闭窗口清除会话；并行读取数量有界',async t=>{
  const f=fixture(t), edits=await Promise.allSettled(Array.from({length:20},()=>f.open()));
  assert.equal(edits.filter(x=>x.status==='fulfilled').length,12);
  f.files.closeOwner(owner);assert.equal(f.files.editor.records.size,0);
  const edit=await f.open();await f.run({operation:'dirty',editId:edit.editId,dirty:true,sequence:2});
  await f.run({operation:'dirty',editId:edit.editId,dirty:false,sequence:1});assert.equal(f.files.editor.exitSummary(),1);
  await f.run({operation:'close',editId:edit.editId});assert.equal(f.files.editor.exitSummary(),0);
});
test('编辑 IPC 只允许可信主框架，拒绝附加路径和外部内容',async t=>{
  const f=fixture(t), handlers=new Map(), sender=new EventEmitter();sender.id=1;sender.mainFrame={};sender.isDestroyed=()=>false;
  registerServerWorkspaceIpc({handle:(key,fn)=>handlers.set(key,fn)},{serverWorkspaceFiles:f.files,isWorkspaceRenderer:()=>true});
  const invoke=(payload,frame=sender.mainFrame)=>handlers.get('v2:server-workspace-edit-file')({sender,senderFrame:frame},{...scope,...payload});
  assert.equal((await invoke({operation:'open',path:'/srv/example.conf'},{})).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.equal((await invoke({operation:'open',path:'/srv/example.conf',unsafe:true})).error.code,'INVALID_ARGUMENT');
  const opened=await invoke({operation:'open',path:'/srv/example.conf'});assert.equal(opened.ok,true);
  assert.equal((await invoke({operation:'commit',editId:opened.data.edit.editId,planId:'bad',path:'/etc/other'})).error.code,'INVALID_ARGUMENT');
});
test('UTF-8 字节上限与二进制、畸形路径拒绝',()=>{
  assert.equal(textBytes('\uFEFF中文\r\n').toString(),'\uFEFF中文\r\n');
  for(const value of ['\0','\uD800','\u001b']) assert.throws(()=>textBytes(value),{code:'FILE_EDIT_ENCODING'});
  assert.throws(()=>textBytes('中'.repeat(400000)),{code:'FILE_TOO_LARGE'});
  for(const value of ['relative','/a/../b','/a//b','/','/a/','/a\n']) assert.throws(()=>editPath(value),{code:'PATH_INVALID'});
});
