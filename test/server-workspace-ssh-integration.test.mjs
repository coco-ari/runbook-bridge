import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import ssh2 from 'ssh2';
import { SshBroker } from '../src/ssh-broker.mjs';
import { DEFAULT_TERMINAL_COLORS } from '../src/server-terminal-startup.mjs';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';

test('真实本地 SSH 协议分配 PTY、持续收发字节并传播窗口变化和退出码', async (t) => {
  const scope = { projectId: 'pty-project', environmentId: 'test', pluginInstanceId: 'server' };
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const publicKey = ssh2.utils.parseKey(privateKey).getPublicSSH();
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  const clients = new Set();
  const windows = [];
  let pty;
  let remote;
  let shellCount = 0;
  let probes = 0;
  let workingDirectory = '/home/operator';
  const directoryQueries = [];
  const startupCommands = [];
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (approve, _reject, info) => {
        const stream = approve();
        if (info.command === 'printf \'%s\' "$SHELL"') {
          probes += 1;
          stream.write('/bin/bash');
        } else {
          assert.equal(info.command, 'command readlink -- /proc/4242/cwd');
          directoryQueries.push(info.command);
          stream.write(workingDirectory + '\n');
        }
        stream.exit(0); stream.end();
      });
      session.on('pty', (approve, _reject, info) => { pty = info; approve(); });
      session.on('window-change', (approve, _reject, info) => { windows.push(info); approve?.(); });
      session.on('shell', (approve) => {
        shellCount += 1;
        remote = approve();
        remote.on('error', () => undefined);
        remote.write(Buffer.from('\x1b[32m终端就绪😀\x1b[0m\r\n'));
        const current = remote;
        current.on('data', (data) => {
          if (data.toString().startsWith(DEFAULT_TERMINAL_COLORS)) {
            startupCommands.push(data.toString());
            const label = data.toString().match(/runbook-ready:[a-f0-9]{32}/u)?.[0];
            assert.ok(label);
            const marker = Buffer.from('\x1b]' + label + '\x07');
            current.write(data);
            current.write('\r\noperator@example:~$ ');
            current.write(data);
            const shellLabel = data.toString().match(/runbook-shell:[a-f0-9]{32}:/u)?.[0];
            assert.ok(shellLabel);
            current.write('\x1b]' + shellLabel + '4242\x07');
            current.write(marker.subarray(0, 7));
            current.write(Buffer.concat([marker.subarray(7), Buffer.from('operator@example:~$ ')]));
          } else current.write(data);
        });
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ssh: { host: '127.0.0.1', port: server.address().port, username: 'fixture', hostKeyFingerprint: fingerprint },
    auth: { type: 'password' }, proxy: { type: 'direct' },
  };
  const broker = new SshBroker({ get: async () => config, appendAudit: async () => undefined });
  const runtime = new EventEmitter();
  runtime.status = () => broker.status('fixture');
  runtime.openTerminal = (_plugin, options) => broker.openTerminal('fixture', options);
  broker.setLifecycleHandler((event) => runtime.emit('lifecycle', { ...event, ...scope }));
  const manager = new ServerWorkspaceManager({
    serverRuntime: runtime,
    workspaceStore: { getPlugin: async () => ({ ...scope, pluginType: 'server', revision: 1 }), appendAudit: async () => undefined },
  });
  t.after(async () => {
    manager.dispose();
    await broker.closeAll();
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  });
  await broker.connect('fixture', { password: 'fixture-password' });
  const session = await manager.openTerminal(1, { ...scope, cols: 132, rows: 37 });
  const payload = { ...scope, sessionId: session.sessionId };
  const receive = async (predicate) => {
    const chunks = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await manager.readTerminal(1, payload);
      chunks.push(Buffer.from(result.data));
      const content = Buffer.concat(chunks);
      if (predicate(content, result)) return { content, result };
    }
    assert.fail('本地 SSH 终端未在时限内返回预期数据');
  };
  const initial = await receive((data) => data.includes(Buffer.from('operator@example:~$ ')));
  assert.equal(initial.content.toString(), 'operator@example:~$ ');
  assert.equal(pty.term, 'xterm-256color');
  assert.equal(pty.cols, 132);
  assert.equal(pty.rows, 37);

  assert.deepEqual(await manager.terminalWorkingDirectory(1, payload), { path: workingDirectory });
  workingDirectory = '/srv/example';
  const input = 'cd /srv/example\r\x03\t\x1b[A';
  await manager.writeTerminal(1, { ...payload, data: input });
  const echoed = await receive((data) => data.length === Buffer.byteLength(input));
  assert.equal(echoed.content.toString(), input);
  assert.deepEqual(await manager.terminalWorkingDirectory(1, payload), { path: '/srv/example' });
  assert.equal(directoryQueries.length, 2);
  assert.equal((await manager.readTerminal(1, payload)).data.length, 0, '查询目录不向人工终端注入命令或输出');
  assert.equal((await manager.openTerminal(1, scope)).sessionId, session.sessionId);
  assert.equal(shellCount, 1);
  assert.equal(probes, 1);
  assert.equal(startupCommands.length, 1);
  assert.ok(startupCommands[0].startsWith(DEFAULT_TERMINAL_COLORS));
  await manager.resizeTerminal(1, { ...payload, cols: 101, rows: 29 });
  for (let i = 0; i < 50 && !windows.length; i += 1) await delay(10);
  assert.equal(windows[0].cols, 101);
  assert.equal(windows[0].rows, 29);

  remote.exit(7);
  remote.end('最后一行\r\n');
  const ended = await receive((_data, result) => result.status === 'closed');
  assert.equal(ended.content.toString(), '最后一行\r\n');
  assert.equal(ended.result.exitCode, 7);
});


test('真实 SFTP 解析相对目录链接和文件链接，拒绝失效循环与特殊文件', async (t) => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const content = Buffer.from('fixture_enabled = true\n');
  const nodes = new Map([
    ['/', { type: 'directory' }], ['/usr', { type: 'directory' }], ['/usr/bin', { type: 'directory' }], ['/dev', { type: 'directory' }],
    ['/bin', { type: 'symlink', target: 'usr/bin' }], ['/usr/bin/X11', { type: 'symlink', target: '.' }],
    ['/usr/bin/tool.conf', { type: 'file' }], ['/current.conf', { type: 'symlink', target: 'usr/bin/tool.conf' }],
    ['/broken', { type: 'symlink', target: '/missing' }], ['/loop', { type: 'symlink', target: '/loop' }],
    ['/special', { type: 'symlink', target: '/dev/null' }], ['/dev/null', { type: 'special' }],
  ]);
  const resolve = (input, followLast = true) => {
    let value = path.posix.normalize(input);
    for (let count = 0; count < 16; count += 1) {
      const parts = value.split('/').filter(Boolean);
      let rewritten = false;
      for (let index = 0; index < parts.length; index += 1) {
        const prefix = '/' + parts.slice(0, index + 1).join('/');
        const node = nodes.get(prefix);
        if (node?.type === 'symlink' && (followLast || index !== parts.length - 1)) {
          value = path.posix.resolve(path.posix.dirname(prefix), node.target, ...parts.slice(index + 1));
          rewritten = true; break;
        }
      }
      if (!rewritten && nodes.has(value)) return value;
      if (!rewritten) throw new Error('不存在');
    }
    throw new Error('循环链接');
  };
  const attrs = (value) => ({ mode: ({ directory: 0o040755, file: 0o100644, symlink: 0o120777, special: 0o020666 })[nodes.get(value).type], size: nodes.get(value).type === 'file' ? content.length : 0, uid: 1, gid: 1, atime: 1, mtime: 1 });
  const clients = new Set();
  const openedFiles = [];
  const directoryCalls = { sessions: 0, opens: 0, reads: 0, active: 0, peak: 0, linkStats: 0 };
  let holdUploadStat = false; let heldUploadSftp;
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => undefined);
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', approve => approve());
      session.on('shell', approve => { const channel=approve(); channel.on('error',()=>undefined); channel.on('data', data=>channel.write(data)); });
      session.on('sftp', approve => {
        const sftp = approve(); const handles = new Map(); let sequence = 0;
        directoryCalls.sessions += 1;
        sftp.on('error', () => undefined);
        const action = (id, fn) => { try { fn(); } catch { sftp.status(id, 2); } };
        sftp.on('REALPATH', (id, value) => action(id, () => { const target = resolve(value); sftp.name(id, [{ filename: target, longname: target, attrs: attrs(target) }]); }));
        sftp.on('LSTAT', (id, value) => action(id, () => { if (holdUploadStat && value === '/usr/bin') { heldUploadSftp = sftp; return; } if (nodes.get(value)?.type === 'symlink') directoryCalls.linkStats += 1; sftp.attrs(id, attrs(resolve(value, false))); }));
        sftp.on('STAT', (id, value) => action(id, () => sftp.attrs(id, attrs(resolve(value)))));
        sftp.on('OPENDIR', (id, value) => action(id, () => { directoryCalls.opens += 1; const handle = Buffer.from(String(++sequence)); handles.set(handle.toString(), { path: resolve(value), read: false, offset: 0 }); sftp.handle(id, handle); }));
        sftp.on('READDIR', (id, handle) => action(id, () => {
          const state = handles.get(handle.toString());
          directoryCalls.reads += 1;
          if (state.path === '/large') {
            const entries = [...nodes.keys()].filter(value => path.posix.dirname(value) === state.path).slice(state.offset, state.offset + 50).map(value => ({ filename: path.posix.basename(value), longname: path.posix.basename(value), attrs: attrs(value) }));
            state.offset += entries.length;
            directoryCalls.active += 1; directoryCalls.peak = Math.max(directoryCalls.peak, directoryCalls.active);
            setTimeout(() => { directoryCalls.active -= 1; if (entries.length) sftp.name(id, entries); else sftp.status(id, 1); }, 15);
            return;
          }
          if (state.read) return sftp.status(id, 1);
          state.read = true;
          const entries = [...nodes.keys()].filter(value => value !== '/' && path.posix.dirname(value) === state.path).map(value => ({ filename: path.posix.basename(value), longname: path.posix.basename(value), attrs: attrs(value) }));
          if (entries.length) sftp.name(id, entries); else sftp.status(id, 1);
        }));
        sftp.on('OPEN', (id, value) => action(id, () => { const target = resolve(value); openedFiles.push(target); const handle = Buffer.from(String(++sequence)); handles.set(handle.toString(), { path: target }); sftp.handle(id, handle); }));
        sftp.on('READ', (id, handle, offset, length) => action(id, () => { const target = handles.get(handle.toString()).path; if (nodes.get(target).type !== 'file') throw new Error('非普通文件'); if (offset >= content.length) sftp.status(id, 1); else sftp.data(id, content.subarray(offset, offset + length)); }));
        sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); sftp.status(id, 0); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { ssh: { host: '127.0.0.1', port: server.address().port, username: 'fixture', hostKeyFingerprint: fingerprint }, auth: { type: 'password' }, proxy: { type: 'direct' } };
  const broker = new SshBroker({ get: async () => config, appendAudit: async () => undefined });
  const scope = { projectId: 'sftp-fixture', environmentId: 'test', pluginInstanceId: 'server' };
  const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1 };
  const runtime = {
    status: () => broker.status('fixture'),
    withRemoteReadSession: (_plugin, fn, options) => broker.withRemoteReadSession('fixture', fn, options),
    statRemotePath: (_plugin, value) => broker.statRemotePath('fixture', value),
    listRemoteDirectory: (_plugin, value, options) => broker.listRemoteDirectory('fixture', value, options),
    readRemoteRange: (_plugin, value, start, limit) => broker.readRemoteRange('fixture', value, start, limit),
  };
  const store = { getPlugin: async () => plugin };
  const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: new ServerOperations(runtime, store) });
  t.after(async () => { files.dispose(); await broker.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  await broker.connect('fixture', { password: 'fixture-password' });
  const root = await files.listDirectory('renderer:1', { ...scope, path: '/' });
  assert.equal(root.entries.find(entry => entry.name === 'bin').linkTargetType, 'directory');
  assert.equal(root.entries.find(entry => entry.name === 'current.conf').linkTargetType, 'file');
  assert.equal(root.entries.find(entry => entry.name === 'special').linkTargetType, 'special');
  assert.equal(root.entries.find(entry => entry.name === 'broken').linkTargetType, 'unavailable');
  assert.equal(root.entries.find(entry => entry.name === 'loop').linkTargetType, 'unavailable');
  const directory = await files.listDirectory('renderer:1', { ...scope, path: '/bin' });
  assert.equal(directory.canonicalPath, '/usr/bin');
  assert.equal(directory.entries.find(entry => entry.name === 'tool.conf').path, '/bin/tool.conf');
  assert.equal(directory.entries.find(entry => entry.name === 'X11').linkTarget, '/usr/bin');
  const preview = await files.readFile('renderer:1', { ...scope, path: '/current.conf' });
  assert.equal(preview.content, content.toString());
  assert.equal(preview.path, '/current.conf');
  assert.equal(preview.canonicalPath, '/usr/bin/tool.conf');
  await assert.rejects(files.readFile('renderer:1', { ...scope, path: '/special' }), { code: 'PATH_INVALID' });
  await assert.rejects(files.listDirectory('renderer:1', { ...scope, path: '/loop' }), { code: 'PATH_INVALID' });
  assert.deepEqual(openedFiles, ['/usr/bin/tool.conf']);

  runtime.withWorkspaceReadSession = (_plugin, fn, options) => broker.withRemoteReadSession('fixture', fn, options);
  const before = { ...directoryCalls };
  const fastRoot = await files.listDirectory('renderer:1', { ...scope, path: '/', deferLinks: true });
  assert.equal(directoryCalls.sessions - before.sessions, 1, '基础列表只建立一个 SFTP 通道');
  assert.equal(directoryCalls.linkStats, before.linkStats, '首屏不请求任何链接属性');
  assert.equal(fastRoot.entries.find(entry => entry.name === 'bin').linkTargetType, undefined);
  const detailed = await files.listDirectory('renderer:1', { ...scope, path: '/', snapshotId: fastRoot.snapshotId, resolveLinks: true });
  assert.equal(detailed.entries.find(entry => entry.name === 'bin').linkTargetType, 'directory');
  assert.equal(detailed.entries.find(entry => entry.name === 'current.conf').linkTargetType, 'file');
  assert.equal(detailed.entries.find(entry => entry.name === 'special').linkTargetType, 'special');
  assert.equal(detailed.entries.find(entry => entry.name === 'broken').linkTargetType, 'unavailable');
  assert.equal(detailed.entries.find(entry => entry.name === 'loop').linkTargetType, 'unavailable');
  const linkedPage = await files.listDirectory('renderer:1', { ...scope, path: '/bin', deferLinks: true });
  assert.equal(linkedPage.canonicalPath, '/usr/bin');
  assert.equal(linkedPage.entries.find(entry => entry.name === 'tool.conf').path, '/bin/tool.conf');

  nodes.set('/large', { type: 'directory' });
  for (let index = 0; index < 650; index += 1) nodes.set('/large/file-' + String(index).padStart(4, '0'), { type: 'file' });
  const legacyStart = performance.now();
  let legacyCursor;
  let legacyFirstMs;
  do {
    const page = await files.serverOperations.listDirectory(plugin, { path: '/large', cursor: legacyCursor, limit: 200 });
    legacyFirstMs ??= performance.now() - legacyStart;
    legacyCursor = page.nextCursor;
  } while (legacyCursor);
  const legacyTotalMs = performance.now() - legacyStart;
  const optimizedStart = performance.now();
  const first = await files.listDirectory('renderer:1', { ...scope, path: '/large', deferLinks: true });
  const optimizedFirstMs = performance.now() - optimizedStart;
  const scanCount = directoryCalls.opens;
  assert.equal(directoryCalls.peak, 4, '真实 SFTP 在途目录读取上限为四个');
  const names = first.entries.map(entry => entry.name);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await files.listDirectory('renderer:1', { ...scope, path: '/large', deferLinks: true, snapshotId: first.snapshotId, cursor });
    names.push(...page.entries.map(entry => entry.name)); cursor = page.nextCursor;
  }
  assert.equal(names.length, 650);
  assert.equal(new Set(names).size, 650, '流水线与缓存分页没有丢失或重复条目');
  assert.deepEqual(names, [...names].sort());
  assert.equal(directoryCalls.opens, scanCount, '后续页不重新打开目录句柄');
  assert.equal(directoryCalls.active, 0, 'EOF 后没有悬挂目录请求');
  t.diagnostic(JSON.stringify({ fixture: '650 条目，每个 READDIR 响应延迟 15 ms，共四页', legacyFirstMs: Math.round(legacyFirstMs), optimizedFirstMs: Math.round(optimizedFirstMs), legacyTotalMs: Math.round(legacyTotalMs), optimizedTotalMs: Math.round(performance.now() - optimizedStart) }));
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-review-ssh-'));
  const uploadPaths = Array.from({ length: 5 }, (_, index) => path.join(uploadRoot, 'upload-' + index + '.txt'));
  await Promise.all(uploadPaths.map(file => fs.writeFile(file, 'fixture')));
  t.after(async () => {
    assert.ok(path.resolve(uploadRoot).startsWith(path.resolve(os.tmpdir()) + path.sep + 'upload-review-ssh-'));
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });
  const uploadSessionStart = directoryCalls.sessions;
  const review = await files.beginUploadReview('renderer:1', { ...scope, path: '/bin' }, uploadPaths);
  assert.equal(review.status, 'checking');
  await files.uploadReviews.records.get(review.reviewId).done;
  const ready = await files.readUploadReview('renderer:1', { ...scope, reviewId: review.reviewId });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.path, '/usr/bin');
  assert.equal(directoryCalls.sessions - uploadSessionStart, 2, '真实 SFTP 的五个文件只复用两个检查通道');

  const terminal = await broker.openTerminal('fixture', { defaultColors: false });
  terminal.on('error', () => undefined);
  terminal.resume();
  const echo = async text => {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('终端回显超时')), 3000);
      terminal.once('data', data => { clearTimeout(timeout); resolve(data.toString()); });
    });
    terminal.write(text);
    assert.equal(await response, text);
  };
  await echo('before-cancel');
  holdUploadStat = true;
  const cancelled = await files.beginUploadReview('renderer:1', { ...scope, path: '/usr/bin' }, uploadPaths);
  const pendingReview = files.uploadReviews.records.get(cancelled.reviewId);
  for (let i = 0; i < 100 && !heldUploadSftp; i += 1) await delay(10);
  assert.ok(heldUploadSftp, '真实 SFTP 检查正在等待服务端响应');
  files.cancelUploadReview('renderer:1', { ...scope, reviewId: cancelled.reviewId });
  await pendingReview.done;
  holdUploadStat = false;
  assert.equal(files.preparations.size, 0);
  assert.equal(broker.status('fixture').connected, true, '取消预处理不会断开 SSH 连接');
  await echo('after-cancel');
  assert.equal((await files.readFile('renderer:1', { ...scope, path: '/usr/bin/tool.conf' })).content, content.toString(), '取消后文件预览仍可读取');
  terminal.end();

});
