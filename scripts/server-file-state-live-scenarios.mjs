import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// 只操作入口本次新建的随机目录；所有变更继续经过桌面预检与一次性确认。
export async function runFileStateScenarios({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames, action, measure, waitFor, reconnect, parentsOnly = false }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
  assert.ok(owned.has(root));
  const otherOwner = owner + '-state-other';
  const source = root + '/state-source.txt';
  const initial = 'synthetic initial file\n';
  const replacement = 'synthetic independently replaced content with a different size\n';
  const conflict = 'synthetic conflicting destination\n';
  const originalUpload = runtime.uploadRemoteFile, originalMutate = runtime.mutateWorkspacePath;
  let parentObservation = null;
  const observations = [];
  const client = runtime.broker.requireSession(runtime.key(plugin)).client, originalSftp = client.sftp;
  const decorated = new WeakSet();
  let fileReads = 0;
  const safe = target => assert.ok(target.startsWith(root + '/') && path.posix.normalize(target) === target);
  client.sftp = function(callback) {
    const observation = parentObservation;
    return originalSftp.call(this, (error, channel) => {
      if (channel && !decorated.has(channel)) {
        decorated.add(channel);
        const read = channel.read;
        channel.read = function(...args) { fileReads += 1; return read.apply(this, args); };
        if (observation) {
          let paths = 0;
          const realpath = channel.realpath, lstat = channel.lstat;
          channel.realpath = function(target, done) {
            const sampled = target === observation.parentPath && paths++ % 2 === 0;
            const phase = sampled ? { started:performance.now() } : null;
            if (phase) observation.phases.push(phase);
            return realpath.call(this, target, (failure, value) => {
              if (phase) phase.pathMs = performance.now() - phase.started;
              done(failure, value);
            });
          };
          channel.lstat = function(target, done) {
            const phase = target === observation.canonicalParent ? observation.phases.at(-1) : null;
            if (phase) phase.statStartMs = performance.now() - phase.started;
            return lstat.call(this, target, done);
          };
        }
      }
      callback(error, channel);
    });
  };
  runtime.mutateWorkspacePath = async function(selected, args, options) {
    const observation = ['mkdir','rename'].includes(args.kind) ? { parentPath:args.parentPath, canonicalParent:args.canonicalParent, phases:[] } : null;
    parentObservation = observation;
    try { return await originalMutate.call(this, selected, args, options); }
    finally {
      parentObservation = null;
      if (observation) observations.push(observation);
      // 仅输出协议阶段和数值时间，真实路径与服务端返回值不进入诊断输出。
      if (observation) console.log(JSON.stringify({ feature:'state.parent-check-protocol', status:'observed', kind:args.kind,
        phases:observation.phases.map(({ pathMs, statStartMs }) => ({ pathMs:Math.round(pathMs * 10) / 10, statStartMs:Math.round(statStartMs * 10) / 10 })) }));
    }
  };
  runtime.uploadRemoteFile = function(selected, local, target, precondition, options = {}) {
    safe(target); assert.ok(owned.has(target));
    return originalUpload.call(this, selected, local, target, precondition, { ...options,
      onCheckpoint: checkpoint => {
        assert.ok(checkpoint.temporary.startsWith(target + '.part-'));
        assert.match(checkpoint.temporary.slice((target + '.part-').length), /^[a-f0-9]{24}$/u);
        if (checkpoint.owned) owned.add(checkpoint.temporary);
        options.onCheckpoint?.(checkpoint);
      },
    });
  };
  async function upload(name, content, directory = root) {
    assert.match(name, /^[a-z-]+\.txt$/u); assert.ok(owned.has(directory));
    assert.ok(directory === root || directory.startsWith(root + '/'));
    const local = path.join(localRoot, name);
    const exists = localNames.has(name); localNames.add(name);
    await fs.writeFile(local, content, { flag:exists ? 'w' : 'wx', mode:0o600 });
    const prepared = await files.prepareUpload(owner, { ...scope, path:directory }, [local]);
    assert.equal(prepared.files.length, 1);
    const target = directory + '/' + name;
    assert.equal(prepared.files[0].remotePath, target);
    if (prepared.files[0].exists) assert.ok(owned.has(target));
    owned.add(target);
    const { jobs } = await files.confirmUpload(owner, { ...scope, preparationId:prepared.preparationId, overwrite:prepared.files[0].exists });
    await waitFor(() => jobs.every(job => { const current = files.jobs.get(job.jobId); return !current.inFlight && ['completed','error','cancelled'].includes(current.status); }), 60000);
    assert.ok(jobs.every(job => files.jobs.get(job.jobId).status === 'completed'));
    return target;
  }
  const prepare = (kind, target, name, selectedOwner = owner) => {
    assert.ok(owned.has(target));
    if (target !== root) safe(target);
    if (name !== undefined) assert.match(name, /^[a-z-]+(?:\.txt)?$/u);
    return files.prepareFileAction(selectedOwner, { ...scope, kind, path:target, ...(name === undefined ? {} : { name }) });
  };
  const confirm = (prepared, selectedOwner = owner) => files.confirmFileAction(selectedOwner, { ...scope, operationId:prepared.operationId });
  const content = target => files.readFile(owner, { ...scope, path:target });
  const absent = target => assert.rejects(runtime.statRemotePath(plugin, target), { code:'SOURCE_NOT_FOUND' });
  async function rejected(prepared, codes = ['REMOTE_CHANGED'], selectedOwner = owner) {
    await assert.rejects(confirm(prepared, selectedOwner), error => codes.includes(error.code));
    await assert.rejects(confirm(prepared, selectedOwner), { code:'WORKSPACE_ACTION_EXPIRED' });
  }
  try {
    if (parentsOnly) {
      const created = await measure('parents.prepare-mkdir', () => prepare('mkdir', root, 'state-parent'));
      await measure('parents.confirm-mkdir', async () => {
        const result = await confirm(created); assert.equal(result.destinationPath, root + '/state-parent'); owned.add(result.destinationPath);
      });
      const renamed = await measure('parents.prepare-rename', () => prepare('rename', root + '/state-parent', 'state-parent-renamed'));
      await measure('parents.confirm-rename', async () => {
        const result = await confirm(renamed); assert.equal(result.destinationPath, root + '/state-parent-renamed');
        owned.delete(root + '/state-parent'); owned.add(result.destinationPath);
      });
      await measure('parents.verify-result-and-overlap', async () => {
        assert.equal((await files.fileInfo(owner, { ...scope, path:root + '/state-parent-renamed' })).type, 'directory');
        await absent(root + '/state-parent');
        assert.equal(observations.length, 2);
        for (const observation of observations) {
          assert.equal(observation.phases.length, 2);
          assert.ok(observation.phases.every(phase => Number.isFinite(phase.statStartMs) && phase.statStartMs <= phase.pathMs));
        }
      });
      await measure('parents.delete-owned-empty-directory', () => action('delete', root + '/state-parent-renamed'));
      return;
    }
    await measure('state.seed-owned-file', () => upload('state-source.txt', initial));
    await measure('state.attributes-without-content-read', async () => {
      const before = fileReads, info = await files.fileInfo(owner, { ...scope, path:source });
      assert.equal(info.type, 'file'); assert.equal(info.size, Buffer.byteLength(initial));
      assert.equal(fileReads, before);
    });
    const rename = await measure('state.prepare-rename', () => prepare('rename', source, 'state-never-renamed.txt'));
    const deletion = await measure('state.prepare-delete', () => prepare('delete', source, undefined, otherOwner));
    await measure('state.replace-after-preparation', () => upload('state-source.txt', replacement));
    await measure('state.reject-stale-rename', () => rejected(rename));
    await measure('state.reject-stale-delete', () => rejected(deletion, ['REMOTE_CHANGED'], otherOwner));
    await measure('state.preserve-new-content', async () => {
      assert.equal((await content(source)).content, replacement); await absent(root + '/state-never-renamed.txt');
    });
    const renameCollision = await prepare('rename', source, 'state-conflict.txt');
    const mkdirCollision = await prepare('mkdir', root, 'state-conflict.txt', otherOwner);
    await measure('state.occupy-destination-after-preparation', () => upload('state-conflict.txt', conflict));
    await measure('state.reject-rename-collision', () => rejected(renameCollision));
    await measure('state.reject-mkdir-collision', () => rejected(mkdirCollision, ['REMOTE_CHANGED'], otherOwner));
    await measure('state.preserve-both-conflicting-files', async () => {
      assert.equal((await content(source)).content, replacement);
      assert.equal((await content(root + '/state-conflict.txt')).content, conflict);
    });
    await action('mkdir', root, 'state-directory');
    const directory = root + '/state-directory';
    const emptyDeletion = await prepare('delete', directory);
    await measure('state.populate-prepared-empty-directory', () => upload('state-child.txt', initial, directory));
    await measure('state.reject-newly-nonempty-directory', async () => {
      await rejected(emptyDeletion, ['REMOTE_CHANGED','DIRECTORY_NOT_EMPTY']);
      assert.equal((await content(directory + '/state-child.txt')).content, initial);
    });
    const missing = await prepare('delete', source, undefined, otherOwner);
    const page = await files.listDirectory(owner, { ...scope, path:root, deferLinks:true });
    await measure('state.rename-and-invalidate-snapshot', async () => {
      await action('rename', source, 'state-renamed.txt');
      await assert.rejects(files.listDirectory(owner, { ...scope, path:root, snapshotId:page.snapshotId, cursor:'0', deferLinks:true }), { code:'WORKSPACE_DIRECTORY_EXPIRED' });
    });
    const renamed = root + '/state-renamed.txt';
    await measure('state.reject-missing-delete-and-preview', async () => {
      await rejected(missing, ['REMOTE_CHANGED'], otherOwner);
      await assert.rejects(content(source), { code:'SOURCE_NOT_FOUND' });
      assert.equal((await content(renamed)).content, replacement);
    });
    await measure('state.refreshed-directory', async () => {
      const fresh = await files.listDirectory(owner, { ...scope, path:root, deferLinks:true });
      assert.notEqual(fresh.snapshotId, page.snapshotId);
      assert.ok(fresh.entries.some(entry => entry.name === 'state-renamed.txt'));
      assert.ok(!fresh.entries.some(entry => entry.name === 'state-source.txt'));
    });
    const once = await prepare('mkdir', root, 'state-once');
    await measure('state.reject-other-owner-and-scope', async () => {
      await assert.rejects(confirm(once, otherOwner), { code:'WORKSPACE_ACTION_EXPIRED' });
      await assert.rejects(files.confirmFileAction(owner, { ...scope, environmentId:'other', operationId:once.operationId }), { code:'WORKSPACE_ACTION_EXPIRED' });
    });
    await measure('state.concurrent-confirmation-once', async () => {
      const results = await Promise.allSettled([confirm(once), confirm(once)]);
      const succeeded = results.filter(result => result.status === 'fulfilled');
      for (const result of succeeded) { assert.equal(result.value.destinationPath, root + '/state-once'); owned.add(result.value.destinationPath); }
      assert.equal(succeeded.length, 1);
      const failure = results.find(result => result.status === 'rejected');
      assert.equal(failure.reason.code, 'WORKSPACE_ACTION_EXPIRED');
    });
    const closed = await prepare('delete', renamed, undefined, otherOwner);
    await measure('state.closed-owner-invalidates-confirmation', async () => {
      files.closeOwner(otherOwner); await rejected(closed, ['WORKSPACE_ACTION_EXPIRED'], otherOwner);
    });
    const disconnected = await prepare('delete', renamed);
    await measure('state.reconnect-invalidates-confirmation', async () => {
      await runtime.disconnect(plugin); await reconnect();
      await rejected(disconnected, ['WORKSPACE_ACTION_EXPIRED']);
      assert.equal((await content(renamed)).content, replacement);
    });
  } finally {
    runtime.uploadRemoteFile = originalUpload; runtime.mutateWorkspacePath = originalMutate; client.sftp = originalSftp;
    files.closeOwner(otherOwner);
  }
}
