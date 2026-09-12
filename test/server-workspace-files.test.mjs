import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

const scope = { projectId: 'example-project', environmentId: 'test-env', pluginInstanceId: 'example-server' };
const owner = 'renderer:1';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness({ now } = {}) {
  const plugin = { ...scope, revision: 1, pluginType: 'server', configState: 'ready' };
  const runtime = new EventEmitter();
  let connected = true;
  let generation = 1;
  const uploads = [];
  const audits = [];
  runtime.status = () => ({ connected, generation });
  runtime.statRemotePath = async (_plugin, target) => ({ path: target, canonicalPath: target, type: target.endsWith('.txt') ? 'file' : 'directory' });
  runtime.uploadRemoteFile = (selected, local, remote, precondition, options) => new Promise((resolve, reject) => {
    uploads.push({ selected, local, remote, precondition, options, resolve, reject });
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const store = { getPlugin: async () => ({ ...plugin }), appendAudit: async (_projectId, entry) => audits.push(entry) };
  const operations = {
    prepareMutation: async (_plugin, capability, args) => ({ ...args, _precondition: { local: { size: 100, mtimeMs: 1, sha256: 'example-digest' }, remote: { exists: args.remotePath.includes('existing'), type: 'file', size: 12 } } }),
    listDirectory: async (_plugin, args) => ({ ...args, entries: [], nextCursor: null, truncated: false }),
    readFile: async (_plugin, args) => ({ path: args.path, content: 'example', size: 7, truncated: false }),
  };
  const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: operations, ...(now ? { now } : {}) });
  return { files, runtime, plugin, store, operations, uploads, audits, disconnect: () => { connected = false; runtime.emit('lifecycle', { ...scope, type: 'disconnected' }); }, reconnect: () => { connected = true; generation += 1; } };
}
const local = (name) => path.resolve('test-upload-' + name + '.txt');

test('上传确认固定路径和窗口，拒绝改写、跨窗口和重复消费', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('new')]);
  assert.equal(prep.files[0].remotePath, '/srv/example/test-upload-new.txt');
  assert.equal(JSON.stringify(prep).includes('example-digest'), false);
  assert.equal(Object.hasOwn(prep.files[0], 'localPath'), false);
  await assert.rejects(h.files.confirmUpload('renderer:2', { ...scope, preparationId: prep.preparationId, overwrite: false }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, pluginInstanceId: 'other', preparationId: prep.preparationId, overwrite: false }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  const results = await Promise.allSettled([1, 2].map(() => h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false })));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  await flush();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].remote, '/srv/example/test-upload-new.txt');
  assert.equal(h.uploads[0].precondition.local.sha256, 'example-digest');
});

test('覆盖需要明确确认，连接换代和配置修改使上传确认失效', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('existing')]);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false }), { code: 'TARGET_EXISTS' });
  h.plugin.revision += 1;
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: true }), { code: 'WORKSPACE_CHANGED' });
  const next = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('new')]);
  h.reconnect();
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: false }), { code: 'WORKSPACE_CHANGED' });
  assert.equal(h.uploads.length, 0);
});

test('异步预检绑定窗口生命周期，窗口关闭后不能建立确认', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  let release;
  h.operations.prepareMutation = async (_plugin, _capability, args) => {
    await new Promise((resolve) => { release = resolve; });
    return { ...args, _precondition: { local: { size: 1 }, remote: { exists: false } } };
  };
  const pending = h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('new')]);
  await flush();
  h.files.closeOwner(owner); release();
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED' });
  assert.equal(h.files.preparations.size, 0);
});

test('上传只有两个并发，真实进度与完成提交分离，返回页面不取消任务', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('one'), local('two'), local('three')]);
  const result = await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  await flush();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.files.uploads(owner, scope).jobs.filter((job) => job.status === 'queued').length, 1);
  h.uploads[0].options.onProgress({ transferredBytes: 100, totalBytes: 100, phase: 'verifying' });
  assert.equal(h.files.uploads(owner, scope).jobs[0].status, 'verifying');
  h.uploads[0].resolve({ bytes: 100 }); await flush();
  assert.equal(h.files.uploads(owner, scope).jobs[0].status, 'completed');
  assert.equal(h.uploads.length, 3);
  const cancelled = h.files.cancelUpload(owner, { ...scope, jobId: result.jobs[1].jobId });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(h.uploads[1].options.signal.aborted, true);
  assert.equal(h.uploads[2].options.signal.aborted, false);
  assert.equal(JSON.stringify(h.audits).includes('example-digest'), false);
});

test('断线中止上传并保留失败状态，窗口销毁清理其任务', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('one')]);
  await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  await flush(); h.disconnect(); await flush();
  assert.equal(h.uploads[0].options.signal.aborted, true);
  assert.equal(h.files.uploads(owner, scope).jobs[0].status, 'error');
  h.files.closeOwner(owner);
  assert.deepEqual(h.files.uploads(owner, scope).jobs, []);
});

test('文件读取受数量和连接约束，特殊文件不能预览', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const listing = await h.files.listDirectory(owner, { ...scope, path: '/srv/example' });
  assert.equal(listing.limit, 200);
  await assert.rejects(h.files.readFile(owner, { ...scope, path: '/dev/device' }), { code: 'PATH_INVALID' });
  h.disconnect();
  await assert.rejects(h.files.listDirectory(owner, { ...scope, path: '/srv/example' }), { code: 'NOT_CONNECTED' });
});

test('桌面 IPC 拒绝子框架、非可信页面、任意路径和凭据字段', async () => {
  const handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  const event = { sender, senderFrame: sender.mainFrame };
  let trusted = true;
  const calls = [];
  const manager = { openTerminal: async (...args) => { calls.push(args); return { sessionId: 'example' }; }, closeOwner: (id) => calls.push(['close', id]) };
  registerServerWorkspaceIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    serverWorkspaceManager: manager, isWorkspaceRenderer: () => trusted,
  });
  const open = handlers.get('v2:server-terminal-open');
  const payload = { ...scope, cols: 80, rows: 24 };
  assert.equal((await open({ ...event, senderFrame: {} }, payload)).error.code, 'WORKSPACE_ACCESS_DENIED');
  trusted = false;
  assert.equal((await open(event, payload)).error.code, 'WORKSPACE_ACCESS_DENIED');
  trusted = true;
  assert.equal((await open(event, { ...payload, localPath: local('hidden') })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await open(event, { ...payload, password: 'example' })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await open(event, payload)).ok, true);
  assert.equal(calls[0][0], owner);
  sender.emit('did-start-navigation', {}, 'file:///example.html', false, true);
  assert.deepEqual(calls[1], ['close', owner]);
  sender.emit('destroyed');
  assert.deepEqual(calls[2], ['close', owner]);
});
test('上传预检在到期时失效并消耗，不能通过重复提交恢复', async (t) => {
  let clock = 1_000;
  const h = harness({ now: () => clock }); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('expires')]);
  assert.equal(prep.expiresAt, clock + 5 * 60 * 1000);
  clock = prep.expiresAt;
  const payload = { ...scope, preparationId: prep.preparationId, overwrite: false };
  await assert.rejects(h.files.confirmUpload(owner, payload), { code: 'UPLOAD_CONFIRMATION_EXPIRED' });
  assert.equal(h.files.preparations.has(prep.preparationId), false);
  await assert.rejects(h.files.confirmUpload(owner, payload), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  assert.equal(h.uploads.length, 0);
  assert.equal(h.files.jobs.size, 0);
});

test('路径栏和上传预检拒绝无法验证最终目标的路径', async (t) => {
  for (const scenario of [
    { name: '目录本身是符号链接', type: 'symlink', canonicalPath: '/srv/actual' },

    { name: '目录真实路径解析失败', type: 'directory', canonicalPath: null },
    { name: '目录真实路径缺失', type: 'directory' },
  ]) {
    await t.test(scenario.name, async (child) => {
      const h = harness(); child.after(() => h.files.dispose());
      let lists = 0; let preparations = 0;
      h.runtime.statRemotePath = async (_plugin, requested) => ({ path: requested, ...scenario });
      h.operations.listDirectory = async () => { lists += 1; return { entries: [] }; };
      h.operations.prepareMutation = async () => { preparations += 1; throw new Error('不应读取本地文件'); };
      await assert.rejects(h.files.listDirectory(owner, { ...scope, path: '/srv/link/nested' }), { code: 'PATH_INVALID' });
      await assert.rejects(h.files.prepareUpload(owner, { ...scope, path: '/srv/link/nested' }, [local('new')]), { code: 'PATH_INVALID' });
      assert.equal(lists, 0);
      assert.equal(preparations, 0);
      assert.equal(h.files.preparations.size, 0);
    });
  }
});

test('文件预览拒绝无法解析的链接和特殊文件', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  let reads = 0;
  h.operations.readFile = async () => { reads += 1; return { content: '不应读取' }; };
  for (const stat of [
    { type: 'symlink', canonicalPath: '/srv/actual.txt' },
    { type: 'special', canonicalPath: '/srv/example.txt' },

    { type: 'file', canonicalPath: null },
    { type: 'file' },
  ]) {
    h.runtime.statRemotePath = async () => stat;
    await assert.rejects(h.files.readFile(owner, { ...scope, path: '/srv/example.txt' }), { code: 'PATH_INVALID' });
  }
  assert.equal(reads, 0);
});

test('排队上传取消或关闭后清理内部参数且仅记录一次终止审计', async (t) => {
  for (const scenario of [
    { name: '取消排队任务', result: 'cancelled', stop: (h, id) => h.files.cancelUpload(owner, { ...scope, jobId: id }) },
    { name: '关闭服务器作用域', result: 'error', stop: (h) => h.files.closeScope(scope) },
    { name: '销毁窗口', result: 'cancelled', stop: (h) => h.files.closeOwner(owner) },
  ]) {
    await t.test(scenario.name, async (child) => {
      const h = harness(); child.after(() => h.files.dispose());
      const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('one'), local('two'), local('queued')]);
      const confirmed = await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
      await flush();
      const queued = h.files.jobs.get(confirmed.jobs[2].jobId);
      assert.equal(queued.status, 'queued');
      assert.ok(queued.args);
      scenario.stop(h, queued.jobId);
      await flush();
      assert.equal(queued.status, scenario.result);
      assert.equal(Object.hasOwn(queued, 'args'), false);
      assert.equal(h.audits.filter((entry) => entry.operation.remotePath === queued.path && entry.result === scenario.result).length, 1);
      assert.equal(h.audits.filter((entry) => entry.operation.remotePath === queued.path && entry.result === 'started').length, 0);
      for (const upload of h.uploads) upload.resolve({ bytes: 100 });
      await flush();
      assert.equal(h.uploads.length, 2);
      assert.equal(JSON.stringify(h.audits).includes('example-digest'), false);
    });
  }
});

test('启动审计等待期间配置修改阻止上传并记录失败', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  let release;
  h.store.appendAudit = async (_projectId, entry) => {
    h.audits.push(entry);
    if (entry.result === 'started') await new Promise((resolve) => { release = resolve; });
  };
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('revision')]);
  const confirmed = await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  await flush();
  assert.equal(typeof release, 'function');
  h.plugin.revision += 1;
  release();
  await flush();
  assert.equal(h.uploads.length, 0);
  const job = h.files.jobs.get(confirmed.jobs[0].jobId);
  assert.equal(job.status, 'error');
  assert.equal(Object.hasOwn(job, 'args'), false);
  assert.deepEqual(h.audits.map((entry) => entry.result), ['started', 'error']);
});

test('启动审计等待期间取消也记录一次终止审计', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  let release;
  h.store.appendAudit = async (_projectId, entry) => {
    h.audits.push(entry);
    if (entry.result === 'started') await new Promise((resolve) => { release = resolve; });
  };
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('cancel-before-start')]);
  const confirmed = await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  await flush();
  h.files.cancelUpload(owner, { ...scope, jobId: confirmed.jobs[0].jobId });
  release();
  await flush();
  assert.equal(h.uploads.length, 0);
  const job = h.files.jobs.get(confirmed.jobs[0].jobId);
  assert.equal(job.status, 'cancelled');
  assert.equal(Object.hasOwn(job, 'args'), false);
  assert.deepEqual(h.audits.map((entry) => entry.result), ['started', 'cancelled']);
});

test('原生文件选择仅接收主进程路径，窗口异步失效后不能建立上传预检', async (t) => {
  for (const scenario of ['navigation', 'destroyed']) {
    await t.test(scenario, async (child) => {
      const h = harness(); child.after(() => h.files.dispose());
      const handlers = new Map();
      let destroyed = false; let pickerCount = 0; let release;
      const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => destroyed });
      const event = { sender, senderFrame: sender.mainFrame };
      registerServerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
        serverWorkspaceFiles: h.files,
        isWorkspaceRenderer: () => true,
        pickServerUploadFiles: async (selectedSender) => {
          assert.equal(selectedSender, sender);
          pickerCount += 1;
          return new Promise((resolve) => { release = resolve; });
        },
      });
      const pick = handlers.get('v2:server-workspace-pick-upload');
      const payload = { ...scope, path: '/srv/example' };
      for (const injection of [{ localPath: local('unselected') }, { localPaths: [local('unselected')] }, { files: [local('unselected')] }]) {
        const result = await pick(event, { ...payload, ...injection });
        assert.equal(result.error.code, 'INVALID_ARGUMENT');
      }
      assert.equal(pickerCount, 0);
      const pending = pick(event, payload);
      await flush();
      assert.equal(pickerCount, 1);
      if (scenario === 'destroyed') { destroyed = true; sender.emit('destroyed'); }
      else sender.emit('did-start-navigation', {}, 'file:///example.html', false, true);
      release([local('selected')]);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.error.code, scenario === 'destroyed' ? 'WORKSPACE_ACCESS_DENIED' : 'WORKSPACE_CHANGED');
      assert.equal(h.files.preparations.size, 0);
      assert.equal(h.uploads.length, 0);
    });
  }
});

test('上传提交前再次校验窗口、连接、配置与目标父目录', async (t) => {
  for (const scenario of [
    { name: '配置修订变化', code: 'WORKSPACE_CHANGED', change: (h) => { h.plugin.revision += 1; } },
    { name: 'SSH 连接换代', code: 'WORKSPACE_CHANGED', change: (h) => h.reconnect() },
    { name: '窗口已关闭', code: 'WORKSPACE_CHANGED', change: (h) => h.files.closeOwner(owner) },
    { name: '目标父目录改为链接', code: 'WORKSPACE_PATH_CHANGED', change: (h) => { h.runtime.statRemotePath = async () => ({ type: 'directory', canonicalPath: '/srv/replaced' }); } },
  ]) {
    await t.test(scenario.name, async (child) => {
      const h = harness(); child.after(() => h.files.dispose());
      const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('before-commit')]);
      await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
      await flush();
      assert.equal(h.uploads.length, 1);
      const transfer = h.uploads[0];
      await transfer.options.beforeCommit();
      scenario.change(h);
      await assert.rejects(transfer.options.beforeCommit(), { code: scenario.code });
      transfer.reject(new Error('模拟提交前校验拒绝'));
      await flush();
      assert.equal(h.audits.some((entry) => entry.result === 'success'), false);
    });
  }
});


test('目录项保留自身路径，多个链接和展开后的目标文件不共用标识', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  h.operations.listDirectory = async (_plugin, args) => ({ path: args.path, nextCursor: '200', truncated: true, entries: args.path === '/' ? [
    { name: 'srv', path: '/srv', type: 'directory' },
    { name: 'shortcut', path: '/srv/example.conf', type: 'symlink' },
    { name: 'another-link', path: '/srv/example.conf', type: 'symlink' },
  ] : [{ name: 'example.conf', path: '/srv/example.conf', type: 'file' }] });
  const rootPage = await h.files.listDirectory(owner, { ...scope, path: '/' });
  const childPage = await h.files.listDirectory(owner, { ...scope, path: '/srv' });
  assert.deepEqual(rootPage.entries.map((entry) => entry.path), ['/srv', '/shortcut', '/another-link']);
  const paths = [...rootPage.entries, ...childPage.entries].map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(rootPage.entries[1].type, 'symlink');
  assert.equal(rootPage.entries[1].linkTarget, '/srv/example.conf');
  assert.equal(rootPage.entries[2].linkTarget, '/srv/example.conf');
  assert.equal(Object.hasOwn(childPage.entries[0], 'linkTarget'), false);
  assert.equal(rootPage.nextCursor, '200');
  assert.equal(rootPage.truncated, true);
});


function linkedHarness(t) {
  const h = harness(); t.after(() => h.files.dispose());
  let destination = '/usr/bin';
  h.setDestination = (value) => { destination = value; };
  h.runtime.statRemotePath = async (_plugin, requested) => {
    const canonicalPath = requested === '/bin' || requested.startsWith('/bin/') ? destination + requested.slice(4) : requested === '/tool.conf' ? '/usr/bin/tool.conf' : requested;
    return { path: requested, canonicalPath, type: requested === '/bin' || requested === '/tool.conf' ? 'symlink' : requested.endsWith('.conf') ? 'file' : 'directory' };
  };
  return h;
}

test('人工浏览解析目录链接、链接父路径和文件链接，保留独立显示路径', async (t) => {
  const h = linkedHarness(t);
  const reads = [];
  h.operations.listDirectory = async (_plugin, args) => {
    reads.push(args.path);
    return { path: args.path, entries: [{ name: 'tool.conf', path: args.path + '/tool.conf', type: 'file' }], nextCursor: null, truncated: false };
  };
  h.operations.readFile = async (_plugin, args) => { reads.push(args.path); return { path: args.path, content: 'fixture', size: 7 }; };
  const alias = await h.files.listDirectory(owner, { ...scope, path: '/bin' });
  assert.equal(alias.path, '/bin');
  assert.equal(alias.canonicalPath, '/usr/bin');
  assert.equal(alias.entries[0].path, '/bin/tool.conf');
  const file = await h.files.readFile(owner, { ...scope, path: '/bin/tool.conf' });
  assert.equal(file.path, '/bin/tool.conf');
  assert.equal(file.canonicalPath, '/usr/bin/tool.conf');
  const link = await h.files.readFile(owner, { ...scope, path: '/tool.conf' });
  assert.equal(link.path, '/tool.conf');
  assert.deepEqual(reads, ['/usr/bin', '/usr/bin/tool.conf', '/usr/bin/tool.conf']);
});

test('链接元数据复用只读通道，区分目录文件特殊目标并限制并发', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  let sessions = 0; let active = 0; let peak = 0;
  h.runtime.withRemoteReadSession = async (_plugin, run) => {
    sessions += 1;
    return run({ statPath: async (target) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return { canonicalPath: target, type: target.includes('special') ? 'special' : target.endsWith('.conf') ? 'file' : 'directory' };
    } });
  };
  h.operations.listDirectory = async () => ({ entries: Array.from({ length: 17 }, (_, index) => ({ name: 'link-' + index, type: 'symlink', path: index === 0 ? '/target-directory' : index === 1 ? '/special' : '/targets/' + index + '.conf' })), nextCursor: null });
  const page = await h.files.listDirectory(owner, { ...scope, path: '/' });
  assert.equal(sessions, 1);
  assert.equal(peak, 4);
  assert.equal(page.entries[0].linkTargetType, 'directory');
  assert.equal(page.entries[1].linkTargetType, 'special');
  assert.equal(page.entries[2].linkTargetType, 'file');
  assert.equal(page.entries[2].path, '/link-2');
});

test('读取期间链接换目标时拒绝交付旧目录或文件内容', async (t) => {
  const h = linkedHarness(t);
  h.operations.listDirectory = async () => { h.setDestination('/changed'); return { entries: [] }; };
  await assert.rejects(h.files.listDirectory(owner, { ...scope, path: '/bin' }), { code: 'WORKSPACE_PATH_CHANGED' });
  h.setDestination('/usr/bin');
  h.operations.readFile = async () => { h.setDestination('/changed'); return { content: 'fixture' }; };
  await assert.rejects(h.files.readFile(owner, { ...scope, path: '/bin/tool.conf' }), { code: 'WORKSPACE_PATH_CHANGED' });
});

test('链接目录上传显示并绑定实际目标，确认前和提交前换目标均拒绝', async (t) => {
  const h = linkedHarness(t);
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/bin' }, [local('linked')]);
  assert.equal(prep.sourcePath, '/bin');
  assert.equal(prep.path, '/usr/bin');
  assert.equal(prep.files[0].remotePath, '/usr/bin/test-upload-linked.txt');
  h.setDestination('/changed');
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false }), { code: 'WORKSPACE_PATH_CHANGED' });
  assert.equal(h.uploads.length, 0);
  h.setDestination('/usr/bin');
  const next = await h.files.prepareUpload(owner, { ...scope, path: '/bin' }, [local('linked')]);
  await h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: false });
  await flush();
  assert.equal(h.uploads[0].remote, '/usr/bin/test-upload-linked.txt');
  await h.uploads[0].options.beforeCommit();
  h.setDestination('/changed');
  await assert.rejects(h.uploads[0].options.beforeCommit(), { code: 'WORKSPACE_PATH_CHANGED' });
});


test('目录树省略 SFTP 自身和父目录条目，不产生重复路径或父级展开', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  h.operations.listDirectory = async () => ({ entries: [{name:'.',path:'/srv',type:'directory'}, {name:'..',path:'/',type:'directory'}, {name:'child',path:'/srv/child',type:'directory'}], nextCursor:'200', truncated:true });
  const page = await h.files.listDirectory(owner, {...scope,path:'/srv'});
  assert.deepEqual(page.entries.map(entry=>entry.path), ['/srv/child']);
  assert.equal(page.nextCursor,'200');
});
