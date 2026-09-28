import { AppError } from './errors.mjs';

export const LOG_READ_BLOCK_BYTES = 30 * 1024;

// 仅供进程内读取使用；正文和块状态不得进入游标、错误或 MCP 返回值。
export class LogReadCheckpoint {
  constructor(expected) {
    this.expected = { canonicalPath:expected.canonicalPath ?? expected.path, size:Number(expected.size), mtime:Number(expected.mtime) };
    this.content = Buffer.alloc(this.expected.size);
    this.blocks = new Set();
    this.retainedBytes = 0;
    this.identity = null;
    this.active = true;
  }

  validate(identity) {
    for (const [field, value] of Object.entries(this.identity ?? this.expected)) {
      if (identity[field] !== value) throw new AppError('SOURCE_CHANGED', '归档在分段读取期间发生变化，请重新搜索。', field === 'canonicalPath' ? {reason:'path'} : undefined);
    }
    this.identity ??= { ...identity };
  }

  has(position) { return this.blocks.has(position); }

  retain(position, buffer) {
    if (!this.active) return;
    if (!Number.isSafeInteger(position) || position < 0 || position % LOG_READ_BLOCK_BYTES !== 0
      || buffer.length !== Math.min(LOG_READ_BLOCK_BYTES, this.content.length - position) || buffer.length <= 0) {
      throw new AppError('TRANSFER_FAILED', '归档读取块范围无效。');
    }
    if (this.blocks.has(position)) return;
    buffer.copy(this.content, position);
    this.blocks.add(position);
    this.retainedBytes += buffer.length;
  }

  clear() {
    this.active = false;
    this.content.fill(0);
    this.blocks.clear();
    this.retainedBytes = 0;
  }
}
