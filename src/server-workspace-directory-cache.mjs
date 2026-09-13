import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.mjs';

const PAGE_SIZE = 200;
const MAX_DIRECTORIES = 32;
const MAX_ENTRIES = 20_000;
const expired = () => new AppError('WORKSPACE_DIRECTORY_EXPIRED', '目录缓存已更新，请重新读取。');
const sameBinding = (left, right) => left.revision === right.revision && left.generation === right.generation && left.epoch === right.epoch
  && ['projectId', 'environmentId', 'pluginInstanceId'].every((key) => left.scope[key] === right.scope[key]);

// 仅缓存人工工作区目录；不改变 Agent 的读取策略，也不长期占用空闲 SFTP 通道。
export class ServerWorkspaceDirectoryCache {
  constructor(files) { this.files = files; this.snapshots = new Map(); }

  clear(predicate) {
    for (const [id, item] of this.snapshots) if (predicate(item)) {
      this.snapshots.delete(id);
      for (const controller of item.controllers) controller.abort();
    }
  }

  assertCurrent(item) {
    if (this.snapshots.get(item.id) !== item) throw expired();
  }

  trim(protectedItem) {
    while (this.snapshots.size > MAX_DIRECTORIES || [...this.snapshots.values()].reduce((sum, item) => sum + (item.entries?.length ?? 0), 0) > MAX_ENTRIES) {
      const oldest = [...this.snapshots.values()].find((item) => item !== protectedItem);
      if (!oldest) break;
      this.clear((item) => item === oldest);
    }
  }

  async session(item, plugin, operation) {
    this.assertCurrent(item);
    const controller = new AbortController();
    item.controllers.add(controller);
    try {
      return await this.files.serverRuntime.withWorkspaceReadSession(plugin, operation, { signal: controller.signal });
    } finally { item.controllers.delete(controller); }
  }

  async validatePath(item, plugin, reader) {
    this.assertCurrent(item);
    const target = await this.files.resolvePath(plugin, item.path, 'directory', (value) => reader.statPath(value));
    if (item.canonicalPath && target.canonicalPath !== item.canonicalPath) {
      this.clear((value) => value === item);
      throw new AppError('WORKSPACE_PATH_CHANGED', '目录链接目标已变化，请刷新后重试。');
    }
    return target.canonicalPath;
  }

  page(item, offset) {
    const entries = item.entries.slice(offset, offset + PAGE_SIZE).map((entry) => ({ ...entry }));
    const more = offset + PAGE_SIZE < item.entries.length;
    return { path: item.path, canonicalPath: item.canonicalPath, snapshotId: item.id, entries,
      nextCursor: more ? String(offset + PAGE_SIZE) : null, truncated: more || item.truncated,
      metadataPending: entries.some((entry) => entry.type === 'symlink' && !entry.linkTargetType) };
  }

  async resolveLinks(item, plugin, reader, offset) {
    const links = item.entries.slice(offset, offset + PAGE_SIZE).filter((entry) => entry.type === 'symlink' && !entry.linkTargetType);
    let next = 0;
    // 使用同一通道并限制并发，只处理当前页；普通文件不会产生逐项 STAT。
    await Promise.all(Array.from({ length: Math.min(8, links.length) }, async () => {
      for (;;) {
        const entry = links[next++];
        if (!entry) return;
        this.assertCurrent(item);
        try {
          const target = await this.files.resolvePath(plugin, entry.path, null, (value) => reader.statPath(value));
          Object.assign(entry, { linkTarget: target.canonicalPath, linkTargetType: target.type });
        } catch (error) {
          if (!['PATH_INVALID', 'SOURCE_NOT_FOUND'].includes(error.code)) throw error;
          entry.linkTargetType = 'unavailable';
        }
      }
    }));
  }

  async list(ownerId, payload, plugin, binding) {
    const offset = Number(payload.cursor ?? 0);
    let item;
    let fresh = false;
    if (payload.snapshotId) {
      item = this.snapshots.get(payload.snapshotId);
      if (!item || item.ownerId !== ownerId || item.path !== payload.path || !sameBinding(item.binding, binding)) throw expired();
      this.snapshots.delete(item.id);
      this.snapshots.set(item.id, item);
    } else {
      // 同一路径的并发首次读取合并；明确刷新会替换已完成的快照。
      item = [...this.snapshots.values()].find((value) => value.ownerId === ownerId && value.path === payload.path && sameBinding(value.binding, binding) && !value.entries);
      if (!item) {
        this.clear((value) => value.ownerId === ownerId && value.path === payload.path && sameBinding(value.binding, binding));
        item = { id: crypto.randomUUID(), ownerId, binding, path: payload.path, controllers: new Set(), metadata: new Map() };
        this.snapshots.set(item.id, item);
        this.trim(item);
        fresh = true;
        item.ready = this.session(item, plugin, async (reader) => {
          item.canonicalPath = await this.validatePath(item, plugin, reader);
          const result = await reader.listDirectoryEntries(item.canonicalPath);
          await this.validatePath(item, plugin, reader);
          await this.files.requirePlugin(ownerId, payload, binding);
          this.assertCurrent(item);
          item.entries = result.entries.filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..' && !/[\/\\\0]/u.test(entry.name))
            .slice(0, 10_000).sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => ({ ...entry, path: path.posix.join(item.path, entry.name) }));
          item.truncated = result.truncated;
          this.trim(item);
        }).catch((error) => { this.clear((value) => value === item); throw error; });
      }
    }
    await item.ready;
    this.assertCurrent(item);
    const needsMetadata = (payload.resolveLinks || !payload.deferLinks) && this.page(item, offset).metadataPending;
    if (needsMetadata || !fresh) {
      // 元数据请求按页合并；分页只校验目录路径，不再次枚举目录。
      const key = (needsMetadata ? 'links:' : 'page:') + offset;
      let pending = item.metadata.get(key);
      if (!pending) {
        pending = this.session(item, plugin, async (reader) => {
          await this.validatePath(item, plugin, reader);
          if (needsMetadata) {
            await this.resolveLinks(item, plugin, reader, offset);
            await this.validatePath(item, plugin, reader);
          }
        }).finally(() => item.metadata.delete(key));
        item.metadata.set(key, pending);
      }
      await pending;
    }
    this.assertCurrent(item);
    return this.page(item, offset);
  }
}
