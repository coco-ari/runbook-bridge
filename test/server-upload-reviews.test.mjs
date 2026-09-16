import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SshBroker } from '../src/ssh-broker.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

const scope = { projectId: 'review-fixture', environmentId: 'test', pluginInstanceId: 'server' };
const owner = 'renderer:1';
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

async function harness(t, count = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-review-test-'));
  const paths = Array.from({ length: count }, (_, index) => path.join(root, 'file-' + index + '.txt'));
  await Promise.all(paths.map((file, index) => fs.writeFile(file, 'fixture-' + index)));
  let connected = true, generation = 1, destination = '/srv';
  const plugin = { ...scope, revision: 1, pluginType: 'server', configState: 'ready' };
  const remote = new Map();
  const state = { sessions: 0, direct: 0, statCalls: 0, barrier: null, signals: [], closed: 0, hashBytes: 0 };
  const runtime = new EventEmitter();
  runtime.status = () => ({ connected, generation });
  const stat = async target => {
    state.statCalls += 1;
    if (state.barrier) await state.barrier.promise;
    if (['/srv', '/alias', '/changed'].includes(target)) return { type: 'directory', canonicalPath: target === '/alias' ? destination : target };
    if (remote.has(target)) return { path: target, canonicalPath: target, type: 'file', size: remote.get(target), mtime: 1 };
    throw Object.assign(new Error('fixture missing'), { code: 'SOURCE_NOT_FOUND' });
  };
  runtime.statRemotePath = async (_plugin, target) => { state.direct += 1; return stat(target); };
  runtime.withRemoteReadSession = async (_plugin, operation, { signal } = {}) => {
    state.sessions += 1; state.signals.push(signal);
    try { signal?.throwIfAborted(); return await operation({ statPath: stat }); }
    finally { state.closed += 1; }
  };
  const store = { getPlugin: async () => ({ ...plugin }), appendAudit: async () => {} };
  const operations = new ServerOperations(runtime, store);
  const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: operations });
  t.after(async () => {
    const pending = [...files.uploadReviews.records.values()].map(item => item.done);
    files.dispose(); state.barrier?.release(); await Promise.allSettled(pending);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'upload-review-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, paths, state, plugin, remote, operations, files, store,
    begin: (target = '/srv') => files.beginUploadReview(owner, { ...scope, path: target }, paths),
    read: review => files.readUploadReview(owner, { ...scope, reviewId: review.reviewId }),
    cancel: review => files.cancelUploadReview(owner, { ...scope, reviewId: review.reviewId }),
    done: async review => { await files.uploadReviews.records.get(review.reviewId)?.done; return files.readUploadReview(owner, { ...scope, reviewId: review.reviewId }); },
    reconnect: () => { generation += 1; },
    disconnect: () => { connected = false; runtime.emit('lifecycle', { ...scope, type: 'disconnected' }); },
    setDestination: value => { destination = value; },
  };
}

test('本地清单在远端检查完成前交付，完成前没有上传凭证，整批检查只使用两个 SFTP 会话', async t => {
  const h = await harness(t);
  h.state.barrier = gate();
  const start = performance.now();
  const review = await h.begin();
  t.diagnostic('本地清单返回耗时：' + (performance.now() - start).toFixed(1) + ' ms');
  assert.equal(review.status, 'checking');
  assert.equal(review.preparationId, null);
  assert.deepEqual(review.files.map(file => file.localPath), h.paths);
  assert.ok(review.files.every(file => file.bytes === 9 && file.exists === null));
  assert.equal(h.files.preparations.size, 0);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: review.reviewId, overwrite: true }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  h.state.barrier.release();
  const ready = await h.done(review);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.progress.completedFiles, 3);
  assert.equal(ready.progress.hashedBytes, 27);
  assert.equal(h.state.sessions, 2);
  assert.equal(h.state.closed, 2);
  assert.equal(h.state.direct, 0, '不逐文件新建 stat 通道');
  assert.equal(JSON.stringify(ready).includes('sha256'), false);
  assert.ok(h.files.preparations.get(ready.preparationId).files.every(file => /^[a-f0-9]{64}$/.test(file.args._precondition.local.sha256)));
});

test('哈希读取可取消，取消不会创建上传任务或留下凭证', async t => {
  const h = await harness(t, 1);
  await fs.writeFile(h.paths[0], Buffer.alloc(4 * 1024 * 1024, 1));
  const original = h.operations.prepareMutation.bind(h.operations);
  let review;
  h.operations.prepareMutation = (plugin, capability, args, options) => original(plugin, capability, args, {
    ...options, onProgress: bytes => { h.state.hashBytes = bytes; options.onProgress(bytes); h.cancel(review); },
  });
  review = await h.begin();
  const record = h.files.uploadReviews.records.get(review.reviewId);
  await record.done;
  assert.ok(h.state.hashBytes > 0 && h.state.hashBytes < 4 * 1024 * 1024, '取消中断实际文件读取');
  assert.equal(h.files.preparations.size, 0);
  assert.equal(h.files.jobs.size, 0);
  await assert.rejects(h.read(review), { code: 'UPLOAD_CONFIRMATION_INVALID' });
});

test('取消后新选择不会被旧检查的迟到结果覆盖', async t => {
  const h = await harness(t);
  h.state.barrier = gate();
  const first = await h.begin();
  const old = h.files.uploadReviews.records.get(first.reviewId);
  await tick();
  h.cancel(first);
  assert.equal(old.controller.signal.aborted, true);
  const second = await h.begin();
  assert.notEqual(first.reviewId, second.reviewId);
  assert.equal(second.status, 'checking');
  h.state.barrier.release();
  const ready = await h.done(second);
  await old.done;
  assert.equal(ready.status, 'ready');
  assert.equal(h.files.preparations.size, 1);
  assert.equal(h.files.uploadReviews.records.size, 1);
});

test('后台检查绑定窗口、作用域、连接代次与配置，失效结果不能签发凭证', async t => {
  for (const action of ['owner', 'scope', 'disconnect', 'generation', 'revision']) await t.test(action, async child => {
    const h = await harness(child, 1);
    h.state.barrier = gate();
    const review = await h.begin();
    const record = h.files.uploadReviews.records.get(review.reviewId);
    await tick();
    if (action === 'owner') h.files.closeOwner(owner);
    if (action === 'scope') h.files.closeScope(scope);
    if (action === 'disconnect') h.disconnect();
    if (action === 'generation') h.reconnect();
    if (action === 'revision') h.plugin.revision += 1;
    h.state.barrier.release();
    await record.done;
    assert.equal(h.files.preparations.size, 0);
    assert.equal(h.files.jobs.size, 0);
    if (['owner', 'scope', 'disconnect'].includes(action)) assert.equal(record.controller.signal.aborted, true);
    else assert.equal((await h.read(review)).status, 'error');
  });
});

test('主动重新检查刷新目标状态，固定目录与同名覆盖状态保持准确', async t => {
  const h = await harness(t, 1);
  const first = await h.done(await h.begin('/alias'));
  h.remote.set('/srv/file-0.txt', 12);
  const next = await h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt'] });
  assert.equal(next.preparationId, null);
  assert.equal(h.files.preparations.has(first.preparationId), false);
  const ready = await h.done(next);
  assert.equal(ready.path, '/srv');
  assert.equal(ready.sourcePath, '/alias');
  assert.equal(ready.files.length, 1);
  assert.equal(ready.files[0].exists, true);
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: ready.preparationId, overwrite: false }), { code: 'TARGET_EXISTS' });
  h.setDestination('/changed');
  const changed = await h.files.reviseUploadReview(owner, { ...scope, reviewId: ready.reviewId, fileNames: ['file-0.txt'] });
  assert.equal((await h.done(changed)).error.code, 'WORKSPACE_PATH_CHANGED');
  assert.equal(h.files.preparations.size, 0);
});

test('检查失败可重试，完成后才开始五分钟确认有效期，移除最后一个文件释放资源', async t => {
  const h = await harness(t, 1);
  let clock = 1000;
  h.files.now = () => clock;
  const original = h.operations.prepareMutation.bind(h.operations);
  h.operations.prepareMutation = async () => { throw Object.assign(new Error('校验失败'), { code: 'LOCAL_FILE_CHANGED' }); };
  const failed = await h.done(await h.begin());
  assert.equal(failed.status, 'error');
  assert.equal(failed.preparationId, null);
  h.operations.prepareMutation = original;
  clock += 200000;
  const retry = await h.files.reviseUploadReview(owner, { ...scope, reviewId: failed.reviewId, fileNames: ['file-0.txt'] });
  const ready = await h.done(retry);
  assert.equal(ready.expiresAt, clock + 300000);
  clock = ready.expiresAt;
  assert.equal((await h.read(ready)).error.code, 'UPLOAD_CONFIRMATION_EXPIRED');
  assert.equal(h.files.preparations.size, 0);
  assert.equal(await h.files.reviseUploadReview(owner, { ...scope, reviewId: ready.reviewId, fileNames: [] }), null);
  assert.equal(h.files.uploadReviews.records.size, 0);
});

test('检查期间目录链接改向被最终复核拦截', async t => {
  const h = await harness(t, 1);
  const original = h.operations.prepareMutation.bind(h.operations);
  h.operations.prepareMutation = async (...args) => { const result = await original(...args); h.setDestination('/changed'); return result; };
  const review = await h.done(await h.begin('/alias'));
  assert.equal(review.status, 'error');
  assert.equal(review.error.code, 'WORKSPACE_PATH_CHANGED');
  assert.equal(h.files.preparations.size, 0);
});

test('桌面后台检查 API 拒绝跨窗口、跨作用域及注入路径', async t => {
  const h = await harness(t, 1);
  const review = await h.begin();
  await assert.rejects(h.files.readUploadReview('renderer:2', { ...scope, reviewId: review.reviewId }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  assert.throws(() => h.files.cancelUploadReview(owner, { ...scope, environmentId: 'other', reviewId: review.reviewId }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  const handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  const event = { sender, senderFrame: sender.mainFrame };
  registerServerWorkspaceIpc({ handle: (name, fn) => handlers.set(name, fn) }, { serverWorkspaceFiles: h.files, isWorkspaceRenderer: () => true });
  for (const name of ['read-upload-review', 'cancel-upload-review', 'revise-upload']) {
    const handler = handlers.get('v2:server-workspace-' + name);
    const result = await handler(event, { ...scope, reviewId: review.reviewId, path: '/other', localPath: '/arbitrary' });
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal((await handler({ ...event, senderFrame: {} }, { ...scope, reviewId: review.reviewId })).error.code, 'WORKSPACE_ACCESS_DENIED');
  }
});

test('一至二十个文件保持恒定数量的 SFTP 会话', async t => {
  for (const count of [1, 5, 20]) await t.test(String(count), async child => {
    const h = await harness(child, count);
    const ready = await h.done(await h.begin());
    assert.equal(ready.status, 'ready');
    assert.equal(ready.files.length, count);
    assert.equal(h.state.sessions, 2);
    child.diagnostic(count + ' 个文件：2 个 SFTP 会话，' + h.state.statCalls + ' 次路径检查');
  });
});

test('连续移除仅缩小有效清单，不读取内容、不访问远端、不延长有效期', async t => {
  const h = await harness(t);
  let clock = 1000;
  h.files.now = () => clock;
  h.remote.set('/srv/file-0.txt', 12);
  const first = await h.done(await h.begin('/alias'));
  const original = h.files.preparations.get(first.preparationId);
  const stats = h.state.statCalls;
  const sessions = h.state.sessions;
  h.operations.prepareMutation = async () => { assert.fail('移除文件不应重新读取和哈希'); };
  clock += 10000;
  const next = await h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt', 'file-2.txt'] });
  assert.equal(next.status, 'ready');
  assert.notEqual(next.reviewId, first.reviewId);
  assert.notEqual(next.preparationId, first.preparationId);
  assert.equal(next.expiresAt, first.expiresAt);
  assert.equal(next.path, '/srv');
  assert.equal(next.sourcePath, '/alias');
  assert.deepEqual(next.files.map(file => file.name), ['file-0.txt', 'file-2.txt']);
  assert.deepEqual(next.progress, { phase: 'ready', completedFiles: 2, totalFiles: 2, hashedBytes: 18, totalBytes: 18 });
  assert.deepEqual(h.files.preparations.get(next.preparationId).files, [original.files[0], original.files[2]]);
  assert.equal(h.files.preparations.has(first.preparationId), false);
  await assert.rejects(h.read(first), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
  await assert.rejects(h.files.reviseUploadReview(owner, { ...scope, reviewId: next.reviewId, fileNames: ['file-1.txt'] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: false }), { code: 'TARGET_EXISTS' });
  clock += 10000;
  const last = await h.files.reviseUploadReview(owner, { ...scope, reviewId: next.reviewId, fileNames: ['file-2.txt'] });
  assert.equal(last.status, 'ready');
  assert.equal(last.files[0].exists, false);
  assert.equal(last.expiresAt, first.expiresAt);
  assert.equal(last.progress.totalBytes, 9);
  assert.equal(h.state.statCalls, stats);
  assert.equal(h.state.sessions, sessions);
  assert.equal(h.files.preparations.size, 1);
  assert.equal(h.files.uploadReviews.records.size, 1);
  clock = first.expiresAt;
  assert.equal((await h.read(last)).error.code, 'UPLOAD_CONFIRMATION_EXPIRED');
  assert.equal(h.files.preparations.size, 0);
  assert.equal(await h.files.reviseUploadReview(owner, { ...scope, reviewId: last.reviewId, fileNames: [] }), null);
});

test('过期后移除会重新检查，移除过程中到期也不能复用旧结果', async t => {
  for (const expiresDuringBinding of [false, true]) await t.test(String(expiresDuringBinding), async child => {
    const h = await harness(child);
    let clock = 1000;
    h.files.now = () => clock;
    const first = await h.done(await h.begin());
    const original = h.store.getPlugin;
    if (expiresDuringBinding) h.store.getPlugin = async (...args) => { clock = first.expiresAt; return original(...args); };
    else clock = first.expiresAt;
    const next = await h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt'] });
    assert.equal(next.status, 'checking');
    assert.equal(next.preparationId, null);
    assert.equal(h.files.preparations.has(first.preparationId), false);
    const ready = await h.done(next);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.expiresAt, clock + 300000);
    assert.equal(h.state.sessions, 4);
  });
});

test('并发移除与确认竞争不能恢复已消费的凭证或重复生成清单', async t => {
  const h = await harness(t);
  const first = await h.done(await h.begin());
  const outcomes = await Promise.allSettled([
    h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt', 'file-1.txt'] }),
    h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt'] }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(h.files.preparations.size, 1);
  const next = outcomes.find(result => result.status === 'fulfilled').value;
  h.files.drain = () => {};
  const removing = h.files.reviseUploadReview(owner, { ...scope, reviewId: next.reviewId, fileNames: ['file-0.txt'] });
  const confirming = h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: true });
  await assert.rejects(removing, { code: 'UPLOAD_CONFIRMATION_INVALID' });
  assert.equal((await confirming).jobs.length, 2);
  assert.equal(h.files.preparations.size, 0);
  await assert.rejects(h.files.reviseUploadReview(owner, { ...scope, reviewId: next.reviewId, fileNames: ['file-0.txt'] }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
});

test('移除期间取消、窗口关闭、配置和连接变化不产生新凭证', async t => {
  for (const action of ['cancel', 'owner', 'generation', 'revision']) await t.test(action, async child => {
    const h = await harness(child);
    const first = await h.done(await h.begin());
    const barrier = gate();
    const original = h.store.getPlugin;
    h.store.getPlugin = async (...args) => { await barrier.promise; return original(...args); };
    const removing = h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt'] });
    if (action === 'cancel') h.cancel(first);
    if (action === 'owner') h.files.closeOwner(owner);
    if (action === 'generation') h.reconnect();
    if (action === 'revision') h.plugin.revision += 1;
    barrier.release();
    await assert.rejects(removing);
    assert.ok([...h.files.preparations.keys()].every(id => id === first.preparationId), '不得签发新凭证');
    if (action === 'generation' || action === 'revision') {
      await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: first.preparationId, overwrite: true }), { code: 'WORKSPACE_CHANGED' });
    }
    assert.equal(h.files.jobs.size, 0);
  });
});

test('复用后的文件前置条件继续拦截源文件、远端文件和目录链接变化', async t => {
  const h = await harness(t);
  const first = await h.done(await h.begin('/alias'));
  const next = await h.files.reviseUploadReview(owner, { ...scope, reviewId: first.reviewId, fileNames: ['file-0.txt', 'file-1.txt'] });
  const prepared = h.files.preparations.get(next.preparationId);
  const broker = new SshBroker({});
  const changedSource = prepared.files[0].args;
  await fs.appendFile(changedSource.localPath, 'changed');
  await assert.rejects(broker.uploadRemoteFileApproved('fixture', changedSource.localPath, changedSource.remotePath, changedSource._precondition), { code: 'LOCAL_FILE_CHANGED' });
  broker.withInternalSftp = async (_scope, operation) => operation({
    lstat: (_target, callback) => callback(null, {size: 12, mtime: 1, mode: 0o100644, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false}),
    realpath: (target, callback) => callback(null, target),
    createWriteStream: () => assert.fail('目标变化后不得写入'),
  });
  const changedTarget = prepared.files[1].args;
  await assert.rejects(broker.uploadRemoteFileApproved('fixture', changedTarget.localPath, changedTarget.remotePath, changedTarget._precondition), { code: 'REMOTE_CHANGED' });
  h.setDestination('/changed');
  await assert.rejects(h.files.confirmUpload(owner, { ...scope, preparationId: next.preparationId, overwrite: true }), { code: 'WORKSPACE_PATH_CHANGED' });
  assert.equal(h.files.jobs.size, 0);
});
