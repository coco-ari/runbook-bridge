import crypto from 'node:crypto';
import path from 'node:path';
import { AppError, toPublicError } from './errors.mjs';
import { ServerWorkspaceDownloads } from './server-workspace-downloads.mjs';
import { ServerUploadResumes } from './server-upload-resumes.mjs';
import { recoverableUpload } from './server-upload-transfer.mjs';
import { ServerUploadReviews } from './server-upload-reviews.mjs';
import { ServerUploadProgress } from './server-upload-progress.mjs';
import { ServerWorkspaceDirectoryCache } from './server-workspace-directory-cache.mjs';

const PREPARATION_TTL = 5 * 60 * 1000;
const ACTIVE = new Set(['queued', 'running', 'verifying', 'pausing']);
const ENDED = new Set(['completed', 'cancelled', 'error']);
const SCOPE_FIELDS = ['projectId', 'environmentId', 'pluginInstanceId'];

function scopeOf(input) {
  if (!input || typeof input !== 'object' || SCOPE_FIELDS.some((key) => typeof input[key] !== 'string' || !input[key] || input[key].length > 200 || /[\\/\0]/u.test(input[key]))) {
    throw new AppError('INVALID_ARGUMENT', '服务器工作区作用域无效。');
  }
  return Object.fromEntries(SCOPE_FIELDS.map((key) => [key, input[key]]));
}
function includesScope(full, partial) { return SCOPE_FIELDS.every((key) => !partial[key] || full[key] === partial[key]); }
function sameScope(left, right) { return SCOPE_FIELDS.every((key) => left[key] === right[key]); }
function remotePath(input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.length > 4096 || /[\0\r\n\\]/u.test(input)) {
    throw new AppError('PATH_INVALID', '请输入有效的服务器绝对路径。');
  }
  return path.posix.normalize(input);
}
function publicJob(job) {
  return { direction: job.direction ?? 'upload', ...(job.localPath ? {localPath:job.localPath} : {}), canRemove: ENDED.has(job.status) && !job.inFlight, canPause: job.direction !== 'download' && ['queued', 'running'].includes(job.status) && job.checkpoint?.phase !== 'committing' && Boolean(job.plugin.target?.hostKeyFingerprint), jobId: job.jobId, name: job.name, path: job.path, bytes: job.bytes, transferred: job.transferred, status: job.status, ...(['interrupted', 'paused'].includes(job.status) ? { canResume: !job.inFlight, resumeBytes: job.checkpoint?.bytes ?? 0 } : {}), ...(ACTIVE.has(job.status) ? job.progress?.snapshot(job.transferred, job.bytes) : {}), ...(job.message ? { message: job.message } : {}) };
}

// 人工上传使用独立的一次性预检凭证，完整参数只保留在主进程内存。
export class ServerWorkspaceFiles {
  constructor({ workspaceStore, serverRuntime, serverOperations, now = Date.now }) {
    Object.assign(this, { workspaceStore, serverRuntime, serverOperations, now });
    this.directoryCache = new ServerWorkspaceDirectoryCache(this);
    this.preparations = new Map();
    this.uploadReviews = new ServerUploadReviews(this);
    this.uploadResumes = new ServerUploadResumes(this);
    this.jobs = new Map();
    this.downloads = new ServerWorkspaceDownloads(this);
    this.ownerEpochs = new Map();
    this.readCounts = new Map();
    this.preparing = new Set();
    this.running = 0;
    this.disposed = false;
    this.onLifecycle = (event) => {
      if (['lost', 'disconnected'].includes(event.type)) this.interruptScope(event);
    };
    serverRuntime.on?.('lifecycle', this.onLifecycle);
  }

  ownerEpoch(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId.startsWith('renderer:') || this.disposed) throw new AppError('WORKSPACE_UNAVAILABLE', '工作区已经关闭。');
    return this.ownerEpochs.get(ownerId) ?? 0;
  }

  async requirePlugin(ownerId, payload, expected = null) {
    const epoch = this.ownerEpoch(ownerId);
    const scope = scopeOf(payload);
    const plugin = await this.workspaceStore.getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId);
    if (!sameScope(plugin, scope) || plugin.pluginType !== 'server' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', '请选择配置完整的服务器。');
    const status = this.serverRuntime.status(plugin);
    if (!status?.connected || status.connecting) throw new AppError('NOT_CONNECTED', '请先连接服务器。');
    if (this.disposed || this.ownerEpoch(ownerId) !== epoch) throw new AppError('WORKSPACE_UNAVAILABLE', '工作区已经关闭。');
    if (expected && (expected.revision !== plugin.revision || expected.generation !== status.generation || expected.epoch !== epoch)) {
      throw new AppError('WORKSPACE_CHANGED', '服务器配置或连接已经变化，请重新选择文件并确认。');
    }
    return { plugin, scope, revision: plugin.revision, generation: status.generation, epoch };
  }

  async read(ownerId, payload, operation) {
    const count = this.readCounts.get(ownerId) ?? 0;
    if (count >= 4) throw new AppError('WORKSPACE_BUSY', '文件读取较多，请稍后重试。');
    this.readCounts.set(ownerId, count + 1);
    try {
      const binding = await this.requirePlugin(ownerId, payload);
      const value = await operation(binding.plugin, binding);
      await this.requirePlugin(ownerId, payload, binding);
      return value;
    } finally {
      const next = (this.readCounts.get(ownerId) ?? 1) - 1;
      if (next > 0) this.readCounts.set(ownerId, next);
      else this.readCounts.delete(ownerId);
    }
  }

  withPathReader(plugin, operation, options = {}) {
    if (this.serverRuntime.withRemoteReadSession) return this.serverRuntime.withRemoteReadSession(plugin, (reader) => operation((target) => reader.statPath(target)), options);
    return operation((target) => this.serverRuntime.statRemotePath(plugin, target));
  }

  async resolvePath(plugin, selectedPath, type, stat = (target) => this.serverRuntime.statRemotePath(plugin, target)) {
    const source = await stat(selectedPath);
    if (typeof source.canonicalPath !== 'string') throw new AppError('PATH_INVALID', '路径无法解析，链接可能已失效或形成循环。');
    const canonicalPath = remotePath(source.canonicalPath);
    const target = canonicalPath === selectedPath ? source : await stat(canonicalPath);
    if (target.canonicalPath !== canonicalPath || !['file', 'directory', 'special'].includes(target.type) || (type && target.type !== type)) {
      throw new AppError('PATH_INVALID', '链接目标不可用，或目标不是所需的普通文件或目录。');
    }
    return { ...target, canonicalPath };
  }

  listDirectory(ownerId, payload) {
    const selectedPath = remotePath(payload.path);
    if (payload.cursor != null && !/^\d{1,7}$/u.test(String(payload.cursor))) throw new AppError('INVALID_ARGUMENT', '目录分页位置无效。');
    if ((payload.deferLinks !== undefined && typeof payload.deferLinks !== 'boolean') || (payload.resolveLinks !== undefined && typeof payload.resolveLinks !== 'boolean') || (payload.snapshotId !== undefined && (typeof payload.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/u.test(payload.snapshotId))) || (payload.resolveLinks && !payload.snapshotId)) throw new AppError('INVALID_ARGUMENT', '目录缓存参数无效。');
    if (this.serverRuntime.withWorkspaceReadSession) return this.read(ownerId, payload, (plugin, binding) => this.directoryCache.list(ownerId, { ...payload, path: selectedPath }, plugin, binding));
    return this.read(ownerId, payload, (plugin) => this.withPathReader(plugin, async (stat) => {
      const resolved = await this.resolvePath(plugin, selectedPath, 'directory', stat);
      const page = await this.serverOperations.listDirectory(plugin, { path: resolved.canonicalPath, cursor: payload.cursor, limit: 200 });
      const listed = page.entries.filter((entry) => entry.name !== '.' && entry.name !== '..');
      const entries = listed.map((entry) => ({ ...entry, path: path.posix.join(selectedPath, entry.name) }));
      let next = 0;
      // 链接元数据共用一个 SFTP 会话，最多四个并发；行标识始终使用浏览路径。
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= entries.length) return;
          if (entries[index].type !== 'symlink') continue;
          const original = listed[index];
          try {
            const target = await this.resolvePath(plugin, original.path, null, stat);
            Object.assign(entries[index], { linkTarget: target.canonicalPath, linkTargetType: target.type });
          } catch {
            Object.assign(entries[index], { linkTargetType: 'unavailable' });
          }
        }
      }));
      const after = await this.resolvePath(plugin, selectedPath, 'directory', stat);
      if (after.canonicalPath !== resolved.canonicalPath) throw new AppError('WORKSPACE_PATH_CHANGED', '目录链接目标已变化，请刷新后重试。');
      return { ...page, path: selectedPath, canonicalPath: resolved.canonicalPath, entries };
    }));
  }

  async assertPath(plugin, selectedPath, type, readStat = (target) => this.serverRuntime.statRemotePath(plugin, target)) {
    const stat = await readStat(selectedPath);
    if (stat.type !== type || stat.canonicalPath !== selectedPath) {
      throw new AppError('PATH_INVALID', '仅支持普通文件和目录，请使用不含符号链接的完整路径。');
    }
    return stat;
  }

  readFile(ownerId, payload) {
    const selectedPath = remotePath(payload.path);
    return this.read(ownerId, payload, (plugin) => this.withPathReader(plugin, async (stat) => {
      const resolved = await this.resolvePath(plugin, selectedPath, 'file', stat);
      const result = await this.serverOperations.readFile(plugin, { path: resolved.canonicalPath, maxBytes: 262_144 });
      const after = await this.resolvePath(plugin, selectedPath, 'file', stat);
      if (after.canonicalPath !== resolved.canonicalPath) throw new AppError('WORKSPACE_PATH_CHANGED', '文件链接目标已变化，请重新打开。');
      return { ...result, path: selectedPath, canonicalPath: resolved.canonicalPath };
    }));
  }

  normalizeUploadPath(input) { return remotePath(input); }

  async assertUploadDirectory(plugin, directory, options = {}) {
    return this.withPathReader(plugin, async stat => {
      const resolved = await this.resolvePath(plugin, directory.path, 'directory', stat);
      if (resolved.canonicalPath !== directory.canonicalPath) throw new AppError('WORKSPACE_PATH_CHANGED', '上传目录链接目标已变化，请重新选择文件并确认。');
      await this.assertPath(plugin, directory.canonicalPath, 'directory', stat);
    }, options);
  }

  prepareUploadResume(ownerId, payload) { return this.uploadResumes.prepare(ownerId, payload); }

  beginUploadReview(ownerId, payload, paths) { return this.uploadReviews.start(ownerId, payload, paths); }
  readUploadReview(ownerId, payload) { return this.uploadReviews.read(ownerId, payload); }
  reviseUploadReview(ownerId, payload) { return this.uploadReviews.revise(ownerId, payload); }
  cancelUploadReview(ownerId, payload) { return this.uploadReviews.cancel(ownerId, payload); }

  async prepareUpload(ownerId, payload, localPaths, previous = null, options = {}) {
    if (!Array.isArray(localPaths) || !localPaths.length || localPaths.length > 20) throw new AppError('INVALID_ARGUMENT', '每次请选择 1 至 20 个普通文件。');
    if (this.preparing.has(ownerId)) throw new AppError('WORKSPACE_BUSY', '正在校验上一批文件，请稍候。');
    this.preparing.add(ownerId);
    try {
      options.ensureActive?.();
      const binding = await this.requirePlugin(ownerId, payload, previous ?? options.binding);
      const sourcePath = remotePath(payload.path);
      const resolved = options.directory ? { canonicalPath: options.directory } : await this.resolvePath(binding.plugin, sourcePath, 'directory');
      const directory = resolved.canonicalPath;
      if (previous && directory !== previous.path) throw new AppError('WORKSPACE_PATH_CHANGED', '上传目录链接目标已变化，请重新选择文件并确认。');
      const uploadDirectory = { path: sourcePath, canonicalPath: directory };
      for (const [id, item] of this.preparations) {
        if (item.expiresAt <= this.now() || (item.ownerId === ownerId && item !== previous)) this.preparations.delete(id);
      }
      const names = new Set();
      const files = [];
      let hashedBytes = 0;
      for (const source of localPaths) {
        if (typeof source !== 'string' || !path.isAbsolute(source)) throw new AppError('PATH_INVALID', '本地文件路径无效。');
        const name = path.basename(source);
        if (!name || /[\0\r\n\\/]/u.test(name) || names.has(name)) throw new AppError('INVALID_ARGUMENT', '文件名无效，或同一批次中存在同名文件。');
        names.add(name);
        options.ensureActive?.();
        const args = await this.serverOperations.prepareMutation(binding.plugin, 'fs.upload', {
          localPath: source, remotePath: path.posix.join(directory, name), overwrite: true,
        }, {
          signal: options.signal,
          onProgress: bytes => options.onProgress?.({ currentFile: name, hashedBytes: hashedBytes + bytes }),
          ...(options.snapshots ? { remoteSnapshot: async target => {
            if (!options.snapshots.has(target)) throw new AppError('UPLOAD_REVIEW_REQUIRED', '目标检查不完整，请重新检查文件。');
            return options.snapshots.get(target);
          } } : {}),
        });
        if (args._precondition.remote.exists && args._precondition.remote.type !== 'file') throw new AppError('PATH_INVALID', '目标同名路径不是普通文件，不能覆盖。');
        options.ensureActive?.();
        files.push({ name, args });
        hashedBytes += args._precondition.local.size;
        options.onProgress?.({ completedFiles: files.length, hashedBytes });
      }
      await this.requirePlugin(ownerId, payload, binding);
      await this.assertUploadDirectory(binding.plugin, uploadDirectory, { signal: options.signal });
      await this.requirePlugin(ownerId, payload, binding);
      if (previous && ![...this.preparations.values()].includes(previous)) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '上传选择已失效，请重新选择文件。');
      if (previous && previous.expiresAt <= this.now()) throw new AppError('UPLOAD_CONFIRMATION_EXPIRED', '上传确认已过期，请重新选择文件。');
      for (const [id, item] of this.preparations) if (item.ownerId === ownerId) this.preparations.delete(id);
      options.ensureActive?.();
      const preparationId = crypto.randomUUID();
      const expiresAt = this.now() + PREPARATION_TTL;
      this.preparations.set(preparationId, { ...binding, ownerId, files, path: directory, uploadDirectory, expiresAt });
      return { preparationId, path: directory, sourcePath, expiresAt, files: files.map(({ name, args }) => ({
        name, localPath: args.localPath, bytes: args._precondition.local.size, remotePath: args.remotePath, exists: args._precondition.remote.exists,
      })) };
    } finally { this.preparing.delete(ownerId); }
  }

  async reviseUpload(ownerId, payload) {
    this.ownerEpoch(ownerId);
    const scope = scopeOf(payload);
    const selectedPath = remotePath(payload.path);
    const preparation = this.preparations.get(payload.preparationId);
    if (!preparation || preparation.ownerId !== ownerId || !sameScope(preparation.scope, scope)) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '上传选择已失效，请重新选择文件。');
    if (preparation.expiresAt <= this.now()) {
      this.preparations.delete(payload.preparationId);
      throw new AppError('UPLOAD_CONFIRMATION_EXPIRED', '上传确认已过期，请重新选择文件。');
    }
    if (selectedPath !== preparation.uploadDirectory.path) throw new AppError('INVALID_ARGUMENT', '上传目标目录已固定，请取消后在目标目录重新选择文件。');
    if (!Array.isArray(payload.fileNames) || payload.fileNames.length > 20 || new Set(payload.fileNames).size !== payload.fileNames.length || payload.fileNames.some((name) => typeof name !== 'string' || !preparation.files.some((file) => file.name === name))) throw new AppError('INVALID_ARGUMENT', '只能保留本次已经选择的文件。');
    if (this.preparing.has(ownerId)) throw new AppError('WORKSPACE_BUSY', '正在校验上一批文件，请稍候。');
    // 修改开始即禁止旧确认；失败时仅保留文件选择供重试，不恢复旧的写入凭证。
    preparation.needsRevision = true;
    if (!payload.fileNames.length) {
      this.preparations.delete(payload.preparationId);
      return null;
    }
    const localPaths = payload.fileNames.map((name) => preparation.files.find((file) => file.name === name).args.localPath);
    return this.prepareUpload(ownerId, { ...scope, path: selectedPath }, localPaths, preparation);
  }

  async confirmUpload(ownerId, payload) {
    const scope = scopeOf(payload);
    const preparation = this.preparations.get(payload.preparationId);
    if (!preparation || preparation.ownerId !== ownerId || !sameScope(preparation.scope, scope)) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '上传确认已失效，请重新选择文件。');
    if (preparation.expiresAt <= this.now()) {
      this.preparations.delete(payload.preparationId);
      throw new AppError('UPLOAD_CONFIRMATION_EXPIRED', '上传确认已过期，请重新选择文件。');
    }
    if (preparation.needsRevision) throw new AppError('UPLOAD_REVIEW_REQUIRED', '上传选择已经修改，请重新检查后确认。');
    if (typeof payload.overwrite !== 'boolean' || (preparation.files.some(({ args }) => args._precondition.remote.exists) && !payload.overwrite)) throw new AppError('TARGET_EXISTS', '请明确确认覆盖同名文件。');
    if ([...this.jobs.values()].filter((job) => job.ownerId === ownerId && !ENDED.has(job.status)).length + (preparation.resumeJobId ? 0 : preparation.files.length) > 40) throw new AppError('WORKSPACE_BUSY', '待上传文件过多，请等待当前传输完成。');
    // 在第一次异步操作前消耗凭证，避免重复点击并发使用同一确认。
    this.preparations.delete(payload.preparationId);
    const binding = await this.requirePlugin(ownerId, scope, preparation);
    await this.assertUploadDirectory(binding.plugin, preparation.uploadDirectory);
    await this.requirePlugin(ownerId, scope, binding);
    const jobs = preparation.resumeJobId ? [this.uploadResumes.confirm(ownerId, scope, preparation, binding)] : preparation.files.map(({ name, args }) => {
      const job = { ...binding, uploadDirectory: preparation.uploadDirectory, ownerId, jobId: crypto.randomUUID(), name, path: args.remotePath, bytes: args._precondition.local.size, transferred: 0, status: 'queued', progress: new ServerUploadProgress(this.now), args: { ...args, overwrite: payload.overwrite }, controller: new AbortController() };
      this.jobs.set(job.jobId, job);
      return job;
    });
    this.pruneJobs(ownerId);
    this.drain();
    return { jobs: jobs.map(publicJob) };
  }

  pruneJobs(ownerId) {
    const finished = [...this.jobs.values()].filter((job) => job.ownerId === ownerId && ENDED.has(job.status) && !job.inFlight);
    for (const job of finished.slice(0, Math.max(0, finished.length - 40))) { this.uploadResumes.forget(job); this.jobs.delete(job.jobId); }
  }

  async audit(job, result) {
    await this.workspaceStore.appendAudit(job.scope.projectId, {
      ...job.scope, pluginType: 'server', type: job.direction === 'download' ? 'desktop-download' : 'desktop-upload', source: 'desktop-human', result, operation: { remotePath: job.path, bytes: job.bytes },
    });
  }

  drain() {
    if (this.disposed) return;
    for (const job of this.jobs.values()) {
      if (this.running >= 2) break;
      if (job.status !== 'queued') continue;
      job.status = 'running';
      job.inFlight = true;
      this.running += 1;
      void this.runJob(job).finally(() => { this.running -= 1; this.pruneJobs(job.ownerId); this.drain(); });
    }
  }

  async runJob(job) {
    if (job.direction === 'download') return this.downloads.run(job);
    const controller = job.controller;
    try {
      let binding = await this.requirePlugin(job.ownerId, job.scope, job);
      if (job.controller.signal.aborted) throw new AppError('TRANSFER_CANCELLED', '上传已取消。');
      await this.assertUploadDirectory(binding.plugin, job.uploadDirectory);
      await this.audit(job, 'started');
      binding = await this.requirePlugin(job.ownerId, job.scope, job);
      if (job.controller.signal.aborted) throw new AppError('TRANSFER_CANCELLED', '上传已取消。');
      await this.serverRuntime.uploadRemoteFile(binding.plugin, job.args.localPath, job.path, job.args._precondition, {
        signal: job.controller.signal, resumable: true, checkpoint: job.checkpoint,
        shouldPause: () => job.pauseRequested === true,
        onCheckpoint: value => { if (job.controller === controller && ACTIVE.has(job.status) && !controller.signal.aborted) job.checkpoint = { ...value }; },
        beforeCommit: async () => {
          const current = await this.requirePlugin(job.ownerId, job.scope, job);
          controller.signal.throwIfAborted();
          await this.assertUploadDirectory(current.plugin, job.uploadDirectory);
          await this.requirePlugin(job.ownerId, job.scope, job);
        },
        onProgress: ({ transferredBytes, phase }) => {
          if (job.controller !== controller || controller.signal.aborted || !ACTIVE.has(job.status)) return;
          job.transferred = Math.min(job.bytes, Math.max(job.transferred, Number(transferredBytes) || 0));
          job.progress.update(job.transferred, phase);
          job.status = job.pauseRequested ? 'pausing' : phase === 'verifying' ? 'verifying' : 'running';
        },
      });
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      job.status = 'completed';
      job.transferred = job.bytes;
      delete job.message;
      try { await this.audit(job, 'success'); } catch { job.message = '上传完成，但记录审计失败。'; }
    } catch (error) {
      if (job.status === 'pausing' && error?.code === 'UPLOAD_PAUSED' && !controller.signal.aborted) this.uploadResumes.pause(job);
      if (ACTIVE.has(job.status) && recoverableUpload(error, job.controller.signal)) this.uploadResumes.interrupt(job);
      if (!['paused', 'interrupted', 'cancelled', 'error'].includes(job.status)) {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
        job.message = job.controller.signal.aborted ? '上传已取消。' : toPublicError(error).message;
      }
      if (job.status === 'cancelled') job.message = '传输已取消，请刷新目录核对目标状态。';
      try { await this.audit(job, job.status); } catch { /* 失败信息只留在任务状态，避免记录远端内容。 */ }
    } finally {
      // 仅暂停和中断任务保留私有参数，旧操作退出前禁止启动新的续传。
      job.inFlight = false;
      if (!['paused', 'interrupted'].includes(job.status)) this.uploadResumes.forget(job);
    }
  }

  uploads(ownerId, payload) {
    this.ownerEpoch(ownerId);
    const scope = scopeOf(payload);
    return { jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId && sameScope(job.scope, scope)).map(publicJob) };
  }

  activeProjectTransfers(projectId) {
    return [...this.jobs.values()].some(job => job.scope?.projectId === projectId && (job.inFlight || ACTIVE.has(job.status)));
  }

  exitSummary() {
    let active = 0;
    let resumable = 0;
    for (const job of this.jobs.values()) {
      if (job.inFlight || ACTIVE.has(job.status)) active += 1;
      else if (['paused', 'interrupted'].includes(job.status)) resumable += 1;
    }
    return {active, resumable};
  }

  stopJob(job, status, message) {
    if (!ACTIVE.has(job.status) && !['interrupted', 'paused'].includes(job.status)) return;
    const idle = !job.inFlight;
    job.status = status;
    job.message = message;
    job.controller.abort(new AppError(status === 'cancelled' ? 'TRANSFER_CANCELLED' : 'WORKSPACE_CHANGED', message));
    if (!job.inFlight) this.uploadResumes.forget(job);
    if (idle) {
      delete job.args;
      void this.audit(job, status).catch(() => undefined);
    }
  }

  pauseUpload(ownerId, payload) {
    this.ownerEpoch(ownerId);
    const job = this.jobs.get(payload.jobId);
    if (!job || job.ownerId !== ownerId || !sameScope(job.scope, scopeOf(payload))) throw new AppError('UPLOAD_NOT_FOUND', '上传任务不存在。');
    if (job.status === 'pausing' || job.status === 'paused') return publicJob(job);
    if (!publicJob(job).canPause) throw new AppError('UPLOAD_PAUSE_UNAVAILABLE', '当前任务无法暂停，文件可能已进入最终校验。');
    if (job.status === 'queued') {
      this.uploadResumes.pause(job);
      void this.audit(job, 'paused').catch(() => undefined);
    } else {
      job.pauseRequested = true;
      job.status = 'pausing';
      job.message = '正在等待当前批次写入完成…';
    }
    return publicJob(job);
  }

  clearTransfers(ownerId, payload) {
    this.ownerEpoch(ownerId);
    const scope = scopeOf(payload);
    if (payload.jobId !== undefined && (typeof payload.jobId !== 'string' || !payload.jobId)) throw new AppError('INVALID_ARGUMENT', '任务标识无效。');
    const matching = [...this.jobs.values()].filter(job => job.ownerId === ownerId && sameScope(job.scope, scope) && (payload.jobId === undefined || job.jobId === payload.jobId));
    if (payload.jobId !== undefined && (!matching.length || !publicJob(matching[0]).canRemove)) throw new AppError('TRANSFER_BUSY', '仅能移除已经结束的传输记录。');
    const removedIds = [];
    for (const job of matching) if (publicJob(job).canRemove) {
      this.uploadResumes.forget(job);
      this.jobs.delete(job.jobId);
      removedIds.push(job.jobId);
    }
    return { removedIds };
  }

  cancelUpload(ownerId, payload) {
    this.ownerEpoch(ownerId);
    const scope = scopeOf(payload);
    const job = this.jobs.get(payload.jobId);
    if (!job || job.ownerId !== ownerId || !sameScope(job.scope, scope)) throw new AppError('UPLOAD_NOT_FOUND', '上传任务不存在。');
    this.stopJob(job, 'cancelled', job.status === 'queued' ? '已取消排队。' : '正在取消传输。');
    return publicJob(job);
  }

  interruptScope(scope) {
    this.uploadReviews.clear(item => includesScope(item.scope, scope));
    this.directoryCache.clear(item => includesScope(item.binding.scope, scope));
    for (const [id, item] of this.preparations) if (includesScope(item.scope, scope)) this.preparations.delete(id);
    for (const job of this.jobs.values()) if (includesScope(job.scope, scope)) this.uploadResumes.interrupt(job);
  }

  closeScope(scope, reason = '服务器配置或连接已经变化。') {
    this.uploadReviews.clear(item => includesScope(item.scope, scope));
    this.directoryCache.clear((item) => includesScope(item.binding.scope, scope));
    for (const [id, preparation] of this.preparations) if (includesScope(preparation.scope, scope)) this.preparations.delete(id);
    for (const job of this.jobs.values()) if (includesScope(job.scope, scope)) this.stopJob(job, 'error', reason);
  }

  closeOwner(ownerId) {
    this.uploadReviews.clear(item => item.ownerId === ownerId);
    this.directoryCache.clear((item) => item.ownerId === ownerId);
    this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1);
    for (const [id, preparation] of this.preparations) if (preparation.ownerId === ownerId) this.preparations.delete(id);
    for (const [id, job] of this.jobs) if (job.ownerId === ownerId) {
      this.stopJob(job, 'cancelled', '窗口已经关闭。');
      this.jobs.delete(id);
    }
  }

  dispose() {
    this.uploadReviews.clear(() => true);
    this.directoryCache.clear(() => true);
    this.disposed = true;
    this.serverRuntime.off?.('lifecycle', this.onLifecycle);
    for (const ownerId of new Set([...this.jobs.values(), ...this.preparations.values()].map((item) => item.ownerId))) this.closeOwner(ownerId);
  }
}