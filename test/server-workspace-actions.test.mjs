import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { workspaceEntryName } from '../src/server-workspace-actions.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

const scope = { projectId: 'action-fixture', environmentId: 'test', pluginInstanceId: 'server' };
const owner = 'renderer:1';
async function setup(t) {
  const fixture = await createUploadFixture(t);
  await fixture.broker.connect('fixture', { password: 'fixture-password' });
  for (const name of ['/', '/srv']) { fixture.files.set(name, Buffer.alloc(0)); fixture.modes.set(name, 0o40755); }
  fixture.files.set('/srv/app.jar', Buffer.from('fixture'));
  let connected = true, generation = 1, beforeCommit = async () => {};
  const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1 };
  const runtime = new EventEmitter();
  const audits = [];
  runtime.status = () => ({ connected, generation });
  runtime.statRemotePath = (_plugin, target) => fixture.broker.statRemotePath('fixture', target);
  runtime.withRemoteReadSession = (_plugin, operation, options) => fixture.broker.withRemoteReadSession('fixture', operation, options);
  runtime.mutateWorkspacePath = (_plugin, args, options) => fixture.broker.mutateWorkspacePathApproved('fixture', args, {
    ...options, beforeCommit: async () => { await beforeCommit(); await options.beforeCommit(); },
  });
  const store = { getPlugin: async () => plugin, appendAudit: async (_projectId, entry) => { audits.push(entry); } };
  const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: new ServerOperations(runtime, store) });
  t.after(() => files.dispose());
  return { ...fixture, workspace: files, plugin, runtime, audits,
    prepare: (kind, path, name) => files.prepareFileAction(owner, { ...scope, kind, path, name }),
    confirm: item => files.confirmFileAction(owner, { ...scope, operationId: item.operationId }),
    beforeCommit: fn => { beforeCommit = fn; },
    reconnect: () => { generation += 1; },
    disconnect: () => { connected = false; runtime.emit('lifecycle', { ...scope, type: 'disconnected' }); },
  };
}

test('文件名称校验保留中文和空格，拒绝路径穿越和控制字符', () => {
  for (const name of ['', '.', '..', '../other', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'x'.repeat(256)]) assert.throws(() => workspaceEntryName(name), { code: 'INVALID_ARGUMENT' });
  assert.equal(workspaceEntryName('发布 文件.jar'), '发布 文件.jar');
});

test('真实 SFTP 新建与重命名仅在确认后执行，绑定窗口、路径且凭证单次消费', async t => {
  const f = await setup(t);
  const directory = await f.prepare('mkdir', '/srv', '发布 文件');
  assert.equal(f.files.has('/srv/发布 文件'), false);
  assert.equal(Object.hasOwn(directory, 'args'), false);
  await assert.rejects(f.workspace.confirmFileAction('renderer:2', { ...scope, operationId: directory.operationId }), { code: 'WORKSPACE_ACTION_EXPIRED' });
  await assert.rejects(f.workspace.confirmFileAction(owner, { ...scope, environmentId: 'other', operationId: directory.operationId }), { code: 'WORKSPACE_ACTION_EXPIRED' });
  const both = await Promise.allSettled([f.confirm(directory), f.confirm(directory)]);
  assert.equal(both.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.modes.get('/srv/发布 文件') & 0o170000, 0o40000);
  const renamed = await f.prepare('rename', '/srv/app.jar', 'app-backup.jar');
  await f.confirm(renamed);
  assert.equal(f.files.has('/srv/app.jar'), false);
  assert.equal(f.files.get('/srv/app-backup.jar').toString(), 'fixture');
  const folder = await f.prepare('rename', '/srv/发布 文件', '备份目录');
  await f.confirm(folder);
  assert.equal(f.files.has('/srv/备份目录'), true);
  assert.deepEqual(f.audits.map(item => item.result), ['started', 'completed', 'started', 'completed', 'started', 'completed']);
});

test('重名、根目录、链接与特殊文件不会被覆盖或重命名', async t => {
  const f = await setup(t);
  await assert.rejects(f.prepare('mkdir', '/srv', 'app.jar'), { code: 'TARGET_EXISTS' });
  await assert.rejects(f.prepare('rename', '/', 'root-copy'), { code: 'PATH_INVALID' });
  for (const mode of [0o120777, 0o010644]) {
    f.files.set('/srv/unsupported', Buffer.alloc(0)); f.modes.set('/srv/unsupported', mode);
    await assert.rejects(f.prepare('rename', '/srv/unsupported', 'renamed'), { code: 'PATH_INVALID' });
  }
  assert.equal(f.counters.renames, 0);
});

test('最终执行前重查源文件及目标，遇到并发变化保留双方文件', async t => {
  const f = await setup(t);
  const rename = await f.prepare('rename', '/srv/app.jar', 'backup.jar');
  f.beforeCommit(async () => { f.files.set('/srv/backup.jar', Buffer.from('other writer')); });
  await assert.rejects(f.confirm(rename), { code: 'REMOTE_CHANGED' });
  assert.equal(f.files.get('/srv/backup.jar').toString(), 'other writer');
  assert.equal(f.files.get('/srv/app.jar').toString(), 'fixture');
  const changed = await f.prepare('rename', '/srv/app.jar', 'other.jar');
  f.beforeCommit(async () => { f.files.set('/srv/app.jar', Buffer.from('changed source')); });
  await assert.rejects(f.confirm(changed), { code: 'REMOTE_CHANGED' });
  assert.equal(f.files.has('/srv/other.jar'), false);
});

test('取消、过期、配置换代与窗口关闭使文件写入确认失效', async t => {
  for (const scenario of ['cancel', 'expired', 'revision', 'generation', 'owner', 'disconnect']) await t.test(scenario, async child => {
    const f = await setup(child);
    const prepared = await f.prepare('mkdir', '/srv', 'new-folder');
    if (scenario === 'cancel') f.workspace.cancelFileAction(owner, { ...scope, operationId: prepared.operationId });
    if (scenario === 'expired') f.workspace.actions.records.get(prepared.operationId).expiresAt = 0;
    if (scenario === 'revision') f.plugin.revision += 1;
    if (scenario === 'generation') f.reconnect();
    if (scenario === 'owner') f.beforeCommit(async () => f.workspace.closeOwner(owner));
    if (scenario === 'disconnect') f.disconnect();
    await assert.rejects(f.confirm(prepared));
    assert.equal(f.files.has('/srv/new-folder'), false);
  });
});

test('属性读取不读取文件内容，桌面写接口拒绝客户端改写已确认参数', async t => {
  const f = await setup(t);
  const info = await f.workspace.fileInfo(owner, { ...scope, path: '/srv/app.jar' });
  assert.equal(info.size, 7); assert.equal(info.type, 'file'); assert.equal(f.counters.downloaded, 0);
  const handlers = new Map(), sender = new EventEmitter();
  sender.id = 1; sender.mainFrame = {}; sender.isDestroyed = () => false;
  registerServerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler) }, { serverWorkspaceFiles: f.workspace, isWorkspaceRenderer: () => true });
  const event = { sender, senderFrame: sender.mainFrame };
  const prepared = await f.prepare('mkdir', '/srv', 'safe');
  const handler = handlers.get('v2:server-workspace-confirm-file-action');
  for (const extra of [{ destinationPath: '/other' }, { name: 'other' }, { overwrite: true }]) {
    assert.equal((await handler(event, { ...scope, operationId: prepared.operationId, ...extra })).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal((await handler({ ...event, senderFrame: {} }, { ...scope, operationId: prepared.operationId })).error.code, 'WORKSPACE_ACCESS_DENIED');
  await f.confirm(prepared);
  assert.equal(f.files.has('/srv/safe'), true);
});
