// 大文件按保守的最低传输速率估算总时限，另用无进展时限识别卡住的通道。
export function uploadTimeouts(bytes) {
  return {
    timeoutMs: Math.max(10 * 60_000, Math.min(12 * 60 * 60_000, 2 * 60_000 + Math.ceil(bytes / (16 * 1024)) * 1000)),
    inactivityMs: 90_000,
    timeoutMessage: '文件上传超过总时限，请检查网络后重新上传。',
  };
}

export class ServerUploadProgress {
  constructor(now = Date.now) {
    this.now = now;
    this.phase = 'preparing';
    this.samples = [];
    this.lastAdvanceAt = null;
  }

  update(bytes, phase) {
    const at = this.now();
    this.phase = ['preparing', 'uploading', 'verifying'].includes(phase) ? phase : 'uploading';
    if (this.phase !== 'uploading') return;
    const previous = this.samples.at(-1);
    if (!previous || bytes > previous.bytes) this.lastAdvanceAt = at;
    this.samples.push({ at, bytes });
    // 保留约五秒的滑动窗口与一个边界样本，并限制样本总数。
    while (this.samples.length > 2 && this.samples[1].at < at - 5000) this.samples.shift();
    if (this.samples.length > 32) this.samples.shift();
  }

  snapshot(bytes, total) {
    const result = { phase: this.phase, bytesPerSecond: null, etaSeconds: null };
    if (this.phase !== 'uploading' || !this.samples.length) return result;
    const at = this.now();
    const first = this.samples[0];
    const elapsed = (at - first.at) / 1000;
    if (this.lastAdvanceAt !== null && at - this.lastAdvanceAt >= 5000) return { ...result, bytesPerSecond: 0 };
    if (elapsed < 0.5 || bytes <= first.bytes) return result;
    const bytesPerSecond = (bytes - first.bytes) / elapsed;
    return { ...result, bytesPerSecond, etaSeconds: Math.ceil(Math.max(0, total - bytes) / bytesPerSecond) };
  }
}
