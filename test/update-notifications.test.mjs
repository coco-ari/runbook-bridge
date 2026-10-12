import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateNotifications, UpdateNotificationDelivery, notificationChannel, cloudUpdateNotices, softwareUpdateNotices } from '../src/update-notifications.mjs';
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
  assert.equal(notices[0].localProjectId,'local-a');
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
test('首次目录基线只抑制未下载的相同内容，后续变化与真实同步冲突仍提醒',() => {
  const {state,status} = fixture();
  state.repositories[0].notificationBaseline = {'project-a':'new-digest'};
  status.cloudProjects[0] = {...status.cloudProjects[0],downloaded:false,syncStatus:'remote'};
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
  state.repositories[0].catalog[0].digest = 'later-digest';
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'changed');
  state.repositories[0].notificationBaseline = {};
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'added');
  state.repositories[0].notificationBaseline = null;
  assert.deepEqual(cloudUpdateNotices(state,status),[]);
  state.repositories[0].notificationBaseline = {'project-a':'later-digest'};
  status.cloudProjects[0] = {...status.cloudProjects[0],downloaded:true,syncStatus:'behind'};
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'changed');
  status.cloudProjects[0].syncStatus = 'modified';
  assert.equal(cloudUpdateNotices(state,status)[0].kind,'conflict');
});
test('首次基线按仓库隔离，同 ID 项目不串用其他仓库的初始化记录',() => {
  const {state,status} = fixture();
  state.repositories[0].notificationBaseline = {'project-a':'new-digest'};
  state.repositories.push({...state.repositories[0],repositoryId:'repo-b',notificationBaseline:{}});
  status.repositories.push({repositoryId:'repo-b',unlocked:true});
  status.cloudProjects[0] = {...status.cloudProjects[0],downloaded:false,syncStatus:'remote'};
  status.cloudProjects.push({...status.cloudProjects[0],repositoryId:'repo-b'});
  const notices = cloudUpdateNotices(state,status);
  assert.equal(notices.length,1);
  assert.equal(notices[0].repositoryId,'repo-b');
  assert.equal(notices[0].kind,'added');
});
test('消息持续保留到更新完成，重启及重复检查不重复弹通知',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'update-notices-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const workspace = {directory,unseal:JSON.parse,writeSealed:(file,value) => fs.writeFile(file,JSON.stringify(value))};
  const messages = [], {state,status} = fixture(), notices = cloudUpdateNotices(state,status);
  const service = new UpdateNotifications({workspace,onNotify:items => messages.push(items)});
  await service.init(); await service.reconcile(notices); await service.reconcile(notices);
  assert.equal(messages.length,1); assert.equal(service.snapshot().items.length,1);
  assert.equal(Object.hasOwn(service.snapshot().items[0],'unread'),false);
  assert.equal(Object.hasOwn(service.snapshot().items[0],'snoozedUntil'),false);
  const firstSeen = service.snapshot().items[0].firstSeenAt;
  const restarted = new UpdateNotifications({workspace,onNotify:() => assert.fail('不重复弹出')});
  await restarted.init(); await restarted.reconcile(notices);
  assert.equal(restarted.snapshot().items.length,1); assert.equal(restarted.snapshot().items[0].firstSeenAt,firstSeen);
  await restarted.reconcile([]); assert.deepEqual(restarted.snapshot().items,[]);
  await fs.writeFile(service.file,'corrupt');
  const broken = new UpdateNotifications({workspace,onNotify:() => assert.fail()});
  await broken.init(); await broken.reconcile(notices);
  assert.ok(broken.snapshot().error); assert.equal(await fs.readFile(service.file,'utf8'),'corrupt');
});
test('旧版已读和稍后记录恢复显示，保留发现时间、通知偏好与去重状态',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'update-migration-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const workspace = {directory,unseal:JSON.parse,writeSealed:(file,value) => fs.writeFile(file,JSON.stringify(value))};
  const notices = cloudUpdateNotices(...Object.values(fixture()));
  for (const schemaVersion of [1,2]) {
    const service = new UpdateNotifications({workspace,onNotify:() => assert.fail('迁移不重复弹通知')});
    await fs.writeFile(service.file,JSON.stringify({schemaVersion,notificationMode:'app',records:{[notices[0].id]:{read:true,notified:true,firstSeenAt:123,snoozedUntil:Date.now()+86400000}}}));
    await service.init(); await service.reconcile(notices);
    assert.equal(service.snapshot().items.length,1);
    assert.equal(service.snapshot().items[0].firstSeenAt,123);
    assert.equal(service.snapshot().notificationMode,'app');
    const saved = JSON.parse(await fs.readFile(service.file,'utf8'));
    assert.equal(saved.schemaVersion,3);
    assert.deepEqual(saved.records[notices[0].id],{notified:true,firstSeenAt:123});
  }
});
test('消息中心 IPC 仅接受可信主窗口的状态和提醒偏好，不接受已读或延后',async () => {
  let handler;
  const sender = {mainFrame:{},isDestroyed:() => false};
  registerUpdateNotificationsIpc({handle:(_name,fn) => { handler = fn; }},{isWorkspaceRenderer:value => value === sender,updateNotifications:{snapshot:() => ({items:[]}),preferences:async notificationMode => ({notificationMode})}});
  const event = {sender,senderFrame:sender.mainFrame};
  assert.equal((await handler(event,{action:'status'})).ok,true);
  assert.equal((await handler(event,{action:'preferences',notificationMode:'app'})).data.notificationMode,'app');
  for (const payload of [{action:'read',ids:['a'.repeat(64)]},{action:'snooze',ids:['a'.repeat(64)],duration:'hour'},{action:'install'},{action:'status',url:'https://bad.invalid'},{action:'preferences',notificationMode:'remote'},{action:'preferences',notificationMode:'app',url:'https://bad.invalid'}]) assert.equal((await handler(event,payload)).ok,false);
  assert.equal((await handler({...event,senderFrame:{}},{action:'status'})).ok,false);
  assert.equal((await handler({sender:{mainFrame:{}},senderFrame:{}},{action:'status'})).ok,false);
});
test('下载失败仍保留版本消息，完成安装后移除',() => {
  const software = {phase:'error',availableVersion:'9.0.0',source:{repositoryId:'repo-a',name:'合成仓库',origin:'https://updates.example.invalid'}};
  assert.equal(softwareUpdateNotices(software,'win32','x64')[0].version,'9.0.0');
  software.phase = 'current'; assert.deepEqual(softwareUpdateNotices(software,'win32','x64'),[]);
});
test('合并提醒排除已完成消息，通知渠道遵守偏好且不会双重弹出',() => {
  let state = {items:[{id:'a'},{id:'b'}],notificationMode:'background'};
  const deliveries = [];
  const delivery = new UpdateNotificationDelivery({current:() => state,send:(...args) => deliveries.push(args)});
  delivery.enqueue([{id:'a'}]); delivery.enqueue([{id:'b'},{id:'a'},{id:'removed'}]);
  state = {...state,items:[{id:'b'}]};
  delivery.flush(); assert.deepEqual(deliveries,[[[{id:'b'}],'background']]);
  delivery.enqueue([{id:'b'}]); delivery.dispose(); delivery.flush(); assert.equal(deliveries.length,1);
  assert.equal(notificationChannel('app',true),'app'); assert.equal(notificationChannel('app',false),null);
  assert.equal(notificationChannel('background',true),'app'); assert.equal(notificationChannel('background',false),'system');
  assert.equal(notificationChannel('always',true),'system'); assert.equal(notificationChannel('always',false),'system');
});
