import assert from 'node:assert/strict';
import test from 'node:test';
import { REDIS_EDITOR_MAX_LENGTH, redisEditorLimit } from '../renderer/v2/src/features/redis/redis-editor-model.ts';

test('Redis 编辑支持超过 64 KiB 的文本并在 20 MiB 边界拒绝超限输入', () => {
  assert.equal(redisEditorLimit('x'.repeat(REDIS_EDITOR_MAX_LENGTH), REDIS_EDITOR_MAX_LENGTH), null);
  assert.equal(redisEditorLimit('x'.repeat(REDIS_EDITOR_MAX_LENGTH + 1), REDIS_EDITOR_MAX_LENGTH), 'characters');
  assert.equal(redisEditorLimit('😀'.repeat(32769), 200000), null);
});

test('Redis 编辑按真实 UTF-8 字节与会话预算限制内容', () => {
  assert.equal(redisEditorLimit('中文😀', 10), null);
  assert.equal(redisEditorLimit('中文😀', 9), 'bytes');
  assert.equal(redisEditorLimit('中'.repeat(21845), 65536), null);
  assert.equal(redisEditorLimit('中'.repeat(21846), 65536), 'bytes');
  assert.equal(redisEditorLimit('abcd', 3), 'bytes');
  assert.equal(redisEditorLimit('', 0), null);
});
