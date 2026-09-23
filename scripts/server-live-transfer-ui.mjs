import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, dialog } from 'electron';
import { parseDiskMetrics } from '../src/server-metrics-reader.mjs';

const MiB = 1024 * 1024;
const execFileAsync = promisify(execFile);
async function digest(file, bytes) {
  const hash = crypto.createHash('sha256');
  if (bytes !== 0) for await (const chunk of createReadStream(file, bytes === undefined ? {} : { start: 0, end: bytes - 1 })) hash.update(chunk);
  return hash.digest('hex');
}

// 只有产品预检确认过的本次目标进入名单；所有分片按产品回调记录，不扫描删除其他文件。
export async function createLiveTransferUi({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames }) {
  assert.equal(process.platform, 'win32', '原生文件窗口专项目前仅实现 Windows 驱动');
  const raw = await runtime.readWorkspaceMetrics(plugin, 'disks');
  assert.equal(raw.exitCode, 0);
  const disk = parseDiskMetrics(raw.stdout).items.filter(item => item.mount === '/' || root === item.mount || root.startsWith(item.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
  assert.ok(disk && disk.available >= 512 * MiB);
  const localSpace = await fs.statfs(localRoot, { bigint: true });
  assert.ok(localSpace.bavail * localSpace.bsize >= BigInt(512 * MiB));
  const name = 'ui-transfer.bin', source = path.join(localRoot, name), remote = root + '/' + name;
  localNames.add(name);
  const handle = await fs.open(source, 'wx', 0o600);
  try { for (let index = 0; index < 64; index += 1) await handle.writeFile(crypto.randomBytes(MiB)); }
  finally { await handle.close(); }
  const sourceHash = await digest(source), sourceBytes = 64 * MiB;
  const binarySources = new Map(), backend = [], pickerEvents = [], reviewIds = new Set(), preparations = new Map(), knownJobs = new Map();
  let selection = 'cancel', destinationName = 'ui-cancelled.bin', stop = false;
  const originalUpload = runtime.uploadRemoteFile.bind(runtime);
  runtime.uploadRemoteFile = (selected, local, destination, condition, options = {}) => {
    assert.equal(local, source); assert.equal(destination, remote); assert.ok(owned.has(destination));
    return originalUpload(selected, local, destination, condition, { ...options, onCheckpoint: checkpoint => {
      assert.ok(checkpoint.temporary.startsWith(remote + '.part-'));
      assert.match(checkpoint.temporary.slice((remote + '.part-').length), /^[a-f0-9]{24}$/u);
      if (checkpoint.owned) { owned.add(checkpoint.temporary); binarySources.set(checkpoint.temporary, source); }
      options.onCheckpoint?.(checkpoint);
    } });
  };
  const states = new Map();
  const timer = setInterval(() => {
    for (const job of files.jobs.values()) {
      if (job.path !== remote || job.ownerId === owner) continue;
      knownJobs.set(job.jobId, job);
      const state = job.status + ':' + Math.floor(job.transferred / MiB);
      if (states.get(job.jobId) === state) continue;
      states.set(job.jobId, state);
      backend.push({ jobId: job.jobId, direction: job.direction ?? 'upload', status: job.status, bytes: job.transferred, at: Date.now() });
    }
  }, 10);
  timer.unref();
  const checkScope = input => { for (const [key, value] of Object.entries(scope)) assert.equal(input[key], value); };
  async function nativePicker(sender, kind) {
    const window = BrowserWindow.fromWebContents(sender); assert.ok(window?.isVisible());
    const cancel = selection === 'cancel';
    const selected = kind === 'upload' ? source : path.join(localRoot, destinationName);
    assert.equal(path.dirname(selected), localRoot);
    if (kind === 'download') { await assert.rejects(fs.stat(selected), { code: 'ENOENT' }); localNames.add(destinationName); }
    const title = 'RunbookBridge 实测 ' + crypto.randomUUID();
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RUNBOOK_LIVE_')));
    const driver = execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve('scripts/server-native-file-dialog.ps1'), '-TargetProcessId', String(process.pid), '-DialogTitle', title,
      '-PickerAction', cancel ? 'cancel' : 'select', '-SelectedFile', selected],
    { windowsHide: true, env: environment, timeout: 20000, maxBuffer: 4096 });
    // 测试只额外限定初始目录、唯一标题及不加入最近文件；选择结果仍来自系统原生窗口。
    const native = kind === 'upload'
      ? dialog.showOpenDialog(window, { title, defaultPath: localRoot, properties: ['openFile', 'multiSelections', 'dontAddToRecent'] })
      : dialog.showSaveDialog(window, { title, defaultPath: selected, properties: ['showOverwriteConfirmation', 'dontAddToRecent'] });
    let result;
    try {
      [result] = await Promise.all([native, driver]);
      assert.equal(result.canceled, cancel);
      if (!cancel) {
        if (kind === 'upload') assert.deepEqual(result.filePaths, [source]);
        else assert.equal(result.filePath, selected);
      }
    }
    catch (error) {
      pickerEvents.push({ kind, error: 'NATIVE_PICKER_FAILED', at: Date.now() });
      const stage = error.stdout?.match(/"nativePickerFailureStage":"([a-z-]+)"/u)?.[1] ?? 'driver-start';
      process.stdout.write(JSON.stringify({ nativePickerFailed: true, stage, code: typeof error.code === 'number' ? error.code : 'driver-error' }) + '\n');
      throw Object.assign(new Error('本次原生文件窗口自动操作失败'), { code: 'NATIVE_PICKER_FAILED' });
    }
    pickerEvents.push({ kind, canceled: cancel, at: Date.now() });
    window.focus(); sender.focus();
    if (cancel) return kind === 'upload' ? [] : null;
    return kind === 'upload' ? result.filePaths : selected;
  }
  function keepReview(review) {
    reviewIds.add(review.reviewId);
    if (review.preparationId) preparations.set(review.preparationId, review);
    return review;
  }
  const adapters = {
    async requirePlugin(id, input, expected) { checkScope(input); assert.equal(input.path, root); return files.requirePlugin(id, input, expected); },
    async beginUploadReview(id, input, selected) { assert.equal(input.path, root); assert.deepEqual(selected, [source]); return keepReview(await files.beginUploadReview(id, input, selected)); },
    async readUploadReview(id, input) { assert.ok(reviewIds.has(input.reviewId)); return keepReview(await files.readUploadReview(id, input)); },
    cancelUploadReview(id, input) { assert.ok(reviewIds.has(input.reviewId)); return files.cancelUploadReview(id, input); },
    async prepareUploadResume(id, input) { assert.equal(files.jobs.get(input.jobId)?.path, remote); return keepReview(await files.prepareUploadResume(id, input)); },
    async confirmUpload(id, input) {
      const review = preparations.get(input.preparationId); assert.ok(review);
      assert.equal(review.files.length, 1); assert.equal(review.files[0].remotePath, remote); assert.equal(review.files[0].localPath, source);
      if (review.files[0].exists) assert.ok(owned.has(remote));
      owned.add(remote); binarySources.set(remote, source);
      return files.confirmUpload(id, input);
    },
    uploads: (id, input) => files.uploads(id, input),
    pauseUpload(id, input) { assert.equal(files.jobs.get(input.jobId)?.path, remote); return files.pauseUpload(id, input); },
    cancelUpload(id, input) { assert.equal(files.jobs.get(input.jobId)?.path, remote); return files.cancelUpload(id, input); },
    clearTransfers: (id, input) => files.clearTransfers(id, input),
    downloads: {
      async prepare(id, input) { assert.equal(input.path, remote); assert.ok(owned.has(remote)); return files.downloads.prepare(id, input); },
      async start(id, input, prepared, selected) { assert.equal(path.dirname(selected), localRoot); assert.ok(localNames.has(path.basename(selected))); return files.downloads.start(id, input, prepared, selected); },
    },
  };
  const channels = [
    'server-workspace-pick-upload', 'server-workspace-read-upload-review', 'server-workspace-cancel-upload-review',
    'server-workspace-confirm-upload', 'server-workspace-prepare-upload-resume', 'server-workspace-pause-upload',
    'server-workspace-cancel-upload', 'server-workspace-clear-transfers', 'server-workspace-uploads', 'server-workspace-download',
  ];
  async function waitFor(check) {
    const until = Date.now() + 30000;
    while (!await check()) { assert.ok(Date.now() < until, '传输实测等待超时'); await delay(20); }
  }
  return {
    adapters, channels,
    services: { pickServerUploadFiles: sender => nativePicker(sender, 'upload'), pickServerDownloadPath: (sender, selectedName) => { assert.equal(selectedName, name); return nativePicker(sender, 'download'); } },
    name, sourceBytes,
    pick(action, downloadName = 'ui-downloaded.bin') { assert.ok(['select', 'cancel'].includes(action)); assert.match(downloadName, /^ui-[a-z-]+\.bin$/u); selection = action; destinationName = downloadName; },
    snapshot() {
      return { backend: [...backend], pickers: [...pickerEvents], jobs: [...knownJobs.values()].map(job => ({
        jobId: job.jobId, direction: job.direction ?? 'upload', status: job.status, bytes: job.bytes, transferred: job.transferred,
        inFlight: job.inFlight, checkpointBytes: job.checkpoint?.bytes ?? null,
      })) };
    },
    async checkPaused() {
      const job = [...files.jobs.values()].find(item => item.path === remote && item.direction !== 'download');
      assert.equal(job.status, 'paused'); assert.ok(!job.inFlight && job.checkpoint.bytes > 0 && job.checkpoint.bytes < sourceBytes);
      assert.equal((await runtime.statRemotePath(plugin, job.checkpoint.temporary)).size, job.checkpoint.bytes);
      await assert.rejects(runtime.statRemotePath(plugin, remote), { code: 'SOURCE_NOT_FOUND' });
      return job.checkpoint.bytes;
    },
    async checkDownload(downloadName, canceled = false) {
      await waitFor(() => [...knownJobs.values()].filter(job => job.direction === 'download').every(job => !job.inFlight));
      const selected = path.join(localRoot, downloadName);
      if (canceled) await assert.rejects(fs.stat(selected), { code: 'ENOENT' });
      else { assert.equal((await fs.stat(selected)).size, sourceBytes); assert.equal(await digest(selected), sourceHash); }
      assert.equal((await fs.readdir(localRoot)).filter(value => value.startsWith('.runbook-download-')).length, 0);
    },
    async checkOwnedFile(selected, info) {
      if (!binarySources.has(selected)) return false;
      assert.equal(info.type, 'file'); assert.ok(info.size <= sourceBytes && info.size >= 0);
      const verifyName = 'ui-verify-' + crypto.randomBytes(5).toString('hex') + '.bin', destination = path.join(localRoot, verifyName);
      localNames.add(verifyName);
      const prepared = await files.downloads.prepare(owner, { ...scope, path: selected });
      const job = await files.downloads.start(owner, scope, prepared, destination);
      await waitFor(() => !files.jobs.get(job.jobId).inFlight && ['completed', 'error', 'cancelled'].includes(files.jobs.get(job.jobId).status));
      assert.equal(files.jobs.get(job.jobId).status, 'completed');
      assert.equal(await digest(destination), await digest(source, info.size), '清理前核对本次合成二进制或分片的完整内容');
      return true;
    },
    dispose() { if (stop) return; stop = true; clearInterval(timer); runtime.uploadRemoteFile = originalUpload; },
  };
}
