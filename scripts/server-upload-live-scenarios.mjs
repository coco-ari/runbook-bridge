import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseDiskMetrics } from '../src/server-metrics-reader.mjs';

const MiB = 1024 * 1024;
const round = value => Math.round(value * 10) / 10;
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// 仅由已建立独占随机目录的实测入口调用；名称、内容与临时文件均属于本次探针。
export async function runUploadScenarios({ runtime, plugin, files, operations, scope, owner, root, owned, localRoot, localNames, measure, waitFor, reconnect }) {
  const traffic = new Map();
  const partialTargets = new Map();
  const strategies = new Map();
  const decorated = new WeakSet();
  const originalUpload = runtime.uploadRemoteFile.bind(runtime);
  const remote = name => {
    assert.ok(!/[\\/\0\r\n]/u.test(name) && !['.', '..'].includes(name));
    return root + '/' + name;
  };
  const local = name => {
    assert.ok(!/[\\/\0\r\n]/u.test(name) && !['.', '..'].includes(name));
    localNames.add(name); return path.join(localRoot, name);
  };
  async function makeFile(name, bytes) {
    const file = local(name), handle = await fs.open(file, 'wx', 0o600);
    try {
      for (let offset = 0; offset < bytes;) {
        const chunk = crypto.randomBytes(Math.min(MiB, bytes - offset));
        await handle.writeFile(chunk); offset += chunk.length;
      }
    } finally { await handle.close(); }
    return file;
  }
  function observeConnection() {
    const client = runtime.broker.requireSession(runtime.key(plugin)).client;
    const openSftp = client.sftp.bind(client);
    client.sftp = callback => openSftp((error, sftp) => {
      if (sftp && !decorated.has(sftp)) {
        decorated.add(sftp);
        const handles = new Map(), open = sftp.open.bind(sftp), write = sftp.write.bind(sftp);
        sftp.open = (selected, ...args) => {
          const accept = args.at(-1);
          args[args.length - 1] = (failure, handle) => {
            if (!failure) handles.set(handle.toString('hex'), selected);
            accept(failure, handle);
          };
          return open(selected, ...args);
        };
        sftp.write = (handle, buffer, offset, length, position, accept) => {
          const target = partialTargets.get(handles.get(handle.toString('hex')));
          if (target) {
            const item = traffic.get(target);
            item.written += length; item.minPosition = Math.min(item.minPosition, position);
          }
          return write(handle, buffer, offset, length, position, accept);
        };
      }
      callback(error, sftp);
    });
  }
  observeConnection();
  runtime.uploadRemoteFile = (selected, source, target, condition, options = {}) => {
    assert.ok(target.startsWith(root + '/') && owned.has(target));
    const started = performance.now(), sample = { written: 0, minPosition: Infinity, progress: [], started };
    traffic.set(target, sample);
    const strategy = strategies.get(target);
    return originalUpload(selected, source, target, condition, {
      ...options,
      onCheckpoint: checkpoint => {
        assert.ok(checkpoint.temporary.startsWith(target + '.part-'));
        assert.match(checkpoint.temporary.slice((target + '.part-').length), /^[a-f0-9]{24}$/u);
        partialTargets.set(checkpoint.temporary, target);
        if (checkpoint.owned) owned.add(checkpoint.temporary);
        options.onCheckpoint?.(checkpoint);
        if (strategy && !strategy.triggered && checkpoint.bytes >= strategy.at && checkpoint.phase === 'uploading') {
          strategy.triggered = performance.now();
          const job = [...files.jobs.values()].find(item => item.path === target && item.inFlight);
          assert.ok(job);
          if (strategy.kind === 'pause') files.pauseUpload(owner, { ...scope, jobId: job.jobId });
          if (strategy.kind === 'cancel') files.cancelUpload(owner, { ...scope, jobId: job.jobId });
          if (strategy.kind === 'disconnect') strategy.disconnecting = runtime.disconnect(plugin, 'user-plugin-disconnect');
        }
      },
      onProgress: value => {
        sample.progress.push({ bytes: value.transferredBytes, phase: value.phase, ms: round(performance.now() - started) });
        options.onProgress?.(value);
      },
    });
  };
  async function ready(review) {
    let result;
    await waitFor(async () => {
      result = await files.readUploadReview(owner, { ...scope, reviewId: review.reviewId });
      if (result.status === 'error') throw Object.assign(new Error('上传检查失败'), { code: result.error.code });
      return result.status === 'ready';
    }, 30_000);
    return result;
  }
  async function prepare(paths) {
    return ready(await files.beginUploadReview(owner, { ...scope, path: root }, paths));
  }
  async function confirm(review) {
    for (const file of review.files) {
      assert.equal(path.posix.dirname(file.remotePath), root);
      if (file.exists) assert.ok(owned.has(remote(file.name)));
      if (file.action !== 'skip') owned.add(file.remotePath);
    }
    return (await files.confirmUpload(owner, { ...scope, preparationId: review.preparationId,
      overwrite: review.files.some(file => file.action === 'overwrite') })).jobs;
  }
  async function done(job, status = 'completed') {
    await waitFor(() => {
      const item = files.jobs.get(job.jobId);
      return !item.inFlight && ['completed', 'cancelled', 'error', 'paused', 'interrupted'].includes(item.status);
    }, 60_000);
    assert.equal(files.jobs.get(job.jobId).status, status);
    return files.jobs.get(job.jobId);
  }
  async function verify(name, source) {
    const prepared = await files.downloads.prepare(owner, { ...scope, path: remote(name) });
    const destination = local('verify-' + name);
    const job = await files.downloads.start(owner, scope, prepared, destination);
    await done(job);
    assert.equal(await digest(destination), await digest(source));
  }
  async function resume(job, bytes, total) {
    const review = await files.prepareUploadResume(owner, { ...scope, jobId: job.jobId });
    assert.equal(review.resume.bytes, bytes);
    const resumed = await confirm(review);
    assert.equal(resumed[0].jobId, job.jobId);
    await done(job);
    const sent = traffic.get(job.path);
    assert.equal(sent.minPosition, bytes);
    assert.equal(sent.written, total - bytes);
    console.log(JSON.stringify({ feature: 'upload.resume-wire-evidence', status: 'passed', resumedBytes: bytes, writtenBytes: sent.written, totalBytes: total }));
  }
  try {
    await measure('upload.available-space', async () => {
      const raw = await runtime.readWorkspaceMetrics(plugin, 'disks');
      assert.equal(raw.exitCode, 0);
      const disk = parseDiskMetrics(raw.stdout).items.filter(item => item.mount === '/' || root === item.mount || root.startsWith(item.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
      assert.ok(disk && disk.available >= 512 * MiB);
    });
    const pausedSource = await makeFile('pause-large.bin', 64 * MiB);
    const pausePlan = { kind: 'pause', at: 4 * MiB };
    strategies.set(remote('pause-large.bin'), pausePlan);
    const pausedReview = await measure('upload.large-review', () => prepare([pausedSource]));
    let paused;
    await measure('upload.pause-after-four-mib', async () => {
      [paused] = await confirm(pausedReview);
      const state = await done(paused, 'paused');
      const settledMs = round(performance.now() - pausePlan.triggered);
      assert.equal(state.checkpoint.bytes, 4 * MiB);
      assert.equal((await runtime.statRemotePath(plugin, state.checkpoint.temporary)).size, 4 * MiB);
      await assert.rejects(runtime.statRemotePath(plugin, paused.path), { code: 'SOURCE_NOT_FOUND' });
      console.log(JSON.stringify({ feature: 'upload.pause-settle', status: 'passed', ms: settledMs }));
    });
    await measure('directory.during-paused-upload', () => files.listDirectory(owner, { ...scope, path: root, deferLinks: true }));
    await measure('upload.resume-large', () => resume(paused, 4 * MiB, 64 * MiB));
    await measure('upload.large-roundtrip-integrity', () => verify('pause-large.bin', pausedSource));

    const disconnectedSource = await makeFile('disconnect.bin', 32 * MiB);
    const disconnectPlan = { kind: 'disconnect', at: 8 * MiB };
    strategies.set(remote('disconnect.bin'), disconnectPlan);
    const disconnectedReview = await prepare([disconnectedSource]);
    let interrupted;
    await measure('upload.disconnect-after-eight-mib', async () => {
      [interrupted] = await confirm(disconnectedReview);
      await done(interrupted, 'interrupted'); await disconnectPlan.disconnecting;
      assert.equal(files.jobs.get(interrupted.jobId).checkpoint.bytes, 8 * MiB);
    });
    await measure('upload.reconnect-pinned', reconnect);
    observeConnection();
    await measure('upload.resume-after-disconnect', () => resume(interrupted, 8 * MiB, 32 * MiB));
    await measure('upload.reconnected-roundtrip-integrity', () => verify('disconnect.bin', disconnectedSource));

    const cancelledSource = await makeFile('cancel-running.bin', 8 * MiB);
    const cancelPlan = { kind: 'cancel', at: MiB };
    strategies.set(remote('cancel-running.bin'), cancelPlan);
    await measure('upload.cancel-active-and-clean', async () => {
      const [job] = await confirm(await prepare([cancelledSource]));
      await done(job, 'cancelled');
      const settledMs = round(performance.now() - cancelPlan.triggered);
      await assert.rejects(runtime.statRemotePath(plugin, job.path), { code: 'SOURCE_NOT_FOUND' });
      for (const [partial, target] of partialTargets) if (target === job.path) await assert.rejects(runtime.statRemotePath(plugin, partial), { code: 'SOURCE_NOT_FOUND' });
      console.log(JSON.stringify({ feature: 'upload.cancel-settle', status: 'passed', ms: settledMs }));
    });
    await measure('upload.cancel-review', async () => {
      const review = await files.beginUploadReview(owner, { ...scope, path: root }, [cancelledSource]);
      files.cancelUploadReview(owner, { ...scope, reviewId: review.reviewId });
      await assert.rejects(files.readUploadReview(owner, { ...scope, reviewId: review.reviewId }), { code: 'UPLOAD_CONFIRMATION_INVALID' });
    });

    const conflictSource = local('events.log');
    const originalText = (await operations.readFile(plugin, { path: remote('events.log') })).content;
    await fs.writeFile(conflictSource, 'INFO new-probe-content\n');
    for (const decision of ['skip', 'keep-both', 'overwrite']) await measure('upload.conflict-' + decision, async () => {
      const initial = await prepare([conflictSource]);
      assert.equal(initial.files[0].exists, true);
      await assert.rejects(files.confirmUpload(owner, { ...scope, preparationId: initial.preparationId, overwrite: false }), { code: 'TARGET_EXISTS' });
      const chosen = await ready(await files.reviseUploadReview(owner, { ...scope, reviewId: initial.reviewId,
        fileNames: ['events.log'], decisions: [{ name: 'events.log', action: decision }] }));
      const jobs = await confirm(chosen);
      await Promise.all(jobs.map(job => done(job)));
      const content = (await operations.readFile(plugin, { path: remote('events.log') })).content;
      assert.equal(content, decision === 'overwrite' ? 'INFO new-probe-content\n' : originalText);
      if (decision === 'keep-both') assert.equal((await operations.readFile(plugin, { path: remote('events (1).log') })).content, 'INFO new-probe-content\n');
      if (decision === 'skip') assert.equal(jobs.length, 0);
    });

    const discardSource = await makeFile('cancel-paused.bin', 8 * MiB);
    strategies.set(remote('cancel-paused.bin'), { kind: 'pause', at: MiB });
    await measure('upload.cancel-paused-retains-explicitly', async () => {
      const [job] = await confirm(await prepare([discardSource]));
      const state = await done(job, 'paused');
      const temporary = state.checkpoint.temporary;
      const cancelled = files.cancelUpload(owner, { ...scope, jobId: job.jobId });
      await done(job, 'cancelled');
      assert.ok(cancelled.message.includes('临时文件'));
      assert.equal((await runtime.statRemotePath(plugin, temporary)).size, MiB);
      await assert.rejects(runtime.statRemotePath(plugin, job.path), { code: 'SOURCE_NOT_FOUND' });
    });
  } finally { runtime.uploadRemoteFile = originalUpload; }
}
