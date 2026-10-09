import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftwareUpdateService } from '../src/software-update-service.mjs';
import { registerSoftwareUpdateIpc } from '../src/software-update-ipc.mjs';

const sourceA = {repositoryId:'repo-a',name:'合成云仓库 A',origin:'https://updates-a.example.invalid'};
const sourceB = {repositoryId:'repo-b',name:'合成云仓库 B',origin:'https://updates-b.example.invalid'};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
}
function setup(options = {}) {
  const calls = {created:[],checked:0,downloaded:0,installed:0,cancelled:0,disposed:0,saved:[]};
  const input = {sources:[sourceA],result:{version:'2.1.0',releaseNotes:'修复连接问题',releaseDate:'2026-10-02'},...options};
  const drivers = [];
  const service = new SoftwareUpdateService({currentVersion:'2.0.0',platform:'win32',arch:'x64',
    now:() => new Date('2026-10-02T00:00:00Z'),
    getSources:async () => input.sources,
    loadSelection:async () => input.selection ?? null,
    saveSelection:async value => { calls.saved.push(value); },
    createUpdater:({url}) => {
      calls.created.push(url);
      const driver = {
        check:async () => { calls.checked++; return input.check ? input.check() : input.result; },
        download:async onProgress => { calls.downloaded++; return input.download?.(onProgress); },
        cancel:() => { calls.cancelled++; },dispose:() => { calls.disposed++; },
      };
      drivers.push(driver);
      return driver;
    },
    install:async driver => { calls.installed++; return input.install?.(driver); },
    ...input.overrides,
  });
  return {input,calls,drivers,service,invoke:(action,payload = {}) => service.invoke(action,payload)};
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('测试等待的状态没有出现');
}

test('只读状态不联网，无云仓库及未安装环境明确禁止升级',async () => {
  const noSource = setup({sources:[]});
  assert.equal((await noSource.invoke('status')).phase,'no-source');
  await assert.rejects(noSource.invoke('check'),{code:'UPDATE_NO_SOURCE'});
  assert.deepEqual(noSource.calls.created,[]);
  const development = setup({overrides:{supported:false}});
  assert.equal((await development.invoke('status')).phase,'unsupported');
  await assert.rejects(development.invoke('download'),{code:'UPDATE_UNSUPPORTED'});
  assert.equal(development.calls.downloaded,0);
});

test('单源默认可用，多源必须选择，选择只保存仓库 ID',async () => {
  const one = setup();
  assert.equal((await one.invoke('status')).source.repositoryId,'repo-a');
  assert.equal(one.calls.checked,0);
  const multi = setup({sources:[sourceA,sourceB]});
  assert.equal((await multi.invoke('status')).phase,'source-required');
  await assert.rejects(multi.invoke('check'),{code:'UPDATE_SOURCE_REQUIRED'});
  await multi.invoke('source',{repositoryId:'repo-b'});
  const checked = await multi.invoke('check');
  assert.equal(checked.source.repositoryId,'repo-b');
  assert.deepEqual(multi.calls.created,['https://updates-b.example.invalid/updates/win32/x64/']);
  assert.deepEqual(multi.calls.saved,['repo-b']);
  multi.input.sources = [sourceB,sourceA];
  assert.equal((await multi.invoke('status')).source.repositoryId,'repo-b');
  const reset = await multi.invoke('source',{repositoryId:null});
  assert.equal(reset.phase,'source-required');
  assert.deepEqual(multi.calls.saved,['repo-b',null]);
});

test('已选择的仓库被解绑时清理下载，不自动信任剩余仓库',async () => {
  const unit = setup({sources:[sourceA,sourceB],selection:'repo-a'});
  await unit.invoke('check');
  await unit.invoke('download');
  unit.input.sources = [sourceB];
  const status = await unit.invoke('status');
  assert.equal(status.phase,'source-required');
  assert.equal(status.source,null);
  assert.equal(status.availableVersion,null);
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_SOURCE_REQUIRED'});
  assert.equal(unit.calls.installed,0);
  assert.equal(unit.calls.cancelled,1);
});

test('更新地址仅允许 HTTPS 根来源，状态不会带入凭据、查询或片段',async () => {
  for (const invalid of ['http://127.0.0.1:8080','https://user:secret@updates.example.invalid','https://updates.example.invalid?token=secret','https://updates.example.invalid/#secret','https://updates.example.invalid/nested']) {
    const unit = setup({sources:[{...sourceA,origin:invalid}]});
    await assert.rejects(unit.invoke('check'),{code:invalid.startsWith('http:') ? 'UPDATE_HTTPS_REQUIRED' : 'UPDATE_SOURCE_INVALID'});
    assert.doesNotMatch(JSON.stringify(await unit.invoke('status')),/secret|nested/);
    assert.equal(unit.calls.checked,0);
  }
});

test('重复检测合并，不自动下载，更新说明按纯文本和字节限长',async () => {
  const pending = deferred();
  const unit = setup({check:() => pending.promise});
  const first = unit.invoke('check'), second = unit.invoke('check');
  await until(() => unit.calls.checked === 1);
  assert.equal((await unit.invoke('status')).phase,'checking');
  pending.resolve({version:'2.1.0+build.5',releaseNotes:`<b>中文</b>\u0000${'更新'.repeat(3000)}`,releaseDate:'2026-10-02T01:02:03Z'});
  const [a,b] = await Promise.all([first,second]);
  assert.equal(a.phase,'available');
  assert.deepEqual(a,b);
  assert.equal(a.checkedAt,'2026-10-02T00:00:00.000Z');
  assert.equal(a.releaseDate,'2026-10-02T01:02:03.000Z');
  assert.ok(Buffer.byteLength(a.releaseNotes,'utf8') <= 4096);
  assert.doesNotMatch(a.releaseNotes,/<b>|\u0000/);
  assert.equal(unit.calls.checked,1);
  assert.equal(unit.calls.downloaded,0);
});

test('同版或旧版不提示升级，非法版本与预发布失败关闭',async () => {
  for (const version of ['2.0.0','2.0.0+another','1.99.99']) {
    const unit = setup({result:{version}});
    assert.equal((await unit.invoke('check')).phase,'current');
    await assert.rejects(unit.invoke('download'),{code:'UPDATE_NOT_AVAILABLE'});
  }
  for (const version of ['3.0.0-beta.1','v3.0.0','03.0.0','3.0','3.0.0/secret',null]) {
    const unit = setup({result:{version}});
    await assert.rejects(unit.invoke('check'),{code:'UPDATE_MANIFEST_INVALID'});
    assert.equal((await unit.invoke('status')).phase,'error');
    assert.equal(unit.calls.downloaded,0);
  }
});

test('检查中切换来源会取消旧驱动并拒绝迟到结果',async () => {
  const pending = deferred();
  const unit = setup({sources:[sourceA,sourceB],selection:'repo-a',check:() => pending.promise});
  const first = unit.invoke('check');
  const rejected = assert.rejects(first,{code:'UPDATE_CANCELLED'});
  await until(() => unit.calls.checked === 1);
  await unit.invoke('source',{repositoryId:'repo-b'});
  pending.resolve({version:'9.0.0',releaseNotes:'旧来源内容'});
  await rejected;
  const status = await unit.invoke('status');
  assert.equal(status.source.repositoryId,'repo-b');
  assert.equal(status.phase,'idle');
  assert.equal(status.availableVersion,null);
  assert.ok(unit.calls.cancelled >= 1);
});

test('下载中解绑拒绝迟到完成与进度，不能安装残留下载',async () => {
  const pending = deferred();
  let onProgress;
  const unit = setup({download:callback => { onProgress = callback; return pending.promise; }});
  await unit.invoke('check');
  const downloading = unit.invoke('download');
  const rejected = assert.rejects(downloading,{code:'UPDATE_CANCELLED'});
  await until(() => onProgress);
  onProgress({percent:40,transferred:40,total:100});
  assert.equal((await unit.invoke('status')).progress.percent,40);
  unit.input.sources = [];
  assert.equal((await unit.invoke('status')).phase,'no-source');
  onProgress({percent:90,transferred:90,total:100});
  pending.resolve();
  await rejected;
  const status = await unit.invoke('status');
  assert.equal(status.phase,'no-source');
  assert.equal(status.progress,null);
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_NO_SOURCE'});
  assert.equal(unit.calls.installed,0);
});

test('下载重复请求合并且进度有界，后台检查保留下载完成的安装器',async () => {
  const pending = deferred();
  let onProgress;
  const unit = setup({download:callback => { onProgress = callback; return pending.promise; }});
  await unit.invoke('check');
  const a = unit.invoke('download'), b = unit.invoke('download');
  await until(() => onProgress);
  onProgress({percent:500,transferred:50,total:100});
  assert.equal((await unit.invoke('status')).progress.percent,100);
  onProgress({percent:Number.NaN,transferred:-1,total:'secret'});
  assert.equal((await unit.invoke('status')).progress.transferred,50);
  assert.equal((await unit.invoke('check')).phase,'downloading');
  pending.resolve();
  await Promise.all([a,b]);
  assert.equal((await unit.invoke('check')).phase,'downloaded');
  assert.equal(unit.calls.checked,1);
  assert.equal(unit.calls.downloaded,1);
});

test('校验失败禁止安装，网络错误及伪造白名单错误消息均不回显',async () => {
  const integrity = setup({download:async () => { throw Object.assign(new Error('secret download URL'),{code:'ERR_UPDATER_CHECKSUM_MISMATCH'}); }});
  await integrity.invoke('check');
  await assert.rejects(integrity.invoke('download'),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.equal((await integrity.invoke('status')).error.code,'UPDATE_INTEGRITY_FAILED');
  await assert.rejects(integrity.invoke('install'),{code:'UPDATE_NOT_DOWNLOADED'});
  assert.equal(integrity.calls.installed,0);
  for (const code of ['ECONNREFUSED','UPDATE_CHECK_FAILED']) {
    const failed = setup({check:async () => { throw Object.assign(new Error('https://user:secret@internal.invalid/?token=secret'),{code}); }});
    await assert.rejects(failed.invoke('check'),error => error.code === 'UPDATE_CHECK_FAILED' && !error.message.includes('secret'));
    assert.doesNotMatch(JSON.stringify(await failed.invoke('status')),/secret|internal/);
  }
});

test('下载前无法安装，活动操作拒绝安装后保留包以便稍后重试',async () => {
  const unit = setup({install:async () => { throw Object.assign(new Error('sensitive operation detail'),{code:'UPDATE_BUSY'}); }});
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_NOT_DOWNLOADED'});
  await unit.invoke('check');
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_NOT_DOWNLOADED'});
  await unit.invoke('download');
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_BUSY'});
  assert.equal((await unit.invoke('status')).phase,'downloaded');
  unit.input.install = async driver => assert.equal(driver,unit.drivers[0]);
  assert.equal((await unit.invoke('install')).phase,'installing');
  assert.equal(unit.calls.installed,2);
  await assert.rejects(unit.invoke('source',{repositoryId:null}),{code:'UPDATE_BUSY'});
});

test('取消明确清除已下载版本，迟到创建的驱动也会被释放',async () => {
  const unit = setup();
  await unit.invoke('check');
  await unit.invoke('download');
  assert.equal((await unit.invoke('cancel')).phase,'idle');
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_NOT_DOWNLOADED'});
  const pending = deferred();
  let created = false, cancelled = 0;
  const delayed = setup({overrides:{createUpdater:async () => { created = true; return pending.promise; }}});
  const checking = delayed.invoke('check');
  const rejected = assert.rejects(checking,{code:'UPDATE_CANCELLED'});
  await until(() => created);
  await delayed.invoke('cancel');
  pending.resolve({cancel:() => cancelled++,check:async () => ({version:'3.0.0'})});
  await rejected;
  assert.equal(cancelled,1);
  assert.equal((await delayed.invoke('status')).availableVersion,null);
});

test('来源保存期间禁止安装与检测，保存失败也不会保留旧来源安装包',async () => {
  const saving = deferred();
  let started = false;
  const unit = setup({sources:[sourceA,sourceB],selection:'repo-a',overrides:{saveSelection:async () => { started = true; return saving.promise; }}});
  await unit.invoke('check');
  await unit.invoke('download');
  const selecting = unit.invoke('source',{repositoryId:'repo-b'});
  const rejected = assert.rejects(selecting,{code:'UPDATE_STATE_FAILED'});
  await until(() => started);
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_BUSY'});
  await assert.rejects(unit.invoke('check'),{code:'UPDATE_BUSY'});
  saving.reject(new Error('sensitive local storage path'));
  await rejected;
  assert.equal((await unit.invoke('status')).phase,'idle');
  await assert.rejects(unit.invoke('install'),{code:'UPDATE_NOT_DOWNLOADED'});
  assert.equal(unit.calls.installed,0);
});

test('迟到的来源枚举不能恢复已解绑仓库',async () => {
  const stale = deferred();
  let slow = false;
  const unit = setup();
  await unit.invoke('check');
  unit.service.getSources = async () => slow ? [] : (slow = true,stale.promise);
  const oldStatus = unit.invoke('status');
  await until(() => slow);
  assert.equal((await unit.invoke('status')).phase,'no-source');
  stale.resolve([sourceA]);
  assert.equal((await oldStatus).phase,'no-source');
  assert.equal(unit.service.snapshot().source,null);
});

test('服务关闭期间的异步初始化不能启动下载或安装',async () => {
  const loading = deferred();
  const unit = setup({overrides:{loadSelection:() => loading.promise}});
  const checking = unit.invoke('check');
  const rejected = assert.rejects(checking,{code:'UPDATE_UNAVAILABLE'});
  unit.service.dispose();
  loading.resolve('repo-a');
  await rejected;
  assert.equal(unit.calls.checked,0);
  assert.equal(unit.calls.installed,0);
});

test('IPC 只允许受信主窗口及动作白名单，不能传入任意 URL、安装路径或请求头',async () => {
  let handler, called = 0;
  const sender = {mainFrame:{},isDestroyed:() => false};
  registerSoftwareUpdateIpc({handle:(name,value) => { assert.equal(name,'v2:software-update'); handler = value; }},{
    isWorkspaceRenderer:value => value === sender,
    softwareUpdateService:{invoke:async (action,input) => { called++; return {action,...input}; }},
  });
  const event = {sender,senderFrame:sender.mainFrame};
  for (const invalid of [null,[],{action:'constructor'},{action:'__proto__'},{action:'install',path:'C:/secret.exe'},{action:'check',url:'https://evil.invalid'},{action:'download',version:'9.9.9'},{action:'check',headers:{Authorization:'secret'}},{action:'source'},{action:'source',repositoryId:9}]) {
    const result = await handler(event,invalid);
    assert.equal(result.ok,false);
    assert.equal(result.error.code,'UPDATE_INVALID_ARGUMENT');
  }
  for (const untrusted of [{sender,senderFrame:{}},{sender:{...sender},senderFrame:sender.mainFrame},{}, {sender:{...sender,isDestroyed:() => true},senderFrame:sender.mainFrame}]) {
    assert.equal((await handler(untrusted,{action:'install'})).error.code,'UPDATE_ACCESS_DENIED');
  }
  assert.equal(called,0);
  assert.deepEqual(await handler(event,{action:'source',repositoryId:'repo-a'}),{ok:true,data:{action:'source',repositoryId:'repo-a'}});
  assert.equal(called,1);
});

test('IPC 将第三方异常替换为固定消息',async () => {
  let handler;
  const sender = {mainFrame:{}};
  registerSoftwareUpdateIpc({handle:(_name,value) => { handler = value; }},{isWorkspaceRenderer:() => true,
    softwareUpdateService:{invoke:async () => { throw Object.assign(new Error('secret Authorization headers'),{code:'UPDATE_DOWNLOAD_FAILED'}); }},
  });
  const result = await handler({sender,senderFrame:sender.mainFrame},{action:'download'});
  assert.equal(result.error.code,'UPDATE_DOWNLOAD_FAILED');
  assert.doesNotMatch(JSON.stringify(result),/secret|Authorization/);
});
