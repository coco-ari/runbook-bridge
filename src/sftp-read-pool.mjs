import { AppError } from './errors.mjs';

// 仅复用同一 SSH 连接上的桌面读取通道；租用期间独占，空闲短期保留一个通道。
export class SftpReadPool {
  constructor(client, { idleMs = 30_000, maxIdle = 1 } = {}) {
    this.client = client;
    this.idleMs = idleMs;
    this.maxIdle = maxIdle;
    this.entries = new Map();
    this.disposed = false;
    this.disconnected = () => this.dispose();
    client.once('close', this.disconnected);
    client.once('error', this.disconnected);
  }

  sftp(callback) {
    const unavailable = () => new AppError('SFTP_UNAVAILABLE', '桌面读取通道已关闭。');
    if (this.disposed) { callback(unavailable()); return; }
    const idle = [...this.entries.values()].find(entry => entry.idle);
    if (idle) {
      clearTimeout(idle.timer);
      idle.idle = false;
      callback(null, idle.channel);
      return;
    }
    this.client.sftp((error, channel) => {
      if (error) { callback(error); return; }
      if (this.disposed) {
        channel.on('error', () => {});
        try { channel.end(); } catch { /* 迟到的通道不能复活已结束的连接。 */ }
        callback(unavailable());
        return;
      }
      const entry = { channel, idle: false, closing: false, timer: null };
      entry.failed = () => this.close(entry);
      entry.closed = () => {
        this.forget(entry);
        channel.removeListener('error', entry.failed);
        channel.removeListener('end', entry.failed);
        channel.removeListener('close', entry.closed);
      };
      // 空闲期间仍监听错误和关闭；失效通道永不再次借出。
      channel.on('error', entry.failed);
      channel.on('end', entry.failed);
      channel.once('close', entry.closed);
      this.entries.set(channel, entry);
      callback(null, channel);
    });
  }

  forget(entry) {
    clearTimeout(entry.timer);
    this.entries.delete(entry.channel);
  }

  close(entry) {
    this.forget(entry);
    if (entry.closing) return;
    entry.closing = true;
    try { entry.channel.end(); } catch { /* 连接断开时通道可能已关闭。 */ }
  }

  discard(channel) {
    const entry = this.entries.get(channel);
    if (!entry) return false;
    // 失败操作结束就移出池；远端迟到或缺失的关闭通知不能累积占用记录。
    this.close(entry);
    return true;
  }

  release(channel) {
    const entry = this.entries.get(channel);
    if (this.disposed || !entry || entry.idle || entry.closing) return false;
    // 只保留最近归还的有限通道，避免占满服务端会话名额。
    const idle = [...this.entries.values()].filter(value => value.idle);
    while (idle.length >= this.maxIdle && idle.length) this.close(idle.shift());
    if (this.maxIdle < 1) { this.close(entry); return false; }
    entry.idle = true;
    entry.timer = setTimeout(() => this.close(entry), this.idleMs);
    entry.timer.unref?.();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.client.removeListener('close', this.disconnected);
    this.client.removeListener('error', this.disconnected);
    for (const entry of this.entries.values()) this.close(entry);
  }
}
