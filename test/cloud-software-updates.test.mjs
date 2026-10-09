import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createCloudServer } from '../services/cloud-config/server.mjs';
import { prepareCloudUpdate } from '../scripts/prepare-cloud-update.mjs';

const ADMIN = 'synthetic-cloud-release-admin-token-0001';
const VERSION = '2.0.0';
const WINDOWS_NAME = `RunbookBridge-${VERSION}-win32-x64.exe`;

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-cloud-updates-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'runbook-bridge',version:VERSION}));
  await fs.mkdir(path.join(root,'dist'));
  return root;
}

async function windowsRelease(t) {
  const root = await workspace(t);
  const source = path.join(root,'dist',`Agent运维工作台 Setup ${VERSION}.exe`);
  const bytes = Buffer.from('synthetic-package-bytes-0123456789');
  await fs.writeFile(source,bytes);
  await fs.writeFile(`${source}.blockmap`,'synthetic-blockmap');
  const result = await prepareCloudUpdate({root,platform:'win32',arch:'x64',now:new Date('2026-10-02T00:00:00Z')});
  return {root,source,bytes,...result,releasesDirectory:path.join(root,'artifacts','cloud-updates')};
}

async function cloud(t,releasesDirectory) {
  const server = createCloudServer({adminToken:ADMIN,releasesDirectory});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function rawGet(origin,requestPath) {
  return new Promise((resolve,reject) => {
    const url = new URL(origin);
    const request = http.get({hostname:url.hostname,port:url.port,path:requestPath},response => {
      const chunks = [];
      response.on('data',chunk => chunks.push(chunk));
      response.on('end',() => resolve({status:response.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',reject);
    });
    request.on('error',reject);
  });
}

test('Windows 发布准备生成标准 SHA-512 清单和 ASCII 安装包，原文件保持不变',async t => {
  const release = await windowsRelease(t);
  const manifest = YAML.parse(await fs.readFile(path.join(release.directory,'latest.yml'),'utf8'));
  assert.deepEqual(manifest,release.manifest);
  assert.equal(manifest.product,'runbook-bridge');
  assert.equal(manifest.platform,'win32');
  assert.equal(manifest.arch,'x64');
  assert.equal(manifest.version,VERSION);
  assert.equal(manifest.releaseDate,'2026-10-02T00:00:00.000Z');
  assert.deepEqual(manifest.files,[{url:WINDOWS_NAME,sha512:crypto.createHash('sha512').update(release.bytes).digest('base64'),size:release.bytes.length}]);
  assert.equal(manifest.path,WINDOWS_NAME);
  assert.equal(manifest.sha512,manifest.files[0].sha512);
  assert.deepEqual(await fs.readFile(path.join(release.directory,WINDOWS_NAME)),release.bytes);
  assert.deepEqual(await fs.readFile(release.source),release.bytes);
  assert.equal(await fs.readFile(path.join(release.directory,`${WINDOWS_NAME}.blockmap`),'utf8'),'synthetic-blockmap');
  assert.ok((await fs.readdir(release.directory)).every(name => !name.startsWith('.prepare-')));
});

test('macOS 分别准备 x64 与 arm64 ZIP/DMG，缺失 ZIP 时不发布清单',async t => {
  const root = await workspace(t);
  for (const arch of ['x64','arm64']) {
    for (const extension of ['zip','dmg']) await fs.writeFile(path.join(root,'dist',`RunbookBridge-${VERSION}-mac-${arch}.${extension}`),`synthetic-${arch}-${extension}`);
    const result = await prepareCloudUpdate({root,platform:'darwin',arch});
    assert.equal(result.manifestName,'latest-mac.yml');
    assert.equal(result.manifest.arch,arch);
    assert.deepEqual(result.manifest.files.map(file => file.url),['zip','dmg'].map(extension => `RunbookBridge-${VERSION}-darwin-${arch}.${extension}`));
    for (const file of result.manifest.files) {
      const bytes = await fs.readFile(path.join(result.directory,file.url));
      assert.equal(file.size,bytes.length);
      assert.equal(file.sha512,crypto.createHash('sha512').update(bytes).digest('base64'));
    }
  }
  const outputDirectory = path.join(root,'missing-zip');
  await fs.unlink(path.join(root,'dist',`RunbookBridge-${VERSION}-mac-arm64.zip`));
  await assert.rejects(prepareCloudUpdate({root,platform:'darwin',arch:'arm64',outputDirectory}),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(outputDirectory,'darwin','arm64','latest-mac.yml')),{code:'ENOENT'});
});

test('同版本文件不可覆盖不同内容，失败保留旧清单并拒绝预发布版本和超大包',async t => {
  const release = await windowsRelease(t);
  await prepareCloudUpdate({root:release.root,platform:'win32',arch:'x64'});
  const previous = await fs.readFile(path.join(release.directory,'latest.yml'),'utf8');
  await fs.writeFile(release.source,'synthetic-changed-package');
  await assert.rejects(prepareCloudUpdate({root:release.root,platform:'win32',arch:'x64'}),/同版本文件/);
  assert.equal(await fs.readFile(path.join(release.directory,'latest.yml'),'utf8'),previous);
  assert.deepEqual(await fs.readFile(path.join(release.directory,WINDOWS_NAME)),release.bytes);
  await fs.writeFile(path.join(release.root,'package.json'),JSON.stringify({name:'runbook-bridge',version:'2.0.1-beta.1'}));
  await assert.rejects(prepareCloudUpdate({root:release.root,platform:'win32',arch:'x64'}),/稳定三段版本/);
  await assert.rejects(prepareCloudUpdate({root:release.root,platform:'linux',arch:'x64'}),/仅支持/);
  await fs.writeFile(path.join(release.root,'package.json'),JSON.stringify({name:'runbook-bridge',version:VERSION}));
  await fs.truncate(release.source,1024*1024*1024+1);
  await assert.rejects(prepareCloudUpdate({root:release.root,platform:'win32',arch:'x64'}),/大小在限制内/);
  assert.ok((await fs.readdir(release.directory)).every(name => !name.startsWith('.prepare-')));
});

test('升级分发公开只读，支持 HEAD 与有界单范围，不接收任何仓库或管理员凭据',async t => {
  const release = await windowsRelease(t);
  const origin = await cloud(t,release.releasesDirectory);
  const feed = `${origin}/updates/win32/x64`;
  const manifestResponse = await fetch(`${feed}/latest.yml?noCache=synthetic`);
  assert.equal(manifestResponse.status,200);
  assert.equal(manifestResponse.headers.get('cache-control'),'no-store');
  assert.deepEqual(YAML.parse(await manifestResponse.text()),release.manifest);
  const response = await fetch(`${feed}/${WINDOWS_NAME}`);
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),release.bytes);
  const head = await fetch(`${feed}/${WINDOWS_NAME}`,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.headers.get('content-length'),String(release.bytes.length));
  assert.equal(await head.text(),'');
  for (const [range,expected] of [['bytes=2-5',release.bytes.subarray(2,6)],['bytes=5-',release.bytes.subarray(5)],['bytes=-4',release.bytes.subarray(-4)],['bytes=2-9999',release.bytes.subarray(2)]]) {
    const partial = await fetch(`${feed}/${WINDOWS_NAME}`,{headers:{Range:range}});
    assert.equal(partial.status,206);
    assert.equal(partial.headers.get('content-length'),String(expected.length));
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()),expected);
  }
  for (const range of ['bytes=0-1,3-4','bytes=99999-','bytes=4-2','bytes=-0','bytes=9007199254740993-','items=0-1']) {
    const rejected = await fetch(`${feed}/${WINDOWS_NAME}`,{headers:{Range:range}});
    assert.equal(rejected.status,416);
    assert.equal(rejected.headers.get('content-range'),`bytes */${release.bytes.length}`);
  }
  for (const headers of [{Authorization:`Bearer ${ADMIN}`},{Authorization:'Bearer synthetic-repository-token'},{Cookie:'token=synthetic-cookie'},{'Proxy-Authorization':'synthetic-proxy'}]) {
    const rejected = await fetch(`${feed}/latest.yml`,{headers});
    assert.equal(rejected.status,400);
    const body = await rejected.text();
    assert.match(body,/CLOUD_UPDATE_CREDENTIALS_FORBIDDEN/);
    assert.doesNotMatch(body,/synthetic/);
  }
  assert.equal((await fetch(`${feed}/latest.yml`,{method:'POST',body:'synthetic-package'})).status,405);
  assert.equal((await fetch(`${feed}/${WINDOWS_NAME}.blockmap`)).status,200);
  assert.equal((await fetch(`${origin}/healthz`)).status,200);
});

test('未配置分发目录和缺失版本具有不同固定错误，不影响已有云服务',async t => {
  const root = await workspace(t);
  const unconfigured = await cloud(t);
  const configured = await cloud(t,root);
  const one = await fetch(`${unconfigured}/updates/win32/x64/latest.yml`);
  const two = await fetch(`${configured}/updates/win32/x64/latest.yml`);
  assert.equal(one.status,404);
  assert.equal(two.status,404);
  assert.equal((await one.json()).error.code,'CLOUD_UPDATES_UNCONFIGURED');
  assert.equal((await two.json()).error.code,'CLOUD_UPDATE_NOT_FOUND');
  assert.equal((await fetch(`${unconfigured}/healthz`)).status,200);
});

test('升级路由拒绝目录列表、跨平台文件、编码穿越和特殊文件',async t => {
  const release = await windowsRelease(t);
  const origin = await cloud(t,release.releasesDirectory);
  const paths = [
    '/updates/', '/updates/win32/x64/', '/updates/win32/x64/latest-mac.yml',
    '/updates/darwin/ia32/latest-mac.yml', `/updates/win32/arm64/${WINDOWS_NAME}`,
    '/updates/win32/x64/../../../package.json', '/updates/win32/x64/%2e%2e/package.json',
    '/updates/win32/x64/%2e%2e%2fpackage.json', '/updates/win32/x64/..%5cpackage.json',
    '/updates/win32/x64/%6catest.yml', '/updates/win32/x64/.prepare-test.tmp',
    '/updates/win32/x64/latest.yml/extra', '/updates/win32/x64/package.json',
  ];
  for (const requestPath of paths) {
    const response = await rawGet(origin,requestPath);
    assert.equal(response.status,404,requestPath);
    assert.doesNotMatch(response.text,/synthetic-package|[A-Z]:\\/);
  }
  const special = path.join(release.directory,`RunbookBridge-2.0.1-win32-x64.exe`);
  await fs.mkdir(special);
  assert.equal((await fetch(`${origin}/updates/win32/x64/${path.basename(special)}`)).status,404);
  const large = path.join(release.directory,`RunbookBridge-2.0.2-win32-x64.exe`);
  await fs.writeFile(large,'synthetic');
  await fs.truncate(large,1024*1024*1024+1);
  assert.equal((await fetch(`${origin}/updates/win32/x64/${path.basename(large)}`)).status,413);
});

test('升级目录及包拒绝符号链接，发布脚本不沿链接覆盖目标',async t => {
  const release = await windowsRelease(t);
  const origin = await cloud(t,release.releasesDirectory);
  const outside = path.join(release.root,'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'latest.yml'),'synthetic-outside-secret');
  await fs.symlink(outside,path.join(release.releasesDirectory,'win32','arm64'),process.platform === 'win32' ? 'junction' : 'dir');
  const directoryResponse = await fetch(`${origin}/updates/win32/arm64/latest.yml`);
  assert.equal(directoryResponse.status,404);
  assert.doesNotMatch(await directoryResponse.text(),/synthetic-outside/);
  await assert.rejects(prepareCloudUpdate({root:release.root,platform:'win32',arch:'arm64'}),/输出目录不能使用符号链接/);
  const linkedRoot = path.join(release.root,'linked-root');
  await fs.symlink(release.releasesDirectory,linkedRoot,process.platform === 'win32' ? 'junction' : 'dir');
  const linkedOrigin = await cloud(t,linkedRoot);
  assert.equal((await fetch(`${linkedOrigin}/updates/win32/x64/latest.yml`)).status,404);
  const linkedFile = path.join(release.directory,'RunbookBridge-2.0.1-win32-x64.exe');
  try { await fs.symlink(release.source,linkedFile,'file'); }
  catch (error) {
    if (!['EPERM','EACCES'].includes(error.code)) throw error;
    t.diagnostic('本机不允许创建文件符号链接；目录联接拒绝边界已覆盖。');
    return;
  }
  assert.equal((await fetch(`${origin}/updates/win32/x64/${path.basename(linkedFile)}`)).status,404);
});
