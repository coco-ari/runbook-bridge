import { AppError } from './errors.mjs';

const CANONICAL_DECIMAL_CURSOR = /^(?:0|[1-9][0-9]*)$/u;
const MAX_REDIS_CURSOR = 18_446_744_073_709_551_615n;

export const OFFSET_CURSOR_INPUT_SCHEMA = Object.freeze({
  description: '兼容旧版非负整数；推荐原样透传上一页返回的十进制字符串 nextCursor。首次调用时省略。',
  oneOf: [
    {
      type: 'string',
      minLength: 1,
      maxLength: String(Number.MAX_SAFE_INTEGER).length,
      pattern: '^(0|[1-9][0-9]*)$',
    },
    {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  ],
});

export const REDIS_CURSOR_INPUT_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: String(MAX_REDIS_CURSOR).length,
  pattern: '^(0|[1-9][0-9]*)$',
  description: '仅透传上一页返回的十进制字符串 nextCursor；首次调用时省略。',
});

function invalidCursor(message) {
  return new AppError('INVALID_ARGUMENT', message);
}

export function parseOffsetCursor(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw invalidCursor('分页 cursor 无效；必须是非负安全整数，或上一页返回的规范十进制字符串。');
  }
  if (typeof value !== 'string' || !CANONICAL_DECIMAL_CURSOR.test(value)) {
    throw invalidCursor('分页 cursor 无效；必须是非负安全整数，或上一页返回的规范十进制字符串。');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidCursor('分页 cursor 超出安全整数范围；请重新开始分页。');
  }
  return parsed;
}

export function normalizeRedisCursor(value) {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL_CURSOR.test(value)) {
    throw invalidCursor('Redis cursor 无效；必须是上一页返回的规范十进制字符串。');
  }
  if (value.length > String(MAX_REDIS_CURSOR).length || BigInt(value) > MAX_REDIS_CURSOR) {
    throw invalidCursor('Redis cursor 超出无符号 64 位范围；请重新开始扫描。');
  }
  return value;
}
