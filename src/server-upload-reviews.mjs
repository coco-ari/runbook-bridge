import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, toPublicError } from './errors.mjs';
import { planUploadFile, uploadDecisions } from './server-upload-conflicts.mjs';

const SCOPE_FIELDS = ['projectId', 'environmentId', 'pluginInstanceId'];
const CHECK_TIMEOUT = 10 * 60 * 1000;

// 预处理任务与上传凭证分开：显示清单不代表已获准写入服务器。
export class ServerUploadReviews {
  constructor(files) { this.files = files; this.records = new Map(); }

  get(ownerId, payload) {
    this.files.ownerEpoch(ownerId);
    const item = this.records.get(payload.reviewId);
    if (!item || item.ownerId !== ownerId || SCOPE_FIELDS.some(key => item.scope[key] !== payload[key])) {
      throw new AppError('UPLOAD_CONFIRMATION_INVALID', '文件检查已失效，请重新选择文件。');
    }
    return item;
  }

  active(item) {
    item.controller.signal.throwIfAborted();
    if (this.records.get(item.reviewId) !== item) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '文件检查已取消。');
  }

  snapshot(item) {
    return {
      reviewId: item.reviewId, status: item.status, path: item.path, sourcePath: item.sourcePath,
      files: item.publicFiles.map(file => ({ ...file })), progress: { ...item.progress },
      preparationId: item.preparationId ?? null, expiresAt: item.expiresAt ?? null,
      ...(item.error ? { error: item.error } : {}),
      ...(item.resume ? { resume: { ...item.resume } } : {}),
    };
  }

  stop(item) {
    clearTimeout(item.timer);
    item.controller.abort(new AppError('TRANSFER_CANCELLED', '文件检查已取消。'));
    if (item.preparationId) this.files.preparations.delete(item.preparationId);
    this.records.delete(item.reviewId);
  }

  fail(item, error) {
    clearTimeout(item.timer);
    item.error = toPublicError(error);
    item.status = 'error';
    item.controller.abort(error);
    if (item.preparationId) this.files.preparations.delete(item.preparationId);
    item.preparationId = null;
  }

  async start(ownerId, payload, paths, previous = null, decisions = {}) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 20) throw new AppError('INVALID_ARGUMENT', '每次请选择 1 至 20 个普通文件。');
    const binding = await this.files.requirePlugin(ownerId, payload, previous);
    const sourcePath = this.files.normalizeUploadPath(payload.path);
    const names = new Set();
    for (const source of paths) {
      const name = typeof source === 'string' ? path.basename(source) : '';
      if (!name || !path.isAbsolute(source) || /[\0\r\n\\/]/u.test(name) || names.has(name)) throw new AppError('INVALID_ARGUMENT', '文件名无效，或同一批次中存在同名文件。');
      names.add(name);
    }
    const predecessors = [...this.records.values()].filter(item => item.ownerId === ownerId);
    for (const item of predecessors) this.stop(item);
    const item = {
      ...binding, ownerId, reviewId: crypto.randomUUID(), sourcePath, path: previous?.path ?? sourcePath,
      expectedPath: previous?.canonicalPath ?? null, controller: new AbortController(), status: 'checking',
      paths: [...paths], decisions, publicFiles: [], progress: { phase: 'remote', completedFiles: 0, totalFiles: paths.length, hashedBytes: 0, totalBytes: 0 },
    };
    this.records.set(item.reviewId, item);
    item.timer = setTimeout(() => this.fail(item, new AppError('UPLOAD_PREPARATION_TIMEOUT', '文件检查超过 10 分钟，请重试或减少文件数量。')), CHECK_TIMEOUT);
    item.timer.unref?.();
    try {
      // 此阶段只读取文件元数据，不读取内容，也不等待网络。
      item.publicFiles = await Promise.all(paths.map(async localPath => {
        const stat = await fs.lstat(localPath).catch(() => { throw new AppError('PATH_INVALID', '本地上传文件不存在。'); });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('PATH_INVALID', '只能上传本地普通文件。');
        if (stat.size > 500 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '上传文件不能超过 500 MiB。');
        return { name: path.basename(localPath), localPath, bytes: stat.size, localMtimeMs: stat.mtimeMs, remotePath: path.posix.join(item.path, path.basename(localPath)), exists: null };
      }));
      item.progress.totalBytes = item.publicFiles.reduce((sum, file) => sum + file.bytes, 0);
      await this.files.requirePlugin(ownerId, payload, binding);
      this.active(item);
      // 先交付清单；旧检查退出后再开始新检查，避免争用同一窗口的预检锁。
      item.done = Promise.allSettled(predecessors.map(old => old.done))
        .then(() => new Promise(resolve => setImmediate(resolve)))
        .then(() => this.run(item));
      return this.snapshot(item);
    } catch (error) { this.stop(item); throw error; }
  }

  expireReady(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => this.fail(item, new AppError('UPLOAD_CONFIRMATION_EXPIRED', '上传确认已过期，请重新检查文件。')), Math.max(1, item.expiresAt - this.files.now()));
    item.timer.unref?.();
  }

  retainReady(item, names, prepared) {
    const selected = new Set(names);
    const publicFiles = item.publicFiles.filter(file => selected.has(file.name));
    const files = prepared.files.filter(file => selected.has(file.name));
    const totalBytes = publicFiles.reduce((sum, file) => sum + file.bytes, 0);
    const next = {
      ...item, reviewId: crypto.randomUUID(), preparationId: crypto.randomUUID(),
      controller: new AbortController(), done: Promise.resolve(),
      paths: publicFiles.map(file => file.localPath), publicFiles,
      progress: { phase: 'ready', completedFiles: files.length, totalFiles: files.length, hashedBytes: totalBytes, totalBytes },
    };
    // 删除只缩小已校验的参数集合；凭证原子替换，原过期时间和每个文件的前置条件保持不变。
    this.stop(item);
    this.files.preparations.set(next.preparationId, { ...prepared, files });
    this.records.set(next.reviewId, next);
    this.expireReady(next);
    return this.snapshot(next);
  }

  async run(item) {
    let prepared;
    try {
      this.active(item);
      const snapshots = new Map();
      const plans = new Map();
      const reserved = new Set(item.publicFiles.map(file => file.name));
      const binding = await this.files.requirePlugin(item.ownerId, item.scope, item);
      await this.files.withPathReader(binding.plugin, async stat => {
        this.active(item);
        const resolved = await this.files.resolvePath(binding.plugin, item.sourcePath, 'directory', stat);
        if (item.expectedPath && resolved.canonicalPath !== item.expectedPath) throw new AppError('WORKSPACE_PATH_CHANGED', '上传目录链接目标已变化，请重新选择文件并确认。');
        item.path = item.canonicalPath = resolved.canonicalPath;
        for (const file of item.publicFiles) {
          this.active(item);
          const plan = await planUploadFile(file, {
            action: Object.hasOwn(item.decisions, file.name) ? item.decisions[file.name] : undefined, directory: item.path, reserved,
            snapshot: target => this.files.serverOperations.remoteSnapshot(binding.plugin, target, stat),
          });
          plans.set(file.name, plan);
          snapshots.set(plan.remotePath, plan.target);
          item.progress.completedFiles += 1;
        }
      }, { signal: item.controller.signal });
      this.active(item);
      item.progress.phase = 'hashing';
      item.progress.completedFiles = 0;
      prepared = await this.files.prepareUpload(item.ownerId, { ...item.scope, path: item.sourcePath }, item.paths, null, {
        binding: item, signal: item.controller.signal, directory: item.path, snapshots, plans,
        ensureActive: () => this.active(item),
        onProgress: progress => Object.assign(item.progress, progress),
      });
      this.active(item);
      Object.assign(item, { preparationId: prepared.preparationId, expiresAt: prepared.expiresAt, publicFiles: item.publicFiles.map(file => prepared.files.find(next => next.name === file.name) ?? file), status: 'ready' });
      item.progress.phase = 'ready';
      this.expireReady(item);
    } catch (error) {
      if (prepared) this.files.preparations.delete(prepared.preparationId);
      if (this.records.get(item.reviewId) === item && item.status === 'checking') this.fail(item, error);
    }
  }

  async read(ownerId, payload) {
    const item = this.get(ownerId, payload);
    if (item.status !== 'error') {
      try { await this.files.requirePlugin(ownerId, payload, item); }
      catch (error) { this.fail(item, error); }
    }
    if (this.records.get(item.reviewId) !== item) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '文件检查已取消。');
    if (item.expiresAt && item.expiresAt <= this.files.now() && item.status === 'ready') this.fail(item, new AppError('UPLOAD_CONFIRMATION_EXPIRED', '上传确认已过期，请重新检查文件。'));
    return this.snapshot(item);
  }

  async revise(ownerId, payload) {
    const item = this.get(ownerId, payload);
    if (item.resume) throw new AppError('UPLOAD_RESUME_INVALID', '续传文件已固定，请取消后重新选择文件。');
    if (item.status === 'checking') throw new AppError('WORKSPACE_BUSY', '正在检查文件，请稍候或取消。');
    const names = payload.fileNames;
    if (!Array.isArray(names) || names.length > 20 || new Set(names).size !== names.length || names.some(name => !item.publicFiles.some(file => file.name === name))) throw new AppError('INVALID_ARGUMENT', '只能保留本次已经选择的文件。');
    const decisions = uploadDecisions(payload.decisions, names, item.decisions);
    if (!names.length) { this.stop(item); return null; }
    if (payload.decisions === undefined && item.status === 'ready' && names.length < item.publicFiles.length) {
      await this.files.requirePlugin(ownerId, payload, item);
      if (this.records.get(item.reviewId) !== item) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '文件选择已变化，请使用最新清单。');
      if (item.status === 'ready' && item.expiresAt > this.files.now()) {
        const prepared = this.files.preparations.get(item.preparationId);
        if (!prepared || prepared.needsRevision) throw new AppError('UPLOAD_CONFIRMATION_INVALID', '上传凭证已失效，请重新检查文件。');
        return this.retainReady(item, names, prepared);
      }
    }
    return this.start(ownerId, { ...item.scope, path: item.sourcePath }, names.map(name => item.publicFiles.find(file => file.name === name).localPath), item, decisions);
  }

  cancel(ownerId, payload) { this.stop(this.get(ownerId, payload)); return {}; }
  clear(predicate) { for (const item of this.records.values()) if (predicate(item)) this.stop(item); }
}
