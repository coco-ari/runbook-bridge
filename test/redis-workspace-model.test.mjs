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

test('完整浏览后仍按插件限制与 64 KiB 上限禁用编辑', () => {
  const value = { text: 'fixture', hex: '', bytes: 65536, shownBytes: 65536, truncated: false };
  assert.equal(redisValueReadOnlyReason(value, {}), '');
  assert.match(redisValueReadOnlyReason({ ...value, bytes: 65537 }, {}), /超过编辑上限/u);
  assert.match(redisValueReadOnlyReason(value, { limits: { maxValueBytes: 256 } }), /256 B/u);
  assert.match(redisValueReadOnlyReason({ ...value, truncated: true }, {}), /未完整读取/u);
  assert.match(redisValueReadOnlyReason({ ...value, text: null }, {}), /不是文本/u);
});
