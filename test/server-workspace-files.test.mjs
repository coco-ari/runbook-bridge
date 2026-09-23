import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { ServerOperations } from '../src/server-operations.mjs';
import { BoundedReadScheduler } from '../src/bounded-read-scheduler.mjs';
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
  assert.equal(prep.files[0].localPath, local('new'));
  assert.equal(Object.hasOwn(prep.files[0], '_precondition'), false);
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
  const recovering = { ...payload, tabId:'tab-a', recoveryOf:'previous-session' };
  assert.equal((await open(event, recovering)).ok, true);
  assert.deepEqual(calls.pop(), [owner, recovering]);
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

function cachedHarness() {
  const h = harness();
  const calls = { sessions: 0, scans: 0, stats: [], active: 0, peak: 0, cancelled: 0 };
  let entries = Array.from({ length: 450 }, (_, index) => ({ name: String(index).padStart(4, '0'), type: index < 200 ? 'symlink' : 'file', size: 1, mode: 0o644, mtime: 1 }));
  let beforeStat = async () => {};
  let beforeScan = async () => {};
  let canonical = '/srv/example';
  h.runtime.withWorkspaceReadSession = async (_plugin, operation, { signal }) => {
    calls.sessions += 1;
    const aborted = () => { calls.cancelled += 1; };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      return await operation({
        listDirectoryEntries: async () => { calls.scans += 1; await beforeScan(); return { entries, truncated: false }; },
        statPath: async (target) => {
          calls.stats.push(target);
          if (target === '/srv/example' || target === canonical) return { type: 'directory', canonicalPath: canonical };
          calls.active += 1; calls.peak = Math.max(calls.peak, calls.active);
          try { return await beforeStat(target) ?? { type: 'file', canonicalPath: target }; } finally { calls.active -= 1; }
        },
      });
    } finally { signal.removeEventListener('abort', aborted); }
  };
  const input = { ...scope, path: '/srv/example', deferLinks: true };
  return { ...h, calls, input, setEntries: (value) => { entries = value; }, setStat: (value) => { beforeStat = value; }, setScan: (value) => { beforeScan = value; }, setCanonical: (value) => { canonical = value; } };
}

test('目录快照在分页前将文件夹置顶并按名称自然排序，跨页没有漏项或重复', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  const directories = Array.from({ length: 205 }, (_, index) => ({ name: 'z-folder' + (205 - index), type: 'directory' }));
  const files = Array.from({ length: 410 }, (_, index) => ({ name: 'a-file' + (410 - index), type: 'file' }));
  h.setEntries([...files, ...directories]);
  let page = await h.files.listDirectory(owner, h.input);
  assert.ok(page.entries.every(entry => entry.type === 'directory'), '首屏不能因文件名称靠前而遗漏文件夹');
  const entries = [...page.entries];
  while (page.nextCursor) {
    page = await h.files.listDirectory(owner, { ...h.input, snapshotId: page.snapshotId, cursor: page.nextCursor });
    entries.push(...page.entries);
  }
  assert.deepEqual(entries.map(entry => entry.name), [
    ...Array.from({ length: 205 }, (_, index) => 'z-folder' + (index + 1)),
    ...Array.from({ length: 410 }, (_, index) => 'a-file' + (index + 1)),
  ]);
  assert.equal(new Set(entries.map(entry => entry.path)).size, 615);
  assert.equal(h.calls.scans, 1, '继续分页不重复扫描目录');
  assert.ok(h.calls.stats.every(target => target === h.input.path), '普通条目排序不增加逐项属性查询');
});

test('跨页链接解析为目录后保留快照顺序和原游标，展示分组不影响分页', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  h.setEntries([
    { name: 'folder', type: 'directory' },
    ...Array.from({ length: 205 }, (_, index) => ({ name: 'a-file' + index, type: 'file' })),
    { name: 'z-link', type: 'symlink' },
  ]);
  const first = await h.files.listDirectory(owner, h.input);
  const input = { ...h.input, snapshotId: first.snapshotId, cursor: first.nextCursor };
  const second = await h.files.listDirectory(owner, input);
  assert.equal(second.metadataPending, true);
  h.setStat(async target => ({ type: 'directory', canonicalPath: target }));
  const resolved = await h.files.listDirectory(owner, { ...input, resolveLinks: true });
  assert.equal(resolved.entries.at(-1).linkTargetType, 'directory');
  assert.deepEqual(resolved.entries.map(entry => entry.path), second.entries.map(entry => entry.path));
  assert.equal(resolved.nextCursor, second.nextCursor);
  const firstAgain = await h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId });
  assert.deepEqual(firstAgain.entries, first.entries, '后台解析不能把第二页的目录链接移入第一页');
  assert.equal(h.calls.scans, 1);
});

test('目录首屏不等待链接查询，分页复用一次扫描且后台链接并发有界', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  let release; const gate = new Promise((resolve) => { release = resolve; });
  h.setStat(() => gate);
  const first = await h.files.listDirectory(owner, h.input);
  assert.equal(first.entries.length, 200);
  assert.equal(first.metadataPending, true);
  assert.equal(h.calls.sessions, 1);
  assert.deepEqual(h.calls.stats, ['/srv/example', '/srv/example']);
  const metadata = h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId, resolveLinks: true });
  await flush();
  assert.equal(h.calls.peak, 8);
  const second = await h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId, cursor: first.nextCursor });
  assert.equal(second.entries[0].name, '0200');
  assert.equal(second.metadataPending, false);
  assert.equal(h.calls.scans, 1);
  release();
  assert.equal((await metadata).metadataPending, false);
  const again = await h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId, resolveLinks: true });
  assert.ok(again.entries.every((entry) => entry.linkTargetType === 'file'));
  assert.equal(h.calls.stats.filter((value) => value !== h.input.path).length, 200, '每个链接只解析一次，普通文件不额外查属性');
  assert.equal(h.calls.scans, 1);
});

test('目录快照绑定窗口、路径、配置和连接代次，刷新替换旧快照', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  const first = await h.files.listDirectory(owner, h.input);
  const request = { ...h.input, snapshotId: first.snapshotId, cursor: '200' };
  await assert.rejects(h.files.listDirectory('renderer:2', request), { code: 'WORKSPACE_DIRECTORY_EXPIRED' });
  await assert.rejects(h.files.listDirectory(owner, { ...request, path: '/other' }), { code: 'WORKSPACE_DIRECTORY_EXPIRED' });
  h.plugin.revision += 1;
  await assert.rejects(h.files.listDirectory(owner, request), { code: 'WORKSPACE_DIRECTORY_EXPIRED' });
  h.plugin.revision -= 1;
  h.reconnect();
  await assert.rejects(h.files.listDirectory(owner, request), { code: 'WORKSPACE_DIRECTORY_EXPIRED' });
  const fresh = await h.files.listDirectory(owner, h.input);
  const refreshed = await h.files.listDirectory(owner, h.input);
  assert.notEqual(fresh.snapshotId, refreshed.snapshotId);
  await assert.rejects(h.files.listDirectory(owner, { ...h.input, snapshotId: fresh.snapshotId }), { code: 'WORKSPACE_DIRECTORY_EXPIRED' });
  h.setCanonical('/srv/changed');
  await assert.rejects(h.files.listDirectory(owner, { ...h.input, snapshotId: refreshed.snapshotId, cursor: '200' }), { code: 'WORKSPACE_PATH_CHANGED' });
});

test('并发首次目录读取共享完整校验，不为等待者另开会话，后续分页和刷新仍重新校验', async t => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  let release; h.setScan(() => new Promise(resolve => { release = resolve; }));
  const pending = Promise.all([1,2].map(() => h.files.listDirectory(owner, h.input)));
  await flush(); assert.equal(h.calls.scans, 1); release();
  const [first, joined] = await pending;
  assert.equal(first.snapshotId, joined.snapshotId); assert.deepEqual(first.entries, joined.entries);
  assert.equal(h.calls.sessions, 1, '等待同一首次扫描的调用不再申请第二次读取会话');
  assert.deepEqual(h.calls.stats, [h.input.path, h.input.path], '共享结果仍经过扫描前后两次路径检查');
  await h.files.listDirectory(owner, { ...h.input, snapshotId:first.snapshotId, cursor:first.nextCursor });
  assert.equal(h.calls.sessions, 2); assert.equal(h.calls.stats.length, 3, '后来的分页请求仍复核路径');
  h.setScan(async () => {});
  const refreshed = await h.files.listDirectory(owner, h.input);
  assert.notEqual(refreshed.snapshotId, first.snapshotId); assert.equal(h.calls.scans, 2);
  assert.equal(h.calls.stats.length, 5, '完成后的显式刷新重新执行前后检查');
});

test('并发首次目录读取遇到路径或配置变化时全部拒绝，不留下可用快照', async t => {
  for (const change of ['path','revision']) await t.test(change, async child => {
    const h = cachedHarness(); child.after(() => h.files.dispose());
    let release; h.setScan(() => new Promise(resolve => { release = resolve; }));
    const pending = Promise.allSettled([1,2].map(() => h.files.listDirectory(owner, h.input)));
    await flush();
    if (change === 'path') h.setCanonical('/srv/changed'); else h.plugin.revision += 1;
    release();
    const results = await pending;
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.ok(results.every(result => result.reason.code === (change === 'path' ? 'WORKSPACE_PATH_CHANGED' : 'WORKSPACE_CHANGED')));
    assert.equal(h.files.directoryCache.snapshots.size, 0);
  });
});

test('并发首次读取合并扫描，窗口关闭中止读取且迟到响应不能重建缓存', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  let release; h.setScan(() => new Promise((resolve) => { release = resolve; }));
  const reads = Promise.allSettled([h.files.listDirectory(owner, h.input), h.files.listDirectory(owner, h.input)]);
  await flush();
  assert.equal(h.calls.scans, 1);
  h.files.closeOwner(owner);
  assert.equal(h.calls.cancelled, 1);
  release();
  assert.ok((await reads).every((result) => result.status === 'rejected'));
  assert.equal(h.files.directoryCache.snapshots.size, 0);
});

test('后台链接请求合并且刷新后旧链接响应失效，不把传输错误标记为断链', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  h.setEntries([{ name: 'shortcut', type: 'symlink' }]);
  const first = await h.files.listDirectory(owner, h.input);
  h.setStat(async () => { throw Object.assign(new Error('fixture timeout'), { code: 'SFTP_OPERATION_TIMEOUT' }); });
  await assert.rejects(h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId, resolveLinks: true }), { code: 'SFTP_OPERATION_TIMEOUT' });
  const stillPending = await h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId });
  assert.equal(stillPending.entries[0].linkTargetType, undefined);
  let release; h.setStat(() => new Promise((resolve) => { release = resolve; }));
  const before = h.calls.sessions;
  const reads = Promise.allSettled([1, 2].map(() => h.files.listDirectory(owner, { ...h.input, snapshotId: first.snapshotId, resolveLinks: true })));
  await flush(); assert.equal(h.calls.sessions, before + 1);
  const fresh = await h.files.listDirectory(owner, h.input);
  release();
  assert.ok((await reads).every((value) => value.status === 'rejected'));
  assert.equal(fresh.entries[0].linkTargetType, undefined);
  assert.equal(h.files.directoryCache.snapshots.has(first.snapshotId), false);
});

test('目录缓存限制目录数和总条目，断连清除作用域缓存', async (t) => {
  const h = cachedHarness(); t.after(() => h.files.dispose());
  h.setEntries([{ name: 'file', type: 'file' }]);
  for (let index = 0; index < 40; index += 1) { h.setCanonical('/srv/example' + index); await h.files.listDirectory(owner, { ...h.input, path: '/srv/example' + index }); }
  assert.equal(h.files.directoryCache.snapshots.size, 32);
  h.setEntries(Array.from({ length: 10_000 }, (_, index) => ({ name: String(index), type: 'file' })));
  for (let index = 0; index < 3; index += 1) { h.setCanonical('/large' + index); await h.files.listDirectory(owner, { ...h.input, path: '/large' + index }); }
  assert.equal([...h.files.directoryCache.snapshots.values()].reduce((sum, item) => sum + item.entries.length, 0), 20_000);
  h.disconnect();
  assert.equal(h.files.directoryCache.snapshots.size, 0);
});

test('上传方案移除文件后在固定目录重新绑定预检，旧确认不能再使用', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const calls = [];
  h.operations.prepareMutation = async (_plugin, _capability, args) => {
    calls.push(args);
    return { ...args, _precondition: { local: { size: 123, sha256: 'fixture-recheck-' + calls.length }, remote: { exists: calls.length > 2, type: 'file' } } };
  };
  const first = await h.files.prepareUpload(owner, { ...scope, path: '/old' }, [local('keep'), local('remove')]);
  const next = await h.files.reviseUpload(owner, { ...scope, preparationId: first.preparationId, path: '/old', fileNames: [first.files[0].name] });
  assert.notEqual(next.preparationId, first.preparationId);
  assert.deepEqual(next.files, [{ name: first.files[0].name, bytes: 123, localPath: local('keep'), remotePath: '/old/' + first.files[0].name, exists: true }]);
  assert.equal(calls.length, 3, '保留的文件重新计算预检状态');
  assert.equal(calls.at(-1).localPath, local('keep'));
  assert.equal(next.files[0].localPath, local('keep'));
  assert.equal(JSON.stringify(next).includes('sha256'), false);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: false }), { code: 'TARGET_EXISTS' });
  const result = await h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: true });
  assert.equal(result.jobs[0].path, '/old/' + first.files[0].name);
});

test('上传方案修改期间阻止旧确认，预检失败后可重试但不能恢复旧写入凭证', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const first = await h.files.prepareUpload(owner, { ...scope, path: '/old' }, [local('keep')]);
  let release;
  let denied = true;
  h.operations.prepareMutation = async (_plugin, _capability, args) => {
    await new Promise((resolve) => { release = resolve; });
    if (denied) throw Object.assign(new Error('fixture denied'), { code: 'PERMISSION_DENIED' });
    return { ...args, _precondition: { local: { size: 1 }, remote: { exists: false } } };
  };
  const payload = { ...scope, preparationId: first.preparationId, path: '/old', fileNames: first.files.map(file => file.name) };
  const pending = h.files.reviseUpload(owner, payload);
  await flush();
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'UPLOAD_REVIEW_REQUIRED' });
  await assert.rejects(h.files.reviseUpload(owner, payload), { code: 'WORKSPACE_BUSY' });
  release();
  await assert.rejects(pending, { code: 'PERMISSION_DENIED' });
  assert.equal(h.files.jobs.size, 0);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'UPLOAD_REVIEW_REQUIRED' });
  denied = false;
  const retry = h.files.reviseUpload(owner, payload);
  await flush(); release();
  assert.equal((await retry).path, '/old');
});

test('上传方案修改拒绝跨窗口跨作用域和新增本地文件，移除最后一个文件撤销确认', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const first = await h.files.prepareUpload(owner, { ...scope, path: '/old' }, [local('keep')]);
  const payload = { ...scope, preparationId: first.preparationId, path: '/old', fileNames: first.files.map(file => file.name) };
  await assert.rejects(h.files.reviseUpload('renderer:2', payload), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.reviseUpload(owner, { ...payload, environmentId: 'other' }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.reviseUpload(owner, { ...payload, fileNames: ['unknown.txt'] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.files.reviseUpload(owner, { ...payload, fileNames: [...payload.fileNames, ...payload.fileNames] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(await h.files.reviseUpload(owner, { ...payload, fileNames: [] }), null);
  assert.equal(h.files.preparations.size, 0);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
});

test('上传方案修改绑定配置和窗口生命周期，关闭后迟到预检不能重新发布', async (t) => {
  for (const close of ['owner', 'scope', 'revision', 'generation']) await t.test(close, async () => {
    const h = harness();
    try {
      const first = await h.files.prepareUpload(owner, { ...scope, path: '/old' }, [local('keep')]);
      let release;
      h.operations.prepareMutation = async (_plugin, _capability, args) => {
        await new Promise((resolve) => { release = resolve; });
        return { ...args, _precondition: { local: { size: 1 }, remote: { exists: false } } };
      };
      const pending = h.files.reviseUpload(owner, { ...scope, preparationId: first.preparationId, path: '/old', fileNames: first.files.map(file => file.name) });
      await flush();
      if (close === 'owner') h.files.closeOwner(owner);
      if (close === 'scope') h.files.closeScope(scope);
      if (close === 'revision') h.plugin.revision += 1;
      if (close === 'generation') h.reconnect();
      release();
      await assert.rejects(pending, { code: close === 'scope' ? 'UPLOAD_CONFIRMATION_INVALID' : 'WORKSPACE_CHANGED' });
      assert.equal(h.files.jobs.size, 0);
      assert.ok([...h.files.preparations.values()].every(preparation => preparation.needsRevision));
    } finally { h.files.dispose(); }
  });
});


test('桌面上传进度返回服务端计算的速度和剩余时间，结束后清除估算', async t => {
  let now = 1000;
  const h = harness({ now: () => now });
  t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/srv/example' }, [local('rate')]);
  await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  await flush();
  const transfer = h.uploads[0];
  transfer.options.onProgress({ transferredBytes: 0, totalBytes: 100, phase: 'uploading' });
  now += 1000;
  transfer.options.onProgress({ transferredBytes: 25, totalBytes: 100, phase: 'uploading' });
  let job = h.files.uploads(owner, scope).jobs[0];
  assert.equal(job.bytesPerSecond, 25);
  assert.equal(job.etaSeconds, 3);
  transfer.options.onProgress({ transferredBytes: 100, totalBytes: 100, phase: 'verifying' });
  job = h.files.uploads(owner, scope).jobs[0];
  assert.equal(job.status, 'verifying');
  assert.equal(job.etaSeconds, null);
  transfer.resolve({ bytes: 100 });
  await flush();
  assert.equal(h.files.uploads(owner, scope).jobs[0].bytesPerSecond, undefined);
});

test('上传方案拒绝更换目标目录，原凭证仍只能上传到原目录', async (t) => {
  const h = harness(); t.after(() => h.files.dispose());
  const prep = await h.files.prepareUpload(owner, { ...scope, path: '/home' }, [local('fixed')]);
  await assert.rejects(h.files.reviseUpload(owner, {
    ...scope, preparationId: prep.preparationId, path: '/other', fileNames: prep.files.map(file => file.name),
  }), { code: 'INVALID_ARGUMENT' });
  const { jobs } = await h.files.confirmUpload(owner, { ...scope, preparationId: prep.preparationId, overwrite: false });
  assert.equal(jobs[0].path, '/home/test-upload-fixed.txt');
  await flush();
  assert.equal(h.uploads[0].local, local('fixed'));
});

test('上传重新检查保留逻辑目录和实际目标绑定，链接改向不能更新目标', async (t) => {
  const h = linkedHarness(t);
  const first = await h.files.prepareUpload(owner, { ...scope, path: '/bin' }, [local('linked')]);
  const payload = { ...scope, preparationId: first.preparationId, path: '/bin', fileNames: first.files.map(file => file.name) };
  const next = await h.files.reviseUpload(owner, payload);
  assert.equal(next.sourcePath, '/bin');
  assert.equal(next.path, '/usr/bin');
  h.setDestination('/changed');
  await assert.rejects(h.files.reviseUpload(owner, { ...payload, preparationId: next.preparationId }), { code: 'WORKSPACE_PATH_CHANGED' });
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: true }), { code: 'UPLOAD_REVIEW_REQUIRED' });
  assert.equal(h.files.jobs.size, 0);
});

test('续传重新绑定连接并使用新的一次性确认，原任务与文件参数保持不变', async t => {
  const h=harness(); t.after(()=>h.files.dispose());
  h.plugin.target={hostKeyFingerprint:'fixture-pinned-key'};
  const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},[local('resume')]);
  const initial=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
  await flush();
  const checkpoint={bytes:64,sha256:'private-checkpoint',temporary:'/private-part'};
  h.uploads[0].options.onCheckpoint(checkpoint);
  h.disconnect(); await flush();
  const paused=h.files.uploads(owner,scope).jobs[0];
  assert.equal(paused.status,'interrupted'); assert.equal(paused.canResume,true);
  assert.equal(JSON.stringify(paused).includes('private'),false);
  await assert.rejects(h.files.prepareUploadResume(owner,{...scope,jobId:paused.jobId}),{code:'NOT_CONNECTED'});
  h.reconnect();
  await assert.rejects(h.files.prepareUploadResume('renderer:2',{...scope,jobId:paused.jobId}),{code:'UPLOAD_NOT_FOUND'});
  const review=await h.files.prepareUploadResume(owner,{...scope,jobId:paused.jobId});
  assert.equal(review.resume.bytes,64); assert.notEqual(review.preparationId,prep.preparationId);
  assert.equal(JSON.stringify(review).includes('private'),false);
  await assert.rejects(h.files.reviseUploadReview(owner,{...scope,reviewId:review.reviewId,fileNames:[review.files[0].name]}),{code:'UPLOAD_RESUME_INVALID'});
  const result=await Promise.allSettled([1,2].map(()=>h.files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false})));
  assert.equal(result.filter(item=>item.status==='fulfilled').length,1);
  await flush();
  assert.equal(h.uploads.length,2);
  assert.equal(h.files.jobs.size,1);
  assert.equal(h.files.jobs.get(initial.jobs[0].jobId).generation,2);
  assert.deepEqual(h.uploads[1].options.checkpoint,checkpoint);
  assert.equal(h.uploads[1].precondition,h.uploads[0].precondition);
  h.uploads[1].resolve({bytes:100}); await flush();
  assert.equal(h.files.uploads(owner,scope).jobs[0].status,'completed');
  assert.equal(h.files.jobs.get(paused.jobId).args,undefined);
  assert.equal(h.files.jobs.get(paused.jobId).checkpoint,undefined);
});

test('续传拒绝配置、指纹、窗口变化和过期，取消后不能复活', async t => {
  for (const mutation of ['revision','fingerprint','owner','scope','expired','cancelled','generation']) await t.test(mutation,async child=>{
    let now=100;
    const h=harness({now:()=>now}); child.after(()=>h.files.dispose());
    h.plugin.target={hostKeyFingerprint:'fixture-pinned-key'};
    const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},[local('resume')]);
    const {jobs:[job]}=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
    await flush(); h.disconnect(); await flush(); h.reconnect();
    const review=await h.files.prepareUploadResume(owner,{...scope,jobId:job.jobId});
    if(mutation==='revision') h.plugin.revision++;
    if(mutation==='fingerprint') h.plugin.target={hostKeyFingerprint:'different-key'};
    if(mutation==='owner') h.files.closeOwner(owner);
    if(mutation==='scope') h.files.closeScope(scope);
    if(mutation==='expired') now+=31*60*1000;
    if(mutation==='cancelled') h.files.cancelUpload(owner,{...scope,jobId:job.jobId});
    if(mutation==='generation') h.reconnect();
    await assert.rejects(h.files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false}));
    assert.equal(h.uploads.length,1);
  });
});

test('续传等待旧操作结束，队列中断可从零恢复，最多三次', async t=>{
  const h=harness(); t.after(()=>h.files.dispose());
  h.plugin.target={hostKeyFingerprint:'fixture-pinned-key'};
  const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},[local('one'),local('two'),local('queued')]);
  const {jobs}=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
  await flush(); h.disconnect();
  assert.throws(()=>h.files.uploadResumes.get(owner,{...scope,jobId:jobs[0].jobId}),{code:'UPLOAD_RESUME_UNAVAILABLE'});
  await flush(); h.reconnect();
  for(let attempt=0;attempt<3;attempt++){
    const review=await h.files.prepareUploadResume(owner,{...scope,jobId:jobs[2].jobId});
    await h.files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false});
    await flush(); h.disconnect(); await flush(); h.reconnect();
  }
  assert.equal(h.files.jobs.get(jobs[2].jobId).status,'error');
  assert.equal(h.files.jobs.get(jobs[2].jobId).args,undefined);
});

test('SFTP 超时可重新确认继续，取消续传确认不会取消中断任务', async t=>{
  const h=harness(); t.after(()=>h.files.dispose()); h.plugin.target={hostKeyFingerprint:'fixture-pinned-key'};
  const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},[local('timeout')]);
  const {jobs:[job]}=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
  await flush();
  h.uploads[0].reject(Object.assign(new Error('timeout'),{code:'SFTP_OPERATION_TIMEOUT'})); await flush();
  const review=await h.files.prepareUploadResume(owner,{...scope,jobId:job.jobId});
  h.files.cancelUploadReview(owner,{...scope,reviewId:review.reviewId});
  assert.equal(h.files.jobs.get(job.jobId).status,'interrupted');
  await assert.rejects(h.files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false}),{code:'UPLOAD_CONFIRMATION_INVALID'});
  h.files.cancelUpload(owner,{...scope,jobId:job.jobId});
  assert.equal(h.files.jobs.get(job.jobId).args,undefined);
});

test('续传 IPC 只能引用任务，拒绝客户端传入路径、偏移和检查点', async ()=>{
  const handlers=new Map();
  const sender=Object.assign(new EventEmitter(),{id:1,mainFrame:{},isDestroyed:()=>false});
  let called=0;
  registerServerWorkspaceIpc({handle:(name,fn)=>handlers.set(name,fn)},{isWorkspaceRenderer:()=>true,serverWorkspaceFiles:{prepareUploadResume:async()=>{called++;return {};}}});
  const invoke=handlers.get('v2:server-workspace-prepare-upload-resume');
  for(const extra of [{checkpoint:{}},{localPath:'fake'},{offset:100},{remotePath:'/fake'}]){
    const result=await invoke({sender,senderFrame:sender.mainFrame},{...scope,jobId:'job',...extra});
    assert.equal(result.error.code,'INVALID_ARGUMENT');
  }
  assert.equal(called,0);
});

test('暂停仅处理本窗口任务，等待安全检查点，手动继续不消耗断线次数', async t => {
  const h = harness(); t.after(() => h.files.dispose());
  h.plugin.target = {hostKeyFingerprint:'SHA256:fixture'};
  const prep = await h.files.prepareUpload(owner, {...scope,path:'/srv/example'}, [local('pause')]);
  const {jobs:[job]} = await h.files.confirmUpload(owner, {...scope,preparationId:prep.preparationId,overwrite:false});
  await flush();
  assert.throws(() => h.files.pauseUpload('renderer:2', {...scope,jobId:job.jobId}), {code:'UPLOAD_NOT_FOUND'});
  assert.equal(h.files.pauseUpload(owner, {...scope,jobId:job.jobId}).status,'pausing');
  assert.equal(h.uploads[0].options.signal.aborted,false);
  assert.equal(h.uploads[0].options.shouldPause(),true);
  await assert.rejects(h.files.prepareUploadResume(owner, {...scope,jobId:job.jobId}), {code:'UPLOAD_RESUME_UNAVAILABLE'});
  h.uploads[0].options.onCheckpoint({bytes:50,phase:'uploading'});
  h.uploads[0].reject(Object.assign(new Error('pause'), {code:'UPLOAD_PAUSED'}));
  await flush();
  const paused=h.files.uploads(owner,scope).jobs[0];
  assert.equal(paused.status,'paused'); assert.equal(paused.canResume,true); assert.equal(paused.transferred,50);
  assert.throws(() => h.files.clearTransfers(owner,{...scope,jobId:job.jobId}),{code:'TRANSFER_BUSY'});
  assert.deepEqual(h.files.clearTransfers(owner,scope),{removedIds:[]});
  for (let i=0;i<4;i++) {
    const review=await h.files.prepareUploadResume(owner,{...scope,jobId:job.jobId});
    await h.files.confirmUpload(owner,{...scope,preparationId:review.preparationId,overwrite:false});
    await flush();
    assert.equal(h.files.jobs.get(job.jobId).resumeAttempts,0);
    assert.equal(h.uploads.at(-1).options.shouldPause(),false);
    h.files.pauseUpload(owner,{...scope,jobId:job.jobId});
    h.uploads.at(-1).reject(Object.assign(new Error('pause'),{code:'UPLOAD_PAUSED'}));
    await flush();
  }
  h.files.cancelUpload(owner,{...scope,jobId:job.jobId});
  assert.deepEqual(h.files.clearTransfers(owner,{...scope,jobId:job.jobId}),{removedIds:[job.jobId]});
});

test('排队可暂停，最终校验不可暂停，活动任务不能清理', async t => {
  const h=harness();t.after(()=>h.files.dispose());h.plugin.target={hostKeyFingerprint:'SHA256:fixture'};
  const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},['one','two','three'].map(local));
  const {jobs}=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
  await flush();
  assert.equal(h.files.pauseUpload(owner,{...scope,jobId:jobs[2].jobId}).status,'paused');
  assert.equal(h.files.jobs.get(jobs[2].jobId).inFlight,undefined);
  h.uploads[0].options.onProgress({transferredBytes:100,phase:'verifying'});
  assert.throws(()=>h.files.pauseUpload(owner,{...scope,jobId:jobs[0].jobId}),{code:'UPLOAD_PAUSE_UNAVAILABLE'});
  h.files.cancelUpload(owner,{...scope,jobId:jobs[1].jobId});
  assert.throws(()=>h.files.clearTransfers(owner,{...scope,jobId:jobs[1].jobId}),{code:'TRANSFER_BUSY'});
  await flush();
  assert.deepEqual(h.files.clearTransfers('renderer:2',scope).removedIds,[]);
  assert.deepEqual(h.files.clearTransfers(owner,{...scope,environmentId:'other'}).removedIds,[]);
  assert.deepEqual(h.files.clearTransfers(owner,scope).removedIds,[jobs[1].jobId]);
  h.uploads[0].resolve({bytes:100});await flush();
  assert.deepEqual(h.files.clearTransfers(owner,scope).removedIds,[jobs[0].jobId]);
  assert.equal(h.files.jobs.size,1);
});

test('暂停记录仍受过期、配置修改和窗口生命周期约束', async t=>{
  let now=0;const h=harness({now:()=>now});t.after(()=>h.files.dispose());
  h.plugin.target={hostKeyFingerprint:'SHA256:fixture'};h.files.running=2;
  const prep=await h.files.prepareUpload(owner,{...scope,path:'/srv/example'},[local('pause')]);
  const {jobs:[job]}=await h.files.confirmUpload(owner,{...scope,preparationId:prep.preparationId,overwrite:false});
  h.files.pauseUpload(owner,{...scope,jobId:job.jobId});
  now=31*60*1000;
  await assert.rejects(h.files.prepareUploadResume(owner,{...scope,jobId:job.jobId}),{code:'UPLOAD_RESUME_UNAVAILABLE'});
  h.files.closeScope(scope);
  assert.equal(h.files.uploads(owner,scope).jobs[0].status,'error');
  assert.equal(h.files.jobs.get(job.jobId).args,undefined);
  h.files.closeOwner(owner);assert.equal(h.files.jobs.size,0);
});

test('下载只从原生对话框获取本地路径，拒绝越权字段及窗口换代', async t=>{
  const h=harness();t.after(()=>h.files.dispose());
  const handlers=new Map();const sender=new EventEmitter();sender.id=1;sender.mainFrame={};sender.isDestroyed=()=>false;
  const event={sender,senderFrame:sender.mainFrame};
  h.runtime.statRemotePath=async (_p,target)=>({type:'file',size:1,mode:0o100644,mtime:1,canonicalPath:target});
  let picked=0;
  registerServerWorkspaceIpc({handle:(name,fn)=>handlers.set(name,fn)},{
    serverWorkspaceFiles:h.files,isWorkspaceRenderer:()=>true,
    pickServerDownloadPath:async()=>{picked++;h.reconnect();return local('download');},
  });
  const invoke=(payload,ev=event)=>handlers.get('v2:server-workspace-download')(ev,payload);
  assert.equal((await invoke({...scope,path:'/file.txt',localPath:local('evil')})).error.code,'INVALID_ARGUMENT');
  assert.equal(picked,0);
  assert.equal((await invoke({...scope,path:'/file.txt'},{sender,senderFrame:{}})).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.equal((await invoke({...scope,path:'/file.txt'})).error.code,'WORKSPACE_CHANGED');
  assert.equal(h.files.jobs.size,0);
});

test('退出统计覆盖多个工作区、暂停和取消尚未收尾任务，不计入结束记录', t => {
  const h=harness();
  t.after(() => { h.files.jobs.clear(); h.files.dispose(); });
  const states=[
    {status:'queued'}, {status:'running'}, {status:'verifying'}, {status:'pausing'},
    {status:'paused'}, {status:'interrupted'}, {status:'cancelled',inFlight:true},
    {status:'completed'}, {status:'cancelled'}, {status:'error'},
  ];
  states.forEach((job,index)=>h.files.jobs.set(String(index),job));
  assert.deepEqual(h.files.exitSummary(),{active:5,resumable:2});
  h.files.jobs.clear();
  assert.deepEqual(h.files.exitSummary(),{active:0,resumable:0});
});

test('两个并发文件预览复用各自的有界读取会话，不再次排队占用名额', async t => {
  const h = harness(); t.after(() => h.files.dispose());
  const scheduler = new BoundedReadScheduler({ maxConcurrent: 2, maxPerKey: 2, queueTimeoutMs: 100 });
  const operations = new ServerOperations(h.runtime, h.store);
  t.after(() => operations.docker.dispose());
  h.files.serverOperations = operations;
  let sessions = 0; let nestedReads = 0;
  const stats = [];
  const reads = [];
  const readRange = async (target, offset, limit, options) => {
    reads.push({ target, offset, limit, options });
    return { canonicalPath: target, content: 'fixture', startByte: 0, endByte: 7, size: 7, mtime: 1, truncated: false };
  };
  h.runtime.withRemoteReadSession = (_plugin, operation) => scheduler.run('server', 1, async () => {
    sessions += 1;
    await flush();
    return operation({
      statPath: async target => { stats.push(target); return { type: 'file', canonicalPath: target }; },
      readRange,
    });
  });
  h.runtime.readRemoteRange = (_plugin, ...args) => {
    nestedReads += 1;
    return scheduler.run('server', 1, () => readRange(...args));
  };
  const paths = ['/one.txt', '/two.txt'];
  const result = await Promise.all(paths.map(selected => h.files.readFile(owner, { ...scope, path: selected })));
  assert.deepEqual(result.map(item => item.path), paths);
  assert.ok(result.every(item => item.content === 'fixture' && item.nextCursor === null));
  assert.equal(sessions, 2);
  assert.equal(nestedReads, 0);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(item => item.offset === 0 && item.limit === 262_144 && item.options.allowGrowth === true));
  for (const selected of paths) assert.equal(stats.filter(target => target === selected).length, 2, '读取前后仍检查同一路径');
});

test('取消暂停或中断任务明确提示临时文件保留，排队取消不显示仍在等待', async t => {
  for (const status of ['paused', 'interrupted', 'queued']) await t.test(status, async child => {
    const h = harness(); child.after(() => h.files.dispose());
    const job = {
      ownerId: owner, scope, jobId: 'cancel-feedback', status, inFlight: false, direction: 'upload',
      controller: new AbortController(), checkpoint: status === 'queued' ? undefined : { owned: true, temporary: '/private-partial', bytes: 50 },
      args: { localPath: 'private-source' }, name: 'sample.bin', path: '/srv/sample.bin', bytes: 100, transferred: 50,
    };
    h.files.jobs.set(job.jobId, job);
    const result = h.files.cancelUpload(owner, { ...scope, jobId: job.jobId });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.canRemove, true);
    assert.equal(result.message.includes('临时文件'), status !== 'queued');
    assert.equal(result.message.includes('正在取消'), false);
    assert.equal(JSON.stringify(result).includes('/private-partial'), false);
    assert.equal(job.checkpoint, undefined);
    assert.equal(job.args, undefined);
    assert.equal(h.uploads.length, 0, '取消反馈不隐式启动上传或删除');
  });
});


test('已取消的目录读取不创建扫描或缓存', async t => {
  const h=cachedHarness();t.after(()=>h.files.dispose());
  const binding=await h.files.requirePlugin(owner,h.input), controller=new AbortController();controller.abort();
  await assert.rejects(h.files.directoryCache.list(owner,h.input,h.plugin,binding,{signal:controller.signal}),{code:'WORKSPACE_READ_CANCELLED'});
  assert.equal(h.calls.sessions,0);assert.equal(h.files.directoryCache.snapshots.size,0);
});

test('共享首次扫描取消一个读取者不打断另一个，最后一个取消才中止扫描', async t => {
  for(const cancelBoth of [false,true]) await t.test(String(cancelBoth),async child=>{
    const h=cachedHarness();child.after(()=>h.files.dispose());
    const binding=await h.files.requirePlugin(owner,h.input), controllers=[new AbortController(),new AbortController()];
    let release;h.setScan(()=>new Promise(resolve=>{release=resolve;}));
    const reads=controllers.map(controller=>h.files.directoryCache.list(owner,h.input,h.plugin,binding,{signal:controller.signal}));
    const settled=Promise.allSettled(reads);let firstCode;reads[0].catch(error=>{firstCode=error.code;});
    await flush();assert.equal(h.calls.scans,1);controllers[0].abort();await flush();
    try {
      assert.equal(firstCode,'WORKSPACE_READ_CANCELLED');assert.equal(h.calls.cancelled,0);
      if(cancelBoth){controllers[1].abort();await flush();assert.equal(h.calls.cancelled,1);assert.equal(h.files.directoryCache.snapshots.size,0);}
    } finally {release();}
    const result=await settled;
    assert.equal(result[0].status,'rejected');assert.equal(result[1].status,cancelBoth?'rejected':'fulfilled');
    assert.equal(h.files.directoryCache.snapshots.size,cancelBoth?0:1);
  });
});


test('目录取消按窗口作用域和请求标识隔离，只释放被取消读取者的名额', async t => {
  const h=cachedHarness();t.after(()=>h.files.dispose());let release;h.setScan(()=>new Promise(resolve=>{release=resolve;}));
  const one=h.files.listDirectory(owner,{...h.input,requestId:'read-one'}), two=h.files.listDirectory(owner,{...h.input,requestId:'read-two'});
  const rejected=assert.rejects(one,{code:'WORKSPACE_READ_CANCELLED'});await flush();
  assert.equal(h.files.cancelDirectoryRead('renderer:other',{...scope,requestId:'read-one'}).cancelled,false);
  assert.equal(h.files.cancelDirectoryRead(owner,{...scope,pluginInstanceId:'other',requestId:'read-one'}).cancelled,false);
  assert.equal(h.files.readCounts.get(owner),2);assert.equal(h.calls.scans,1);
  h.files.cancelDirectoryRead(owner,{...scope,requestId:'read-one'});await rejected;
  assert.equal(h.files.readCounts.get(owner),1);assert.equal(h.calls.cancelled,0);
  release();await two;assert.equal(h.files.readCounts.size,0);assert.equal(h.files.directoryRequests.size,0);
});

test('目录取消在异步插件校验期间生效，不在迟到校验后启动扫描', async t => {
  const h=cachedHarness();t.after(()=>h.files.dispose());let release;
  const original=h.files.workspaceStore.getPlugin;
  h.files.workspaceStore.getPlugin=()=>new Promise(resolve=>{release=()=>resolve(h.plugin);});
  const read=h.files.listDirectory(owner,{...h.input,requestId:'before-read'});
  const rejected=assert.rejects(read,{code:'WORKSPACE_READ_CANCELLED'});
  h.files.cancelDirectoryRead(owner,{...scope,requestId:'before-read'});
  h.files.workspaceStore.getPlugin=original;release();await rejected;
  assert.equal(h.calls.sessions,0);assert.equal(h.files.directoryRequests.size,0);assert.equal(h.files.readCounts.size,0);
});

test('目录取消拒绝空或非法标识，重复标识不覆盖原请求', async t => {
  const h=cachedHarness();t.after(()=>h.files.dispose());let release;h.setScan(()=>new Promise(resolve=>{release=resolve;}));
  for(const requestId of ['',null,'../other','x'.repeat(81)]) {
    assert.throws(()=>h.files.listDirectory(owner,{...h.input,requestId}),{code:'INVALID_ARGUMENT'});
    assert.throws(()=>h.files.cancelDirectoryRead(owner,{...scope,requestId}),{code:'INVALID_ARGUMENT'});
  }
  const read=h.files.listDirectory(owner,{...h.input,requestId:'same'});await flush();
  assert.throws(()=>h.files.listDirectory(owner,{...h.input,requestId:'same'}),{code:'WORKSPACE_BUSY'});
  release();await read;assert.equal(h.files.directoryRequests.size,0);
});

test('取消链接查询后的迟到结果不污染快照或移除新查询', async t => {
  const h=cachedHarness();t.after(()=>h.files.dispose());h.setEntries([{name:'link',type:'symlink'}]);
  const page=await h.files.listDirectory(owner,h.input), binding=await h.files.requirePlugin(owner,h.input), pending=[];
  h.setStat(target=>new Promise(resolve=>pending.push({target,resolve})));
  const input={...h.input,snapshotId:page.snapshotId,resolveLinks:true}, controller=new AbortController();
  const first=h.files.directoryCache.list(owner,input,h.plugin,binding,{signal:controller.signal});
  const rejected=assert.rejects(first,{code:'WORKSPACE_READ_CANCELLED'});await flush();controller.abort();await rejected;
  const second=h.files.directoryCache.list(owner,input,h.plugin,binding);await flush();assert.equal(pending.length,2);
  pending[0].resolve({type:'file',canonicalPath:'/old-target'});await flush();
  const item=h.files.directoryCache.snapshots.get(page.snapshotId);
  assert.equal(item.metadata.size,1,'旧操作收尾不能删除新查询');assert.equal(item.entries[0].linkTargetType,undefined);
  pending[1].resolve({type:'file',canonicalPath:pending[1].target});const result=await second;
  assert.equal(result.entries[0].linkTargetType,'file');assert.equal(item.metadata.size,0);
});

test('目录取消 IPC 拒绝非主框架和额外路径字段，保留精确作用域', async () => {
  const handlers=new Map(), calls=[];
  const sender=Object.assign(new EventEmitter(),{id:1,mainFrame:{},isDestroyed:()=>false});
  registerServerWorkspaceIpc({handle:(name,fn)=>handlers.set(name,fn)},{isWorkspaceRenderer:()=>true,serverWorkspaceFiles:{cancelDirectoryRead:(...args)=>{calls.push(args);return {cancelled:true};}}});
  const cancel=handlers.get('v2:server-workspace-cancel-directory-read'), event={sender,senderFrame:sender.mainFrame}, input={...scope,requestId:'owned'};
  assert.equal((await cancel({...event,senderFrame:{}},input)).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.equal((await cancel(event,{...input,path:'/'})).error.code,'INVALID_ARGUMENT');
  assert.equal((await cancel(event,input)).ok,true);assert.deepEqual(calls,[[owner,input]]);
});
