import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';
import { SshBroker } from '../src/ssh-broker.mjs';

function attrs(buffer, mode = 0o100600) {
  return { size: buffer.length, mtime: 10, mode, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}

class SftpFixture extends EventEmitter {
  constructor({ onWrite } = {}) {
    super();
    this.files = new Map();
    this.modes = new Map();
    this.writes = [];
    this.renames = [];
    this.onWrite = onWrite;
  }
  end() { queueMicrotask(() => this.emit('close')); }
  lstat(target, callback) {
    const content = this.files.get(target);
    queueMicrotask(() => content ? callback(null, attrs(content, this.modes.get(target))) : callback(Object.assign(new Error('missing'), { code: 2 })));
  }
  stat(target, callback) { this.lstat(target, callback); }
  realpath(target, callback) { queueMicrotask(() => callback(null, target)); }
  unlink(target, callback) { this.files.delete(target); this.modes.delete(target); queueMicrotask(() => callback(null)); }
  rename(from, to, callback) {
    this.renames.push([from, to]);
    this.files.set(to, this.files.get(from));
    this.modes.set(to, this.modes.get(from));
    this.files.delete(from);
    this.modes.delete(from);
    queueMicrotask(() => callback(null));
  }
  createWriteStream(target, options) {
    assert.equal(options.flags, 'wx');
    this.files.set(target, Buffer.alloc(0));
    this.modes.set(target, options.mode | 0o100000);
    const writer = new Writable({
      highWaterMark: options.highWaterMark,
      write: (chunk, _encoding, callback) => {
        this.writes.push(chunk.length);
        this.files.set(target, Buffer.concat([this.files.get(target), chunk]));
        Promise.resolve(this.onWrite?.(this, target)).then(() => { writer.bytesWritten += chunk.length; setImmediate(callback); }, callback);
      },
    });
    writer.bytesWritten = 0;
    return writer;
  }
}

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-workspace-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'example.bin');
  const content = crypto.randomBytes(512 * 1024 + 13);
  await fs.writeFile(source, content);
  const local = await fs.lstat(source);
  const precondition = {
    local: { size: local.size, mtimeMs: local.mtimeMs, sha256: crypto.createHash('sha256').update(content).digest('hex') },
    remote: { exists: false, path: '/uploads/example.bin' },
  };
  const sftp = new SftpFixture(options);
  const broker = new SshBroker({});
  broker.sessions.set('scope', { client: { sftp: (callback) => callback(null, sftp) }, generation: 1 });
  return { broker, source, content, sftp, precondition };
}

test('SFTP 上传分块报告进度、复核内容并只在完成后提交目标', async (t) => {
  const { broker, source, content, sftp, precondition } = await fixture(t);
  const progress = [];
  const result = await broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, { onProgress: (event) => progress.push(event) });
  assert.deepEqual(sftp.files.get('/uploads/example.bin'), content);
  assert.equal(sftp.files.size, 1);
  assert.equal(sftp.modes.get('/uploads/example.bin'), 0o100644);
  assert.equal(sftp.renames.length, 1);
  assert.equal(result.sha256, precondition.local.sha256);
  assert.ok(sftp.writes.length > 1);
  assert.ok(sftp.writes.every((size) => size <= 64 * 1024));
  assert.equal(progress[0].transferredBytes, 0);
  assert.equal(progress.at(-1).phase, 'verifying');
  assert.equal(progress.at(-1).transferredBytes, content.length);
});

test('SFTP 上传可在传输中取消并清理临时文件，不提交目标', async (t) => {
  const controller = new AbortController();
  const { broker, source, sftp, precondition } = await fixture(t, {
    onWrite: () => controller.abort(),
  });
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, { signal: controller.signal }), { code: 'TRANSFER_CANCELLED' });
  assert.equal(sftp.renames.length, 0);
  assert.equal(sftp.files.size, 0);
});

test('SFTP 上传中本地内容或目标状态变化时拒绝最终提交', async (t) => {
  const { broker, source, sftp, precondition } = await fixture(t);
  let changed = false;
  sftp.onWrite = async () => {
    if (changed) return;
    changed = true;
    await fs.appendFile(source, 'changed');
  };
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition), { code: 'LOCAL_FILE_CHANGED' });
  assert.equal(sftp.renames.length, 0);
  assert.equal(sftp.files.size, 0);

  const remoteFixture = await fixture(t);
  remoteFixture.sftp.onWrite = () => { remoteFixture.sftp.files.set('/uploads/example.bin', Buffer.from('other upload')); };
  await assert.rejects(remoteFixture.broker.uploadRemoteFileApproved('scope', remoteFixture.source, '/uploads/example.bin', remoteFixture.precondition), { code: 'REMOTE_CHANGED' });
  assert.equal(remoteFixture.sftp.renames.length, 0);
  assert.equal(remoteFixture.sftp.files.size, 1);
  assert.equal(remoteFixture.sftp.files.get('/uploads/example.bin').toString(), 'other upload');
});

test('SFTP 上传拒绝确认后更改的源文件和预先取消的任务', async (t) => {
  const { broker, source, sftp, precondition } = await fixture(t);
  await fs.appendFile(source, 'changed');
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition), { code: 'LOCAL_FILE_CHANGED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, { signal: controller.signal }), { code: 'TRANSFER_CANCELLED' });
  assert.equal(sftp.writes.length, 0);
});

test('上传提交前重新验证作用域，校验失败时清理临时文件', async (t) => {
  const { broker, source, sftp, precondition } = await fixture(t);
  let checked = false;
  const error = new (await import('../src/errors.mjs')).AppError('WORKSPACE_SCOPE_CHANGED', '工作区已经变化。');
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, {
    beforeCommit: async () => {
      checked = true;
      assert.equal(sftp.renames.length, 0);
      throw error;
    },
  }), { code: 'WORKSPACE_SCOPE_CHANGED' });
  assert.equal(checked, true);
  assert.equal(sftp.files.size, 0);
  assert.equal(sftp.renames.length, 0);
});

test('覆盖上传优先使用 OpenSSH 原子替换并保留普通执行权限', async (t) => {
  const { broker, source, sftp, precondition } = await fixture(t);
  const existing = Buffer.from('previous');
  sftp.files.set('/uploads/example.bin', existing);
  sftp.modes.set('/uploads/example.bin', 0o100755);
  precondition.remote = { exists: true, path: '/uploads/example.bin', type: 'file', size: existing.length, mtime: 10, mode: 0o100755 };
  let extensionCalled = false;
  sftp.ext_openssh_rename = (from, to, callback) => { extensionCalled = true; sftp.rename(from, to, callback); };
  await broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition);
  assert.equal(extensionCalled, true);
  assert.equal(sftp.modes.get('/uploads/example.bin'), 0o100755);
  assert.equal(sftp.renames.length, 1);
});


test('持续收到服务器写入确认时保持上传，进度不能提前报告成功', async t => {
  const { broker, source, sftp, precondition, content } = await fixture(t, {
    onWrite: () => new Promise(resolve => setTimeout(resolve, 90)),
  });
  const original = broker.withInternalSftp.bind(broker);
  broker.withInternalSftp = (scope, action, policy) => original(scope, action, { ...policy, inactivityMs: 400, timeoutMs: 5000 });
  const progress = [];
  await broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, { onProgress: event => progress.push(event) });
  const partial = progress.filter(event => event.phase === 'uploading' && event.transferredBytes > 0);
  assert.ok(partial.length >= 2, '持续上传按确认量报告多次进度');
  assert.ok(partial.every(event => event.transferredBytes < content.length));
  assert.equal(progress.at(-1).transferredBytes, content.length);
  assert.deepEqual(sftp.files.get('/uploads/example.bin'), content);
});

test('本地数据进入发送队列但服务器不确认时触发无进展超时', async t => {
  const { broker, source, sftp, precondition } = await fixture(t, { onWrite: () => new Promise(() => {}) });
  const original = broker.withInternalSftp.bind(broker);
  let policy;
  broker.withInternalSftp = (scope, action, options) => { policy = options; return original(scope, action, { ...options, inactivityMs: 350 }); };
  const progress = [];
  await assert.rejects(broker.uploadRemoteFileApproved('scope', source, '/uploads/example.bin', precondition, { onProgress: event => progress.push(event) }), { code: 'SFTP_OPERATION_TIMEOUT' });
  assert.equal(policy.inactivityMs, 90_000);
  assert.ok(progress.every(event => event.transferredBytes === 0));
  assert.equal(sftp.renames.length, 0);
  assert.equal(sftp.files.has('/uploads/example.bin'), false);
});
