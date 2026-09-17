import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/errors.mjs';
import { EventEmitter } from 'node:events';
import { downloadWorkspaceFile, downloadDestination, DESKTOP_DOWNLOAD_LIMIT } from '../src/server-download-transfer.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

async function setup(t, bytes = 2 * 1024 * 1024 + 31) {
  const f=await createUploadFixture(t);
  const data=crypto.randomBytes(bytes);f.files.set('/source.bin',data);
  await f.broker.connect('fixture',{password:'fixture-password'});
  const expected=await f.broker.statRemotePath('fixture','/source.bin');
  const localPath=path.join(f.root,'下载 file.bin');
  const send=async(options={},destination)=>downloadWorkspaceFile(f.broker,'fixture','/source.bin',destination??await downloadDestination(localPath),expected,options);
  const noParts=async()=>assert.equal((await fsp.readdir(f.root)).some(name=>name.startsWith('.runbook-download-')),false);
  return {...f,data,expected,localPath,send,noParts};
}

test('桌面下载使用真实 SFTP 通道，空文件和多批文件均完整、可覆盖且终端共存', {timeout:20000}, async t=>{
  for(const bytes of [0,2*1024*1024+31]) await t.test(String(bytes),async child=>{
    const f=await setup(child,bytes);
    const progress=[];
    const terminal=f.broker.executeApproved('fixture','probe');
    await f.send({onProgress:value=>progress.push(value)});await terminal;
    assert.deepEqual(await fsp.readFile(f.localPath),f.data);
    assert.equal(progress.at(-1).phase,'verifying');
    assert.equal(progress.at(-1).transferredBytes,bytes);
    await fsp.writeFile(f.localPath,'original');
    await f.send();
    assert.deepEqual(await fsp.readFile(f.localPath),f.data);
    await f.noParts();
  });
});

test('下载取消、中断和源文件改变不覆盖本地原文件，失败后清理临时文件', {timeout:20000}, async t=>{
  for(const fault of ['cancel','disconnect','grow','shrink','special']) await t.test(fault,async child=>{
    const f=await setup(child);
    await fsp.writeFile(f.localPath,'original');
    const controller=new AbortController();let injected=false;
    await assert.rejects(f.send({signal:controller.signal,onProgress:({transferredBytes,phase})=>{
      if(injected || !transferredBytes || phase!=='uploading') return;
      injected=true;
      if(fault==='cancel') controller.abort();
      if(fault==='disconnect') void f.broker.closeAll();
      if(fault==='grow') f.files.set('/source.bin',Buffer.concat([f.data,Buffer.from('changed')]));
      if(fault==='shrink') f.files.set('/source.bin',Buffer.from('short'));
      if(fault==='special') f.modes.set('/source.bin',0o020600);
    }}));
    assert.equal(await fsp.readFile(f.localPath,'utf8'),'original');
    await f.noParts();
  });
});

test('下载拒绝保存位置变化、同名文件抢占和提交前失效，保留新文件', {timeout:20000}, async t=>{
  for(const fault of ['existing-changed','new-conflict','binding']) await t.test(fault,async child=>{
    const f=await setup(child);
    if(fault==='existing-changed') await fsp.writeFile(f.localPath,'original');
    const destination=await downloadDestination(f.localPath);
    await assert.rejects(f.send({beforeCommit:async()=>{
      if(fault==='binding') throw new AppError('WORKSPACE_CHANGED','连接已变化。');
      await fsp.writeFile(f.localPath,'independent file');
    }},destination), {code:fault==='binding'?'WORKSPACE_CHANGED':'DOWNLOAD_TARGET_CHANGED'});
    if(fault!=='binding') assert.equal(await fsp.readFile(f.localPath,'utf8'),'independent file');
    else await assert.rejects(fsp.stat(f.localPath),{code:'ENOENT'});
    await f.noParts();
  });
});

test('下载拒绝目录、特殊文件、超限及远端符号链接，不发送读取', {timeout:15000}, async t=>{
  const f=await setup(t);
  const destination=await downloadDestination(f.localPath);
  for (const expected of [{...f.expected,type:'directory'},{...f.expected,type:'special'},{...f.expected,size:DESKTOP_DOWNLOAD_LIMIT+1}]) {
    await assert.rejects(downloadWorkspaceFile(f.broker,'fixture','/source.bin',destination,expected),{code:'SOURCE_NOT_ALLOWED'});
  }
  f.modes.set('/source.bin',0o120777);
  await assert.rejects(f.send(),{code:'SOURCE_CHANGED'});
  assert.equal(f.counters.downloaded,0);
  await assert.rejects(downloadDestination(f.root),{code:'DOWNLOAD_TARGET_CHANGED'});
  await f.noParts();
});

test('桌面下载任务进入现有队列，保留路径进度，完成后只移除记录', {timeout:15000}, async t=>{
  const f=await setup(t);
  const scope={projectId:'fixture-project',environmentId:'fixture-env',pluginInstanceId:'fixture-server'};
  const plugin={...scope,pluginType:'server',configState:'ready',revision:1,target:{hostKeyFingerprint:f.fingerprint}};
  const runtime=new EventEmitter();
  runtime.status=()=>({connected:true,generation:1});
  runtime.statRemotePath=(_plugin,target)=>f.broker.statRemotePath('fixture',target);
  runtime.downloadWorkspaceFile=(_plugin,...args)=>downloadWorkspaceFile(f.broker,'fixture',...args);
  const audits=[];
  const files=new ServerWorkspaceFiles({workspaceStore:{getPlugin:async()=>plugin,appendAudit:async(_p,item)=>audits.push(item)},serverRuntime:runtime,serverOperations:{}});
  t.after(()=>files.dispose());
  const prepared=await files.downloads.prepare('renderer:1',{...scope,path:'/source.bin'});
  const job=await files.downloads.start('renderer:1',scope,prepared,f.localPath);
  assert.equal(job.direction,'download');assert.equal(job.canPause,false);
  assert.throws(()=>files.pauseUpload('renderer:1',{...scope,jobId:job.jobId}),{code:'UPLOAD_PAUSE_UNAVAILABLE'});
  const deadline=Date.now()+8000;
  while(files.jobs.get(job.jobId).inFlight && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  const done=files.uploads('renderer:1',scope).jobs[0];
  assert.equal(done.status,'completed');assert.equal(done.canRemove,true);assert.equal(done.localPath,f.localPath);
  assert.equal(done.transferred,f.data.length);
  files.clearTransfers('renderer:1',{...scope,jobId:job.jobId});
  assert.deepEqual(await fsp.readFile(f.localPath),f.data);
  assert.equal(audits.at(-1).type,'desktop-download');
  assert.equal(audits.at(-1).result,'success');
});

test('下载前检查硬链接和可用空间，失败不读取远端内容且不留下临时文件', {timeout:15000}, async t => {
  for (const fault of ['unsupported', 'space', 'permission']) await t.test(fault, async child => {
    const f = await setup(child);
    if (fault === 'unsupported') child.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('模拟不支持硬链接'), {code:'ENOTSUP'}); });
    if (fault === 'space') child.mock.method(fsp, 'statfs', async () => ({bavail:1n,bsize:4096n}));
    if (fault === 'permission') {
      const original = fsp.open;
      child.mock.method(fsp, 'open', async (target, ...args) => {
        if (path.dirname(target) === f.root && path.basename(target).startsWith('.runbook-download-')) throw Object.assign(new Error('模拟无写权限'), {code:'EACCES'});
        return original(target, ...args);
      });
    }
    await assert.rejects(f.send(), {code:{unsupported:'DOWNLOAD_SAVE_UNSUPPORTED',space:'DOWNLOAD_DISK_FULL',permission:'DOWNLOAD_ACCESS_DENIED'}[fault]});
    assert.equal(f.counters.downloaded, 0);
    await f.noParts();
    await assert.rejects(fsp.stat(f.localPath), {code:'ENOENT'});
  });
});

test('下载过程中本地写满或被占用有明确提示，并保留原文件', {timeout:15000}, async t => {
  for (const fault of ['ENOSPC', 'EBUSY', 'EACCES']) await t.test(fault, async child => {
    const f=await setup(child);
    await fsp.writeFile(f.localPath, 'original');
    const original = fsp.open;
    child.mock.method(fsp, 'open', async (target, ...args) => {
      const handle=await original(target,...args);
      if (path.dirname(target) === f.root && path.basename(target).startsWith('.runbook-download-')) {
        handle.write=async () => { throw Object.assign(new Error('模拟本地写入失败'), {code:fault}); };
      }
      return handle;
    });
    await assert.rejects(f.send(), {code:{ENOSPC:'DOWNLOAD_DISK_FULL',EBUSY:'DOWNLOAD_FILE_BUSY',EACCES:'DOWNLOAD_ACCESS_DENIED'}[fault]});
    assert.equal(await fsp.readFile(f.localPath,'utf8'),'original');
    await f.noParts();
  });
});

test('硬链接预检查成功仍在最终发布时防止同名文件被抢占', {timeout:15000}, async t => {
  const f=await setup(t);
  const original=fsp.link;
  let checks=0;
  t.mock.method(fsp,'link',async (source,target,...args) => {
    if (target.endsWith('.check')) checks++;
    if (target===f.localPath) await fsp.writeFile(target,'independent file');
    return original(source,target,...args);
  });
  await assert.rejects(f.send(),{code:'DOWNLOAD_TARGET_CHANGED'});
  assert.equal(checks,1);
  assert.equal(await fsp.readFile(f.localPath,'utf8'),'independent file');
  await f.noParts();
});
