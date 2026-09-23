import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.mjs';

const PAGE_SIZE = 200;
const MAX_DIRECTORIES = 32;
const MAX_ENTRIES = 20_000;
const entryNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function compareSnapshotEntries(left, right) {
  const directoryOrder = Number(right.type === 'directory') - Number(left.type === 'directory');
  return directoryOrder || entryNames.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
const cancelled = () => new AppError('WORKSPACE_READ_CANCELLED', '目录读取已取消。');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };

// 每个调用者独立取消；共享操作只有最后一个等待者退出时才中止。
function consume(read, signal) {
  read.users += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort);
      read.users -= 1;
      if (!read.users && !read.settled) read.cancel();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(cancelled());
    signal?.addEventListener('abort', abort, { once:true });
    read.promise.then(value => finish(null, value), error => finish(error));
    if (signal?.aborted) abort();
  });
}

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

  session(item, plugin, operation, { onError, onUnused, onSettled } = {}) {
    this.assertCurrent(item);
    const controller = new AbortController();
    const read = { users:0, settled:false, promise:null, cancel:() => { onUnused?.(); controller.abort(); } };
    item.controllers.add(controller);
    read.promise = Promise.resolve().then(() => {
      checkSignal(controller.signal);
      return this.files.serverRuntime.withWorkspaceReadSession(plugin, reader => {
        // 即使适配器迟到返回，也不能让已取消的链接查询继续写入共享快照。
        const guarded = Object.fromEntries(['statPath','listDirectoryEntries'].map(name => [name, async (...args) => {
          checkSignal(controller.signal);
          const value = await reader[name](...args);
          checkSignal(controller.signal);
          return value;
        }]));
        return operation({ ...guarded, signal:controller.signal });
      }, { signal:controller.signal });
    }).catch(error => { onError?.(error); throw error; }).finally(() => {
      read.settled = true; item.controllers.delete(controller); onSettled?.();
    });
    // 最后一个等待者可先取消；仍接收底层操作的迟到失败，避免未处理拒绝。
    read.promise.catch(() => {});
    return read;
  }

  async validatePath(item, plugin, reader) {
    this.assertCurrent(item);
    const target = await this.files.resolvePath(plugin, item.path, 'directory', (value) => reader.statPath(value));
    checkSignal(reader.signal);
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
          checkSignal(reader.signal);
          Object.assign(entry, { linkTarget: target.canonicalPath, linkTargetType: target.type });
        } catch (error) {
          if (!['PATH_INVALID', 'SOURCE_NOT_FOUND'].includes(error.code)) throw error;
          entry.linkTargetType = 'unavailable';
        }
      }
    }));
  }

  async list(ownerId, payload, plugin, binding, { signal } = {}) {
    checkSignal(signal);
    const offset = Number(payload.cursor ?? 0);
    let item;
    const fresh = !payload.snapshotId;
    if (payload.snapshotId) {
      item = this.snapshots.get(payload.snapshotId);
      if (!item || item.ownerId !== ownerId || item.path !== payload.path || !sameBinding(item.binding, binding)) throw expired();
      this.snapshots.delete(item.id);
      this.snapshots.set(item.id, item);
    } else {
      // 同一路径的并发首次读取共享扫描及前后校验；明确刷新会替换已完成的快照。
      item = [...this.snapshots.values()].find((value) => value.ownerId === ownerId && value.path === payload.path && sameBinding(value.binding, binding) && !value.entries);
      if (!item) {
        this.clear((value) => value.ownerId === ownerId && value.path === payload.path && sameBinding(value.binding, binding));
        item = { id: crypto.randomUUID(), ownerId, binding, path: payload.path, controllers: new Set(), metadata: new Map() };
        this.snapshots.set(item.id, item);
        this.trim(item);
        item.ready = this.session(item, plugin, async (reader) => {
          item.canonicalPath = await this.validatePath(item, plugin, reader);
          let validated = false;
          const result = await reader.listDirectoryEntries(item.canonicalPath, { afterRead: async () => {
            await this.validatePath(item, plugin, reader);
            validated = true;
          } });
          // 不支持重叠收尾的读取适配器仍执行原有复核，不能因忽略回调而跳过校验。
          if (!validated) await this.validatePath(item, plugin, reader);
          await this.files.requirePlugin(ownerId, payload, binding);
          this.assertCurrent(item);
          // 分页前固定普通目录优先的快照顺序；链接补齐后不重排，避免偏移游标漏项或重复。
          item.entries = result.entries.filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..' && !/[\/\\\0]/u.test(entry.name))
            .slice(0, 10_000).sort(compareSnapshotEntries)
            .map((entry) => ({ ...entry, path: path.posix.join(item.path, entry.name) }));
          item.truncated = result.truncated;
          this.trim(item);
        }, { onError:() => this.clear(value => value === item), onUnused:() => this.clear(value => value === item) });
      }
    }
    await consume(item.ready, signal);
    checkSignal(signal);
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
        }, {
          onUnused:() => { if (item.metadata.get(key) === pending) item.metadata.delete(key); },
          onSettled:() => { if (item.metadata.get(key) === pending) item.metadata.delete(key); },
        });
        item.metadata.set(key, pending);
      }
      await consume(pending, signal);
      checkSignal(signal);
    }
    this.assertCurrent(item);
    return this.page(item, offset);
  }
}
