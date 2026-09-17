import crypto from 'node:crypto';
import path from 'node:path';
import { AppError, toPublicError } from './errors.mjs';
import { DESKTOP_DOWNLOAD_LIMIT, downloadDestination } from './server-download-transfer.mjs';
import { ServerUploadProgress } from './server-upload-progress.mjs';

export class ServerWorkspaceDownloads {
  constructor(files) { this.files = files; }

  async prepare(ownerId, payload) {
    const binding = await this.files.requirePlugin(ownerId, payload);
    const remotePath = this.files.normalizeUploadPath(payload.path);
    const expected = await this.files.assertPath(binding.plugin, remotePath, 'file');
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > DESKTOP_DOWNLOAD_LIMIT) throw new AppError('FILE_TOO_LARGE', '桌面下载单个文件不能超过 500 MB。');
    await this.files.requirePlugin(ownerId, payload, binding);
    return {...binding, ownerId, path:remotePath, name:path.posix.basename(remotePath), expected};
  }

  async start(ownerId, payload, prepared, selectedPath) {
    if (prepared.ownerId !== ownerId) throw new AppError('WORKSPACE_ACCESS_DENIED', '下载窗口已失效。');
    const binding = await this.files.requirePlugin(ownerId, payload, prepared);
    const destination = await downloadDestination(selectedPath);
    await this.files.requirePlugin(ownerId, payload, binding);
    if ([...this.files.jobs.values()].filter(job => job.ownerId === ownerId && !['completed','cancelled','error'].includes(job.status)).length >= 40) throw new AppError('WORKSPACE_BUSY', '传输任务过多，请等待当前任务完成。');
    const job = {...prepared, ...binding, direction:'download', destination, localPath:destination.path,
      jobId:crypto.randomUUID(), bytes:prepared.expected.size, transferred:0, status:'queued',
      controller:new AbortController(), progress:new ServerUploadProgress(this.files.now)};
    this.files.jobs.set(job.jobId, job);
    this.files.pruneJobs(ownerId);
    this.files.drain();
    return this.files.uploads(ownerId, payload).jobs.find(item => item.jobId === job.jobId);
  }

  async run(job) {
    const signal = job.controller.signal;
    try {
      const binding = await this.files.requirePlugin(job.ownerId, job.scope, job);
      signal.throwIfAborted();
      await this.files.audit(job, 'started');
      await this.files.requirePlugin(job.ownerId, job.scope, job);
      signal.throwIfAborted();
      await this.files.serverRuntime.downloadWorkspaceFile(binding.plugin, job.path, job.destination, job.expected, {
        signal,
        beforeCommit:async () => { await this.files.requirePlugin(job.ownerId, job.scope, job); signal.throwIfAborted(); },
        onProgress:({transferredBytes, phase}) => {
          if (signal.aborted) return;
          job.transferred = transferredBytes;
          job.progress.update(transferredBytes, phase);
          job.status = phase === 'verifying' ? 'verifying' : 'running';
        },
      });
      job.status = 'completed';
      job.transferred = job.bytes;
      delete job.message;
      try { await this.files.audit(job, 'success'); } catch { job.message = '下载完成，但记录审计失败。'; }
    } catch (error) {
      if (!['cancelled','error'].includes(job.status)) {
        job.status = signal.aborted ? 'cancelled' : 'error';
        job.message = signal.aborted ? '下载已取消。' : toPublicError(error).message;
      }
      await this.files.audit(job, job.status).catch(() => undefined);
    } finally {
      job.inFlight = false;
      delete job.destination;
      delete job.expected;
    }
  }
}
