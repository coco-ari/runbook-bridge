import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRedisJson } from '../renderer/v2/src/features/redis/redis-value-format.ts';

test('JSON 格式化保留大整数、小数、指数、负零、字段顺序和重复字段', () => {
  const raw = '{"id":9007199254740993123,"decimal":1.2300,"exponent":1e+09,"negative":-0,"id":2,"01":3,"empty":{},"list":[]}';
  const shown = formatRedisJson(raw);
  assert.equal(shown, '{\n  "id": 9007199254740993123,\n  "decimal": 1.2300,\n  "exponent": 1e+09,\n  "negative": -0,\n  "id": 2,\n  "01": 3,\n  "empty": {},\n  "list": []\n}');
});

test('JSON 字符串中的标点、HTML、空白、反斜杠和 Unicode 转义按原文保留', () => {
  const raw = String.raw`{"value":"{[,]}: <img onerror=x>  ","escaped":"quote\" slash\\ line\n \u4e2d","list":[true,false,null]}`;
  const shown = formatRedisJson(raw);
  assert.deepEqual(JSON.parse(shown), JSON.parse(raw));
  assert.ok(shown.includes(String.raw`quote\" slash\\ line\n \u4e2d`));
  assert.ok(shown.includes('  "'));
});

test('截断 JSON 可格式化已加载片段，但不补齐括号、引号或丢弃字符串末尾空白', () => {
  for (const raw of ['{"rows":[{"id":1},', '{"text":"未读完  ', '{"rows":[{"id":', '[true, false, {"value":"escaped\\']) {
    assert.equal(formatRedisJson(raw), null);
    const shown = formatRedisJson(raw, true);
    assert.ok(shown !== null && shown.includes('\n'));
    if (raw.endsWith('  ')) assert.ok(shown.endsWith('  '));
    if (raw.endsWith('\\')) assert.ok(shown.endsWith('\\'));
    assert.throws(() => JSON.parse(shown));
  }
  assert.equal(formatRedisJson('普通文本', true), null);
});

test('完整的非法 JSON 不伪装成结构数据，合法标量可显示', () => {
  for (const text of ['', ' ', 'ordinary', '{"a":}', '[1,]', '{bad}', '01', '1 2']) assert.equal(formatRedisJson(text), null);
  for (const text of ['null', 'true', '1234567890123456789', '"hello"']) assert.equal(formatRedisJson(text), text);
});

test('深层 JSON 不递归爆栈，格式化展开受展示预算约束', () => {
  const nested = '['.repeat(500) + '0' + ']'.repeat(500);
  const shown = formatRedisJson(nested);
  assert.equal(shown.replace(/\s/gu, ''), nested);
  const large = '[' + '1,'.repeat(100_000) + '1]';
  assert.equal(formatRedisJson(large), large);
});
