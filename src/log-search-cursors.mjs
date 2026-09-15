import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

export function logSearchBinding(plugin, args, generation) {
  const parameters = Object.fromEntries(Object.entries(args).filter(([key,value]) => key !== 'cursor' && value !== undefined).sort(([a],[b]) => a.localeCompare(b)));
  return crypto.createHash('sha256').update(JSON.stringify([
    plugin.projectId, plugin.environmentId, plugin.pluginInstanceId, plugin.revision,
    generation, parameters,
  ])).digest('hex');
}

// 游标只保存有界文件元数据，按原参数、会话和连接代次绑定，不保存日志正文。
export class LogSearchCursors {
  constructor({ now = Date.now, ttlMs = 5 * 60 * 1000, maxEntries = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
    Object.assign(this,{now,ttlMs,maxEntries,maxBytes});
    this.entries = new Map();
    this.bytes = 0;
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  prune() {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(id);
  }

  get(cursor, binding) {
    this.prune();
    if (typeof cursor !== 'string' || !/^[a-f0-9]{64}$/.test(cursor)) throw new AppError('INVALID_ARGUMENT','日志游标无效，请使用工具返回的 nextCursor。');
    const entry = this.entries.get(cursor);
    if (!entry) throw new AppError('LOG_CURSOR_EXPIRED','日志游标已过期或被淘汰，请从原路径重新搜索。');
    if (entry.binding !== binding) throw new AppError('LOG_CURSOR_MISMATCH','搜索参数、会话或连接已经变化，请移除 cursor 重新搜索。');
    return structuredClone(entry.state);
  }

  put(binding, state) {
    this.prune();
    const bytes = Buffer.byteLength(JSON.stringify(state),'utf8');
    if (bytes > this.maxBytes) throw new AppError('RESULT_LIMIT_EXCEEDED','日志续查元数据超过本地上限，请缩小目录范围。');
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) this.remove(this.entries.keys().next().value);
    const id = crypto.randomBytes(32).toString('hex');
    this.entries.set(id,{binding,state:structuredClone(state),bytes,expiresAt:this.now()+this.ttlMs});
    this.bytes += bytes;
    return id;
  }
}
