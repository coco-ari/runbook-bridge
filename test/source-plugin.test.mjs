import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { SourceStore } from '../src/source-store.mjs';
import { SourceClient } from '../src/source-client.mjs';
import { SourcePluginRuntime } from '../src/source-plugin-runtime.mjs';
import { registerSourceWorkspaceIpc } from '../src/source-workspace-ipc.mjs';
import { sourceHash, sourcePath, normalizeServiceUrl, validateManifest } from '../src/source-protocol.mjs';
import { normalizePlugin } from '../src/plugin-config-model.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { CredentialUseResolver } from '../src/credential-use-resolver.mjs';
import { OperationGate } from '../src/operation-gate.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const plugin = normalizePlugin({pluginType:'source',pluginInstanceId:'source-one',displayName:'测试源码',target:{serviceUrl:'https://source.example.invalid',remoteProjectId:projectId}},{projectId:'project-one',environmentId:'environment-one'});
function snapshot(contents,revision = '1'.repeat(40)) {
  const files = Object.entries(contents).map(([name,value]) => ({path:name,type:'file',mode:0o644,size:Buffer.byteLength(value),sha256:sourceHash(value)})).sort((a,b) => a.path < b.path ? -1 : 1);
  const identity = {projectId,revision,exportVersion:1,sourceIdentity:sourceHash('fixture'),files};
  const snapshotId = sourceHash(JSON.stringify(identity));
  return {protocol:'cmr-source/1',...identity,snapshotId,fileCount:files.length,totalBytes:files.reduce((n,f) => n+f.size,0),archiveBytes:22,archiveSha256:sourceHash('zip-fixture'),createdAt:'2026-01-01T00:00:00.000Z'};
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'source-client-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new SourceStore(root), manifests = new Map(), objects = new Map(), requests = [];
  const add = (contents,revision) => { const m = snapshot(contents,revision); manifests.set(m.snapshotId,m); for (const value of Object.values(contents)) objects.set(sourceHash(value),Buffer.from(value).toString('base64')); return m; };
  const client = {manifest:async id => validateManifest(manifests.get(id),projectId,id),files:async (id,hashes) => { requests.push({id,hashes}); return hashes.map(sha256 => ({sha256,data:objects.get(sha256)})); }};
  const empty = add({}); await store.update(plugin,client,empty.snapshotId);
  return {root,store,client,add,objects,requests};
}
test('源码路径、清单摘要、总量和大小写碰撞均在下载前验证', () => {
  for (const value of ['../escape','a/../b','/absolute','a\\b','a/.git/config','CON.txt','a:stream','a/','a./b','e\u0301.txt']) assert.throws(() => sourcePath(value));
  assert.equal(sourcePath('源码/应用.ts'),'源码/应用.ts');
  for (const value of ['http://example.com','https://u:p@example.com','https://example.com/?token=x','file:///tmp','https://example.com/#secret']) assert.throws(() => normalizeServiceUrl(value));
  assert.equal(normalizeServiceUrl('http://127.0.0.1:8080/'),'http://127.0.0.1:8080');
  assert.equal(normalizeServiceUrl('https://source.example.invalid/prefix/'),'https://source.example.invalid/prefix');
  for (const contents of [{'a':'x','A':'y'},{'a':'x','a/b':'y'},{'Dir/a':'x','dir/b':'y'}]) { const m = snapshot(contents); assert.throws(() => validateManifest(m,projectId,m.snapshotId)); }
  const m = snapshot({'a':'x'});
  assert.throws(() => validateManifest({...m,totalBytes:100},projectId,m.snapshotId));
  assert.throws(() => validateManifest({...m,files:[{...m.files[0],sha256:'0'.repeat(64)}]},projectId,m.snapshotId));
});
test('跨版本按内容复用，拒绝损坏，取消及失败不切换当前目录', async t => {
  const f = await fixture(t), first = f.add({'one.js':'const n = 1;','same.txt':'same'});
  await f.store.update(plugin,f.client,first.snapshotId);
  const next = f.add({'renamed.js':'const n = 2;','same.txt':'same'},'2'.repeat(40));
  f.objects.set(next.files.find(x => x.path === 'renamed.js').sha256,Buffer.from('corrupted!!!').toString('base64'));
  await assert.rejects(f.store.update(plugin,f.client,next.snapshotId),{code:'SOURCE_INVALID'});
  assert.equal((await f.store.current(plugin)).snapshotId,first.snapshotId);
  f.objects.set(next.files.find(x => x.path === 'renamed.js').sha256,Buffer.from('const n = 2;').toString('base64'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.update(plugin,f.client,next.snapshotId,{signal:controller.signal}),{code:'SOURCE_CANCELLED'});
  assert.equal((await f.store.current(plugin)).snapshotId,first.snapshotId);
  const result = await f.store.update(plugin,f.client,next.snapshotId);
  assert.equal(result.downloadedFiles,1); assert.equal(result.reusedFiles,1);
  assert.equal((await f.store.update(plugin,f.client,next.snapshotId)).downloadedFiles,0);
  assert.equal((await f.store.read(plugin,first.snapshotId,'one.js')).toString(),'const n = 1;');
  await assert.rejects(f.store.read(plugin,next.snapshotId,'one.js'),{code:'SOURCE_FILE_NOT_FOUND'});
  assert.equal(await f.store.current({...plugin,environmentId:'another'}),null);
});
test('离线读取拒绝篡改、符号链接与越界，清理保留工作区和持久对话引用', async t => {
  const f = await fixture(t), first = f.add({'dir/file.txt':'original'});
  await f.store.update(plugin,f.client,first.snapshotId);
  const second = f.add({'second.txt':'second'},'2'.repeat(40)); await f.store.update(plugin,f.client,second.snapshotId);
  const release = f.store.acquire(plugin,first.snapshotId);
  await f.store.cleanup(plugin); assert.ok(await f.store.manifest(plugin,first.snapshotId));
  await f.store.pin(plugin,first.snapshotId,'session-one'); release();
  const restarted = new SourceStore(f.root); await restarted.cleanup(plugin); assert.ok(await restarted.manifest(plugin,first.snapshotId));
  const filename = path.join((await f.store.current(plugin)).directory,'second.txt');
  await fs.chmod(filename,0o600); await fs.writeFile(filename,'changed');
  await assert.rejects(f.store.read(plugin,second.snapshotId,'second.txt'),{code:'SOURCE_INVALID'});
  await fs.rm(filename); await fs.symlink(path.join(f.root,'outside'),filename);
  await assert.rejects(f.store.read(plugin,second.snapshotId,'second.txt'),{code:'SOURCE_INVALID'});
  await assert.rejects(f.store.manifest(plugin,'../../outside'),{code:'SOURCE_INVALID'});
  await restarted.unpin(plugin,'session-one'); await restarted.cleanup(plugin);
  await assert.rejects(restarted.manifest(plugin,first.snapshotId),{code:'SOURCE_NOT_DOWNLOADED'});
});
test('源码凭据绑定完整来源，改地址必须明确重绑定，插件注册不授予读文件 MCP 能力', async t => {
  const f = await fixture(t);
  const vault = new PluginCredentialVault(f.root,{isEncryptionAvailable:() => true,encryptString:s => Buffer.from(s),decryptString:b => b.toString()});
  await vault.save(plugin,{password:'test-only-secret'});
  const changed = {...plugin,target:{...plugin.target,serviceUrl:'https://other.example.invalid'}};
  await assert.rejects(vault.load(changed),{code:'CREDENTIAL_BINDING_MISMATCH'});
  await assert.rejects(new CredentialUseResolver(vault).resolve({committedPlugin:plugin,draft:changed,caller:'main',purpose:'resource-access'}),{code:'CREDENTIAL_REBIND_REQUIRED'});
  assert.throws(() => vault.normalizeSecrets(plugin,{apiKey:'no'}));
  // Security is independently enforced even though the plugin is registered.
  assert.throws(() => new OperationGate().authorize({plugin,capability:'read',args:{}}),{code:'POLICY_DENIED'});
});
test('HTTP 错误不泄漏响应内容，认证不会跟随重定向', async () => {
  let options;
  const client = new SourceClient(plugin,'a'.repeat(43),{fetchImpl:async (_url,input) => { options = input; return new Response('remote-secret',{status:401}); }});
  await assert.rejects(client.head(),error => error.code === 'SOURCE_UNAUTHORIZED' && !error.message.includes('remote-secret'));
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(43));
});
test('源码 IPC 检查受信主 frame、类型、修订和 owner；MCP 摘要只有作用域及版本元数据', async t => {
  const f = await fixture(t), target = f.add({'file.txt':'not in metadata'}); await f.store.update(plugin,f.client,target.snapshotId);
  const runtime = new SourcePluginRuntime(f.root,{}, {store:f.store});
  t.after(() => runtime.closeAll());
  const handlers = new Map(), sender = new EventEmitter(); sender.id = 1; sender.mainFrame = {}; sender.isDestroyed = () => false;
  registerSourceWorkspaceIpc({handle:(name,fn) => handlers.set(name,fn)},{sourceRuntime:runtime,workspaceStore:{getPlugin:async () => plugin},isWorkspaceRenderer:s => s === sender});
  const invoke = handlers.get('v2:source-workspace'), event = {sender,senderFrame:sender.mainFrame};
  const payload = {projectId:plugin.projectId,environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,expectedRevision:plugin.revision,snapshotId:target.snapshotId,operation:'read',path:'file.txt'};
  assert.equal((await invoke({...event,senderFrame:{}},payload)).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.equal((await invoke(event,{...payload,expectedRevision:0})).error.code,'SOURCE_WORKSPACE_STALE');
  assert.equal((await invoke(event,payload)).data.text,'not in metadata');
  const hints = await runtime.sourceHints([plugin]); assert.equal(hints[0].snapshotId,target.snapshotId); assert.equal(hints[0].environmentId,plugin.environmentId);
  assert.ok(!JSON.stringify(hints).includes('not in metadata')); assert.ok(!JSON.stringify(hints).includes('serviceUrl'));
  sender.emit('destroyed'); assert.equal(f.store.readers.size,0);
});
