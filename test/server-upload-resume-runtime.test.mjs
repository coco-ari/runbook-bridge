import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

const MiB = 1024 * 1024;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function setup(t, options = {}) {
  const f = await createUploadFixture(t, {capacity: 5 * MiB, ...options});
  const source = path.join(f.root, 'upload.bin');
  const data = crypto.randomBytes(4 * MiB + 13);
  await fsp.writeFile(source, data);
  await fsp.utimes(source,1,1);
  const stat = await fsp.stat(source);
  const condition = { local: {size:data.length, mtimeMs:stat.mtimeMs, sha256:digest(data)}, remote:{exists:false} };
  const connect = () => f.broker.connect('fixture', {password:'fixture-password'});
  await connect();
  let checkpoint;
  const send = (extra = {}) => f.broker.uploadRemoteFileApproved('fixture', source, '/upload.bin', condition, {
    resumable:true, checkpoint, onCheckpoint:value => {checkpoint=value;}, ...extra,
  });
  return { ...f, data, source, condition, reconnect:connect, send, checkpoint:() => checkpoint };
}

test('正式上传通道：正常提交、校验、速度及终端共存', {timeout:60000}, async t => {
  for (const delay of [0,80]) await t.test('写入回执延迟 '+delay+' ms', async child => {
    const f = await setup(child, {writeDelayMs:delay});
    const before = performance.now();
    await f.broker.uploadRemoteFileApproved('fixture', f.source, '/legacy.bin', f.condition);
    const oldMs = performance.now()-before;
    const started = performance.now();
    const command = f.broker.executeApproved('fixture', 'probe');
    await f.send();
    await command;
    const newMs = performance.now()-started;
    assert.deepEqual(f.files.get('/upload.bin'),f.data);
    assert.equal([...f.files.keys()].some(name => name.includes('.part-')),false);
    assert.equal(f.checkpoint().bytes,f.data.length);
    assert.equal(f.counters.probes,1);
    child.diagnostic(JSON.stringify({bytes:f.data.length,writeAckDelayMs:delay,oldTotalMs:Math.round(oldMs),newTotalMs:Math.round(newMs),ratio:Number((oldMs/newMs).toFixed(2))}));
  });
});

test('正式上传通道：连续两次断线，从确认点重写尾部', {timeout:30000}, async t => {
  const f = await setup(t);
  f.faults.dropAfter = 1.5 * MiB;
  await assert.rejects(f.send());
  assert.equal(f.checkpoint().bytes,MiB);
  assert.ok(f.files.get(f.checkpoint().temporary).length > MiB);
  await f.reconnect();
  f.faults.dropAfter = 2.5 * MiB;
  await assert.rejects(f.send());
  assert.equal(f.checkpoint().bytes,2*MiB);
  await f.reconnect();
  const start = f.counters.writes.length;
  await f.send();
  assert.equal(f.counters.writes[start].offset,2*MiB);
  assert.deepEqual(f.files.get('/upload.bin'),f.data);
});

test('正式上传通道：同大小源文件变化、临时文件篡改、目标变化均不续写', {timeout:45000}, async t => {
  for (const mutation of ['source','prefix','symlink','oversize','target']) await t.test(mutation,async child => {
    const f = await setup(child);
    f.faults.dropAfter = 1.5*MiB;
    await assert.rejects(f.send());
    const checkpoint=f.checkpoint();
    if (mutation==='source') { const changed=Buffer.from(f.data); changed[0]^=1; await fsp.writeFile(f.source,changed); await fsp.utimes(f.source,1,1); }
    if (mutation==='prefix') f.files.get(checkpoint.temporary)[0]^=1;
    if (mutation==='symlink') f.modes.set(checkpoint.temporary,0o120777);
    if (mutation==='oversize') f.files.set(checkpoint.temporary,Buffer.alloc(f.data.length+1));
    if (mutation==='target') f.files.set('/upload.bin',Buffer.from('independent change'));
    await f.reconnect();
    const writes=f.counters.writes.length;
    await assert.rejects(f.send(), error => ['LOCAL_FILE_CHANGED','UPLOAD_PARTIAL_CHANGED','REMOTE_CHANGED'].includes(error.code));
    assert.equal(f.counters.writes.length,writes);
    assert.ok(f.files.has(checkpoint.temporary));
  });
});

test('正式上传通道：提交回执丢失只核对结果，不重复写入或重命名', {timeout:30000}, async t => {
  const f=await setup(t);
  f.faults.dropRename=true;
  await assert.rejects(f.send());
  assert.equal(f.checkpoint().phase,'committing');
  assert.ok(!f.files.has(f.checkpoint().temporary));
  await f.reconnect();
  const writes=f.counters.writes.length;
  const result=await f.send();
  assert.equal(result.reconciled,true);
  assert.equal(f.counters.writes.length,writes);
  assert.equal(f.counters.renames,1);
  assert.deepEqual(f.files.get('/upload.bin'),f.data);
});

test('正式上传通道：取消及时退出且不提交', {timeout:15000}, async t => {
  const f=await setup(t,{writeDelayMs:50});
  const controller=new AbortController();
  f.faults.onWrite=() => controller.abort();
  await assert.rejects(f.send({signal:controller.signal}));
  assert.equal(f.files.has('/upload.bin'),false);
  assert.equal(f.files.size,0);
});

test('正式上传通道：取消后迟到写入不复活文件，共享 SSH 连接仍可用', {timeout:15000}, async t => {
  const f=await setup(t), controller=new AbortController();
  f.faults.onWrite=() => controller.abort();
  await assert.rejects(f.send({signal:controller.signal}), {code:'TRANSFER_CANCELLED'});
  f.faults.onWrite=null;
  assert.equal(f.files.size,0);
  assert.equal(f.broker.status('fixture').connected,true);
  const probe=await f.broker.executeApproved('fixture','probe');
  assert.equal(probe.exitCode,0); assert.equal(f.counters.probes,1);
  assert.equal(f.files.size,0);
});

test('正式上传通道：提交前目录授权失败或目标出现时不发布', async t=>{
  for(const cause of ['scope','target']) await t.test(cause,async child=>{
    const f=await setup(child);
    await assert.rejects(f.send({beforeCommit:async()=>{
      if(cause==='target') f.files.set('/upload.bin',Buffer.from('other file'));
      else throw Object.assign(new Error('配置已变化'),{code:'WORKSPACE_CHANGED'});
    }}));
    assert.equal(f.counters.renames,0);
    if(cause==='target') assert.equal(f.files.get('/upload.bin').toString(),'other file');
    else assert.equal(f.files.has('/upload.bin'),false);
  });
});

test('正式上传通道：保留覆盖目标权限，不支持覆盖时保留旧目标', async t=>{
  for(const allowRenameOverwrite of [true,false]) await t.test(String(allowRenameOverwrite),async child=>{
    const f=await setup(child,{allowRenameOverwrite});
    const original=Buffer.from('previous');
    f.files.set('/upload.bin',original); f.modes.set('/upload.bin',0o100640);
    f.condition.remote={exists:true,type:'file',mode:0o100640,size:original.length,mtime:1};
    f.faults.onWrite=()=>assert.deepEqual(f.files.get('/upload.bin'),original,'最终提交前保留原目标');
    if(allowRenameOverwrite){
      await f.send();
      assert.deepEqual(f.files.get('/upload.bin'),f.data);
      assert.equal(f.modes.get('/upload.bin'),0o100640);
    }else{
      await assert.rejects(f.send());
      assert.deepEqual(f.files.get('/upload.bin'),original);
    }
  });
});

test('真实断线事件经桌面任务、重新确认、原任务续传至完成', {timeout:30000},async t=>{
  const f=await setup(t);
  // 提交检查通过真实通道读取目录，夹具需提供实际根目录属性。
  f.files.set('/', Buffer.alloc(0)); f.modes.set('/', 0o40755);
  const scope={projectId:'fixture',environmentId:'fixture-env',pluginInstanceId:'fixture-server'};
  const plugin={...scope,revision:1,pluginType:'server',configState:'ready',target:{hostKeyFingerprint:f.fingerprint}};
  const runtime=new EventEmitter();
  runtime.status=()=>f.broker.status('fixture');
  runtime.statRemotePath=async(_plugin,target)=>({canonicalPath:target,type:'directory'});
  runtime.uploadRemoteFile=(_plugin,source,target,condition,options)=>f.broker.uploadRemoteFileApproved('fixture',source,target,condition,options);
  f.broker.setLifecycleHandler(event=>runtime.emit('lifecycle',{...event,...scope}));
  const audits=[];
  const files=new ServerWorkspaceFiles({
    workspaceStore:{getPlugin:async()=>structuredClone(plugin),appendAudit:async(_id,item)=>audits.push(item)},
    serverRuntime:runtime,
    serverOperations:{prepareMutation:async(_plugin,_operation,args)=>({...args,_precondition:f.condition})},
  });
  t.after(()=>files.dispose());
  const owner='renderer:fixture';
  const review=await files.prepareUpload(owner,{...scope,path:'/'},[f.source]);
  f.faults.dropAfter=1.5*MiB;
  const {jobs:[job]}=await files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false});
  const until=async predicate=>{
    const end=Date.now()+10000;
    while(!predicate() && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(predicate());
  };
  await until(()=>files.jobs.get(job.jobId).status==='interrupted' && !files.jobs.get(job.jobId).inFlight);
  assert.equal(files.jobs.get(job.jobId).checkpoint.bytes,MiB);
  await f.reconnect();
  const resume=await files.prepareUploadResume(owner,{...scope,jobId:job.jobId});
  await files.confirmUpload(owner,{...scope,preparationId:resume.preparationId,overwrite:false});
  await until(()=>files.jobs.get(job.jobId).status==='completed');
  assert.equal(files.jobs.size,1);
  assert.deepEqual(f.files.get('/upload.bin'),f.data);
  assert.ok(audits.some(item=>item.result==='interrupted'));
  assert.equal(JSON.stringify(audits).includes('sha256'),false);
});

test('正式上传通道：空文件及 32 MiB 文件恢复校验保持内容完整', {timeout:45000},async t=>{
  for(const bytes of [0,32*MiB+13]) await t.test(String(bytes),async child=>{
    const f=await createUploadFixture(child,{capacity:bytes});
    const source=path.join(f.root,'boundary.bin');
    const data=crypto.randomBytes(bytes);
    await fsp.writeFile(source,data);
    const stat=await fsp.stat(source);
    const condition={local:{size:bytes,mtimeMs:stat.mtimeMs,sha256:digest(data)},remote:{exists:false}};
    let checkpoint;
    const connect=()=>f.broker.connect('fixture',{password:'fixture-password'});
    const send=()=>f.broker.uploadRemoteFileApproved('fixture',source,'/boundary.bin',condition,{
      resumable:true,checkpoint,onCheckpoint:value=>{checkpoint=value;}
    });
    await connect();
    if(bytes){
      f.faults.dropAfter=25.5*MiB;
      await assert.rejects(send());
      assert.equal(checkpoint.bytes,25*MiB);
      await connect();
    }
    await send();
    assert.deepEqual(f.files.get('/boundary.bin'),data);
    assert.equal(checkpoint.bytes,bytes);
    child.diagnostic(JSON.stringify({bytes,resumeVerificationBytes:f.counters.downloaded}));
  });
});

test('正式上传通道：批次安全暂停保留临时文件，继续从完整确认点写入', {timeout:20000}, async t=>{
  const f=await setup(t,{writeDelayMs:25});
  let pause=false;
  f.faults.onWrite=()=>{pause=true;};
  await assert.rejects(f.send({shouldPause:()=>pause}),{code:'UPLOAD_PAUSED'});
  assert.equal(f.checkpoint().bytes,MiB);
  assert.equal(f.files.get(f.checkpoint().temporary).length,MiB);
  assert.equal(f.files.has('/upload.bin'),false);
  assert.equal(f.counters.pendingWrites,0);
  await f.broker.executeApproved('fixture','probe');
  await assert.rejects(f.send({shouldPause:()=>f.counters.downloaded>0}),{code:'UPLOAD_PAUSED'});
  assert.equal(f.checkpoint().bytes,MiB);
  assert.equal(f.files.get(f.checkpoint().temporary).length,MiB);
  const start=f.counters.writes.length;
  f.faults.onWrite=null;
  await f.send({shouldPause:()=>false});
  assert.equal(f.counters.writes[start].offset,MiB);
  assert.deepEqual(f.files.get('/upload.bin'),f.data);
});

test('正式上传通道：暂停后源文件变化阻止继续，最后批次也可以安全暂停', {timeout:20000}, async t=>{
  const f=await setup(t);
  await assert.rejects(f.send({shouldPause:()=>f.checkpoint()?.bytes===f.data.length}),{code:'UPLOAD_PAUSED'});
  assert.equal(f.files.has('/upload.bin'),false);
  assert.equal(f.files.get(f.checkpoint().temporary).length,f.data.length);
  await fsp.writeFile(f.source,Buffer.alloc(f.data.length));
  await fsp.utimes(f.source,1,1);
  await assert.rejects(f.send(),{code:'LOCAL_FILE_CHANGED'});
  assert.equal(f.files.has('/upload.bin'),false);
});
