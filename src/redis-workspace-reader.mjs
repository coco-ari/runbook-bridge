import net from 'node:net';
import tls from 'node:tls';
import { AppError } from './errors.mjs';

export const REDIS_REPLY_BYTES = 1024 * 1024;
const COMMANDS = new Set(['SCAN', 'TYPE', 'TTL', 'STRLEN', 'GETRANGE', 'HLEN', 'HSCAN', 'HSTRLEN', 'HGET', 'LLEN', 'LRANGE', 'SCARD', 'SSCAN', 'ZCARD', 'ZRANGE']);
const protocolError = () => new AppError('REDIS_REPLY_INVALID', 'Redis 返回的数据格式无效。');
const limitError = () => new AppError('REDIS_REPLY_TOO_LARGE', '内容超过 1 MiB 读取限制，请缩小读取范围。');

// 增量解析 RESP2；在分配正文及数组前检查声明长度，不接收任意大回复。
export class BoundedRespDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.stack = [];
    this.bulkLength = null;
    this.done = false;
    this.value = undefined;
    this.nodes = 0;
  }

  push(chunk) {
    this.bytes += chunk.length;
    if (this.bytes > REDIS_REPLY_BYTES) throw limitError();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    const accept = (value) => {
      while (this.stack.length) {
        const top = this.stack.at(-1);
        top.values.push(value);
        if (top.values.length < top.count) return;
        value = top.values;
        this.stack.pop();
      }
      this.value = value;
      this.done = true;
    };
    while (!this.done) {
      if (this.bulkLength !== null) {
        if (this.buffer.length - offset < this.bulkLength + 2) break;
        const end = offset + this.bulkLength;
        if (this.buffer[end] !== 13 || this.buffer[end + 1] !== 10) throw protocolError();
        const value = Buffer.from(this.buffer.subarray(offset, end));
        offset = end + 2;
        this.bulkLength = null;
        accept(value);
        continue;
      }
      const end = this.buffer.indexOf('\r\n', offset);
      if (end < 0) {
        if (this.buffer.length - offset > 4096) throw protocolError();
        break;
      }
      if (++this.nodes > 65536) throw limitError();
      const kind = this.buffer[offset];
      const text = this.buffer.toString('utf8', offset + 1, end);
      offset = end + 2;
      if (kind === 43) accept(text);
      else if (kind === 45) {
        // 服务端错误可能含 Key、用户名或数据正文，公开错误只保留稳定分类。
        const code = /^WRONGTYPE\b/u.test(text) ? 'REDIS_TYPE_CHANGED'
          : /^(?:NOAUTH|WRONGPASS)\b/u.test(text) ? 'AUTHENTICATION_FAILED'
            : /^NOPERM\b/u.test(text) ? 'REDIS_PERMISSION_DENIED' : 'REDIS_READ_FAILED';
        const message = code === 'REDIS_TYPE_CHANGED' ? 'Key 类型已经变化，请重新读取。'
          : code === 'REDIS_PERMISSION_DENIED' ? '当前 Redis 账号没有此读取权限。' : 'Redis 读取失败，请检查连接及账号权限。';
        throw new AppError(code, message);
      } else if ([36, 42, 58].includes(kind)) {
        if (!/^-?(?:0|[1-9]\d*)$/u.test(text)) throw protocolError();
        const number = Number(text);
        if (!Number.isSafeInteger(number)) throw protocolError();
        if (kind === 58) accept(number);
        else if (number === -1) accept(null);
        else if (number < 0) throw protocolError();
        else if (kind === 36) {
          if (number > REDIS_REPLY_BYTES || this.bytes - this.buffer.length + offset + number + 2 > REDIS_REPLY_BYTES) throw limitError();
          this.bulkLength = number;
        } else {
          if (number > 65536 || this.stack.length >= 16) throw limitError();
          if (!number) accept([]);
          else this.stack.push({ count: number, values: [] });
        }
      } else throw protocolError();
    }
    if (this.done && offset !== this.buffer.length) throw protocolError();
    this.buffer = this.done ? Buffer.alloc(0) : this.buffer.subarray(offset);
    return this.done;
  }
}

function encode(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

export class RedisWorkspaceReader {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.pending = null;
    this.closed = false;
    this.ready = false;
    this.onClose = null;
  }

  async open(deadline) {
    if (this.closed) throw new AppError('REDIS_WORKSPACE_STALE', '工作区已关闭，请重新打开。');
    const { socket: options, username, password, database } = this.options;
    const socket = options.tls ? tls.connect(options) : net.connect(options);
    this.socket = socket;
    socket.on('error', () => this.close(new AppError('REDIS_READ_FAILED', 'Redis 读取通道连接失败。')));
    socket.on('close', () => this.close());
    socket.on('data', (chunk) => {
      const pending = this.pending;
      if (!pending?.decoder) { this.close(protocolError()); return; }
      try {
        if (pending.decoder.push(chunk)) {
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(pending.decoder.value);
        }
      } catch (error) { this.close(error); }
    });
    await new Promise((resolve, reject) => {
      const timer = this.timer(deadline);
      this.pending = { resolve, reject, timer };
      socket.once(options.tls ? 'secureConnect' : 'connect', () => {
        if (this.closed) return;
        clearTimeout(timer);
        this.pending = null;
        resolve();
      });
    });
    if (password !== undefined || username) await this.request(username ? ['AUTH', username, password ?? ''] : ['AUTH', password], deadline);
    // 与主连接保持同一 DB；选择失败时绝不退回 DB 0 或明文连接。
    if (database !== 0) await this.request(['SELECT', database], deadline);
    this.ready = true;
    this.options = null;
  }

  timer(deadline) {
    const timer = setTimeout(() => this.close(new AppError('PLUGIN_TIMEOUT', 'Redis 读取超时，请缩小读取范围后重试。')), Math.max(1, deadline - Date.now()));
    timer.unref?.();
    return timer;
  }

  command(args, deadline) {
    if (!COMMANDS.has(args[0]) || !this.ready) throw new AppError('POLICY_DENIED', '未登记的 Redis 工作区读取操作。');
    return this.request(args, deadline);
  }

  request(args, deadline) {
    if (this.closed || !this.socket) return Promise.reject(new AppError('REDIS_WORKSPACE_STALE', 'Redis 读取通道已失效，请重新读取。'));
    if (this.pending) return Promise.reject(new AppError('READ_BUSY', 'Redis 正在读取，请稍后重试。'));
    if (Date.now() >= deadline) {
      const error = new AppError('PLUGIN_TIMEOUT', 'Redis 读取超时，请缩小读取范围后重试。');
      this.close(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, decoder: new BoundedRespDecoder(), timer: this.timer(deadline) };
      this.socket.write(encode(args));
    });
  }

  close(error = new AppError('REDIS_WORKSPACE_STALE', 'Redis 读取通道已关闭，请重新读取。')) {
    if (this.closed) return;
    this.closed = true;
    this.options = null;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending?.timer);
    pending?.reject(error);
    this.socket?.destroy();
    this.onClose?.();
  }
}
