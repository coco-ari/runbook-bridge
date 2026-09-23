import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// 所有合成文件均放在本次登记的随机目录；上传与覆盖沿用产品预检、确认和提交校验。
export async function runSearchBoundsScenarios({ runtime, plugin, files, operations, scope, owner, root, owned, localRoot, localNames, action, measure, waitFor, includeTextBoundary = true }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
  assert.ok(owned.has(root));
  const started = performance.now();
  const elapsed = since => Math.round((performance.now() - since) * 10) / 10;
  const errorCodes = new Set(['ERR_ASSERTION', 'INTERNAL_ERROR', 'NOT_CONNECTED', 'WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'WORKSPACE_PATH_CHANGED', 'PATH_INVALID', 'INVALID_ARGUMENT', 'TARGET_EXISTS', 'SOURCE_NOT_FOUND', 'SOURCE_NOT_ALLOWED', 'SOURCE_ACCESS_DENIED', 'REMOTE_CHANGED', 'LOCAL_FILE_CHANGED', 'UPLOAD_RESUME_INVALID', 'UPLOAD_PARTIAL_CHANGED', 'UPLOAD_PAUSED', 'UPLOAD_CONNECTION_LOST', 'TRANSFER_CANCELLED', 'TRANSFER_TIMEOUT', 'TRANSFER_FAILED', 'TRANSFER_INTERRUPTED', 'TRANSFER_INTEGRITY_FAILED', 'SFTP_OPERATION_TIMEOUT', 'SFTP_UNAVAILABLE', 'READ_BUSY', 'READ_TIMEOUT']);
  const phases = new Set(['preparing', 'opening', 'uploading', 'verifying', 'resume-verification', 'committing']);
  const lifecycle = event => {
    if (!['connected', 'lost', 'disconnected'].includes(event.type)) return;
    console.log(JSON.stringify({ feature:'search.connection-lifecycle', type:event.type, elapsedMs:elapsed(started), connected:runtime.status(plugin).connected === true }));
  };
  runtime.on?.('lifecycle', lifecycle);
  try {
  const directories = [root, root + '/level-one', root + '/level-one/level-two'];
  const samples = new Map();
  for (const [depth, directory] of directories.entries()) {
    for (let index = 0; index < 2; index += 1) {
      const name = `layer-${depth}-${index}.log`;
      const head = `HEAD probe-${depth}-${index}\n`;
      const filler = 'INFO synthetic filler row 0123456789\n';
      const content = head + filler.repeat(Math.ceil((96 * 1024 - Buffer.byteLength(head)) / Buffer.byteLength(filler))) + `TAIL probe-${depth}-${index}\n`;
      samples.set(directory + '/' + name, { name, content });
    }
  }
  const boundary = root + '/boundary.txt';
  if (includeTextBoundary) samples.set(boundary, { name:'boundary.txt', content:'x'.repeat(1024 * 1024 - 1) + '中文跨页标记\nASCII_CONTROL\n' });
  let uploadBatch = 0;
  async function upload(targets, overwrite = false) {
    const batch = ++uploadBatch, batchStarted = performance.now();
    assert.ok(targets.length >= 1 && targets.length <= 3);
    const directory = path.posix.dirname(targets[0]);
    assert.ok(directories.includes(directory) && owned.has(directory));
    const selected = [];
    for (const target of targets) {
      assert.ok(samples.has(target)); assert.equal(path.posix.dirname(target), directory);
      assert.equal(owned.has(target), overwrite);
      const sample = samples.get(target);
      assert.equal(target, directory + '/' + sample.name);
      assert.match(sample.name, /^[a-z0-9-]+\.(?:log|txt)$/u);
      const local = path.join(localRoot, sample.name);
      localNames.add(sample.name);
      await fs.writeFile(local, sample.content, { flag:overwrite ? 'w' : 'wx', mode:0o600 });
      selected.push(local);
    }
    const review = await files.beginUploadReview(owner, { ...scope, path:directory }, selected);
    let ready;
    await waitFor(async () => {
      ready = await files.readUploadReview(owner, { ...scope, reviewId:review.reviewId });
      if (ready.status === 'error') throw Object.assign(new Error('合成文件上传预检失败'), { code:ready.error.code });
      return ready.status === 'ready';
    }, 180_000);
    assert.equal(ready.files.length, targets.length);
    for (const item of ready.files) { assert.ok(targets.includes(item.remotePath)); assert.equal(item.exists, overwrite); }
    for (const target of targets) owned.add(target);
    const originalUpload = runtime.uploadRemoteFile;
    runtime.uploadRemoteFile = async function(selectedPlugin, source, destination, precondition, options = {}) {
      const transferStarted = performance.now();
      let phase = 'validation', transferred = 0, code = null;
      const bytes = Number.isSafeInteger(precondition?.local?.size) ? precondition.local.size : null;
      const observe = value => {
        if (phases.has(value.phase)) phase = value.phase;
        const current = value.transferredBytes ?? value.bytes;
        if (Number.isSafeInteger(current) && current >= 0) transferred = current;
      };
      try {
        for (const key of ['projectId', 'environmentId', 'pluginInstanceId']) assert.equal(selectedPlugin[key], plugin[key]);
        assert.ok(targets.includes(destination)); assert.ok(selected.includes(source));
        const temporary = new Set();
        const result = await originalUpload.call(this, selectedPlugin, source, destination, precondition, { ...options,
          // 分片名来自本次产品检查点；仅登记已确认由该上传创建的确切路径。
          onCheckpoint: checkpoint => {
            assert.ok(checkpoint.temporary.startsWith(destination + '.part-'));
            assert.match(checkpoint.temporary.slice((destination + '.part-').length), /^[a-f0-9]{24}$/u);
            if (checkpoint.owned) { owned.add(checkpoint.temporary); temporary.add(checkpoint.temporary); }
            observe(checkpoint); options.onCheckpoint?.(checkpoint);
          },
          onProgress: progress => { observe(progress); options.onProgress?.(progress); },
        });
        for (const target of temporary) owned.delete(target);
        return result;
      } catch (error) {
        code = errorCodes.has(error?.code) ? error.code : 'UNKNOWN_ERROR';
        throw error;
      } finally {
        // 仅输出序号、白名单代码和数值，不输出路径、异常正文或上传内容。
        console.log(JSON.stringify({ feature:'search.upload-observation', batch, job:targets.indexOf(destination), phase, elapsedMs:elapsed(transferStarted), transferred, bytes, ...(code ? { code } : {}) }));
      }
    };
    try {
      let jobs = [];
      try {
        ({ jobs } = await files.confirmUpload(owner, { ...scope, preparationId:ready.preparationId, overwrite }));
        await waitFor(() => jobs.every(job => {
          const state = files.jobs.get(job.jobId);
          return !state.inFlight && ['completed','error','cancelled','interrupted','paused'].includes(state.status);
        }), 180_000);
      } finally {
        console.log(JSON.stringify({ feature:'search.upload-jobs', batch, elapsedMs:elapsed(batchStarted), jobs:jobs.map((job, index) => {
          const state = files.jobs.get(job.jobId);
          return { job:index, status:state?.status ?? 'missing', inFlight:Boolean(state?.inFlight), transferred:state?.transferred ?? 0, bytes:state?.bytes ?? 0 };
        }) }));
      }
      assert.ok(jobs.every(job => files.jobs.get(job.jobId).status === 'completed'));
    } finally { runtime.uploadRemoteFile = originalUpload; }
  }
  for (let index = 1; index < directories.length; index += 1) {
    await measure('search.setup-directory.' + index, () => action('mkdir', directories[index - 1], path.posix.basename(directories[index])));
  }
  for (const [index, directory] of directories.entries()) {
    await measure('search.setup-upload.' + index, () => upload([...samples.keys()].filter(target => path.posix.dirname(target) === directory)));
  }
  const logTargets = [...samples.keys()].filter(target => target.endsWith('.log'));
  const stats = { pages:0, remoteBytes:0, cacheHits:0, discoveryContinuations:0 };
  function checkPage(result) {
    assert.ok(result.scannedBytes <= result.limitsApplied.maxScanBytes);
    assert.ok(result.expandedBytes <= result.limitsApplied.maxExpandedBytes);
    assert.ok(result.scannedFiles <= result.limitsApplied.maxFiles);
    assert.ok(result.resultBytes <= result.limitsApplied.maxResultBytes);
    assert.ok(result.coverage.every(item => logTargets.includes(item.path)));
    if (result.status !== 'complete' && result.matchCount === 0) assert.notEqual(result.conclusion, 'no_match');
    stats.pages += 1; stats.remoteBytes += result.remoteBytesRead; stats.cacheHits += result.cache.hits;
  }
  await measure('search.find-depth-bound', async () => {
    const found = await operations.findFiles(plugin, { path:root, pattern:'*.log', maxDepth:0, maxResults:20, refresh:true });
    assert.deepEqual(found.files.map(item => item.path).sort(), logTargets.filter(target => path.posix.dirname(target) === root).sort());
    assert.equal(found.scanned.directories, 1); assert.equal(found.truncated, false);
  });
  await measure('search.find-result-bound', async () => {
    const found = await operations.findFiles(plugin, { path:root, pattern:'*.log', maxDepth:2, maxResults:1, refresh:true });
    assert.equal(found.files.length, 1); assert.equal(found.truncated, true);
    assert.ok(found.scanned.entries <= found.limitsApplied.maxEntries);
  });
  await measure('search.log-file-limit-and-cursors', async () => {
    const scopes = [{ path:root, maxDepth:2 }], visited = new Set(), matches = new Set();
    let cursorChecked = false;
    while (scopes.length) {
      const selection = scopes.shift(); assert.ok(directories.includes(selection.path));
      if (visited.has(selection.path)) continue;
      visited.add(selection.path); assert.ok(visited.size <= directories.length);
      const query = { ...selection, pattern:'*.log', queries:['HEAD'], maxFiles:2, maxMatches:20, maxScanBytes:1024 * 1024, maxExpandedBytes:1024 * 1024, beforeLines:0, afterLines:0 };
      let cursor = null, result;
      for (let page = 0; page < 12; page += 1) {
        result = await operations.searchLogs(plugin, { ...query, ...(cursor ? { cursor } : {}) }); checkPage(result);
        for (const item of result.matches) { assert.ok(logTargets.includes(item.path)); assert.equal(item.lineNumber, 1); matches.add(item.path); }
        if (!cursorChecked && result.nextCursor) {
          await assert.rejects(operations.searchLogs(plugin, { ...query, maxFiles:3, cursor:result.nextCursor }), { code:'LOG_CURSOR_MISMATCH' });
          cursorChecked = true;
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      assert.equal(cursor, null);
      if (!result.progress.selectionComplete) {
        assert.equal(result.status, 'partial'); assert.ok(result.remainingDirectories.length > 0);
        scopes.push(...result.remainingDirectories); stats.discoveryContinuations += result.remainingDirectories.length;
      } else assert.equal(result.status, 'complete');
    }
    assert.equal(cursorChecked, true); assert.deepEqual([...matches].sort(), logTargets.sort());
  });
  const dynamic = root + '/layer-0-0.log';
  const limited = { path:dynamic, queries:['FRESH_GROWTH_MARKER'], maxScanBytes:65536, maxExpandedBytes:65536, beforeLines:0, afterLines:0 };
  let earlier;
  await measure('search.tail-window-inconclusive', async () => {
    earlier = await operations.searchLogs(plugin, limited); checkPage(earlier);
    assert.equal(earlier.matchCount, 0); assert.equal(earlier.conclusion, 'inconclusive'); assert.ok(earlier.nextCursor);
    assert.ok(earlier.coverage.some(item => item.scanStartByte > 0 && !item.complete));
    assert.ok(earlier.truncationReasons.includes('fileTailOnly')); assert.ok(earlier.guidance.length > 0);
  });
  await measure('search.replace-owned-log-with-longer-content', async () => {
    samples.get(dynamic).content += 'FRESH_GROWTH_MARKER synthetic appended text\n';
    await upload([dynamic], true);
  });
  await measure('search.cursor-keeps-original-range-after-growth', async () => {
    let cursor = earlier.nextCursor, grew = false, terminal;
    for (let page = 0; page < 4; page += 1) {
      terminal = await operations.searchLogs(plugin, { ...limited, cursor }); checkPage(terminal);
      assert.equal(terminal.matchCount, 0); assert.equal(terminal.conclusion, 'inconclusive');
      grew ||= terminal.coverage.some(item => item.sourceGrew && item.observedSize > item.snapshotSize);
      cursor = terminal.nextCursor; if (!cursor) break;
    }
    assert.equal(cursor, null); assert.equal(grew, true); assert.equal(terminal.status, 'partial');
  });
  await measure('search.refresh-finds-new-content', async () => {
    const result = await operations.searchLogs(plugin, { ...limited, maxScanBytes:262144, maxExpandedBytes:262144, refresh:true }); checkPage(result);
    assert.equal(result.status, 'complete'); assert.equal(result.matchCount, 1); assert.equal(result.conclusion, 'matches');
  });
  await measure('search.complete-no-match', async () => {
    const result = await operations.searchLogs(plugin, { path:dynamic, queries:['ABSENT_PROBE_MARKER'], maxScanBytes:262144, maxExpandedBytes:262144 }); checkPage(result);
    assert.equal(result.matchCount, 0); assert.equal(result.status, 'complete'); assert.equal(result.conclusion, 'no_match');
  });
  if (includeTextBoundary) {
  await measure('search.text-budget-and-resume', async () => {
    const start = 1024 * 1024 - 1, cursor = String(start);
    await assert.rejects(operations.readFile(plugin, { path:boundary, cursor, maxBytes:2 }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT'); assert.equal(error.details?.minimumBytes, 3); return true;
    });
    const page = await operations.readFile(plugin, { path:boundary, cursor, maxBytes:3 });
    assert.equal(page.content, '中'); assert.equal(page.endByte, start + 3);
  });
  await measure('search.content-utf8-across-mebibyte', async () => {
    const result = await operations.searchFiles(plugin, { path:root, pattern:'boundary.txt', contains:'中文跨页标记', maxDepth:0, maxFiles:10, maxMatches:10, maxScanBytes:2 * 1024 * 1024 });
    assert.equal(result.matchCount, 1); assert.equal(result.matches[0].path, boundary); assert.equal(result.matches[0].line, 1); assert.equal(result.truncated, false);
    assert.equal(result.scannedBytes, Buffer.byteLength(samples.get(boundary).content));
  });
  await measure('search.content-ascii-control', async () => {
    const result = await operations.searchFiles(plugin, { path:root, pattern:'boundary.txt', contains:'ASCII_CONTROL', maxDepth:0, maxFiles:10, maxMatches:10, maxScanBytes:2 * 1024 * 1024 });
    assert.equal(result.matchCount, 1); assert.equal(result.matches[0].line, 2); assert.equal(result.truncated, false);
  });
  }
  await measure('search.budgets-released', async () => {
    await waitFor(() => runtime.readScheduler.active === 0 && operations.logSearchGate.active === 0 && runtime.readScheduler.queue.length === 0 && operations.logSearchGate.queue.length === 0);
    assert.equal(runtime.readScheduler.reservedBytes, 0); assert.equal(operations.logSearchGate.reservedBytes, 0);
  });
  console.log(JSON.stringify({ feature:includeTextBoundary ? 'search.bounds-summary' : 'search.log-bounds-summary', status:'observed', directories:directories.length, logFiles:logTargets.length, textBoundary:includeTextBoundary ? 'passed' : 'not-run', ...stats }));
  } finally { runtime.off?.('lifecycle', lifecycle); }
}
