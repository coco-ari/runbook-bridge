import assert from 'node:assert/strict';
import test from 'node:test';
import { REDIS_EDITOR_MAX_LENGTH, redisEditorLimit } from '../renderer/v2/src/features/redis/redis-editor-model.ts';

test('Redis 编辑保持原 textarea 的 UTF-16 字符上限', () => {
  assert.equal(redisEditorLimit('x'.repeat(REDIS_EDITOR_MAX_LENGTH), 65536), null);
  assert.equal(redisEditorLimit('x'.repeat(REDIS_EDITOR_MAX_LENGTH + 1), 100000), 'characters');
  assert.equal(redisEditorLimit('😀'.repeat(32769), 200000), 'characters');
});

test('Redis 编辑按真实 UTF-8 字节与会话预算限制内容', () => {
  assert.equal(redisEditorLimit('中文😀', 10), null);
  assert.equal(redisEditorLimit('中文😀', 9), 'bytes');
  assert.equal(redisEditorLimit('中'.repeat(21845), 65536), null);
  assert.equal(redisEditorLimit('中'.repeat(21846), 65536), 'bytes');
  assert.equal(redisEditorLimit('abcd', 3), 'bytes');
  assert.equal(redisEditorLimit('', 0), null);
});
