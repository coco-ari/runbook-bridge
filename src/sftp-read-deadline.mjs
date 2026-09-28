// 仅真实新增的读取字节可延长等待；元数据、复用块和重复进度均不续期。
export class SftpReadDeadline {
  constructor(timeoutMs, maxTimeoutMs = timeoutMs, now = Date.now) {
    this.now = now;
    this.startedAt = now();
    this.timeoutMs = timeoutMs;
    this.maxTimeoutMs = Math.max(timeoutMs, maxTimeoutMs);
    this.deadline = timeoutMs > 0 ? this.startedAt + timeoutMs : Infinity;
    this.hardDeadline = timeoutMs > 0 ? this.startedAt + this.maxTimeoutMs : Infinity;
    this.receivedBytes = 0;
    this.lastReadAt = null;
    this.firstReadAt = null;
  }

  progress(value) {
    if (value.phase === 'metadata' || value.phase === 'open') this.receivedBytes = 0;
    if (value.phase !== 'read' || !Number.isSafeInteger(value.receivedBytes) || value.receivedBytes <= this.receivedBytes) return false;
    this.receivedBytes = value.receivedBytes;
    const now = this.now();
    // 迟到回调不能复活已耗尽的等待预算。
    if (now >= this.deadline) return false;
    this.firstReadAt ??= now;
    this.lastReadAt = now;
    const next = Math.max(this.deadline, Math.min(this.hardDeadline, now + this.timeoutMs));
    const extended = next > this.deadline;
    this.deadline = next;
    return extended;
  }

  details() {
    if (this.maxTimeoutMs <= this.timeoutMs) return {};
    return {
      timeoutMs:this.deadline - this.startedAt,
      idleTimeoutMs:this.timeoutMs,
      totalTimeoutMs:this.maxTimeoutMs,
      ...(this.lastReadAt === null ? {} : {
        firstByteMs:this.firstReadAt - this.startedAt,
        lastProgressAgoMs:Math.max(0, this.now() - this.lastReadAt),
      }),
    };
  }
}
