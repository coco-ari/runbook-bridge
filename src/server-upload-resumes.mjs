import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { ServerUploadProgress } from './server-upload-progress.mjs';

const RESUME_TTL = 30 * 60 * 1000;
const MAX_RESUMES = 3;
const sameScope = (left, right) => ['projectId', 'environmentId', 'pluginInstanceId'].every(key => left[key] === right[key]);

// 只保存当前窗口内的任务；续传确认必须重新绑定当前连接，不能复用已消耗的凭证。
export class ServerUploadResumes {
  constructor(files) { this.files = files; }

  forget(job) {
    clearTimeout(job.resumeTimer);
    delete job.args;
    delete job.checkpoint;
  }

  interrupt(job) {
    if (!['queued', 'running', 'verifying'].includes(job.status)) return;
    if (!job.plugin.target?.hostKeyFingerprint || (job.resumeAttempts ?? 0) >= MAX_RESUMES) {
      this.files.stopJob(job, 'error', '上传已中断，请重新选择文件上传。');
      return;
    }
    const queued = job.status === 'queued';
    job.status = 'interrupted';
    job.message = '上传已中断，连接恢复后可在 30 分钟内继续。';
    job.resumeUntil = this.files.now() + RESUME_TTL;
    clearTimeout(job.resumeTimer);
    job.resumeTimer = setTimeout(() => {
      if (job.status === 'interrupted') this.files.stopJob(job, 'error', '续传记录已过期，请重新选择文件。');
    }, RESUME_TTL);
    job.resumeTimer.unref?.();
    job.controller.abort(new AppError('UPLOAD_CONNECTION_LOST', '上传连接已中断。'));
    if (queued) void this.files.audit(job, 'interrupted').catch(() => undefined);
  }

  get(ownerId, payload) {
    this.files.ownerEpoch(ownerId);
    const job = this.files.jobs.get(payload.jobId);
    if (!job || job.ownerId !== ownerId || !sameScope(job.scope, payload)) throw new AppError('UPLOAD_NOT_FOUND', '上传任务不存在。');
    if (job.status !== 'interrupted' || !job.args || job.inFlight || job.resumeUntil <= this.files.now() || (job.resumeAttempts ?? 0) >= MAX_RESUMES) {
      throw new AppError('UPLOAD_RESUME_UNAVAILABLE', '当前任务无法继续，请稍后重试或重新选择文件。');
    }
    return job;
  }

  async prepare(ownerId, payload) {
    const job = this.get(ownerId, payload);
    const binding = await this.files.requirePlugin(ownerId, payload);
    if (binding.revision !== job.revision || binding.epoch !== job.epoch
      || !binding.plugin.target?.hostKeyFingerprint || binding.plugin.target.hostKeyFingerprint !== job.plugin.target?.hostKeyFingerprint) {
      throw new AppError('WORKSPACE_CHANGED', '服务器配置已变化，请重新选择文件。');
    }
    await this.files.assertUploadDirectory(binding.plugin, job.uploadDirectory);
    await this.files.requirePlugin(ownerId, payload, binding);
    if (this.get(ownerId, payload) !== job) throw new AppError('UPLOAD_RESUME_UNAVAILABLE', '续传任务已变化。');
    this.files.uploadReviews.clear(item => item.ownerId === ownerId);
    for (const [id, item] of this.files.preparations) if (item.ownerId === ownerId) this.files.preparations.delete(id);
    const preparationId = crypto.randomUUID();
    const expiresAt = Math.min(job.resumeUntil, this.files.now() + 5 * 60 * 1000);
    const prepared = { ...binding, ownerId, files: [{name: job.name, args: job.args}], path: job.uploadDirectory.canonicalPath,
      uploadDirectory: job.uploadDirectory, expiresAt, resumeJobId: job.jobId, checkpoint: job.checkpoint };
    this.files.preparations.set(preparationId, prepared);
    const item = { ...binding, ownerId, reviewId: crypto.randomUUID(), status: 'ready', preparationId, expiresAt,
      controller: new AbortController(), path: prepared.path, sourcePath: job.uploadDirectory.path,
      resume: { jobId: job.jobId, bytes: job.checkpoint?.bytes ?? 0 },
      publicFiles: [{name: job.name, localPath: job.args.localPath, remotePath: job.path, bytes: job.bytes, exists: job.args._precondition.remote.exists}],
      progress: {phase:'ready', completedFiles:1, totalFiles:1, hashedBytes:job.bytes, totalBytes:job.bytes} };
    this.files.uploadReviews.records.set(item.reviewId, item);
    this.files.uploadReviews.expireReady(item);
    return this.files.uploadReviews.snapshot(item);
  }

  confirm(ownerId, scope, prepared, binding) {
    const job = this.get(ownerId, {...scope, jobId:prepared.resumeJobId});
    if (job.checkpoint !== prepared.checkpoint || job.revision !== binding.revision || job.epoch !== binding.epoch
      || job.plugin.target?.hostKeyFingerprint !== binding.plugin.target?.hostKeyFingerprint) {
      throw new AppError('UPLOAD_RESUME_UNAVAILABLE', '续传状态已变化，请重新确认。');
    }
    clearTimeout(job.resumeTimer);
    Object.assign(job, binding, {
      status: 'queued', controller: new AbortController(), progress: new ServerUploadProgress(this.files.now),
      transferred: job.checkpoint?.bytes ?? 0, resumeAttempts: (job.resumeAttempts ?? 0) + 1,
    });
    delete job.message;
    return job;
  }
}
