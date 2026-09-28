import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AppError, toPublicError } from './errors.mjs';
import { DESKTOP_DOWNLOAD_LIMIT, downloadDestination, assertDestination } from './server-download-transfer.mjs';
import { ServerUploadProgress } from './server-upload-progress.mjs';

const DOWNLOAD_ERROR_CODES = new Set([
  'TRANSFER_CANCELLED', 'TRANSFER_INTERRUPTED', 'TRANSFER_TIMEOUT', 'TRANSFER_FAILED', 'TRANSFER_INTEGRITY_FAILED',
  'SFTP_OPERATION_TIMEOUT', 'SFTP_UNAVAILABLE', 'NOT_CONNECTED', 'PLUGIN_RECONNECTING', 'WORKSPACE_CHANGED',
  'WORKSPACE_UNAVAILABLE', 'PLUGIN_CONFIG_INCOMPLETE', 'SOURCE_CHANGED', 'SOURCE_NOT_ALLOWED', 'FILE_TOO_LARGE',
  'SOURCE_NOT_FOUND', 'SOURCE_ACCESS_DENIED', 'DOWNLOAD_BUSY', 'DOWNLOAD_DISK_FULL', 'DOWNLOAD_ACCESS_DENIED', 'DOWNLOAD_FILE_BUSY', 'DOWNLOAD_SAVE_UNSUPPORTED',
  'DOWNLOAD_TARGET_CHANGED', 'DOWNLOAD_SAVE_FAILED',
]);
const DOWNLOAD_PHASES = new Set(['queue', 'preparing', 'transferring', 'verifying', 'committing']);

export class ServerWorkspaceDownloads {
  constructor(files) { this.files = files; }

  recordFailure(job, error) {
    if (job.errorCode) return;
    // 仅保留应用已知错误码和本地阶段，不记录远端错误正文或任意 details。
    job.errorCode = error instanceof AppError && DOWNLOAD_ERROR_CODES.has(error.code) ? error.code : 'DOWNLOAD_FAILED';
    job.failurePhase = DOWNLOAD_PHASES.has(job.transferPhase) ? job.transferPhase : 'queue';
  }

  auditDetails(job) {
    const queuedAt = job.queuedAt ?? this.files.now();
    return {
      ...(job.errorCode ? {errorCode:job.errorCode, failurePhase:job.failurePhase} : {}),
      transferredBytes:Math.max(0, Math.min(job.bytes, job.transferred)),
      queuedMs:Math.max(0, (job.transferStartedAt ?? this.files.now()) - queuedAt),
    };
  }

  ownedJob(ownerId, payload) {
    this.files.ownerEpoch(ownerId);
    const job = this.files.jobs.get(payload.jobId ?? payload.retryOf);
    if (!job || job.ownerId !== ownerId || job.direction !== 'download' || job.epoch !== this.files.ownerEpoch(ownerId)
      || !['projectId','environmentId','pluginInstanceId'].every(key => job.scope[key] === payload[key])) throw new AppError('DOWNLOAD_UNAVAILABLE', '下载记录已经失效，请重新选择文件。');
    return job;
  }

  async reveal(ownerId, payload) {
    const job = this.ownedJob(ownerId, payload);
    if (job.status !== 'completed' || job.inFlight || !job.localPath) throw new AppError('DOWNLOAD_UNAVAILABLE', '只能定位已完成的下载文件。');
    let stat;
    try { stat = await fs.lstat(job.localPath); } catch { throw new AppError('DOWNLOAD_UNAVAILABLE', '本地文件已移动或删除。'); }
    if (!stat.isFile() || stat.isSymbolicLink() || this.ownedJob(ownerId, payload) !== job) throw new AppError('DOWNLOAD_UNAVAILABLE', '本地文件已经变化。');
    return job.localPath;
  }

  async prepareRetry(ownerId, payload) {
    const job = this.ownedJob(ownerId, payload);
    if (!['cancelled','error'].includes(job.status) || job.inFlight) throw new AppError('DOWNLOAD_UNAVAILABLE', '请等待下载任务结束后重试。');
    const binding = await this.files.requirePlugin(ownerId, payload);
    if (binding.revision !== job.revision || this.ownedJob(ownerId, payload) !== job) throw new AppError('WORKSPACE_CHANGED', '服务器配置已变化，请从目录重新选择文件下载。');
    const prepared = await this.prepare(ownerId, {...payload, path:job.path});
    if (prepared.revision !== job.revision || this.ownedJob(ownerId, payload) !== job) throw new AppError('WORKSPACE_CHANGED', '下载记录已变化，请从目录重新下载。');
    let destination;
    if (job.retryDestination) {
      try {
        await assertDestination(job.retryDestination);
        destination = job.retryDestination;
      } catch (error) {
        if (!(error instanceof AppError) || !error.code.startsWith('DOWNLOAD_')) throw error;
        // 本地目标已变化或不可访问时，重新通过原生窗口确认保存位置。
      }
    }
    return {...prepared, suggestedPath:job.localPath, retryJob:job, destination};
  }

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
    const destination = selectedPath ? await downloadDestination(selectedPath) : prepared.destination;
    if (!destination) throw new AppError('DOWNLOAD_TARGET_CHANGED', '请重新选择下载位置。');
    await assertDestination(destination);
    await this.files.requirePlugin(ownerId, payload, binding);
    const {retryJob, suggestedPath, destination:previousDestination, ...source} = prepared;
    if (retryJob && (this.ownedJob(ownerId, payload) !== retryJob || retryJob.inFlight || !['cancelled','error'].includes(retryJob.status))) {
      throw new AppError('DOWNLOAD_UNAVAILABLE', '下载记录已变化，请等待当前任务结束后重试。');
    }
    if ([...this.files.jobs.values()].filter(job => job.ownerId === ownerId && !['completed','cancelled','error'].includes(job.status)).length >= 40) throw new AppError('WORKSPACE_BUSY', '传输任务过多，请等待当前任务完成。');
    // 重试保留任务 ID，重新创建控制器与进度，覆盖授权仍绑定原本地文件状态。
    const job = {...source, ...binding, direction:'download', destination, retryDestination:destination, localPath:destination.path,
      jobId:retryJob?.jobId ?? crypto.randomUUID(), bytes:prepared.expected.size, transferred:0, status:'queued',
      queuedAt:this.files.now(), transferPhase:'queue',
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
        onStart:async () => {
          await this.files.requirePlugin(job.ownerId, job.scope, job);
          signal.throwIfAborted();
          job.transferStartedAt = this.files.now();
          job.transferPhase = 'preparing';
          job.status = 'running';
        },
        beforeCommit:async () => {
          job.transferPhase = 'committing';
          await this.files.requirePlugin(job.ownerId, job.scope, job); signal.throwIfAborted();
        },
        onProgress:({transferredBytes, phase}) => {
          if (signal.aborted) return;
          job.transferred = transferredBytes;
          job.transferPhase = phase === 'verifying' ? 'verifying' : 'transferring';
          job.progress.update(transferredBytes, phase);
          job.status = phase === 'verifying' ? 'verifying' : 'running';
        },
      });
      job.status = 'completed';
      job.transferred = job.bytes;
      delete job.message;
      delete job.errorCode;
      delete job.failurePhase;
      try { await this.files.audit(job, 'success'); } catch { job.message = '下载完成，但记录审计失败。'; }
    } catch (error) {
      if (!['cancelled','error'].includes(job.status)) {
        job.status = signal.aborted ? 'cancelled' : 'error';
        job.message = signal.aborted ? '下载已取消。'
          : error?.code === 'TRANSFER_INTERRUPTED' ? '下载通道已中断；请检查连接，恢复后可点击“重新下载”，从头传输。'
          : toPublicError(error).message;
      }
      this.recordFailure(job, signal.aborted ? signal.reason : error);
      await this.files.audit(job, job.status).catch(() => undefined);
    } finally {
      job.inFlight = false;
      delete job.destination;
      delete job.expected;
    }
  }
}
