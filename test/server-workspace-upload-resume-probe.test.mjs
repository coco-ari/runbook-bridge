import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';

// 仅验证现有 SSH2 的断点写入能力；不接入生产任务、确认凭据或重连流程。
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const call = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function writeWithLifecycle(sftp, reader, writer, signal) {
  const combined = signal ? AbortSignal.any([signal, sftp.probeSignal]) : sftp.probeSignal;
  let onAbort;
  const interrupted = new Promise((_resolve, reject) => {
    onAbort = () => { sftp.end(); reject(combined.reason); };
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) onAbort();
  });
  // SSH2 的流清理可能等待已丢失的 CLOSE 回执，取消必须有独立的收敛路径。
  try { await Promise.race([pipeline(reader, writer, { signal: combined }), interrupted]); }
  finally { combined.removeEventListener('abort', onAbort); }
}

async function readAll(sftp, name) {
  const chunks = [];
  const reader = sftp.createReadStream(name);
  reader.on('error', () => undefined);
  const closed = new Promise(resolve => reader.once('close', resolve));
  for await (const chunk of reader) chunks.push(chunk);
  await closed;
  return Buffer.concat(chunks);
}

async function statOrMissing(sftp, name) {
  try { return await call(sftp, 'lstat', name); }
  catch (error) { if (error.code === 2) return null; throw error; }
}

async function probeResume(sftp, source, state, { signal, beforeCommit } = {}) {
  signal?.throwIfAborted();
  // 夹具只覆盖小型普通文件及原先不存在的目标，完整读取仅用于故障验证。
  const local = await fsp.readFile(source);
  if (digest(local) !== state.sha256) fail('LOCAL_FILE_CHANGED');
  const partial = await statOrMissing(sftp, state.partial);
  const target = await statOrMissing(sftp, state.target);
  if (target) {
    if (!partial && target.isFile() && target.size === local.length && digest(await readAll(sftp, state.target)) === state.sha256) return { reconciled: true };
    fail('REMOTE_CHANGED');
  }
  if (!partial || !partial.isFile() || partial.size > local.length) fail('PARTIAL_INVALID');
  const prefix = await readAll(sftp, state.partial);
  if (prefix.length !== partial.size || !prefix.equals(local.subarray(0, partial.size))) fail('PARTIAL_CHANGED');
  signal?.throwIfAborted();
  if (partial.size < local.length) {
    await writeWithLifecycle(sftp,
      fs.createReadStream(source, { start: partial.size, highWaterMark: 64 * 1024 }),
      sftp.createWriteStream(state.partial, { flags: 'r+', start: partial.size, highWaterMark: 64 * 1024 }),
      signal,
    );
  }
  if (digest(await fsp.readFile(source)) !== state.sha256) fail('LOCAL_FILE_CHANGED');
  if (digest(await readAll(sftp, state.partial)) !== state.sha256) fail('TRANSFER_INTEGRITY_FAILED');
  await beforeCommit?.();
  signal?.throwIfAborted();
  if (await statOrMissing(sftp, state.target)) fail('REMOTE_CHANGED');
  await call(sftp, 'rename', state.partial, state.target);
  return { resumedAt: partial.size };
}


test('受限续传可行性：真实本地 SSH2 的断线恢复、内容校验、取消和提交回执丢失', { timeout: 60_000 }, async t => {
  const fixture = await createUploadFixture(t);
  const { files, modes, faults, counters, broker, connect } = fixture;
  const content = crypto.randomBytes(1024 * 1024 + 13);
  const source = path.join(fixture.root, 'fixture.bin'); await fsp.writeFile(source, content);
  const local = await fsp.stat(source);
  const state = { target: '/fixture.bin', sha256: digest(content) };
  faults.dropAfter = 768 * 1024;
  await broker.connect('fixture', { password: 'fixture-password' });
  await assert.rejects(broker.uploadRemoteFileApproved('fixture', source, state.target, {
    local: { size: local.size, mtimeMs: local.mtimeMs, sha256: state.sha256 }, remote: { exists: false, path: state.target },
  }));
  state.partial = [...files.keys()].find(name => name.startsWith(state.target + '.part-'));
  assert.ok(state.partial, '现有上传断线后留下可识别的临时文件');
  assert.equal(files.has(state.target), false, '断线不发布半文件');
  const productionPartial = Buffer.from(files.get(state.partial));
  const productionHasGaps = !productionPartial.equals(content.subarray(0, productionPartial.length));
  t.diagnostic(JSON.stringify({ productionPartialBytes: productionPartial.length, productionHasGaps }));
  await broker.closeAll();
  let connection = await connect();
  await t.test('现有批量上传留下的非连续临时文件不能直接按大小续传', async () => {
    // 某些调度时序恰好没有空洞，仍注入同长度空洞验证拒绝路径。
    if (!productionHasGaps) files.get(state.partial).fill(0, 1024, 2048);
    const before = counters.uploaded;
    await assert.rejects(probeResume(connection.sftp, source, state), { code: 'PARTIAL_CHANGED' });
    assert.equal(counters.uploaded, before);
  });
  files.clear(); state.partial = '/fixture.bin.part-probe'; faults.dropAfter = 768 * 1024;
  // 验证串行块写入的连续前缀；此策略可能降低高延迟网络下的吞吐量。
  await assert.rejects(writeWithLifecycle(connection.sftp,
    fs.createReadStream(source, { highWaterMark: 64 * 1024 }),
    connection.sftp.createWriteStream(state.partial, { flags: 'wx', highWaterMark: 64 * 1024 }),
  ));
  const prefix = Buffer.from(files.get(state.partial));
  assert.ok(prefix.length >= 768 * 1024 && prefix.length < content.length);
  assert.ok(prefix.equals(content.subarray(0, prefix.length)));
  connection = await connect();
  const reset = () => { files.clear(); modes.clear(); files.set(state.partial, Buffer.from(prefix)); };
  const rejectWithoutWrite = async (code, options) => {
    const before = counters.uploaded;
    await assert.rejects(probeResume(connection.sftp, source, state, options), { code });
    assert.equal(counters.uploaded, before);
  };

  await t.test('同长度本地文件被修改时拒绝续传', async () => {
    const changed = Buffer.from(content); changed[0] ^= 1; await fsp.writeFile(source, changed);
    await rejectWithoutWrite('LOCAL_FILE_CHANGED'); await fsp.writeFile(source, content);
  });
  await t.test('远端同长度内容被改写或存在空洞时拒绝续传', async () => {
    files.get(state.partial)[0] ^= 1; await rejectWithoutWrite('PARTIAL_CHANGED'); reset();
    files.get(state.partial).fill(0, 1024, 2048); await rejectWithoutWrite('PARTIAL_CHANGED'); reset();
  });
  await t.test('拒绝链接临时文件、越界偏移和已变更目标', async () => {
    modes.set(state.partial, 0o120777); await rejectWithoutWrite('PARTIAL_INVALID'); reset();
    files.set(state.partial, Buffer.alloc(content.length + 1)); await rejectWithoutWrite('PARTIAL_INVALID'); reset();
    files.set(state.target, Buffer.from('other')); await rejectWithoutWrite('REMOTE_CHANGED'); assert.equal(files.get(state.target).toString(), 'other'); reset();
  });
  await t.test('用户取消和提交前目标被创建均不发布文件', async () => {
    const controller = new AbortController(); controller.abort(Object.assign(new Error('已取消'), { code: 'TRANSFER_CANCELLED' })); await rejectWithoutWrite('TRANSFER_CANCELLED', { signal: controller.signal });
    const during = new AbortController(); faults.onWrite = () => during.abort();
    await assert.rejects(probeResume(connection.sftp, source, state, { signal: during.signal }), { name: 'AbortError' });
    faults.onWrite = null; connection.client.destroy(); connection = await connect(); assert.equal(files.has(state.target), false); reset();
    await assert.rejects(probeResume(connection.sftp, source, state, { beforeCommit: () => files.set(state.target, Buffer.from('new-target')) }), { code: 'REMOTE_CHANGED' });
    assert.equal(files.get(state.target).toString(), 'new-target'); reset();
  });
  await t.test('恢复途中再次断线仍可继续且只上传剩余内容', async () => {
    faults.dropAfter = 896 * 1024;
    await assert.rejects(probeResume(connection.sftp, source, state));
    connection = await connect();
    const offset = files.get(state.partial).length;
    assert.ok(offset > prefix.length && offset < content.length);
    const before = { ...counters };
    const result = await probeResume(connection.sftp, source, state);
    assert.equal(result.resumedAt, offset);
    assert.equal(counters.uploaded - before.uploaded, content.length - offset);
    assert.equal(digest(files.get(state.target)), state.sha256);
    assert.equal(counters.renames - before.renames, 1);
    t.diagnostic(JSON.stringify({ fileBytes: content.length, resumedAt: offset, uploadedBytes: counters.uploaded - before.uploaded, verificationDownloadBytes: counters.downloaded - before.downloaded }));
    reset();
  });
  await t.test('同一连接的命令通道在续传时仍能完成请求', async () => {
    const upload = probeResume(connection.sftp, source, state);
    const channel = await call(connection.client, 'exec', 'probe');
    const chunks = []; for await (const chunk of channel) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'ok');
    await upload; assert.equal(counters.probes, 1); reset();
  });
  await t.test('重命名成功但回执丢失时复核成品，不重复提交', async () => {
    faults.dropRename = true;
    await assert.rejects(probeResume(connection.sftp, source, state));
    assert.equal(files.has(state.partial), false); assert.equal(digest(files.get(state.target)), state.sha256);
    connection = await connect(); const before = { ...counters };
    assert.deepEqual(await probeResume(connection.sftp, source, state), { reconciled: true });
    assert.equal(counters.uploaded, before.uploaded); assert.equal(counters.renames, before.renames);
  });
});
