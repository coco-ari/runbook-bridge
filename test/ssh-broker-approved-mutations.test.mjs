import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

async function setup(t, options = { posixRename: true }) {
  const fixture = await createUploadFixture(t, options);
  await fixture.broker.connect('fixture', { password: 'fixture-password' });
  return fixture;
}
const prepared = (remote, content) => ({ remote, bytes: Buffer.byteLength(content), newSha256: crypto.createHash('sha256').update(content).digest('hex') });
const snapshot = (f, target) => f.broker.statRemotePath('fixture', target);
const write = (f, target, content, remote) => f.broker.writeRemoteFileApproved('fixture', target, content, prepared(remote, content));
const move = (f, source, destination, precondition) => f.broker.moveRemotePathApproved('fixture', source, destination, precondition);
const seed = (f, target, content, mode = 0o100644) => { f.files.set(target, Buffer.from(content)); f.modes.set(target, mode); };

test('已确认覆盖写入使用 OpenSSH 原子重命名并保留原权限', async t => {
  const f = await setup(t);
  seed(f, '/target.txt', 'old', 0o100640);
  await write(f, '/target.txt', '新的合成内容', await snapshot(f, '/target.txt'));
  assert.equal(f.files.get('/target.txt').toString(), '新的合成内容');
  assert.equal(f.modes.get('/target.txt'), 0o100640);
  assert.equal(f.counters.posixRenames, 1);
  assert.equal(f.counters.renames, 0);
  assert.equal(f.counters.removes, 0);
  assert.deepEqual([...f.files.keys()], ['/target.txt']);
});

test('已确认覆盖移动使用原子重命名并保持源文件内容和权限', async t => {
  const f = await setup(t);
  seed(f, '/source.txt', 'source content', 0o100600);
  seed(f, '/target.txt', 'old');
  await move(f, '/source.txt', '/target.txt', { source: await snapshot(f, '/source.txt'), destination: await snapshot(f, '/target.txt') });
  assert.equal(f.files.get('/target.txt').toString(), 'source content');
  assert.equal(f.modes.get('/target.txt'), 0o100600);
  assert.equal(f.files.has('/source.txt'), false);
  assert.equal(f.counters.posixRenames, 1);
  assert.equal(f.counters.renames, 0);
  assert.equal(f.counters.removes, 0);
});

test('新建写入和无冲突移动仍使用不允许覆盖的普通重命名', async t => {
  const f = await setup(t);
  await write(f, '/new.txt', 'new', { exists: false, path: '/new.txt' });
  await move(f, '/new.txt', '/moved.txt', { source: await snapshot(f, '/new.txt'), destination: { exists: false, path: '/moved.txt' } });
  assert.equal(f.files.get('/moved.txt').toString(), 'new');
  assert.equal(f.counters.posixRenames, 0);
  assert.equal(f.counters.renames, 2);
  assert.equal(f.counters.removes, 0);
});

test('不支持覆盖扩展时保留已有目标和移动源，仅清理写入临时文件', async t => {
  const f = await setup(t, { posixRename: false });
  seed(f, '/target.txt', 'keep target');
  seed(f, '/source.txt', 'keep source');
  const destination = await snapshot(f, '/target.txt');
  await assert.rejects(write(f, '/target.txt', 'replacement', destination), { code: 'TRANSFER_FAILED' });
  await assert.rejects(move(f, '/source.txt', '/target.txt', { source: await snapshot(f, '/source.txt'), destination }), { code: 'TRANSFER_FAILED' });
  assert.equal(f.files.get('/target.txt').toString(), 'keep target');
  assert.equal(f.files.get('/source.txt').toString(), 'keep source');
  assert.deepEqual([...f.files.keys()].sort(), ['/source.txt', '/target.txt']);
  assert.equal(f.counters.removes, 1);
  assert.equal(f.counters.renames + f.counters.posixRenames, 0);
});

test('写入期间目标变化会在原子覆盖前拒绝并清理临时文件', async t => {
  const f = await setup(t);
  seed(f, '/target.txt', 'old');
  const remote = await snapshot(f, '/target.txt');
  f.faults.onWrite = () => seed(f, '/target.txt', 'independently changed');
  await assert.rejects(write(f, '/target.txt', 'replacement', remote), { code: 'REMOTE_CHANGED' });
  assert.equal(f.files.get('/target.txt').toString(), 'independently changed');
  assert.deepEqual([...f.files.keys()], ['/target.txt']);
  assert.equal(f.counters.renames + f.counters.posixRenames, 0);
});

test('确认不存在的目标在写入期间出现时不能被覆盖', async t => {
  const f = await setup(t);
  f.faults.onWrite = () => seed(f, '/target.txt', 'concurrent file');
  await assert.rejects(write(f, '/target.txt', 'replacement', { exists: false, path: '/target.txt' }), { code: 'REMOTE_CHANGED' });
  assert.equal(f.files.get('/target.txt').toString(), 'concurrent file');
  assert.equal(f.counters.renames + f.counters.posixRenames, 0);
});

test('移动确认后的源或目标变化均阻止覆盖', async t => {
  const f = await setup(t);
  for (const changed of ['/source.txt', '/target.txt']) {
    seed(f, '/source.txt', 'source'); seed(f, '/target.txt', 'target');
    const precondition = { source: await snapshot(f, '/source.txt'), destination: await snapshot(f, '/target.txt') };
    seed(f, changed, 'independently changed');
    await assert.rejects(move(f, '/source.txt', '/target.txt', precondition), { code: 'REMOTE_CHANGED' });
    assert.equal(f.files.get(changed).toString(), 'independently changed');
    assert.ok(f.files.has('/source.txt') && f.files.has('/target.txt'));
  }
  assert.equal(f.counters.renames + f.counters.posixRenames, 0);
  assert.equal(f.counters.removes, 0);
});
