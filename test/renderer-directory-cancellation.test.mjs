import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectoryReader } from '../renderer/v2/src/features/server-workspace/directory-read-controller.ts';
import { createWorkspaceReadQueue } from '../renderer/v2/src/features/server-workspace/workspace-read-queue.ts';
const scope={projectId:'p',environmentId:'e',pluginInstanceId:'s'};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function harness(){
  const calls=[],cancelled=[];
  const api={serverWorkspaceListDirectory:input=>new Promise((resolve,reject)=>calls.push({input,resolve,reject})),serverWorkspaceCancelDirectoryRead:async input=>{cancelled.push(input);return {ok:true,data:{cancelled:true}};}};
  return {api,calls,cancelled,reader:createDirectoryReader(api,scope)};
}

test('收起只取消匹配路径的本控制器请求，迟到成功不会交付',async()=>{
  const h=harness(), other=createDirectoryReader(h.api,scope);
  const reads=[h.reader.read({path:'/a'}),h.reader.read({path:'/a/nested'}),h.reader.read({path:'/ab'}),other.read({path:'/a'})];
  const settled=Promise.allSettled(reads);h.reader.cancel(path=>path==='/a'||path.startsWith('/a/'));h.reader.cancel(path=>path==='/a');
  assert.equal(h.cancelled.length,2);assert.equal(new Set(h.calls.map(x=>x.input.requestId)).size,4);
  assert.deepEqual(h.cancelled.map(x=>x.requestId),h.calls.slice(0,2).map(x=>x.input.requestId));
  for(const call of h.calls)call.resolve({ok:true,data:{}});
  const results=await settled;assert.deepEqual(results.map(x=>x.status),['rejected','rejected','fulfilled','fulfilled']);
  assert.equal(results[0].reason.code,'WORKSPACE_READ_CANCELLED');
});

test('发出取消不提前释放名额，主进程结束读取后才继续排队目录',async()=>{
  const h=harness(),queue=createWorkspaceReadQueue(),owner={};
  const reads=['/a','/b','/c','/next'].map(path=>queue.run(owner,path,()=>h.reader.read({path}),()=>true));
  const settled=Promise.allSettled(reads);await settle();h.reader.cancel(path=>path==='/a');await settle();
  assert.equal(h.calls.length,3,'仅取消确认不释放读取名额');
  h.calls[0].resolve({ok:false,error:{code:'TRANSFER_CANCELLED',message:'合成取消'}});await settle();
  assert.equal(h.calls.length,4);assert.equal(h.calls[3].input.path,'/next');
  for(const call of h.calls.slice(1))call.resolve({ok:true,data:{}});
  assert.equal((await settled)[0].reason.code,'WORKSPACE_READ_CANCELLED');
});

test('未取消请求保留实际错误，已结束请求不再发送取消',async()=>{
  const h=harness();const first=h.reader.read({path:'/a'}), rejected=assert.rejects(first,{message:'合成失败'});
  h.calls[0].reject(new Error('合成失败'));await rejected;h.reader.cancel();assert.equal(h.cancelled.length,0);
  const second=h.reader.read({path:'/a'});const cancelled=assert.rejects(second,{code:'WORKSPACE_READ_CANCELLED'});
  h.reader.cancel();h.calls[1].reject(new Error('迟到传输失败'));await cancelled;
});
