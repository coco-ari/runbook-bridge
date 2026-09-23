import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// 使用真实异步预检和桌面上传任务；仅上传本次合成文件，协议记录不包含路径或正文。
export async function runUploadPhaseScenarios({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames, measure, waitFor }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u); assert.ok(owned.has(root));
  const name = 'state-source.txt', body = 'synthetic initial file\n';
  const local = path.join(localRoot, name), target = root + '/' + name;
  localNames.add(name); await fs.writeFile(local, body, { flag:'wx', mode:0o600 });
  const client = runtime.broker.requireSession(runtime.key(plugin)).client;
  const openSftp = client.sftp, upload = runtime.uploadRemoteFile, checkDirectory = files.assertUploadDirectory;
  const started = performance.now(), round = value => Math.round(value * 10) / 10;
  const channels = [], requests = {}, checks = [], progress = [];
  let phase = 'review', opening = 0, finished = false, transferMs = null, commit = null;
  const elapsed = () => round(performance.now() - started);
  client.sftp = function(callback) {
    const item = { phase, startMs:elapsed() }, start = performance.now();
    opening += 1; channels.push(item);
    return openSftp.call(this, (error, channel) => {
      item.ms = round(performance.now() - start); item.failed = Boolean(error);
      if (channel) for (const method of ['lstat','stat','realpath','open','read','write','fstat','close','rename','unlink']) {
        const original = channel[method];
        channel[method] = function(...args) {
          const key = phase + '.' + method;
          requests[key] = (requests[key] ?? 0) + 1;
          return original.apply(this, args);
        };
      }
      callback(error, channel);
    });
  };
  files.assertUploadDirectory = async function(...args) {
    const item = { phase, startMs:elapsed() }, start = performance.now(); checks.push(item);
    try { return await checkDirectory.apply(this, args); }
    finally { item.ms = round(performance.now() - start); }
  };
  runtime.uploadRemoteFile = async function(selected, source, destination, precondition, options = {}) {
    assert.equal(source, local); assert.equal(destination, target); assert.ok(owned.has(target));
    phase = 'transfer'; const start = performance.now();
    try {
      return await upload.call(this, selected, source, destination, precondition, { ...options,
        onCheckpoint: checkpoint => {
          assert.ok(checkpoint.temporary.startsWith(target + '.part-'));
          assert.match(checkpoint.temporary.slice((target + '.part-').length), /^[a-f0-9]{24}$/u);
          if (checkpoint.owned) owned.add(checkpoint.temporary);
          options.onCheckpoint?.(checkpoint);
        },
        onProgress: value => {
          if (progress.at(-1)?.phase !== value.phase) progress.push({ phase:value.phase, atMs:elapsed() });
          options.onProgress?.(value);
        },
        beforeCommit: async (...args) => {
          phase = 'commit-directory'; const start = performance.now(), before = opening;
          commit = { startMs:elapsed() };
          try { return await options.beforeCommit?.(...args); }
          finally { commit.ms = round(performance.now() - start); commit.newChannels = opening - before; phase = 'commit-final'; }
        },
      });
    } finally { transferMs = round(performance.now() - start); }
  };
  try {
    const review = await measure('upload-phase.review-response', () => files.beginUploadReview(owner, { ...scope, path:root }, [local]));
    assert.equal(review.status, 'checking'); assert.equal(review.preparationId, null);
    let ready;
    await measure('upload-phase.review-ready', async () => {
      await waitFor(async () => {
        ready = await files.readUploadReview(owner, { ...scope, reviewId:review.reviewId });
        if (ready.status === 'error') throw Object.assign(new Error('上传预检未完成。'), { code:ready.error.code });
        return ready.status === 'ready';
      }, 90000);
      assert.equal(ready.files.length, 1); assert.equal(ready.files[0].remotePath, target); assert.equal(ready.files[0].exists, false);
    });
    phase = 'confirm'; owned.add(target);
    const queued = await measure('upload-phase.confirm-queued', () => files.confirmUpload(owner, { ...scope, preparationId:ready.preparationId, overwrite:false }));
    assert.equal(queued.jobs.length, 1);
    const id = queued.jobs[0].jobId;
    await measure('upload-phase.task-completed', async () => {
      await waitFor(() => !files.jobs.get(id).inFlight && ['completed','error','cancelled','paused','interrupted'].includes(files.jobs.get(id).status), 90000);
      if (files.jobs.get(id).status !== 'completed') throw Object.assign(new Error('专项上传没有完成。'), { code:'UPLOAD_PROBE_INCOMPLETE' });
      assert.equal(files.jobs.get(id).transferred, Buffer.byteLength(body));
    });
    phase = 'read-back';
    await measure('upload-phase.verify-content', async () => {
      const value = await files.readFile(owner, { ...scope, path:target });
      assert.equal(value.content, body); assert.equal(value.truncated, false);
    });
    assert.ok(commit); finished = true;
  } finally {
    client.sftp = openSftp; runtime.uploadRemoteFile = upload; files.assertUploadDirectory = checkDirectory;
    console.log(JSON.stringify({ feature:'upload-phase.protocol', status:finished ? 'observed' : 'partial', transferMs, commit, channels, checks, progress, requests }));
  }
}
