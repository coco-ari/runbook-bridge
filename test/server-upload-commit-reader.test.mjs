import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

const scope = { projectId:'commit-reader', environmentId:'test', pluginInstanceId:'server' };
const owner = 'renderer:commit-reader';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function until(predicate) {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) await delay(10);
  assert.ok(predicate(), '上传提交应在观察期限内收敛');
}
async function setup(t) {
  const f = await createUploadFixture(t);
  await f.broker.connect('fixture', { password:'fixture-password' });
  for (const name of ['/', '/srv']) { f.files.set(name, Buffer.alloc(0)); f.modes.set(name, 0o40755); }
  const plugin = { ...scope, revision:1, pluginType:'server', configState:'ready', target:{ hostKeyFingerprint:f.fingerprint } };
  const audits = [], store = { getPlugin:async () => ({ ...plugin }), appendAudit:async (_id, event) => { audits.push(event); } };
  const runtime = new ServerPluginRuntime(store, { load:async () => null });
  // 连接使用真实本地 SSH 夹具；运行时调度、桌面任务和文件操作均保留生产实现。
  runtime.broker = f.broker; runtime.key = () => 'fixture';
  f.broker.setLifecycleHandler(event => runtime.emit('lifecycle', { ...event, ...scope }));
  const files = new ServerWorkspaceFiles({ workspaceStore:store, serverRuntime:runtime, serverOperations:new ServerOperations(runtime, store) });
  t.after(() => files.dispose());
  const source = path.join(f.root, 'small.txt'), body = Buffer.from('synthetic upload body\n');
  await fs.writeFile(source, body);
  const prepared = await files.prepareUpload(owner, { ...scope, path:'/srv' }, [source]);
  return { ...f, runtime, workspace:files, plugin, audits, source, body, prepared };
}

test('上传提交复用当前 SFTP 校验目录，不等待已占满的普通读取队列', { timeout:15000 }, async t => {
  const f = await setup(t), arrived = gate(), allowCommit = gate(), releaseReads = gate();
  const upload = f.runtime.uploadRemoteFile;
  let reader, held = [], job;
  f.runtime.uploadRemoteFile = function(plugin, local, target, condition, options) {
    return upload.call(this, plugin, local, target, condition, { ...options,
      beforeCommit:async (...args) => { reader = args[0]; arrived.release(); await allowCommit.promise; return options.beforeCommit(...args); },
    });
  };
  const client = f.broker.requireSession('fixture').client, sftp = client.sftp;
  let opened = 0;
  client.sftp = function(...args) { opened += 1; return sftp.apply(this, args); };
  try {
    const queued = await f.workspace.confirmUpload(owner, { ...scope, preparationId:f.prepared.preparationId, overwrite:false });
    job = f.workspace.jobs.get(queued.jobs[0].jobId);
    await arrived.promise;
    held = [1,2].map(() => f.runtime.boundedRead(f.plugin, () => releaseReads.promise));
    await until(() => f.runtime.readScheduler.active === 2);
    const before = opened; allowCommit.release();
    await until(() => !job.inFlight || f.runtime.readScheduler.queue.length > 0);
    assert.equal(f.runtime.readScheduler.queue.length, 0, '提交校验不能再次申请已占满的读取名额');
    assert.equal(job.status, 'completed'); assert.equal(opened, before, '提交校验不新开 SFTP 通道');
    assert.equal(f.runtime.readScheduler.active, 2, '已有读取的预算没有被提前释放');
    assert.deepEqual(f.files.get('/srv/small.txt'), f.body);
    assert.ok(f.audits.some(event => event.type === 'desktop-upload' && event.result === 'success'));
    assert.deepEqual(Object.keys(reader), ['statPath']);
    await assert.rejects(reader.statPath('/srv'), { code:'SFTP_UNAVAILABLE' });
  } finally {
    releaseReads.release(); allowCommit.release(); await Promise.allSettled(held);
    if (job) await until(() => !job.inFlight);
    client.sftp = sftp;
  }
});

test('复用上传通道仍拒绝提交前目录改向、配置变化与关闭窗口', { timeout:15000 }, async t => {
  for (const scenario of ['parent-link', 'revision', 'owner']) await t.test(scenario, async child => {
    const f = await setup(child), upload = f.runtime.uploadRemoteFile;
    let reader, rejectedCode;
    f.runtime.uploadRemoteFile = function(plugin, local, target, condition, options) {
      return upload.call(this, plugin, local, target, condition, { ...options,
        beforeCommit:async value => {
          reader = value;
          if (scenario === 'parent-link') {
            f.files.set('/other', Buffer.alloc(0)); f.modes.set('/other', 0o40755); f.faults.realPaths.set('/srv', '/other');
          } else if (scenario === 'revision') f.plugin.revision += 1;
          else f.workspace.closeOwner(owner);
          try { return await options.beforeCommit(value); }
          catch (error) { rejectedCode = error.code; throw error; }
        },
      });
    };
    const queued = await f.workspace.confirmUpload(owner, { ...scope, preparationId:f.prepared.preparationId, overwrite:false });
    const job = f.workspace.jobs.get(queued.jobs[0].jobId);
    await until(() => !job.inFlight);
    assert.equal(rejectedCode, scenario === 'parent-link' ? 'WORKSPACE_PATH_CHANGED' : 'WORKSPACE_CHANGED');
    assert.notEqual(job.status, 'completed'); assert.equal(f.counters.renames, 0);
    assert.equal(f.files.has('/srv/small.txt'), false);
    await assert.rejects(reader.statPath('/srv'), { code:'SFTP_UNAVAILABLE' });
  });
});

test('普通上传与回执丢失后的结果核对均只借用当前通道，校验结束后读取能力失效', { timeout:15000 }, async t => {
  for (const scenario of ['regular', 'reconciled']) await t.test(scenario, async child => {
    const f = await setup(child);
    const condition = f.workspace.preparations.get(f.prepared.preparationId).files[0].args._precondition;
    let opened = 0, checkpoint;
    const readers = [];
    const observe = () => {
      const client = f.broker.requireSession('fixture').client, open = client.sftp;
      client.sftp = function(...args) { opened += 1; return open.apply(this, args); };
    };
    const send = () => f.broker.uploadRemoteFileApproved('fixture', f.source, '/srv/small.txt', condition, {
      resumable:scenario === 'reconciled', checkpoint, onCheckpoint:value => { checkpoint = value; },
      beforeCommit:async reader => {
        readers.push(reader); assert.deepEqual(Object.keys(reader), ['statPath']); assert.equal(Object.isFrozen(reader), true);
        assert.equal((await reader.statPath('/srv')).type, 'directory');
      },
    });
    observe();
    if (scenario === 'reconciled') {
      f.faults.dropRename = true; await assert.rejects(send());
      assert.equal(checkpoint.phase, 'committing');
      await f.broker.connect('fixture', { password:'fixture-password' }); observe();
      const writes = f.counters.writes.length;
      assert.equal((await send()).reconciled, true);
      assert.equal(f.counters.writes.length, writes); assert.equal(opened, 2);
    } else { await send(); assert.equal(opened, 1); }
    assert.deepEqual(f.files.get('/srv/small.txt'), f.body); assert.equal(f.counters.renames, 1);
    for (const reader of readers) await assert.rejects(reader.statPath('/srv'), { code:'SFTP_UNAVAILABLE' });
  });
});
