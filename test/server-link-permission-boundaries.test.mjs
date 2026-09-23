import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { SshBroker } from '../src/ssh-broker.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';

async function until(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await delay(10);
  assert.ok(predicate(), '本地 SFTP 通道应在观察期限内收尾');
}

async function fixture(t) {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength:2048, privateKeyEncoding:{type:'pkcs1',format:'pem'}, publicKeyEncoding:{type:'spki',format:'pem'} }).privateKey;
  const publicKey = ssh2.utils.parseKey(key).getPublicSSH();
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  const nodes = new Map([
    ['/', {type:'directory'}], ['/root', {type:'directory'}], ['/root/sub', {type:'directory'}], ['/outside', {type:'directory'}],
    ['/root/ok.txt', {type:'file',content:Buffer.from('fixture needle root\n')}],
    ['/root/sub/deep.txt', {type:'file',content:Buffer.from('fixture needle child\n')}],
    ['/outside/excluded.txt', {type:'file',content:Buffer.from('fixture needle excluded\n')}],
    ['/root/self', {type:'symlink',target:'self'}],
    ['/root/pair-a', {type:'symlink',target:'pair-b'}], ['/root/pair-b', {type:'symlink',target:'pair-a'}],
    ['/root/sub/ancestor', {type:'symlink',target:'..'}],
    ['/root/outside-link', {type:'symlink',target:'/outside'}],
    ['/root/file-link', {type:'symlink',target:'ok.txt'}],
  ]);
  const denied = new Set(), calls = [], channels = [], clients = new Set(), resolutions = [];
  const statusError = code => Object.assign(new Error('夹具路径不可用'), {code});
  const resolvePath = (input, followLast = true) => {
    let value = path.posix.normalize(input);
    // 这里只模拟服务端对链接解析次数的限制；客户端是否循环遍历由实际请求记录独立断言。
    for (let traversed = 0; traversed < 16; traversed += 1) {
      const parts = value.split('/').filter(Boolean);
      let rewritten = false;
      for (let index = 0; index < parts.length; index += 1) {
        const prefix = '/' + parts.slice(0, index + 1).join('/');
        const node = nodes.get(prefix);
        if (!node) throw statusError(2);
        if (node.type === 'symlink' && (followLast || index !== parts.length - 1)) {
          value = path.posix.resolve(path.posix.dirname(prefix), node.target, ...parts.slice(index + 1));
          rewritten = true;
          break;
        }
      }
      if (!rewritten) {
        if (!nodes.has(value)) throw statusError(2);
        resolutions.push({input, traversed});
        return value;
      }
    }
    resolutions.push({input, traversed:16, loop:true});
    throw statusError(4);
  };
  const attrs = name => {
    const node = nodes.get(name);
    return {mode:{directory:0o40755,file:0o100644,symlink:0o120777}[node.type],size:node.content?.length ?? 0,uid:1,gid:1,atime:1,mtime:1};
  };
  const server = new ssh2.Server({hostKeys:[key]}, client => {
    clients.add(client);
    client.on('error', () => undefined);
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password' ? context.accept() : context.reject());
    client.on('ready', () => client.on('session', accept => accept().on('sftp', approve => {
      const sftp = approve(), state = {closed:false,handles:new Map()}, channel = channels.length;
      channels.push(state);
      sftp.on('error', () => undefined);
      sftp.once('close', () => { state.closed = true; state.handles.clear(); });
      let sequence = 0;
      const action = (method, id, target, fn) => {
        calls.push({method,path:target,channel});
        try {
          if (denied.has(method + ':' + target)) throw statusError(3);
          fn();
        } catch (error) { sftp.status(id, error.code ?? 4); }
      };
      const handleFor = (id, target, directory = false) => {
        const handle = Buffer.from(String(++sequence));
        state.handles.set(handle.toString(), {path:target,directory,read:false});
        sftp.handle(id, handle);
      };
      sftp.on('REALPATH', (id, target) => action('REALPATH', id, target, () => {
        const canonical = resolvePath(target);
        sftp.name(id, [{filename:canonical,longname:canonical,attrs:attrs(canonical)}]);
      }));
      for (const method of ['LSTAT','STAT']) sftp.on(method, (id, target) => action(method, id, target, () => sftp.attrs(id, attrs(resolvePath(target, method === 'STAT')))));
      sftp.on('OPENDIR', (id, target) => action('OPENDIR', id, target, () => {
        const canonical = resolvePath(target);
        if (nodes.get(canonical).type !== 'directory') throw statusError(4);
        handleFor(id, canonical, true);
      }));
      sftp.on('READDIR', (id, handle) => {
        const current = state.handles.get(handle.toString());
        action('READDIR', id, current?.path, () => {
          if (!current?.directory) throw statusError(4);
          if (current.read) { sftp.status(id, 1); return; }
          current.read = true;
          const entries = [...nodes.keys()].filter(name => name !== '/' && path.posix.dirname(name) === current.path);
          if (!entries.length) { sftp.status(id, 1); return; }
          sftp.name(id, entries.map(name => ({filename:path.posix.basename(name),longname:path.posix.basename(name),attrs:attrs(name)})));
        });
      });
      sftp.on('OPEN', (id, target, flags) => action('OPEN', id, target, () => {
        if (flags !== 1) throw statusError(3);
        const canonical = resolvePath(target);
        if (nodes.get(canonical).type !== 'file') throw statusError(4);
        handleFor(id, canonical);
      }));
      sftp.on('READ', (id, handle, offset, length) => {
        const current = state.handles.get(handle.toString());
        action('READ', id, current?.path, () => {
          const content = nodes.get(current.path).content;
          if (offset >= content.length) sftp.status(id, 1);
          else sftp.data(id, content.subarray(offset, offset + length));
        });
      });
      sftp.on('CLOSE', (id, handle) => {
        const current = state.handles.get(handle.toString());
        action('CLOSE', id, current?.path, () => { state.handles.delete(handle.toString()); sftp.status(id, 0); });
      });
    })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {ssh:{host:'127.0.0.1',port:server.address().port,username:'fixture',hostKeyFingerprint:fingerprint},auth:{type:'password'},proxy:{type:'direct'}};
  const broker = new SshBroker({get:async () => config,appendAudit:async () => undefined});
  const scope = {projectId:'link-fixture',environmentId:'test',pluginInstanceId:'server'};
  const plugin = {...scope,pluginType:'server',configState:'ready',revision:1};
  const store = {getPlugin:async () => plugin};
  const runtime = new ServerPluginRuntime(store, {});
  runtime.broker = broker;
  runtime.key = () => 'fixture';
  const operations = new ServerOperations(runtime, store);
  const workspace = new ServerWorkspaceFiles({workspaceStore:store,serverRuntime:runtime,serverOperations:operations});
  t.after(async () => {
    workspace.dispose(); operations.docker.dispose();
    await broker.closeAll();
    for (const client of clients) client._sock.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await broker.connect('fixture', {password:'fixture-password'});
  return {broker,runtime,operations,workspace,scope,plugin,calls,channels,denied,resolutions};
}

function assertNoLinkedTraversal(f) {
  const directories = f.calls.filter(call => call.method === 'OPENDIR').map(call => call.path);
  assert.ok(directories.every(target => ['/root','/root/sub'].includes(target)));
  assert.equal(new Set(directories).size, directories.length, '每个实际目录最多扫描一次，不递归进入祖先回链');
  assert.ok(f.calls.filter(call => call.method === 'OPEN').every(call => ['/root/ok.txt','/root/sub/deep.txt'].includes(call.path)));
  assert.ok(f.calls.length < 80, '客户端请求数应与实际节点数有关，不能随链接环增长');
  assert.ok(f.resolutions.filter(item => item.loop).length >= 3);
}

for (const method of ['listDirectory','findFiles','searchFiles']) test('Agent ' + method + ' 在真实 SFTP 中跳过单点、双点、祖先和越界目录链接的递归遍历', {timeout:10_000}, async t => {
  const f = await fixture(t);
  const result = await f.operations[method](f.plugin, {path:'/root',contains:'needle'});
  if (method === 'listDirectory') {
    assert.equal(result.entries.filter(entry => entry.type === 'symlink').length, 5);
    assert.deepEqual(f.calls.filter(call => call.method === 'OPENDIR').map(call => call.path), ['/root']);
    assert.equal(f.calls.some(call => call.method === 'OPEN'), false);
  } else if (method === 'findFiles') {
    assert.deepEqual(result.files.map(file => file.path).sort(), ['/root/ok.txt','/root/sub/deep.txt']);
    assert.equal(result.scanned.directories, 2);
    assert.equal(result.truncated, false);
  } else {
    assert.deepEqual(result.matches.map(match => match.path).sort(), ['/root/ok.txt','/root/sub/deep.txt']);
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.truncated, false);
  }
  assertNoLinkedTraversal(f);
  await until(() => f.runtime.readScheduler.active === 0);
});

for (const target of ['/root/self','/root/pair-a']) test('显式选择循环路径 ' + target + ' 时 Agent 与桌面均及时有界结束', {timeout:10_000}, async t => {
  const f = await fixture(t);
  for (const method of ['listDirectory','findFiles','searchFiles']) {
    const before = f.calls.length;
    await assert.rejects(f.operations[method](f.plugin, {path:target,contains:'needle'}), {code:method === 'listDirectory' ? 'TRANSFER_FAILED' : 'SOURCE_NOT_ALLOWED'});
    assert.ok(f.calls.length - before <= 2);
  }
  for (const method of ['listDirectory','readFile']) {
    const before = f.calls.length;
    await assert.rejects(f.workspace[method]('renderer:1', {...f.scope,path:target}), {code:'PATH_INVALID'});
    assert.ok(f.calls.length - before <= 2);
  }
  const info = await f.workspace.fileInfo('renderer:1', {...f.scope,path:target});
  assert.equal(info.linkTargetType, 'unavailable');
  assert.equal(info.canonicalPath, null);
  assert.equal(f.calls.some(call => ['OPENDIR','OPEN','READ'].includes(call.method)), false);
  assert.ok(f.resolutions.every(item => item.traversed <= 16));
  await until(() => f.runtime.readScheduler.active === 0);
});

test('祖先回链的 Agent 递归入口拒绝跟随，桌面显式展开只读取所选一层', {timeout:10_000}, async t => {
  const f = await fixture(t), target = '/root/sub/ancestor';
  for (const method of ['findFiles','searchFiles']) await assert.rejects(f.operations[method](f.plugin, {path:target,contains:'needle'}), {code:'SOURCE_NOT_ALLOWED'});
  assert.equal(f.calls.some(call => call.method === 'OPENDIR'), false);
  const result = await f.workspace.listDirectory('renderer:1', {...f.scope,path:target,deferLinks:true});
  assert.equal(result.canonicalPath, '/root');
  assert.ok(result.entries.some(entry => entry.name === 'sub'));
  assert.deepEqual(f.calls.filter(call => call.method === 'OPENDIR').map(call => call.path), ['/root']);
  assert.equal(f.calls.some(call => call.method === 'OPEN'), false);
  assert.ok(f.calls.length < 30);
});

for (const scenario of [
  {surface:'agent',method:'listDirectory',denial:'OPENDIR:/root'},
  {surface:'agent',method:'listDirectory',denial:'READDIR:/root',closed:'/root'},
  {surface:'agent',method:'findFiles',denial:'LSTAT:/root/sub'},
  {surface:'agent',method:'findFiles',denial:'READDIR:/root/sub',closed:'/root/sub'},
  {surface:'agent',method:'searchFiles',denial:'STAT:/root/ok.txt'},
  {surface:'agent',method:'searchFiles',denial:'OPEN:/root/ok.txt'},
  {surface:'agent',method:'searchFiles',denial:'READ:/root/ok.txt',closed:'/root/ok.txt'},
  {surface:'desktop',method:'readFile',denial:'LSTAT:/root/ok.txt'},
  {surface:'desktop',method:'readFile',denial:'READ:/root/ok.txt',closed:'/root/ok.txt'},
]) test(scenario.surface + ' ' + scenario.method + ' 收到协议权限拒绝 ' + scenario.denial + ' 后释放通道与读取名额并可恢复', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.denied.add(scenario.denial);
  const read = () => scenario.surface === 'agent'
    ? f.operations[scenario.method](f.plugin, {path:'/root',contains:'needle',refresh:true})
    : f.workspace[scenario.method]('renderer:1', {...f.scope,path:'/root/ok.txt'});
  let activePeak = 0, queuePeak = 0;
  const run = f.runtime.readScheduler.run.bind(f.runtime.readScheduler);
  f.runtime.readScheduler.run = (...args) => {
    const pending = run(...args);
    activePeak = Math.max(activePeak, f.runtime.readScheduler.active);
    queuePeak = Math.max(queuePeak, f.runtime.readScheduler.queue.length);
    return pending;
  };
  const readings = Array.from({length:3}, () => read());
  const results = await Promise.allSettled(readings);
  assert.equal(activePeak, 2);
  assert.equal(queuePeak, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'SOURCE_ACCESS_DENIED'));
  await until(() => f.runtime.readScheduler.active === 0);
  assert.equal(f.runtime.readScheduler.queue.length, 0);
  assert.equal(f.runtime.readScheduler.activeCounts.size, 0);
  assert.equal(f.workspace.readCounts.size, 0);
  if (scenario.closed) assert.ok(f.calls.some(call => call.method === 'CLOSE' && call.path === scenario.closed));
  await until(() => f.channels.every(channel => channel.closed));
  assert.ok(f.channels.every(channel => channel.handles.size === 0));
  const failedChannels = f.channels.length;
  assert.equal(f.broker.status('fixture').connected, true);
  if (scenario.surface === 'desktop') assert.equal(f.broker.requireSession('fixture').workspaceReads.entries.size, 0);
  f.denied.clear();
  const recovered = await read();
  assert.ok(recovered);
  assert.ok(f.channels.length > failedChannels, '权限失败后的成功读取必须建立新通道');
  await until(() => f.runtime.readScheduler.active === 0);
});

for (const denial of ['LSTAT:/root','READDIR:/root','LSTAT:/root/outside-link']) test('桌面目录协议权限拒绝 ' + denial + ' 后并发窗口名额与池通道收尾，可再次解析链接', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.denied.add(denial);
  const read = () => f.workspace.listDirectory('renderer:1', {...f.scope,path:'/root'});
  const readings = Array.from({length:3}, () => read());
  const results = await Promise.allSettled(readings);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'SOURCE_ACCESS_DENIED'));
  assert.equal(f.workspace.readCounts.size, 0);
  assert.ok([...f.workspace.directoryCache.snapshots.values()].every(item => item.controllers.size === 0 && item.metadata.size === 0));
  assert.equal(f.broker.requireSession('fixture').workspaceReads.entries.size, 0);
  await until(() => f.channels.every(channel => channel.closed));
  assert.ok(f.channels.every(channel => channel.handles.size === 0));
  if (denial === 'READDIR:/root') assert.ok(f.calls.some(call => call.method === 'CLOSE' && call.path === '/root'));
  f.denied.clear();
  const result = await read();
  assert.equal(result.entries.find(entry => entry.name === 'self').linkTargetType, 'unavailable');
  assert.equal(result.entries.find(entry => entry.name === 'pair-a').linkTargetType, 'unavailable');
  assert.equal(result.entries.find(entry => entry.name === 'outside-link').linkTargetType, 'directory');
  assert.ok(f.calls.filter(call => call.method === 'OPENDIR').every(call => call.path === '/root'));
  assert.equal(f.workspace.readCounts.size, 0);
  assert.equal(f.broker.status('fixture').connected, true);
});
