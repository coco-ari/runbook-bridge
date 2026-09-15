import { AppError } from './errors.mjs';

// 只缓存可失效的展示元数据；授权、凭据和业务查询结果不能通过此缓存复用。
export class BoundedReadCache {
  constructor({ maxBytes = 4 * 1024 * 1024, maxEntries = 128, maxPending = 32, ttlMs = 60_000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntries, maxPending, ttlMs, now });
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  async read(key, load, { refresh = false } = {}) {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(id);
    if (refresh) this.remove(key);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { value:structuredClone(cached.value), hit:true, ageMs:this.now() - cached.createdAt };
    }
    if (this.pending.has(key)) return { value:structuredClone(await this.pending.get(key)), hit:true, ageMs:0 };
    if (this.pending.size >= this.maxPending) throw new AppError('READ_BUSY', '元数据读取队列已满，请稍后重试。', { phase:'queue', retryAfterMs:1000 });
    const promise = Promise.resolve().then(load);
    this.pending.set(key, promise);
    try {
      const value = await promise;
      // 清理期间完成的旧请求不能重新填充缓存。
      if (this.pending.get(key) === promise) {
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (bytes <= this.maxBytes) {
          while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) this.remove(this.entries.keys().next().value);
          this.entries.set(key, { value:structuredClone(value), bytes, createdAt:this.now(), expiresAt:this.now() + this.ttlMs });
          this.bytes += bytes;
        }
      }
      return { value:structuredClone(value), hit:false, ageMs:0 };
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }
}
