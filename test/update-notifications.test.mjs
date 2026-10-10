import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateNotifications, cloudUpdateNotices, softwareUpdateNotices } from '../src/update-notifications.mjs';
import { registerUpdateNotificationsIpc } from '../src/update-notifications-ipc.mjs';

function fixture() {
  const state = {repositories:[{repositoryId:'repo-a',name:'合成仓库',catalog:[{projectId:'project-a',name:'合成项目',digest:'new-digest'}]}],mappings:[{repositoryId:'repo-a',remoteId:'project-a',localId:'local-a',remoteDigest:'old-digest'}]};
  const status = {repositories:[{repositoryId:'repo-a',unlocked:true}],cloudProjects:[{repositoryId:'repo-a',projectId:'project-a',downloaded:true,visible:true,syncStatus:'behind'}],deletedCloudProjects:[],projects:[{projectId:'local-a'}]};
  return {state,status};
}
test('云提醒以项目内容去重，本地单独修改、上传完成、隐藏未下载和锁定仓库不提醒',() => {
  const {state,status} = fixture();
  const notices = cloudUpdateNotices(state,status);
  assert.equal(notices.length,1); assert.equal(notices[0].kind,'changed');
  state.repositories[0].snapshotId = 'another-snapshot';
  assert.equal(cloudUpdateNotices(state,status)[0].id,notices[0].id);
  status.cloudProjects[0].syncStatus = 'modified';
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'conflict');
  state.mappings[0].remoteDigest = 'new-digest';
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
  status.cloudProjects[0].syncStatus = 'synced';
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
  status.cloudProjects[0] = {...status.cloudProjects[0],downloaded:false,visible:false,syncStatus:'remote'};
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
  status.cloudProjects[0].visible = true;
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'added');
  status.repositories[0].unlocked = false;
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
});
test('删除提醒只针对现存本地副本，软件提醒绑定来源平台版本和下载阶段',() => {
  const {state,status} = fixture();
  state.repositories[0].catalog = [];
  state.repositories[0].deletedProjects = [{projectId:'project-a',name:'合成项目',deletedAt:'2026-10-10T00:00:00Z'}];
  status.deletedCloudProjects = [{repositoryId:'repo-a',projectId:'project-a'}];
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'deleted');
  status.projects = []; assert.deepEqual(cloudUpdateNotices(state,status),[]);
  const software = {phase:'available',availableVersion:'9.0.0',source:{repositoryId:'repo-a',name:'合成仓库',origin:'https://updates.example.invalid'}};
  const id = softwareUpdateNotices(software,'win32','x64')[0].id;
  software.phase = 'downloading'; assert.equal(softwareUpdateNotices(software,'win32','x64')[0].id,id);
  software.phase = 'downloaded'; assert.notEqual(softwareUpdateNotices(software,'win32','x64')[0].id,id);
  software.phase = 'available'; software.source.repositoryId = 'repo-b'; assert.notEqual(softwareUpdateNotices(software,'win32','x64')[0].id,id);
});
test('已读与待处理分离、重启后不重复提示，损坏记录保持原文件',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'update-notices-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  // 此夹具仅包含合成摘要；生产存储使用系统安全存储加密。
  const workspace = {directory,unseal:JSON.parse,writeSealed:(file,value) => fs.writeFile(file,JSON.stringify(value))};
  const messages = [], {state,status} = fixture(), notices = cloudUpdateNotices(state,status);
  const service = new UpdateNotifications({workspace,onNotify:items => messages.push(items)});
  await service.init(); await service.reconcile(notices); await service.reconcile(notices);
  assert.equal(messages.length,1); assert.equal(service.snapshot().items[0].unread,true);
  await service.read([notices[0].id]); assert.equal(service.snapshot().items.length,1); assert.equal(service.snapshot().items[0].unread,false);
  const restarted = new UpdateNotifications({workspace,onNotify:() => assert.fail('不重复弹出')});
  await restarted.init(); await restarted.reconcile(notices); assert.equal(restarted.snapshot().items[0].unread,false);
  await restarted.reconcile([]); assert.deepEqual(restarted.snapshot().items,[]);
  await fs.writeFile(service.file,'corrupt');
  const broken = new UpdateNotifications({workspace,onNotify:() => assert.fail()});
  await broken.init(); await broken.reconcile(notices);
  assert.ok(broken.snapshot().error); assert.equal(await fs.readFile(service.file,'utf8'),'corrupt');
});
test('提醒 IPC 仅允许可信主窗口的状态和精确已读参数',async () => {
  let handler;
  const sender = {mainFrame:{},isDestroyed:() => false};
  registerUpdateNotificationsIpc({handle:(_name,fn) => { handler = fn; }},{isWorkspaceRenderer:value => value === sender,updateNotifications:{snapshot:() => ({items:[]}),read:async ids => ({items:[],ids})}});
  const event = {sender,senderFrame:sender.mainFrame};
  assert.equal((await handler(event,{action:'status'})).ok,true);
  assert.equal((await handler(event,{action:'read',ids:['a'.repeat(64)]})).ok,true);
  for (const payload of [{action:'install'},{action:'status',url:'https://bad.invalid'},{action:'read',ids:['bad']},{action:'read'},{action:'read',ids:[],repositoryId:'other'}]) assert.equal((await handler(event,payload)).ok,false);
  assert.equal((await handler({...event,senderFrame:{}},{action:'status'})).ok,false);
  assert.equal((await handler({sender:{mainFrame:{}},senderFrame:{}},{action:'status'})).ok,false);
});
