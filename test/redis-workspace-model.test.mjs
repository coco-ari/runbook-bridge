import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRedisValue, redisValueReadOnlyReason } from '../renderer/v2/src/features/redis/redis-workspace-model.ts';

test('分段浏览合并文本与字节，二进制不伪装为可编辑文本', () => {
  const first = { text: '中', hex: 'e4b8ad', bytes: 6, shownBytes: 3, truncated: true };
  const last = { text: '文', hex: 'e69687', bytes: 6, shownBytes: 3, truncated: false };
  assert.deepEqual(mergeRedisValue(first, last), { text: '中文', hex: 'e4b8ade69687', bytes: 6, shownBytes: 6, truncated: false });
  assert.equal(mergeRedisValue({ ...first, text: null }, last).text, null);
  assert.equal(mergeRedisValue(first, { ...last, text: null }).text, null);
});

test('普通文本允许直接进入编辑准备，超大值和二进制明确说明限制', () => {
  const value = { text: 'fixture', hex: '', bytes: 65536, shownBytes: 65536, truncated: false };
  assert.equal(redisValueReadOnlyReason(value), '');
  assert.equal(redisValueReadOnlyReason({ ...value, bytes: 99*1024 }), '');
  assert.match(redisValueReadOnlyReason({ ...value, bytes: 20*1024*1024+1 }), /20 MiB/u);
  assert.equal(redisValueReadOnlyReason({ ...value, truncated: true }), '');
  assert.match(redisValueReadOnlyReason({ ...value, text: null }), /二进制/u);
});
