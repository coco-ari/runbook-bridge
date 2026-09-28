import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ServerPluginRuntime} from '../src/server-plugin-runtime.mjs';
import {ServerWorkspaceFiles} from '../src/server-workspace-files.mjs';
import {abortable} from '../src/server-upload-transfer.mjs';
import {AppError} from '../src/errors.mjs';
import {createUploadFixture} from './fixtures/upload-ssh-server.mjs';

const scope = {projectId:'download-queue', environmentId:'test', pluginInstanceId:'server'};
const owner = 'renderer:download-queue';
const gate = () => {let release; const promise = new Promise(resolve => {release=resolve;}); return {promise,release};};
async function until(check) {
  const end = Date.now()+5000;
  while (!check() && Date.now()<end) await delay(10);
  assert.ok(check(),'下载队列应在观察期限内收敛');
}

async function fixture(t, {otherServer=false} = {}) {
  const f = await createUploadFixture(t);
  const body = Buffer.alloc(65537,7);
  for (const name of ['first','second','third']) f.files.set('/'+name+'.bin',body);
  await f.broker.connect('fixture',{password:'fixture-password'});
  if (otherServer) await f.broker.connect('fixture-other',{password:'fixture-password'});
  const plugin = {...scope,revision:1,pluginType:'server',configState:'ready',target:{hostKeyFingerprint:f.fingerprint}};
  const plugins = new Map([['server',plugin],['other',{...plugin,pluginInstanceId:'other'}]]);
  const audits = [];
  const store = {getPlugin:async (_project,_environment,id) => plugins.get(id),
    appendAudit:async (_project,entry) => {audits.push(entry);}};
  const runtime = new ServerPluginRuntime(store,{load:async () => null});
  runtime.broker=f.broker;
  runtime.key = selected => selected.pluginInstanceId === 'other' ? 'fixture-other' : 'fixture';
  f.broker.setLifecycleHandler(event => runtime.emit('lifecycle',{...event,...scope,
    pluginInstanceId:event.projectId === 'fixture-other' ? 'other' : 'server'}));
  const files = new ServerWorkspaceFiles({workspaceStore:store,serverRuntime:runtime,serverOperations:{}});
  const holds = new Map();
  const download = runtime.downloadWorkspaceFile.bind(runtime);
  runtime.downloadWorkspaceFile = (selected,remote,destination,expected,options) => download(selected,remote,destination,expected,{
    ...options,beforeCommit:async () => {
      const held=holds.get(remote);
      if (held) {held.entered=true;await abortable(held.promise,options.signal);}
      await options.beforeCommit?.();
    },
  });
  const hold = remote => {const value=gate();holds.set(remote,value);return value;};
  const start = async (name,selectedScope=scope,selectedOwner=owner) => {
    const prepared=await files.downloads.prepare(selectedOwner,{...selectedScope,path:'/'+name+'.bin'});
    const local=path.join(f.root,selectedScope.pluginInstanceId+'-'+name+'.bin');
    const result=await files.downloads.start(selectedOwner,selectedScope,prepared,local);
    return files.jobs.get(result.jobId);
  };
  const ended = job => !job.inFlight && ['completed','error','cancelled'].includes(job.status);
  t.after(() => {for(const held of holds.values())held.release();files.dispose();});
  return {...f,body,plugin,plugins,runtime,workspace:files,audits,holds,hold,start,ended};
}

test('同服务器下载等待超过十秒仍排队，其他服务器可并行，释放后按顺序完成', {timeout:20000}, async t => {
  const f=await fixture(t,{otherServer:true}),firstGate=f.hold('/first.bin');
  let first,second;
  try {
    first=await f.start('first');await until(()=>firstGate.entered);
    second=await f.start('second',scope,'renderer:another-window');
    const third=await f.start('third',{...scope,pluginInstanceId:'other'});
    await until(()=>f.ended(third));
    assert.equal(third.status,'completed','同服务器等待任务不阻塞其他服务器');
    await delay(10100);
    assert.equal(second.status,'queued');assert.equal(Boolean(second.inFlight),false);
    assert.equal(second.transferred,0);
    assert.equal(f.workspace.running,1);
    assert.equal(f.runtime.downloadScheduler.active,1);
    assert.equal(f.runtime.downloadScheduler.queue.length,0);
    assert.equal(f.audits.some(entry=>entry.result==='error'),false);
    await assert.rejects(fs.access(second.localPath),{code:'ENOENT'});
    assert.equal(f.workspace.exitSummary().active,2);
  } finally {firstGate.release();}
  await until(()=>f.ended(first)&&f.ended(second));
  assert.equal(first.status,'completed');assert.equal(second.status,'completed');
  assert.deepEqual(await fs.readFile(second.localPath),f.body);
  const completed=f.audits.find(entry=>entry.operationId===second.auditOperationId&&entry.result==='success');
  assert.ok(completed.queuedMs>=10000);
  assert.equal(completed.transferredBytes,f.body.length);
});

test('桌面下载等待共享下载名额时不使用查询时限，取消立即释放排队且不生成文件', async t => {
  const f=await fixture(t),held=gate();
  f.runtime.downloadScheduler.queueTimeoutMs=20;
  const busy=f.runtime.downloadScheduler.run('fixture',1,()=>held.promise);
  try {
    const job=await f.start('second');
    await until(()=>f.runtime.downloadScheduler.queue.length===1);
    await delay(60);
    assert.equal(job.status,'queued');assert.equal(job.inFlight,true);
    f.workspace.drain();f.workspace.drain();
    assert.equal(f.runtime.downloadScheduler.queue.length,1,'重复调度不重复提交');
    f.workspace.cancelUpload(owner,{...scope,jobId:job.jobId});
    await until(()=>f.ended(job));
    assert.equal(job.status,'cancelled');
    assert.equal(f.runtime.downloadScheduler.queue.length,0);
    assert.equal(f.workspace.running,0);
    assert.equal(f.runtime.downloadScheduler.active,1,'保留真实占用者的名额');
    await assert.rejects(fs.access(job.localPath),{code:'ENOENT'});
    const entry=f.audits.find(value=>value.result==='cancelled');
    assert.equal(entry.errorCode,'TRANSFER_CANCELLED');
    assert.equal(entry.failurePhase,'queue');
  } finally {held.release();await busy;}
});

test('实际 SSH 断开使活动和排队下载明确中断，保留原文件，重连后同任务可重试', async t => {
  const f=await fixture(t),held=f.hold('/first.bin');
  const local=path.join(f.root,'server-first.bin');
  await fs.writeFile(local,'original');
  const first=await f.start('first');await until(()=>held.entered);
  const second=await f.start('second');
  f.broker.requireSession('fixture').client.destroy();
  await until(()=>f.ended(first)&&f.ended(second));
  for(const job of [first,second]) {
    assert.equal(job.status,'error');assert.match(job.message,/服务器连接已断开/);
    assert.match(job.message,/连接恢复后/);
    const entry=f.audits.find(value=>value.operationId===job.auditOperationId&&value.result==='error');
    assert.equal(entry.errorCode,'TRANSFER_INTERRUPTED');
    assert.equal(entry.failurePhase,job===first?'verifying':'queue');
    assert.equal(entry.transferredBytes,job===first?f.body.length:0);
  }
  assert.equal(await fs.readFile(local,'utf8'),'original');
  await assert.rejects(fs.access(second.localPath),{code:'ENOENT'});
  f.holds.clear();held.release();
  await f.broker.connect('fixture',{password:'fixture-password'});
  const input={...scope,retryOf:first.jobId};
  const prepared=await f.workspace.downloads.prepareRetry(owner,input);
  const retried=await f.workspace.downloads.start(owner,input,prepared);
  const current=f.workspace.jobs.get(retried.jobId);
  assert.equal(current.errorCode,undefined);
  assert.equal(current.jobId,first.jobId);
  await until(()=>f.ended(current));
  assert.equal(current.status,'completed');
  assert.deepEqual(await fs.readFile(local),f.body);
});

test('共享名额等待期间断线或窗口关闭立即退出，迟到释放不会复活任务', async t => {
  for(const reason of ['disconnect','owner']) await t.test(reason,async t=>{
    const f=await fixture(t),held=gate();
    const busy=f.runtime.downloadScheduler.run('fixture',1,()=>held.promise);
    try {
      const job=await f.start('second');
      await until(()=>f.runtime.downloadScheduler.queue.length===1);
      if(reason==='disconnect')f.runtime.emit('lifecycle',{...scope,type:'lost'});
      else f.workspace.closeOwner(owner);
      await until(()=>!job.inFlight&&f.runtime.downloadScheduler.queue.length===0);
      assert.equal(job.status,reason==='disconnect'?'error':'cancelled');
      assert.equal(f.workspace.running,0);
      held.release();await busy;await delay(20);
      assert.equal(f.counters.downloaded,0);
      await assert.rejects(fs.access(job.localPath),{code:'ENOENT'});
    } finally {held.release();await busy;}
  });
});

test('等待期间本地目标或远端源变化仍拒绝传输，不扩大原覆盖授权', async t => {
  for(const change of ['local','remote']) await t.test(change,async t=>{
    const f=await fixture(t),held=f.hold('/first.bin');
    let second;
    try {
      const first=await f.start('first');await until(()=>held.entered);
      second=await f.start('second');
      if(change==='local')await fs.writeFile(second.localPath,'new local content');
      else f.files.set('/second.bin',Buffer.from('changed source'));
      held.release();
      await until(()=>f.ended(first)&&f.ended(second));
      assert.equal(second.status,'error');
      assert.equal(second.errorCode,change==='local'?'DOWNLOAD_TARGET_CHANGED':'SOURCE_CHANGED');
      if(change==='local')assert.equal(await fs.readFile(second.localPath,'utf8'),'new local content');
      else await assert.rejects(fs.access(second.localPath),{code:'ENOENT'});
    } finally {held.release();}
  });
});

test('下载审计仅记录允许的错误码和数值，不保存原始错误正文及详情', async t => {
  const f=await fixture(t);
  f.runtime.downloadWorkspaceFile=async ()=>{
    throw new AppError('UNTRUSTED_DETAIL','fixture-private-error-text',{remote:'fixture-private-error-detail'});
  };
  const job=await f.start('second');await until(()=>f.ended(job));
  const entry=f.audits.find(value=>value.result==='error');
  assert.equal(entry.errorCode,'DOWNLOAD_FAILED');
  assert.equal(entry.failurePhase,'queue');
  assert.equal(entry.transferredBytes,0);
  assert.doesNotMatch(JSON.stringify(f.audits),/UNTRUSTED_DETAIL|fixture-private-error|localPath|destination/);
});

test('实际传输已提交后收到取消仍以完成为准，不留下失败审计字段', async t => {
  const f=await fixture(t);
  f.runtime.downloadWorkspaceFile=async (_plugin,_remote,_destination,_expected,options)=>{
    await options.onStart();
    const job=[...f.workspace.jobs.values()][0];
    f.workspace.cancelUpload(owner,{...scope,jobId:job.jobId});
  };
  const job=await f.start('second');await until(()=>f.ended(job));
  assert.equal(job.status,'completed');
  const entry=f.audits.find(value=>value.result==='success');
  assert.equal(entry.errorCode,undefined);
  assert.equal(entry.failurePhase,undefined);
});

test('下载等待名额期间配置修订变化，在真正传输前拒绝过期任务', async t => {
  const f=await fixture(t),held=gate();
  const busy=f.runtime.downloadScheduler.run('fixture',1,()=>held.promise);
  try {
    const job=await f.start('second');
    await until(()=>f.runtime.downloadScheduler.queue.length===1);
    f.plugin.revision++;
    held.release();await busy;await until(()=>f.ended(job));
    assert.equal(job.errorCode,'WORKSPACE_CHANGED');
    assert.equal(job.transferStartedAt,undefined);
    assert.equal(f.counters.downloaded,0);
    await assert.rejects(fs.access(job.localPath),{code:'ENOENT'});
  } finally {held.release();await busy;}
});
