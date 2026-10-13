// Run against a local checkout: node scripts/test-source-service.mjs /path/to/CodeMinificationRepository
// No deployed infrastructure, credentials or user repositories are accessed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SourceClient } from '../src/source-client.mjs';
import { SourceStore } from '../src/source-store.mjs';
import { SourcePluginRuntime } from '../src/source-plugin-runtime.mjs';

if (!process.argv[2]) throw new Error('请提供 CodeMinificationRepository 本地仓库路径');
const serviceRoot = path.resolve(process.argv[2]);
const {createApplication} = await import(pathToFileURL(path.join(serviceRoot,'src/server.mjs')));
const {ArchiveBuilder} = await import(pathToFileURL(path.join(serviceRoot,'src/archive.mjs')));
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'source-service-integration-'));
const repository = path.join(temp,'repository');
const exec = promisify(execFile);
const git = (...args) => exec('git',['-c','user.name=Source Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',...args],{cwd:repository});
let app, runtime;
try {
  await fs.mkdir(path.join(repository,'src'),{recursive:true});
  await git('init','-b','main');
  await fs.writeFile(path.join(repository,'src/app.js'),'export const version = 1;\n');
  await fs.writeFile(path.join(repository,'stable.txt'),'unchanged\n');
  await fs.writeFile(path.join(repository,'excluded.txt'),'not exported\n');
  await fs.writeFile(path.join(repository,'.gitattributes'),'excluded.txt export-ignore\n');
  await git('add','.'); await git('commit','-m','测试初始源码');
  const builder = new ArchiveBuilder(path.join(temp,'git-cache'),{allowLocal:true});
  app = await createApplication({directory:path.join(temp,'service'),secureCookies:false,builder:{initialize:() => builder.initialize(),build:project => builder.build({...project,repository},null)}});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const created = await app.service.saveProject({name:'测试源码',repository:'https://gitee.com/example/source.git',branch:'main',sourceEnabled:true});
  await app.service.sync(created.project.id);
  const plugin = {projectId:'test-project',environmentId:'test-environment',pluginInstanceId:'test-source',pluginType:'source',configState:'ready',displayName:'测试源码',revision:1,
    target:{serviceUrl:`http://127.0.0.1:${app.server.address().port}`,remoteProjectId:created.project.id}};
  const client = new SourceClient(plugin,created.token), store = new SourceStore(path.join(temp,'client'));
  const first = (await client.head()).snapshot;
  const initial = await store.update(plugin,client,first.snapshotId);
  assert.equal(initial.downloadedFiles,3);
  assert.equal((await fs.readFile(path.join(initial.directory,'src/app.js'),'utf8')),'export const version = 1;\n');
  await assert.rejects(fs.access(path.join(initial.directory,'excluded.txt')));
  await assert.rejects(fs.access(path.join(initial.directory,'.git')));
  assert.deepEqual((await store.search(plugin,first.snapshotId,'version',{content:true})).results.map(x => [x.path,x.line]),[['src/app.js',1]]);
  await store.pin(plugin,first.snapshotId,'codex-test-session');
  await fs.rename(path.join(repository,'src/app.js'),path.join(repository,'src/renamed.js'));
  await fs.writeFile(path.join(repository,'intermediate.txt'),'skipped');
  await git('add','-A'); await git('commit','-m','测试中间版本'); await app.service.sync(created.project.id);
  await fs.rm(path.join(repository,'intermediate.txt'));
  await fs.writeFile(path.join(repository,'src/renamed.js'),'export const version = 3;\n');
  await git('add','-A'); await git('commit','-m','测试目标版本'); await app.service.sync(created.project.id);
  const target = (await client.head()).snapshot;
  const updated = await store.update(plugin,client,target.snapshotId);
  assert.equal(updated.downloadedFiles,1); assert.equal(updated.reusedFiles,2);
  assert.equal(updated.downloadedBytes,Buffer.byteLength('export const version = 3;\n'));
  await assert.rejects(fs.access(path.join(updated.directory,'src/app.js')));
  assert.equal((await store.update(plugin,client,target.snapshotId)).downloadedFiles,0);
  assert.equal((await store.cleanup(plugin)).removed,0,'Codex 对话引用保留旧版本');
  assert.equal((await store.read(plugin,first.snapshotId,'src/app.js')).toString(),'export const version = 1;\n');
  await store.unpin(plugin,'codex-test-session');
  assert.equal((await store.cleanup(plugin)).removed,1);
  runtime = new SourcePluginRuntime(path.join(temp,'client'),{load:async () => ({password:created.token})},{store});
  await runtime.connect(plugin);
  assert.equal((await runtime.sourceHints([plugin]))[0].snapshotId,target.snapshotId);
  assert.ok(!JSON.stringify(await runtime.sourceHints([plugin])).includes(created.token));
  await runtime.disconnect(plugin);
  assert.equal((await runtime.workspaceStatus(plugin)).local.snapshotId,target.snapshotId,'断线仍可浏览当前源码');
  assert.equal(await store.current({...plugin,target:{...plugin.target,remoteProjectId:'11111111-1111-4111-8111-111111111111'}}),null);
  console.log(JSON.stringify({passed:true,initialFiles:initial.downloadedFiles,incrementalFiles:updated.downloadedFiles,incrementalBytes:updated.downloadedBytes,checks:['archive','hashes','export-ignore','cross-version','rename-delete','no-change','pins','cleanup','offline','scope','MCP-metadata']},null,2));
} finally {
  await runtime?.closeAll();
  if (app) await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
  await fs.rm(temp,{recursive:true,force:true});
}
