import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { createSoftwareUpdateDriver } from '../src/software-update-driver.mjs';
import { parseMacSoftwareUpdateManifest, quarantineMacUpdate } from '../src/software-update-mac-driver.mjs';

const bytes = Buffer.from('synthetic DMG content, never mounted');
const digest = value => crypto.createHash('sha512').update(value).digest('base64');
function metadata(arch = 'arm64') {
  return {product:'runbook-bridge',platform:'darwin',arch,version:'2.1.0',files:['zip','dmg'].map(ext => ({
    url:`RunbookBridge-2.1.0-darwin-${arch}.${ext}`,size:bytes.length,sha512:digest(bytes),
  }))};
}
async function harness(t,options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mac-update-test-'));
  const arch = options.arch ?? 'arm64';
  const calls = {requests:[],opened:[],revealed:[],quarantined:[]};
  const manifest = metadata(arch);
  const driver = await createSoftwareUpdateDriver({url:`https://updates.example.invalid/updates/darwin/${arch}/`,platform:'darwin',arch,temporaryRoot:root,
    loadUpdater:() => assert.fail('Mac 手动更新不能加载原生自动安装器'),
    fetchImpl:async (url,request) => {
      calls.requests.push({url:String(url),...request});
      if (String(url).endsWith('latest-mac.yml')) return options.manifestResponse?.() ?? new Response(stringify(manifest));
      return options.packageResponse?.(request) ?? new Response(bytes);
    },
    openPath:async file => { calls.opened.push(file); return options.open?.(file) ?? ''; },
    showItemInFolder:file => { calls.revealed.push(file); },
    quarantineFile:async file => { calls.quarantined.push(file); await options.quarantine?.(file); },
  });
  t.after(async () => { await driver.dispose(); await fs.rm(root,{recursive:true,force:true}); });
  const destination = async () => path.join(root,(await fs.readdir(root))[0],manifest.files[1].url);
  return {driver,root,calls,manifest,destination};
}

test('Mac 清单从 ZIP 与 DMG 中只选择对应架构的 DMG，忽略旧下载地址及请求头',() => {
  for (const arch of ['arm64','x64']) {
    const value = metadata(arch);
    value.path = 'https://evil.example.invalid/other.dmg';
    value.files[1].headers = {Authorization:'synthetic-secret'};
    const parsed = parseMacSoftwareUpdateManifest(stringify(value),{arch});
    assert.equal(parsed.files.length,1);
    assert.equal(parsed.files[0].url,`RunbookBridge-2.1.0-darwin-${arch}.dmg`);
    assert.doesNotMatch(JSON.stringify(parsed),/evil|secret|headers/);
    value.files.shift();
    assert.equal(parseMacSoftwareUpdateManifest(stringify(value),{arch}).files.length,1);
  }
});

test('Mac 清单拒绝缺失或重复 DMG、其他产品架构、目录穿越和无界内容',() => {
  const mutations = [
    value => { value.product = 'other'; }, value => { value.platform = 'win32'; }, value => { value.arch = 'x64'; },
    value => { value.version = '02.1.0'; }, value => { value.version = '2.1.0-beta.1'; },
    value => { value.files.pop(); }, value => { value.files = []; }, value => { value.files = [value.files[1],value.files[1]]; },
    value => { value.packages = {}; }, value => { value.files[0].url = 'unknown.zip'; },
    ...['../package.dmg','https://evil.invalid/a.dmg','//evil.invalid/a.dmg','RunbookBridge-2.1.0-darwin-arm64.dmg?token=x','RunbookBridge-2.1.0-darwin-x64.dmg'].map(url => value => { value.files[1].url = url; }),
    ...[0,-1,1.2,1024 ** 3 + 1,'12'].map(size => value => { value.files[1].size = size; }),
    value => { value.files[1].sha512 = 'a'.repeat(88); },
  ];
  for (const mutate of mutations) {
    const value = metadata(); mutate(value);
    assert.throws(() => parseMacSoftwareUpdateManifest(stringify(value),{arch:'arm64'}),{code:'UPDATE_MANIFEST_INVALID'});
  }
  for (const content of ['x'.repeat(65537),`${stringify(metadata())}\nversion: 2.1.0\n`,'a: &a {key: value}\nb: *a']) {
    assert.throws(() => parseMacSoftwareUpdateManifest(content,{arch:'arm64'}),{code:'UPDATE_MANIFEST_INVALID'});
  }
});

test('Mac 来源要求 HTTPS、固定架构路径且没有凭据和查询参数',async () => {
  for (const url of ['http://updates.invalid/updates/darwin/arm64/','https://a:b@updates.invalid/updates/darwin/arm64/','https://updates.invalid/updates/darwin/x64/','https://updates.invalid/updates/darwin/arm64/?token=x','https://updates.invalid/updates/darwin/arm64/#x']) {
    await assert.rejects(createSoftwareUpdateDriver({url,platform:'darwin',arch:'arm64'}),{code:'UPDATE_SOURCE_INVALID'});
  }
  await assert.rejects(createSoftwareUpdateDriver({url:'https://updates.invalid/updates/darwin/ia32/',platform:'darwin',arch:'ia32'}),{code:'UPDATE_SOURCE_INVALID'});
});

test('两种架构仅下载 DMG，完成隔离标记与校验后才允许显式打开及定位',async t => {
  for (const arch of ['arm64','x64']) await t.test(arch,async t => {
    const unit = await harness(t,{arch});
    await assert.rejects(unit.driver.openInstaller(),{code:'UPDATE_NOT_DOWNLOADED'});
    assert.equal((await unit.driver.check()).version,'2.1.0');
    assert.equal(unit.calls.requests.length,1);
    const progress = [];
    await unit.driver.download(value => progress.push(value));
    const file = await unit.destination();
    assert.deepEqual(await fs.readFile(file),bytes);
    assert.deepEqual(unit.calls.quarantined,[file]);
    assert.deepEqual(unit.calls.opened,[]);
    assert.equal(progress.at(-1).percent,100);
    await unit.driver.openInstaller();
    await unit.driver.openInstaller({reveal:true});
    assert.deepEqual(unit.calls.opened,[file]);
    assert.deepEqual(unit.calls.revealed,[file]);
    for (const request of unit.calls.requests) {
      assert.equal(request.redirect,'error'); assert.equal(request.credentials,'omit');
      assert.deepEqual(request.headers,{'Accept-Encoding':'identity'});
      assert.doesNotMatch(request.url,/zip$/);
    }
    await unit.driver.dispose();
    assert.deepEqual(await fs.readFile(file),bytes,'系统接手后退出不能删除 DMG');
  });
});

test('不存在的 Mac 清单明确提示未发布，其他错误与超限内容使用固定错误',async t => {
  for (const [response,code] of [
    [() => new Response('',{status:404}),'UPDATE_NOT_PUBLISHED'],
    [() => new Response('',{status:302,headers:{location:'https://evil.invalid'}}),'UPDATE_CHECK_FAILED'],
    [() => new Response('x'.repeat(65537)),'UPDATE_MANIFEST_INVALID'],
    [() => new Response('x',{headers:{'content-length':'65537'}}),'UPDATE_MANIFEST_INVALID'],
    [() => new Response(stringify(metadata()),{headers:{'content-length':'1'}}),'UPDATE_MANIFEST_INVALID'],
  ]) {
    const unit = await harness(t,{manifestResponse:response});
    await assert.rejects(unit.driver.check(),{code});
    assert.deepEqual(await fs.readdir(unit.root),[]);
  }
});

test('篡改、截断、超限、重定向及隔离标记失败的下载都清理文件且不能打开',async t => {
  for (const [response,code] of [
    [() => new Response(Buffer.alloc(bytes.length)),'UPDATE_INTEGRITY_FAILED'],
    [() => new Response(bytes.subarray(1)),'UPDATE_INTEGRITY_FAILED'],
    [() => new Response(Buffer.concat([bytes,bytes])),'UPDATE_INTEGRITY_FAILED'],
    [() => new Response(bytes,{headers:{'content-length':String(bytes.length+1)}}),'UPDATE_INTEGRITY_FAILED'],
    [() => new Response('',{status:302,headers:{location:'https://evil.invalid'}}),'UPDATE_DOWNLOAD_FAILED'],
  ]) {
    const unit = await harness(t,{packageResponse:response});
    await unit.driver.check();
    await assert.rejects(unit.driver.download(),{code});
    await assert.rejects(unit.driver.openInstaller(),{code:'UPDATE_NOT_DOWNLOADED'});
    assert.deepEqual(await fs.readdir(unit.root),[]);
  }
  const unit = await harness(t,{quarantine:() => { throw new Error('synthetic private path'); }});
  await unit.driver.check();
  await assert.rejects(unit.driver.download(),error => error.code === 'UPDATE_DOWNLOAD_FAILED' && !error.message.includes('private'));
  assert.deepEqual(await fs.readdir(unit.root),[]);
});

test('下载取消与释放不会留下未交给系统的安装包',async t => {
  const unit = await harness(t);
  await unit.driver.check();
  await assert.rejects(unit.driver.download(() => { void unit.driver.cancel(); }),{code:'UPDATE_CANCELLED'});
  await unit.driver.dispose();
  assert.deepEqual(await fs.readdir(unit.root),[]);
  const ready = await harness(t);
  await ready.driver.check(); await ready.driver.download(); await ready.driver.dispose();
  assert.deepEqual(await fs.readdir(ready.root),[]);
});

test('打开或定位前拒绝下载后的修改、缺失、目录和符号链接',async t => {
  for (const change of ['modified','missing','directory','symlink']) await t.test(change,async t => {
    const unit = await harness(t);
    await unit.driver.check(); await unit.driver.download();
    const file = await unit.destination();
    await fs.unlink(file);
    if (change === 'modified') await fs.writeFile(file,Buffer.alloc(bytes.length));
    if (change === 'directory') await fs.mkdir(file);
    if (change === 'symlink') {
      const target = path.join(unit.root,'synthetic-target'); await fs.writeFile(target,bytes);
      try { await fs.symlink(target,file); } catch (error) { if (error.code === 'EPERM') return t.skip('当前系统不允许创建文件符号链接'); throw error; }
    }
    await assert.rejects(unit.driver.openInstaller(),{code:'UPDATE_INTEGRITY_FAILED'});
    await assert.rejects(unit.driver.openInstaller({reveal:true}),{code:'UPDATE_INTEGRITY_FAILED'});
    assert.deepEqual(unit.calls.opened,[]); assert.deepEqual(unit.calls.revealed,[]);
  });
});

test('复核后的来源取消或文件替换仍然禁止系统打开',async t => {
  const cancelled = await harness(t);
  await cancelled.driver.check(); await cancelled.driver.download();
  await assert.rejects(cancelled.driver.openInstaller({beforeOpen:() => { void cancelled.driver.cancel(); }}),{code:'UPDATE_CANCELLED'});
  assert.deepEqual(cancelled.calls.opened,[]);
  const changed = await harness(t);
  await changed.driver.check(); await changed.driver.download();
  await assert.rejects(changed.driver.openInstaller({beforeOpen:async () => {
    const file = await changed.destination(); await fs.unlink(file); await fs.writeFile(file,Buffer.alloc(bytes.length));
  }}),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.deepEqual(changed.calls.opened,[]);
});

test('系统打开失败可重试或定位，错误路径不返回给界面',async t => {
  let failed = true;
  const unit = await harness(t,{open:() => failed ? 'synthetic private system error' : ''});
  await unit.driver.check(); await unit.driver.download();
  await assert.rejects(unit.driver.openInstaller(),error => error.code === 'UPDATE_OPEN_FAILED' && !error.message.includes('private'));
  await unit.driver.openInstaller({reveal:true});
  failed = false; await unit.driver.openInstaller();
  assert.equal(unit.calls.opened.length,2); assert.equal(unit.calls.revealed.length,1);
});

test('下载目录被替换后拒绝打开，释放驱动不能删除替换目录的文件',async t => {
  const unit = await harness(t);
  await unit.driver.check(); await unit.driver.download();
  const file = await unit.destination(), directory = path.dirname(file);
  await fs.rename(directory,`${directory}-original`);
  await fs.mkdir(directory); await fs.writeFile(file,bytes);
  await assert.rejects(unit.driver.openInstaller(),{code:'UPDATE_INTEGRITY_FAILED'});
  await unit.driver.dispose();
  assert.deepEqual(await fs.readFile(file),bytes);
  assert.deepEqual(unit.calls.opened,[]);
});

test('来源复查期间文件被删除时按完整性失败处理',async t => {
  const unit = await harness(t);
  await unit.driver.check(); await unit.driver.download();
  await assert.rejects(unit.driver.openInstaller({beforeOpen:async () => fs.unlink(await unit.destination())}),{code:'UPDATE_INTEGRITY_FAILED'});
  assert.deepEqual(unit.calls.opened,[]);
});

test('隔离标记使用固定系统命令及参数，不启动 shell 或移除隔离属性',async () => {
  let call;
  await quarantineMacUpdate('/synthetic path/update.dmg',{exec:async (...args) => { call = args; }});
  assert.equal(call[0],'/usr/bin/xattr');
  assert.deepEqual(call[1].slice(0,2),['-w','com.apple.quarantine']);
  assert.match(call[1][2],/^0081;[0-9a-f]+;RunbookBridge;$/);
  assert.equal(call[1][3],'/synthetic path/update.dmg');
  assert.equal(call[2].shell,undefined);
});

test('Mac 原生隔离属性可写入并读取合成文件',{skip:process.platform !== 'darwin'},async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mac-quarantine-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'synthetic.dmg'); await fs.writeFile(file,bytes);
  await quarantineMacUpdate(file);
  const {stdout} = await promisify(execFile)('/usr/bin/xattr',['-p','com.apple.quarantine',file]);
  assert.match(stdout,/^0081;[0-9a-f]+;RunbookBridge;/);
});
