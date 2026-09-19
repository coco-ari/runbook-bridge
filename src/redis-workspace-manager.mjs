import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { AppError } from './errors.mjs';
import { findRedisPattern, redisKeyAllowed } from './redis-plugin-runtime.mjs';
import { normalizeRedisCursor } from './pagination-cursor.mjs';

const SCOPE = ['projectId', 'environmentId', 'pluginInstanceId'];
const FIELDS = {
  scan: ['patternId', 'keyword', 'cursor', 'limit'],
  inspect: ['patternId', 'key'],
  read: ['patternId', 'key', 'cursor', 'limit', 'field', 'expectedType'],
  release: [],
};
// 后端游标占 4 MiB，Renderer 占 12 MiB，工作区保留数据合计不超过 16 MiB。
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const CURSOR_AGE = 5 * 60 * 1000;
const scopeKey = (value) => SCOPE.map((field) => value[field]).join('/');
const stale = () => new AppError('REDIS_WORKSPACE_STALE', '浏览会话已经失效，请重新读取。');
const invalidCursor = () => new AppError('INVALID_CURSOR', '分页已失效或不属于当前查询，请重新读取。');
const invalidReply = () => new AppError('REDIS_REPLY_INVALID', 'Redis 返回的数据格式无效。');

export function prepareRedisWorkspaceRequest(payload, operation) {
  const fields = FIELDS[operation];
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some((name) => ![...SCOPE, ...fields].includes(name))
    || SCOPE.some((name) => typeof payload[name] !== 'string' || !payload[name] || payload[name].length > 128 || /[\\/\u0000-\u001f\u007f]/u.test(payload[name]))) {
    throw new AppError('INVALID_ARGUMENT', 'Redis 工作区请求参数无效。');
  }
  if (operation !== 'release' && (typeof payload.patternId !== 'string' || !payload.patternId || payload.patternId.length > 128)) {
    throw new AppError('INVALID_ARGUMENT', '请选择有效的 Key 范围。');
  }
  for (const name of ['key', 'field']) {
    if ((name === 'key' && ['read', 'inspect'].includes(operation)) || payload[name] !== undefined) {
      if (typeof payload[name] !== 'string' || !payload[name] || Buffer.byteLength(payload[name]) > 1024 || Buffer.from(payload[name]).toString('utf8') !== payload[name]) {
        throw new AppError('INVALID_ARGUMENT', 'Key 或字段必须是长度不超过 1024 字节的非空文本。');
      }
    }
  }
  if (payload.keyword !== undefined && (typeof payload.keyword !== 'string' || Buffer.byteLength(payload.keyword) > 1024)) throw new AppError('INVALID_ARGUMENT', '搜索词超过长度限制。');
  if (payload.cursor !== undefined && payload.cursor !== null && (typeof payload.cursor !== 'string' || !/^[a-f0-9]{48}$/u.test(payload.cursor))) throw invalidCursor();
  if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 1000)) throw new AppError('INVALID_ARGUMENT', '分页数量必须是 1 到 1000 的整数。');
  if (payload.expectedType !== undefined && !['string', 'hash', 'list', 'set', 'zset', 'stream', 'none'].includes(payload.expectedType)) throw new AppError('INVALID_ARGUMENT', 'Redis 数据类型无效。');
  if (payload.field !== undefined && payload.cursor) throw new AppError('INVALID_ARGUMENT', '精确字段读取不能包含分页参数。');
  return { scope: Object.fromEntries(SCOPE.map((field) => [field, payload[field]])), capability: operation === 'scan' ? 'scan' : 'read' };
}

function buffer(value) {
  if (!Buffer.isBuffer(value)) throw invalidReply();
  return value;
}
function number(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidReply();
  return value;
}
function kind(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof text !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(text)) throw invalidReply();
  return text;
}
function scanReply(value) {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) throw invalidReply();
  return { cursor: normalizeRedisCursor(buffer(value[0]).toString('ascii')), entries: value[1] };
}

export function redisValuePreview(value, budget, originalBytes = value.length) {
  let size = Math.min(value.length, Math.max(0, budget));
  let textValue = isUtf8(value) && !value.includes(0);
  if (!textValue && !value.includes(0) && originalBytes > value.length) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value, { stream: true });
      size = Math.min(size, Buffer.byteLength(decoded));
      textValue = true;
    } catch { /* 非法 UTF-8 仍以十六进制展示。 */ }
  }
  if (textValue && size < value.length) {
    while (size > 0 && (value[size] & 0xc0) === 0x80) size -= 1;
  }
  const shown = value.subarray(0, size);
  return { text: textValue ? shown.toString('utf8') : null, hex: shown.toString('hex'), bytes: originalBytes, shownBytes: size, truncated: size < originalBytes };
}

// 工作区缓存只驻留内存，游标绑定窗口、配置、连接代次及完整查询参数。
export class RedisWorkspaceManager {
  constructor(redisRuntime) {
    this.runtime = redisRuntime;
    this.records = new Map();
    this.busy = new Set();
  }

  release(ownerId, scope) {
    const record = this.records.get(ownerId + ':' + scopeKey(scope));
    if (record) this.closeRecord(record);
    return { released: true };
  }

  closeRecord(record) {
    if (this.records.get(record.id) === record) this.records.delete(record.id);
    record.active = false;
    clearTimeout(record.timer);
    record.cursors.clear();
    record.reader?.close();
  }

  closeOwner(ownerId) {
    for (const record of this.records.values()) if (record.ownerId === ownerId) this.closeRecord(record);
  }

  invalidate(scope) {
    for (const record of this.records.values()) {
      if (SCOPE.every((field) => !scope[field] || record.plugin[field] === scope[field])) this.closeRecord(record);
    }
  }

  dispose() {
    for (const record of this.records.values()) this.closeRecord(record);
  }

  record(ownerId, plugin) {
    const id = ownerId + ':' + scopeKey(plugin);
    const session = this.runtime.require(plugin);
    let record = this.records.get(id);
    if (record && (record.session !== session || record.plugin.revision !== plugin.revision)) {
      this.closeRecord(record);
      record = null;
    }
    if (!record) {
      record = { id, ownerId, plugin, session, active: true, reader: null, cursors: new Map(), timer: null };
      this.records.set(id, record);
    }
    clearTimeout(record.timer);
    record.timer = setTimeout(() => this.closeRecord(record), CURSOR_AGE);
    record.timer.unref?.();
    return record;
  }

  assertCurrent(record) {
    if (!record.active || this.records.get(record.id) !== record || this.runtime.require(record.plugin) !== record.session) throw stale();
  }

  async execute(ownerId, plugin, operation, payload, verifyCurrent = async () => {}, assertOwner = () => {}) {
    assertOwner();
    const resource = scopeKey(plugin);
    if (this.busy.has(resource)) throw new AppError('READ_BUSY', 'Redis 正在读取，请稍后重试。', { retryAfterMs: 200 });
    const pattern = findRedisPattern(plugin, payload.patternId);
    if (payload.key && !redisKeyAllowed(pattern.pattern, payload.key)) throw new AppError('POLICY_DENIED', 'Redis Key 不在允许范围内。');
    const record = this.record(ownerId, plugin);
    this.busy.add(resource);
    const deadline = Date.now() + plugin.limits.timeoutMs;
    try {
      if (!record.reader || record.reader.closed) {
        record.reader = this.runtime.workspaceReader(plugin);
        const onClose = record.reader.onClose;
        record.reader.onClose = () => { onClose?.(); this.closeRecord(record); };
        await record.reader.open(deadline);
      }
      this.assertCurrent(record);
      const command = async (...args) => {
        assertOwner();
        this.assertCurrent(record);
        const result = await record.reader.command(args, deadline);
        this.assertCurrent(record);
        return result;
      };
      const result = operation === 'scan'
        ? await this.scan(record, payload, pattern, command)
        : operation === 'inspect'
          ? await this.inspect(payload, command)
          : await this.read(record, payload, command);
      await verifyCurrent();
      assertOwner();
      this.assertCurrent(record);
      return { ...result, readAt: new Date().toISOString() };
    } catch (error) {
      if (['REDIS_TYPE_CHANGED', 'REDIS_WORKSPACE_STALE', 'PLUGIN_NOT_CONNECTED', 'PLUGIN_TIMEOUT'].includes(error?.code)) this.closeRecord(record);
      throw error;
    } finally { this.busy.delete(resource); }
  }

  takeCursor(record, payload, type, defaultLimit) {
    const limit = Math.min(payload.limit ?? defaultLimit, record.plugin.limits.maxKeys);
    const binding = JSON.stringify([payload.patternId, payload.keyword ?? '', payload.key ?? '', type, limit]);
    for (const [token, item] of record.cursors) if (item.expiresAt < Date.now()) record.cursors.delete(token);
    if (payload.cursor) {
      const state = record.cursors.get(payload.cursor);
      if (!state || state.binding !== binding || state.expiresAt < Date.now()) throw invalidCursor();
      record.cursors.delete(payload.cursor);
      return state;
    }
    return { binding, type, limit, cursor: '0', offset: 0, pending: [], complete: false, expiresAt: 0 };
  }

  saveCursor(record, state) {
    if (state.complete && !state.pending.length) return null;
    while (record.cursors.size >= 64) record.cursors.delete(record.cursors.keys().next().value);
    const bytes = (entry) => entry.reduce((sum, row) => sum + (Array.isArray(row) ? row.reduce((n, value) => n + (Buffer.isBuffer(value) ? value.length : 16), 64) : row.length + 64), 0);
    const used = [...record.cursors.values()].reduce((sum, item) => sum + bytes(item.pending), bytes(state.pending));
    if (used > MAX_CACHE_BYTES) throw new AppError('REDIS_CACHE_LIMIT', '浏览缓存已达上限，请关闭标签或收窄搜索。');
    const token = crypto.randomBytes(24).toString('hex');
    state.expiresAt = Date.now() + CURSOR_AGE;
    record.cursors.set(token, state);
    return token;
  }

  async scan(record, payload, pattern, command) {
    const state = this.takeCursor(record, payload, 'keys', 100);
    let unsupportedKeys = 0;
    if (!state.pending.length && !state.complete) {
      const reply = scanReply(await command('SCAN', state.cursor, 'MATCH', pattern.pattern, 'COUNT', state.limit));
      state.cursor = reply.cursor;
      state.complete = reply.cursor === '0';
      state.pending = reply.entries.filter((entry) => {
        buffer(entry);
        if (!entry.length || entry.length > 1024 || !isUtf8(entry)) { unsupportedKeys += 1; return false; }
        const text = entry.toString('utf8');
        return redisKeyAllowed(pattern.pattern, text) && text.includes(payload.keyword ?? '');
      });
    }
    const keys = [];
    let bytes = 0;
    while (state.pending.length && keys.length < state.limit) {
      const next = state.pending[0];
      if (keys.length && bytes + next.length > record.plugin.limits.maxValueBytes) break;
      keys.push(state.pending.shift().toString('utf8'));
      bytes += next.length;
    }
    const nextCursor = this.saveCursor(record, state);
    return { keys, nextCursor, complete: nextCursor === null, unsupportedKeys };
  }

  async inspect(payload, command) {
    const type = kind(await command('TYPE', payload.key));
    if (type === 'none') return { key: payload.key, type, exists: false, ttlSeconds: -2, length: null, cardinality: null };
    const counts = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD' };
    const count = counts[type] ? number(await command(counts[type], payload.key)) : null;
    const ttlSeconds = await command('TTL', payload.key);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < -2) throw invalidReply();
    const after = kind(await command('TYPE', payload.key));
    if (after === 'none' || ttlSeconds === -2) return { key: payload.key, type: 'none', exists: false, ttlSeconds: -2, length: null, cardinality: null };
    if (after !== type) throw new AppError('REDIS_TYPE_CHANGED', 'Key 类型已经变化，请重新读取。');
    return { key: payload.key, type, exists: true, ttlSeconds, length: type === 'string' ? count : null, cardinality: type === 'string' ? null : count };
  }

  async read(record, payload, command) {
    const type = kind(await command('TYPE', payload.key));
    if (type === 'none') return { key: payload.key, type, exists: false, rows: [], nextCursor: null, complete: true, truncated: false };
    if (payload.expectedType && payload.expectedType !== type) throw new AppError('REDIS_TYPE_CHANGED', 'Key 类型已经变化，请重新读取。');
    const budget = record.plugin.limits.maxValueBytes;
    let result;
    if (type === 'string') {
      if (payload.cursor || payload.field !== undefined) throw new AppError('INVALID_ARGUMENT', 'String 不支持字段或集合分页。');
      const length = number(await command('STRLEN', payload.key));
      const value = length ? buffer(await command('GETRANGE', payload.key, 0, Math.min(length, budget) - 1)) : Buffer.alloc(0);
      result = { value: redisValuePreview(value, budget, length), rows: [], nextCursor: null, complete: true };
    } else if (type === 'hash' && payload.field !== undefined) {
      const length = number(await command('HSTRLEN', payload.key, payload.field));
      const raw = length <= budget ? await command('HGET', payload.key, payload.field) : null;
      result = { field: payload.field, fieldExists: length > budget || raw !== null, value: raw === null ? null : redisValuePreview(buffer(raw), budget),
        valueBytes: length, truncated: length > budget, rows: [], nextCursor: null, complete: true };
    } else if (['hash', 'list', 'set', 'zset'].includes(type)) {
      if (payload.field !== undefined) throw new AppError('INVALID_ARGUMENT', '只有 Hash 可以读取字段。');
      result = await this.collection(record, payload, type, command);
    } else result = { unsupported: true, rows: [], nextCursor: null, complete: true };
    const after = kind(await command('TYPE', payload.key));
    if (after === 'none') return { key: payload.key, type: 'none', exists: false, rows: [], nextCursor: null, complete: true, truncated: false };
    if (after !== type) throw new AppError('REDIS_TYPE_CHANGED', 'Key 类型已经变化，请重新读取。');
    return { key: payload.key, type, exists: true, truncated: result.value?.truncated ?? false, ...result };
  }

  async collection(record, payload, type, command) {
    const state = this.takeCursor(record, payload, type, 50);
    if (!state.pending.length && !state.complete) {
      if (type === 'hash' || type === 'set') {
        const reply = scanReply(await command(type === 'hash' ? 'HSCAN' : 'SSCAN', payload.key, state.cursor, 'COUNT', state.limit));
        state.cursor = reply.cursor;
        state.complete = reply.cursor === '0';
        if (type === 'hash' && reply.entries.length % 2) throw invalidReply();
        for (let i = 0; i < reply.entries.length; i += type === 'hash' ? 2 : 1) {
          state.pending.push(type === 'hash' ? [buffer(reply.entries[i]), buffer(reply.entries[i + 1])] : [buffer(reply.entries[i])]);
        }
      } else {
        const count = number(await command(type === 'list' ? 'LLEN' : 'ZCARD', payload.key));
        const end = state.offset + state.limit - 1;
        const args = [type === 'list' ? 'LRANGE' : 'ZRANGE', payload.key, state.offset, end];
        if (type === 'zset') args.push('WITHSCORES');
        const entries = await command(...args);
        if (!Array.isArray(entries) || (type === 'zset' && entries.length % 2)) throw invalidReply();
        for (let i = 0; i < entries.length; i += type === 'zset' ? 2 : 1) {
          state.pending.push(type === 'list' ? [buffer(entries[i]), state.offset++] : [buffer(entries[i]), buffer(entries[i + 1]), state.offset++]);
        }
        state.complete = state.offset >= count || !entries.length;
      }
    }
    const rows = [];
    let remaining = record.plugin.limits.maxValueBytes;
    while (state.pending.length && rows.length < state.limit && remaining > 0) {
      const entry = state.pending.shift();
      const raw = type === 'hash' ? entry[1] : entry[0];
      const value = redisValuePreview(raw, remaining);
      remaining -= Math.max(1, value.shownBytes);
      const identity = crypto.createHash('sha256').update(entry[0]).digest('hex');
      rows.push({ id: type === 'list' ? String(entry[1]) : type === 'zset' ? identity : identity, value,
        ...(type === 'hash' ? { field: entry[0].length <= 1024 && isUtf8(entry[0]) ? entry[0].toString('utf8') : null, fieldLabel: isUtf8(entry[0]) ? entry[0].subarray(0, 1024).toString('utf8') : '[二进制字段]' } : {}),
        ...(type === 'list' ? { index: entry[1] } : {}),
        ...(type === 'zset' ? { index: entry[2], score: entry[1].toString('ascii') } : {}) });
    }
    const nextCursor = this.saveCursor(record, state);
    return { rows, nextCursor, complete: nextCursor === null, truncated: rows.some((row) => row.value.truncated) };
  }
}
