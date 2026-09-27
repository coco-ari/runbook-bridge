import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-'));
  const scope = {projectId:'fixture',environmentId:'test',pluginInstanceId:'server'};
  const plugin = {...scope,revision:1,pluginType:'server',configState:'ready'};
  const state = {connected:true,generation:1};
  const runtime = new EventEmitter();
  runtime.status = () => state;
  let size = 8;
  runtime.statRemotePath = async (_plugin, target) => ({type:'file',canonicalPath:target,size,mtime:1,mode:0o100644});
  const files = new ServerWorkspaceFiles({workspaceStore:{getPlugin:async () => plugin, appendAudit:async () => {}},serverRuntime:runtime,serverOperations:{}});
  const owner = 'renderer:1';
  const prepared = await files.downloads.prepare(owner, {...scope,path:'/fixture.txt'});
  const job = {...prepared,jobId:'fixture-job',direction:'download',status:'error',inFlight:false,localPath:path.join(root,'fixture.txt'),controller:new AbortController(),bytes:8,transferred:0};
  files.jobs.set(job.jobId, job);
  t.after(async () => {files.dispose(); await fs.rm(root,{recursive:true,force:true});});
  return {scope,owner,plugin,state,files,job,runtime,root,setSize:value => {size=value;}};
}

test('下载重试只用原任务的远端路径，重连后重新预检，配置改变则拒绝', async t => {
  const f = await fixture(t);
  f.state.generation++;
  f.setSize(19);
  const prepared = await f.files.downloads.prepareRetry(f.owner,{...f.scope,retryOf:f.job.jobId});
  assert.equal(prepared.path, '/fixture.txt');
  assert.equal(prepared.expected.size,19);
  assert.equal(prepared.generation,f.state.generation);
  assert.equal(prepared.suggestedPath,f.job.localPath);
  f.plugin.revision++;
  await assert.rejects(f.files.downloads.prepareRetry(f.owner,{...f.scope,retryOf:f.job.jobId}),{code:'WORKSPACE_CHANGED'});
});

test('下载记录隔离窗口和项目，活动、完成或已经清理的任务不能重试', async t => {
  const f = await fixture(t); const input = {...f.scope,retryOf:f.job.jobId};
  await assert.rejects(f.files.downloads.prepareRetry('renderer:2',input),{code:'DOWNLOAD_UNAVAILABLE'});
  await assert.rejects(f.files.downloads.prepareRetry(f.owner,{...input,environmentId:'other'}),{code:'DOWNLOAD_UNAVAILABLE'});
  for (const status of ['running','queued','completed']) {
    f.job.status = status;
    await assert.rejects(f.files.downloads.prepareRetry(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
  }
  f.job.status='cancelled'; f.job.inFlight=true;
  await assert.rejects(f.files.downloads.prepareRetry(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
  f.job.inFlight=false;
  assert.equal((await f.files.downloads.prepareRetry(f.owner,input)).path,'/fixture.txt');
  f.files.clearTransfers(f.owner,{...f.scope,jobId:f.job.jobId});
  await assert.rejects(f.files.downloads.prepareRetry(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
});

test('打开本地位置允许离线，但只接受本窗口已完成且仍存在的普通文件', async t => {
  const f = await fixture(t); const input = {...f.scope,jobId:f.job.jobId};
  await fs.writeFile(f.job.localPath,'fixture');
  await assert.rejects(f.files.downloads.reveal(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
  f.job.status='completed'; f.state.connected=false;
  assert.equal(await f.files.downloads.reveal(f.owner,input),f.job.localPath);
  await assert.rejects(f.files.downloads.reveal('renderer:2',input),{code:'DOWNLOAD_UNAVAILABLE'});
  await fs.rm(f.job.localPath);
  await assert.rejects(f.files.downloads.reveal(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
  await fs.symlink(f.root,f.job.localPath);
  await assert.rejects(f.files.downloads.reveal(f.owner,input),{code:'DOWNLOAD_UNAVAILABLE'});
});

test('下载重试仍经过原生另存为，可取消；IPC 拒绝本地路径注入和子框架', async t => {
  const f = await fixture(t); const handlers = new Map();
  const sender = new EventEmitter(); sender.id=1; sender.mainFrame={}; sender.isDestroyed=() => false;
  const event = {sender,senderFrame:sender.mainFrame};
  const selections=[]; const revealed=[];
  registerServerWorkspaceIpc({handle:(name,fn) => handlers.set(name,fn)}, {
    serverWorkspaceFiles:f.files,isWorkspaceRenderer:() => true,
    pickServerDownloadPath:async (...args) => {selections.push(args); return null;},
    revealServerDownload:target => revealed.push(target),
  });
  const invoke = (channel,payload,ev=event) => handlers.get('v2:server-workspace-'+channel)(ev,{...f.scope,...payload});
  for (const payload of [{retryOf:f.job.jobId,path:'/other'}, {retryOf:f.job.jobId,localPath:'/arbitrary'}, {retryOf:''}, {}]) assert.equal((await invoke('download',payload)).error.code,'INVALID_ARGUMENT');
  assert.equal(selections.length,0);
  assert.equal((await invoke('download',{retryOf:f.job.jobId},{sender,senderFrame:{}})).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.deepEqual(await invoke('download',{retryOf:f.job.jobId}),{ok:true,data:null});
  assert.equal(selections[0][1],'fixture.txt'); assert.equal(selections[0][2],f.job.localPath);
  assert.equal(f.files.jobs.size,1);
  assert.equal((await invoke('reveal-download',{jobId:f.job.jobId,localPath:'/arbitrary'})).error.code,'INVALID_ARGUMENT');
  f.job.status='completed'; await fs.writeFile(f.job.localPath,'fixture');
  assert.equal((await invoke('reveal-download',{jobId:f.job.jobId})).ok,true);
  assert.deepEqual(revealed,[f.job.localPath]);
  f.files.closeOwner(f.owner);
  await assert.rejects(f.files.downloads.reveal(f.owner,{...f.scope,jobId:f.job.jobId}));
});
