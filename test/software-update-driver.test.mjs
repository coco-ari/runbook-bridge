import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { stringify } from 'yaml';
import { createSoftwareUpdateDriver, parseSoftwareUpdateManifest } from '../src/software-update-driver.mjs';

const base = 'https://updates.example.invalid/updates/win32/x64/';
const fixture = Buffer.from('synthetic installer content only for tests');
const digest = value => crypto.createHash('sha512').update(value).digest('base64');
function metadata(bytes = fixture) {
  return {product:'runbook-bridge',platform:'win32',arch:'x64',version:'2.1.0',releaseNotes:'合成更新说明',releaseDate:'2026-10-02',
    files:[{url:'RunbookBridge-2.1.0-win32-x64.exe',size:bytes.length,sha512:digest(bytes)}]};
}
function streamResponse(chunks,{headers = {},status = 200,onCancel = () => {}} = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
    cancel:reason => onCancel(reason),
  }),{status,headers});
}
async function harness(t,options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-update-driver-test-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const destination = path.join(directory,'update.exe');
  const bytes = options.bytes ?? fixture;
  const release = options.manifest ?? metadata(bytes);
  const calls = {requests:[],updaters:[],installed:[],spawned:[],children:[],quitRequests:0,fallbacks:0,tokenCancelled:0};
  class MockNsisUpdater extends EventEmitter {
    constructor(configuration) {
      super();
      calls.updaters.push(this);
      this.configuration = configuration;
      this.provider = new configuration.updateProvider();
      this.httpExecutor = {};
      this.installerPath = destination;
      this.token = {cancel:() => { calls.tokenCancelled++; }};
      this.on('error',() => {});
    }
    async checkForUpdates() {
      this.info = await this.provider.getLatestVersion();
      return {isUpdateAvailable:options.available !== false,cancellationToken:this.token};
    }
    async downloadUpdate(token) {
      assert.equal(token,this.token);
      if (options.downloadError) throw options.downloadError;
      if (options.cached) return [destination];
      const file = this.provider.resolveFiles()[0];
      await this.httpExecutor.download(options.target ?? file.url,destination,{
        headers:{Authorization:'synthetic-must-not-be-sent',Cookie:'synthetic-must-not-be-sent'},
        onProgress:value => this.emit('download-progress',value),
      });
      return [destination];
    }
    quitAndInstall(...args) {
      calls.installed.push(args);
      if (options.installError) { this.emit('error',new Error('synthetic installation error with private path')); return; }
      this.spawnLog(destination,['--updated'],undefined,'ignore').catch(() => { calls.fallbacks++; });
      setImmediate(() => { calls.quitRequests++; });
    }
    async spawnLog() { assert.fail('测试不得调用原始安装启动器'); }
  }
  const fetchImpl = async (target,request) => {
    calls.requests.push({url:String(target),...request});
    if (String(target).endsWith('/latest.yml')) {
      if (options.manifestError) throw options.manifestError;
      return options.manifestResponse ? options.manifestResponse(request) : new Response(stringify(release));
    }
    if (options.packageError) throw options.packageError;
    return options.packageResponse ? options.packageResponse(request) : streamResponse([bytes.subarray(0,7),bytes.subarray(7)]);
  };
  const driver = await createSoftwareUpdateDriver({url:base,platform:'win32',arch:'x64',fetchImpl,
    loadUpdater:async () => options.defaultExport ? {default:{NsisUpdater:MockNsisUpdater}} : {NsisUpdater:MockNsisUpdater},
    spawnImpl:(command,args,configuration) => {
      calls.spawned.push({command,args,configuration});
      const child = new EventEmitter();
      child.unref = () => { child.unreferenced = true; };
      calls.children.push(child);
      if (!options.manualSpawn) queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  t.after(() => driver.dispose());
  return {driver,calls,destination,release,bytes};
}

test('更新清单只保留已验证字段，固定产品、平台、架构、文件名与摘要',() => {
  const document = metadata();
  document.path = 'https://evil.example.invalid/other.exe';
  document.sha512 = 'untrusted legacy value';
  document.files[0].headers = {Authorization:'synthetic-secret'};
  document.files[0].packageInfo = {path:'https://evil.example.invalid/package.7z'};
  const parsed = parseSoftwareUpdateManifest(stringify(document),{platform:'win32',arch:'x64'});
  assert.equal(parsed.files.length,1);
  assert.deepEqual(parsed.files[0],{url:'RunbookBridge-2.1.0-win32-x64.exe',size:fixture.length,sha512:digest(fixture)});
  assert.deepEqual(Object.keys(parsed).sort(),['files','releaseDate','releaseNotes','version']);
  assert.doesNotMatch(JSON.stringify(parsed),/evil|Authorization|secret/);
});

test('元数据拒绝 URL 越界、错误产品平台、坏版本、别名及大小或摘要异常',() => {
  const mutations = [
    value => { value.product = 'another-product'; },
    value => { value.platform = 'darwin'; },
    value => { value.arch = 'arm64'; },
    value => { value.version = '2.2.0-beta.1'; },
    value => { value.version = '02.1.0'; },
    value => { value.files = []; },
    value => { value.files.push({...value.files[0]}); },
    value => { value.packages = {x64:{path:'other.7z'}}; },
    ...['https://evil.example.invalid/a.exe','//evil.example.invalid/a.exe','../update.exe','RunbookBridge-2.1.0-win32-x64.exe?secret=1','RunbookBridge-2.1.0-win32-x64.exe#tag','RunbookBridge-2.2.0-win32-x64.exe'].map(url => value => { value.files[0].url = url; }),
    ...[0,-1,1.5,1024 * 1024 * 1024 + 1,'10'].map(size => value => { value.files[0].size = size; }),
    ...['x'.repeat(88),'A'.repeat(87) + '=',Buffer.alloc(63).toString('base64')].map(sha512 => value => { value.files[0].sha512 = sha512; }),
  ];
  for (const mutation of mutations) {
    const value = metadata(); mutation(value);
    assert.throws(() => parseSoftwareUpdateManifest(stringify(value),{platform:'win32',arch:'x64'}),{code:'UPDATE_MANIFEST_INVALID'});
  }
  for (const content of ['x'.repeat(64 * 1024 + 1),`${stringify(metadata())}\nversion: 2.2.0\n`,'first: &a {text: synthetic}\nsecond: *a\n']) {
    assert.throws(() => parseSoftwareUpdateManifest(content,{platform:'win32',arch:'x64'}),{code:'UPDATE_MANIFEST_INVALID'});
  }
});

test('驱动拒绝 HTTP、带凭据参数或片段的来源及错误更新路径',async () => {
  for (const url of ['http://updates.example.invalid/updates/win32/x64/','https://user:secret@updates.example.invalid/updates/win32/x64/',`${base}?token=secret`,`${base}#secret`,'https://updates.example.invalid/updates/win32/arm64/','https://updates.example.invalid/other/']) {
    await assert.rejects(createSoftwareUpdateDriver({url,platform:'win32',arch:'x64'}),{code:'UPDATE_SOURCE_INVALID'});
  }
  await assert.rejects(createSoftwareUpdateDriver({url:'https://updates.example.invalid/updates/linux/x64/',platform:'linux',arch:'x64'}),{code:'UPDATE_SOURCE_INVALID'});
});

test('检查不下载，固定来源提供器禁用自动安装、自动下载、差分和网络安装器',async t => {
  const unit = await harness(t,{defaultExport:true});
  assert.equal((await unit.driver.check()).version,'2.1.0');
  assert.equal(unit.calls.requests.length,1);
  const updater = unit.calls.updaters[0];
  assert.equal(updater.configuration.provider,'custom');
  for (const flag of ['autoDownload','autoInstallOnAppQuit','allowPrerelease','allowDowngrade']) assert.equal(updater[flag],false);
  for (const flag of ['disableWebInstaller','disableDifferentialDownload']) assert.equal(updater[flag],true);
  assert.equal(updater.logger,null);
  assert.equal(updater.provider.fileExtraDownloadHeaders,null);
  assert.equal(updater.provider.isUseMultipleRangeRequest,false);
  assert.equal(updater.provider.resolveFiles({files:[{url:'https://evil.example.invalid/malware.exe'}]})[0].url.href,`${base}RunbookBridge-2.1.0-win32-x64.exe`);
  assert.equal(unit.calls.installed.length,0);
});

test('分块下载完整顺序写入并校验 SHA512，请求没有凭据且禁止跳转',async t => {
  const bytes = Buffer.from(Array.from({length:400_000},(_value,index) => index % 251));
  const chunks = Array.from({length:40},(_value,index) => bytes.subarray(index * 10_000,(index + 1) * 10_000));
  const unit = await harness(t,{bytes,packageResponse:() => streamResponse(chunks,{headers:{'content-length':String(bytes.length)}})});
  await unit.driver.check();
  const updates = [];
  await unit.driver.download(value => updates.push(value));
  assert.deepEqual(await fs.readFile(unit.destination),bytes);
  assert.equal(updates.length,40);
  assert.equal(updates.at(-1).percent,100);
  assert.equal(updates.at(-1).transferred,bytes.length);
  assert.equal(unit.calls.updaters[0].listenerCount('download-progress'),0);
  for (const request of unit.calls.requests) {
    assert.equal(request.redirect,'error');
    assert.equal(request.credentials,'omit');
    assert.deepEqual(request.headers,{'Accept-Encoding':'identity'});
    assert.ok(request.signal instanceof AbortSignal);
    assert.ok(request.url.startsWith(base));
  }
  await unit.driver.verifyDownloaded();
  await unit.driver.quitAndInstall();
  assert.deepEqual(unit.calls.installed,[[true,true]]);
  assert.equal(unit.calls.spawned[0].configuration.windowsHide,true);
  assert.equal(unit.calls.children[0].unreferenced,true);
});

test('无更新时返回 null，未检查或未下载时不能安装',async t => {
  const unit = await harness(t,{available:false});
  await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_NOT_AVAILABLE'});
  await assert.rejects(unit.driver.quitAndInstall(),{code:'UPDATE_NOT_DOWNLOADED'});
  assert.equal(await unit.driver.check(),null);
  await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_NOT_AVAILABLE'});
  assert.equal(unit.calls.requests.length,1);
});

test('清单 HTTP 失败、跳转和网络错误使用检查错误且不加载更新器',async t => {
  let cancelled = 0;
  for (const options of [
    {manifestResponse:() => streamResponse([fixture],{status:404,onCancel:() => cancelled++})},
    {manifestResponse:() => streamResponse([fixture],{status:302,onCancel:() => cancelled++})},
    {manifestError:new Error('synthetic private network URL and Authorization')},
  ]) {
    const unit = await harness(t,options);
    await assert.rejects(unit.driver.check(),error => error.code === 'UPDATE_CHECK_FAILED' && !error.message.includes('Authorization'));
    assert.equal(unit.calls.updaters.length,0);
  }
  assert.equal(cancelled,2);
});

test('清单超过实际字节上限、伪造长度或提前结束时失败关闭',async t => {
  const content = Buffer.from(stringify(metadata()));
  for (const response of [
    () => streamResponse([content],{headers:{'content-length':String(64 * 1024 + 1)}}),
    () => streamResponse([Buffer.alloc(64 * 1024 + 1)]),
    () => streamResponse([content],{headers:{'content-length':String(content.length + 1)}}),
    () => streamResponse([content],{headers:{'content-length':'invalid'}}),
  ]) {
    const unit = await harness(t,{manifestResponse:response});
    await assert.rejects(unit.driver.check(),{code:'UPDATE_MANIFEST_INVALID'});
    assert.equal(unit.calls.updaters.length,0);
  }
});

test('篡改、截断、超长或伪造长度的安装包均删除临时文件并禁止安装',async t => {
  const tampered = Buffer.from(fixture); tampered[0] ^= 1;
  for (const response of [
    () => streamResponse([tampered]),
    () => streamResponse([fixture.subarray(0,fixture.length - 1)]),
    () => streamResponse([fixture,Buffer.from('excess')]),
    () => streamResponse([fixture],{headers:{'content-length':String(fixture.length + 1)}}),
    () => streamResponse([fixture],{headers:{'content-length':'invalid'}}),
  ]) {
    const unit = await harness(t,{packageResponse:response});
    await unit.driver.check();
    await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_INTEGRITY_FAILED'});
    await assert.rejects(fs.stat(unit.destination),{code:'ENOENT'});
    await assert.rejects(unit.driver.quitAndInstall(),{code:'UPDATE_NOT_DOWNLOADED'});
    assert.equal(unit.calls.updaters[0].listenerCount('download-progress'),0);
  }
});

test('安装包响应跳转和错误不会留下文件，也不会跟随新来源',async t => {
  let cancelled = false;
  const unit = await harness(t,{packageResponse:() => streamResponse([fixture],{status:302,headers:{location:'https://evil.example.invalid/update.exe'},onCancel:() => { cancelled = true; }})});
  await unit.driver.check();
  await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_DOWNLOAD_FAILED'});
  assert.equal(cancelled,true);
  assert.equal(unit.calls.requests.length,2);
  assert.ok(unit.calls.requests.every(request => request.url.startsWith(base)));
  await assert.rejects(fs.stat(unit.destination),{code:'ENOENT'});
});

test('更新器不能利用自定义下载器请求其他地址',async t => {
  const unit = await harness(t,{target:'https://evil.example.invalid/other.exe'});
  await unit.driver.check();
  await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_SOURCE_INVALID'});
  assert.equal(unit.calls.requests.length,1);
  await assert.rejects(fs.stat(unit.destination),{code:'ENOENT'});
});

test('下载中取消关闭文件句柄并清理临时文件，晚到安装调用失败',async t => {
  const unit = await harness(t,{packageResponse:() => streamResponse([fixture.subarray(0,5),fixture.subarray(5)])});
  await unit.driver.check();
  await assert.rejects(unit.driver.download(() => unit.driver.cancel()),{code:'UPDATE_CANCELLED'});
  await assert.rejects(fs.stat(unit.destination),{code:'ENOENT'});
  await fs.writeFile(unit.destination,'文件句柄已关闭');
  await fs.rm(unit.destination);
  await assert.rejects(unit.driver.verifyDownloaded(),{code:'UPDATE_CANCELLED'});
  await assert.rejects(unit.driver.quitAndInstall(),{code:'UPDATE_CANCELLED'});
  assert.equal(unit.calls.installed.length,0);
  assert.equal(unit.calls.tokenCancelled,1);
});

test('已下载包在检测后被替换时安装入口重新哈希，等长篡改也不能通过',async t => {
  const unit = await harness(t);
  await unit.driver.check();
  await unit.driver.download(() => {});
  await unit.driver.verifyDownloaded();
  const tampered = Buffer.from(fixture); tampered[0] ^= 1;
  await fs.writeFile(unit.destination,tampered);
  await assert.rejects(unit.driver.quitAndInstall(),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.equal(unit.calls.installed.length,0);
  await fs.writeFile(unit.destination,fixture);
  await unit.driver.quitAndInstall();
  assert.equal(unit.calls.installed.length,1);
});

test('复用下载缓存时安装前仍校验大小、文件类型和内容，底层异常不泄露路径',async t => {
  const unit = await harness(t,{cached:true});
  await unit.driver.check();
  await unit.driver.download(() => {});
  await assert.rejects(unit.driver.verifyDownloaded(),error => error.code === 'UPDATE_INTEGRITY_FAILED' && !error.message.includes(unit.destination));
  await fs.writeFile(unit.destination,'truncated');
  await assert.rejects(unit.driver.verifyDownloaded(),{code:'UPDATE_INTEGRITY_FAILED'});
  await fs.rm(unit.destination);
  await fs.mkdir(unit.destination);
  await assert.rejects(unit.driver.verifyDownloaded(),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.equal(unit.calls.installed.length,0);
});

test('校验或签名错误统一为完整性失败，安装器错误固定脱敏',async t => {
  for (const code of ['ERR_UPDATER_CHECKSUM_MISMATCH','ERR_UPDATER_INVALID_SIGNATURE']) {
    const unit = await harness(t,{downloadError:Object.assign(new Error('synthetic secret path'),{code})});
    await unit.driver.check();
    await assert.rejects(unit.driver.download(() => {}),{code:'UPDATE_INTEGRITY_FAILED'});
  }
  const installation = await harness(t,{installError:true});
  await installation.driver.check();
  await installation.driver.download(() => {});
  await assert.rejects(installation.driver.quitAndInstall(),error => error.code === 'UPDATE_INSTALL_FAILED' && !error.message.includes('private'));
});

test('安装等待真实 spawn 事件，库提前请求退出时驱动仍保持未完成',async t => {
  const unit = await harness(t,{manualSpawn:true});
  await unit.driver.check();
  await unit.driver.download(() => {});
  let completed = false;
  const installing = unit.driver.quitAndInstall().then(() => { completed = true; });
  while (!unit.calls.children.length) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unit.calls.quitRequests,1);
  assert.equal(completed,false);
  unit.calls.children[0].emit('spawn');
  await installing;
  assert.equal(completed,true);
  assert.equal(unit.calls.children[0].unreferenced,true);
});

test('异步启动失败明确返回失败，不触发库不可观察的安装旁路',async t => {
  const unit = await harness(t,{manualSpawn:true});
  await unit.driver.check();
  await unit.driver.download(() => {});
  const original = unit.calls.updaters[0].spawnLog;
  const installing = unit.driver.quitAndInstall();
  const rejected = assert.rejects(installing,error => error.code === 'UPDATE_INSTALL_FAILED' && !error.message.includes('sensitive'));
  while (!unit.calls.children.length) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  unit.calls.children[0].emit('error',Object.assign(new Error('sensitive installation path'),{code:'ENOENT'}));
  await rejected;
  assert.equal(unit.calls.fallbacks,0);
  assert.equal(unit.calls.children[0].unreferenced,undefined);
  assert.equal(unit.calls.updaters[0].spawnLog,original);
  assert.equal(unit.calls.updaters[0].quitAndInstallCalled,false);
});

test('安装期间异步 updater error 不会漏过驱动监听器',async t => {
  const unit = await harness(t,{manualSpawn:true});
  await unit.driver.check();
  await unit.driver.download(() => {});
  const installing = unit.driver.quitAndInstall();
  const rejected = assert.rejects(installing,{code:'UPDATE_INSTALL_FAILED'});
  while (!unit.calls.children.length) await new Promise(resolve => setImmediate(resolve));
  unit.calls.updaters[0].emit('error',new Error('sensitive asynchronous installer failure'));
  unit.calls.children[0].emit('spawn');
  await rejected;
  assert.equal(unit.calls.updaters[0].listenerCount('error'),1);
});

test('真实 NsisUpdater 使用固定来源完成检查、缓存下载与签名配置读取',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-real-updater-test-'));
  const drivers = [];
  t.after(async () => {
    for (const driver of drivers) driver.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  });
  const appUpdateConfigPath = path.join(directory,'app-update.yml');
  await fs.writeFile(appUpdateConfigPath,stringify({updaterCacheDirName:'synthetic-updater-cache'}));
  const fakeApp = {
    version:'2.0.0',name:'synthetic-runbook-update-test',isPackaged:true,
    whenReady:async () => {},appUpdateConfigPath,
    userDataPath:path.join(directory,'user-data'),baseCachePath:path.join(directory,'cache'),
    onQuit:() => assert.fail('下载不应注册自动退出安装处理器'),
    quit:() => assert.fail('集成测试不允许退出应用'),
  };
  const {NsisUpdater} = await import('electron-updater/out/NsisUpdater.js');
  const updaters = [], requests = [];
  let signatureChecks = 0;
  class TestNsisUpdater extends NsisUpdater {
    constructor(options) {
      super(options,fakeApp);
      this.httpExecutor = {};
      updaters.push(this);
    }
    async verifySignature(file) {
      signatureChecks++;
      return super.verifySignature(file);
    }
  }
  const fetchImpl = async (target,request) => {
    const url = String(target);
    requests.push(url);
    assert.equal(request.redirect,'error');
    assert.equal(request.credentials,'omit');
    assert.deepEqual(request.headers,{'Accept-Encoding':'identity'});
    if (url === `${base}latest.yml`) return new Response(stringify(metadata()));
    assert.equal(url,`${base}RunbookBridge-2.1.0-win32-x64.exe`);
    return streamResponse([fixture.subarray(0,10),fixture.subarray(10)],{headers:{'content-length':String(fixture.length)}});
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const driver = await createSoftwareUpdateDriver({url:base,platform:'win32',arch:'x64',fetchImpl,
      loadUpdater:async () => ({NsisUpdater:TestNsisUpdater}),spawnImpl:() => assert.fail('集成测试不得启动安装器'),
    });
    drivers.push(driver);
    assert.equal((await driver.check()).version,'2.1.0');
    const progress = [];
    await driver.download(value => progress.push(value));
    await driver.verifyDownloaded();
    const updater = updaters[attempt];
    assert.ok(updater instanceof NsisUpdater);
    assert.equal(updater.installerPath,path.join(directory,'cache','synthetic-updater-cache','pending','RunbookBridge-2.1.0-win32-x64.exe'));
    assert.deepEqual(await fs.readFile(updater.installerPath),fixture);
    assert.deepEqual(await updater.configOnDisk.value,{updaterCacheDirName:'synthetic-updater-cache'});
    if (attempt === 0) assert.equal(progress.at(-1).percent,100);
  }
  assert.equal(signatureChecks,1);
  assert.deepEqual(requests,[`${base}latest.yml`,`${base}RunbookBridge-2.1.0-win32-x64.exe`,`${base}latest.yml`]);
});

test('真实 NsisUpdater 静默更新后重启，沿用安装范围，启动失败不会绕过可观察的安装入口',async t => {
  const require = createRequire(import.meta.url);
  const updaterRequire = createRequire(require.resolve('electron-updater/out/BaseUpdater.js'));
  const electronPath = updaterRequire.resolve('electron');
  const previousElectron = require.cache[electronPath];
  const autoUpdater = new EventEmitter();
  const events = [];
  autoUpdater.on('before-quit-for-update',() => events.push('before-quit'));
  // 只替换 Electron 退出通知，不修改真实更新器的安装参数转换或启动逻辑。
  require.cache[electronPath] = {id:electronPath,filename:electronPath,loaded:true,exports:{
    autoUpdater,shell:{openPath:() => assert.fail('启动失败不得绕过受控安装入口')},
  }};
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });
  const {NsisUpdater} = await import('electron-updater/out/NsisUpdater.js');
  for (const errorCode of [null,'ENOENT','EACCES']) {
    await t.test(errorCode ?? '成功启动',async st => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-real-install-test-'));
      let driver;
      st.after(async () => {
        driver?.dispose();
        await fs.rm(directory,{recursive:true,force:true});
      });
      const appUpdateConfigPath = path.join(directory,'app-update.yml');
      await fs.writeFile(appUpdateConfigPath,stringify({updaterCacheDirName:'synthetic-updater-cache'}));
      const fakeApp = {
        version:'2.0.0',name:'synthetic-runbook-install-test',isPackaged:true,
        whenReady:async () => {},appUpdateConfigPath,
        userDataPath:path.join(directory,'user-data'),baseCachePath:path.join(directory,'cache'),
        onQuit:() => assert.fail('测试不得注册退出时自动安装'),quit:() => events.push('quit'),
      };
      let updater;
      class TestNsisUpdater extends NsisUpdater {
        constructor(options) {
          super(options,fakeApp);
          this.httpExecutor = {};
          updater = this;
        }
      }
      const launches = [];
      driver = await createSoftwareUpdateDriver({url:base,platform:'win32',arch:'x64',
        loadUpdater:async () => ({NsisUpdater:TestNsisUpdater}),
        fetchImpl:async target => new Response(String(target).endsWith('/latest.yml') ? stringify(metadata()) : fixture),
        spawnImpl:(command,args,options) => {
          const child = new EventEmitter();
          child.unref = () => { child.unreferenced = true; };
          launches.push({command,args,options,child});
          queueMicrotask(() => errorCode
            ? child.emit('error',Object.assign(new Error('synthetic private installation path'),{code:errorCode}))
            : child.emit('spawn'));
          return child;
        },
      });
      await driver.check();
      await driver.download(() => {});
      // 即使交互安装默认不启动应用，本次静默更新仍必须显式要求启动。
      updater.autoRunAppAfterInstall = false;
      const originalSpawn = updater.spawnLog;
      const eventCount = events.length;
      if (errorCode) {
        await assert.rejects(driver.quitAndInstall(),error => error.code === 'UPDATE_INSTALL_FAILED' && !error.message.includes('private'));
        assert.equal(updater.quitAndInstallCalled,false);
      } else {
        await driver.quitAndInstall();
        assert.equal(updater.quitAndInstallCalled,true);
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(launches.length,1);
      assert.equal(launches[0].command,updater.installerPath);
      // 不指定安装目录或用户范围，由安装器读取现有注册信息，保留原安装位置和范围。
      assert.deepEqual(launches[0].args,['--updated','/S','--force-run']);
      assert.equal(launches[0].options.windowsHide,true);
      assert.equal(launches[0].options.detached,true);
      assert.equal(launches[0].child.unreferenced,errorCode ? undefined : true);
      assert.equal(updater.spawnLog,originalSpawn);
      assert.deepEqual(events.slice(eventCount),['before-quit','quit']);
    });
  }
});
