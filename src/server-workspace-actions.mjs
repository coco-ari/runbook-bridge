import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.mjs';

const matchesScope = (item, scope) => ['projectId', 'environmentId', 'pluginInstanceId'].every(key => item.scope[key] === scope[key]);
const invalid = () => new AppError('WORKSPACE_ACTION_EXPIRED', '文件操作确认已失效，请重新操作。');

export function workspaceEntryName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/u.test(value) || Buffer.byteLength(value) > 255) {
    throw new AppError('INVALID_ARGUMENT', '名称不能为空，不能包含斜杠、控制字符，且不能超过 255 字节。');
  }
  return value;
}

export class ServerWorkspaceActions {
  constructor(files) { this.files = files; this.records = new Map(); this.executions = new Set(); }

  clear(predicate) {
    for (const [id, item] of this.records) if (predicate(item)) { this.records.delete(id); item.controller.abort(invalid()); }
    for (const item of this.executions) if (predicate(item)) item.controller.abort(invalid());
  }

  async info(ownerId, payload) {
    const selectedPath = this.files.normalizeUploadPath(payload.path);
    return this.files.read(ownerId, payload, plugin => this.files.withPathReader(plugin, async stat => {
      const entry = await stat(selectedPath);
      let linkTargetType;
      if (entry.type === 'symlink') {
        try { linkTargetType = (await this.files.resolvePath(plugin, selectedPath, null, stat)).type; }
        catch (error) {
          if (!['PATH_INVALID', 'SOURCE_NOT_FOUND'].includes(error.code)) throw error;
          linkTargetType = 'unavailable';
        }
      }
      return { path: selectedPath, name: path.posix.basename(selectedPath) || '/', type: entry.type,
        size: entry.size, mtime: entry.mtime, mode: entry.mode,
        canonicalPath: entry.canonicalPath, ...(entry.type === 'symlink' ? { linkTarget: entry.canonicalPath, linkTargetType } : {}),
        observedAt: this.files.now() };
    }));
  }

  active(item) {
    item.controller.signal.throwIfAborted();
    if (this.records.get(item.operationId) !== item && !this.executions.has(item)) throw invalid();
  }

  async prepare(ownerId, payload) {
    if (!['mkdir', 'rename'].includes(payload.kind)) throw new AppError('INVALID_ARGUMENT', '文件操作类型无效。');
    const name = workspaceEntryName(payload.name);
    const selectedPath = this.files.normalizeUploadPath(payload.path);
    if (payload.kind === 'rename' && selectedPath === '/') throw new AppError('PATH_INVALID', '不能重命名根目录。');
    const binding = await this.files.requirePlugin(ownerId, payload);
    if ([...this.executions].some(item => item.ownerId === ownerId)) throw new AppError('WORKSPACE_BUSY', '正在执行文件操作，请稍候。');
    this.clear(item => item.ownerId === ownerId || item.expiresAt <= this.files.now());
    const item = { ...binding, ownerId, operationId: crypto.randomUUID(), controller: new AbortController(),
      kind: payload.kind, selectedPath, name, expiresAt: this.files.now() + 5 * 60 * 1000 };
    this.records.set(item.operationId, item);
    try {
      await this.files.withPathReader(binding.plugin, async stat => {
        const parentPath = item.kind === 'mkdir' ? selectedPath : path.posix.dirname(selectedPath);
        const parent = await this.files.resolvePath(binding.plugin, parentPath, 'directory', stat);
        this.active(item);
        const destinationPath = path.posix.join(parent.canonicalPath, name);
        if (destinationPath.length > 4096) throw new AppError('PATH_INVALID', '目标路径过长。');
        const destination = await this.files.serverOperations.remoteSnapshot(binding.plugin, destinationPath, stat);
        if (destination.exists) throw new AppError('TARGET_EXISTS', '同名文件或文件夹已存在，请使用其他名称。');
        let sourcePath, source;
        if (item.kind === 'rename') {
          sourcePath = path.posix.join(parent.canonicalPath, path.posix.basename(selectedPath));
          source = await this.files.serverOperations.remoteSnapshot(binding.plugin, sourcePath, stat);
          if (!source.exists) throw new AppError('SOURCE_NOT_FOUND', '待重命名的文件或文件夹已不存在。');
          if (!['file', 'directory'].includes(source.type) || source.canonicalPath !== sourcePath) throw new AppError('PATH_INVALID', '首版只支持普通文件和文件夹重命名，请使用实际路径操作链接。');
        }
        const after = await this.files.resolvePath(binding.plugin, parentPath, 'directory', stat);
        if (after.canonicalPath !== parent.canonicalPath) throw new AppError('WORKSPACE_PATH_CHANGED', '目录链接目标已变化，请重新操作。');
        item.parentPath = parentPath;
        item.destinationPath = destinationPath;
        item.logicalDestination = path.posix.join(parentPath, name);
        item.args = { kind: item.kind, parentPath, canonicalParent: parent.canonicalPath, destinationPath,
          ...(sourcePath ? { sourcePath } : {}), precondition: { destination, ...(source ? { source } : {}) } };
      }, { signal: item.controller.signal });
      await this.files.requirePlugin(ownerId, payload, binding);
      this.active(item);
      return { operationId: item.operationId, kind: item.kind, path: selectedPath, destinationPath: item.logicalDestination,
        canonicalDestination: item.destinationPath, expiresAt: item.expiresAt };
    } catch (error) { this.records.delete(item.operationId); item.controller.abort(error); throw error; }
  }

  get(ownerId, payload) {
    this.files.ownerEpoch(ownerId);
    const item = this.records.get(payload.operationId);
    if (!item || item.ownerId !== ownerId || !matchesScope(item, payload)) throw invalid();
    return item;
  }

  cancel(ownerId, payload) {
    const item = this.get(ownerId, payload);
    this.clear(value => value === item);
    return {};
  }

  async confirm(ownerId, payload) {
    const item = this.get(ownerId, payload);
    if (!item.args || item.expiresAt <= this.files.now()) { this.clear(value => value === item); throw invalid(); }
    // 在任何异步工作之前消耗凭证，实际参数和前置条件始终来自主进程。
    this.records.delete(item.operationId);
    this.executions.add(item);
    const audit = result => this.files.workspaceStore.appendAudit(item.scope.projectId, {
      ...item.scope, pluginType: 'server', source: 'desktop-human', type: 'desktop-file-action', result,
      operation: { kind: item.kind, path: item.selectedPath, destinationPath: item.logicalDestination },
    });
    try {
      const binding = await this.files.requirePlugin(ownerId, payload, item);
      this.active(item);
      await audit('started');
      await this.files.serverRuntime.mutateWorkspacePath(binding.plugin, item.args, {
        signal: item.controller.signal,
        beforeCommit: async () => { await this.files.requirePlugin(ownerId, payload, item); this.active(item); },
      });
      this.files.directoryCache.clear(value => matchesScope(item, value.binding.scope));
      await audit('completed');
      return { kind: item.kind, path: item.selectedPath, destinationPath: item.logicalDestination, parentPath: item.parentPath };
    } catch (error) {
      await audit('error').catch(() => {});
      throw error;
    } finally { this.executions.delete(item); }
  }
}
