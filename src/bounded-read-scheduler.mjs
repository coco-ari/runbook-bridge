import { AppError } from './errors.mjs';

// 限制每个插件及全局的并发、排队时间和预留内存。
export class BoundedReadScheduler {
  constructor({ maxConcurrent = 4, maxPerKey = 1, maxReservedBytes = Number.MAX_SAFE_INTEGER, maxQueued = 32, queueTimeoutMs = 10_000, busyCode = 'READ_BUSY' } = {}) {
    Object.assign(this, { maxConcurrent, maxPerKey, maxReservedBytes, maxQueued, queueTimeoutMs, busyCode });
    this.active = 0;
    this.reservedBytes = 0;
    this.activeKeys = new Set();
    this.activeCounts = new Map();
    this.queue = [];
  }

  run(key, reservationBytes, operation) {
    if (typeof operation !== 'function') throw new AppError('INVALID_ARGUMENT', '只读操作无效。');
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1 || reservationBytes > this.maxReservedBytes) {
      throw new AppError('RESULT_LIMIT_EXCEEDED', '读取请求超过本地资源预算。');
    }
    if (this.queue.length >= this.maxQueued) {
      throw new AppError(this.busyCode, '读取队列已满，请等待当前查询完成后重试。', { phase:'queue', retryAfterMs:1000 });
    }
    return new Promise((resolve, reject) => {
      const task = { key, reservationBytes, operation, resolve, reject };
      task.timer = setTimeout(() => {
        const index = this.queue.indexOf(task);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new AppError(this.busyCode, '等待读取超过排队时限，请合并查询条件后重试。', { phase:'queue', retryAfterMs:1000 }));
      }, this.queueTimeoutMs);
      this.queue.push(task);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.maxConcurrent) {
      const index = this.queue.findIndex(task => (this.activeCounts.get(task.key) ?? 0) < this.maxPerKey && this.reservedBytes + task.reservationBytes <= this.maxReservedBytes);
      if (index < 0) break;
      const [task] = this.queue.splice(index, 1);
      clearTimeout(task.timer);
      this.active += 1;
      this.reservedBytes += task.reservationBytes;
      this.activeKeys.add(task.key);
      this.activeCounts.set(task.key,(this.activeCounts.get(task.key) ?? 0) + 1);
      Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => {
        this.active -= 1;
        this.reservedBytes -= task.reservationBytes;
        const remaining = this.activeCounts.get(task.key) - 1;
        if (remaining === 0) { this.activeCounts.delete(task.key); this.activeKeys.delete(task.key); }
        else this.activeCounts.set(task.key,remaining);
        this.drain();
      });
    }
  }
}
