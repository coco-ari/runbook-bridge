import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTimeRange } from '../renderer/v2/src/features/audit/audit-time-range.ts';
import { redisKeyAllowed } from '../src/redis-key-pattern.mjs';

test('审计自定义范围转换本机时区，包含结束分钟且拒绝不完整或反向时间', () => {
  assert.deepEqual(auditTimeRange('2026-10-11T10:00','2026-10-11T10:01'),{
    from:new Date('2026-10-11T10:00:00').toISOString(),to:new Date('2026-10-11T10:01:59.999').toISOString(),
  });
  for (const [start,end] of [['',''],['2026-10-11','2026-10-12'],['2026-10-11T11:00','2026-10-11T10:00'],['2026-99-11T10:00','2026-99-11T11:00']]) assert.equal(auditTimeRange(start,end),null);
  assert.equal(auditTimeRange('2026-02-30T10:00','2026-03-02T11:00'),null);
});

test('Redis 范围试算复用服务端语义，不把字符组或转义当作额外权限', () => {
  assert.equal(redisKeyAllowed('service:*','service:fixture'),true);
  assert.equal(redisKeyAllowed('service:?','service:ab'),false);
  assert.equal(redisKeyAllowed('service:[ab]','service:a'),false);
  assert.equal(redisKeyAllowed('service:[ab]','service:[ab]'),true);
  assert.equal(redisKeyAllowed('service:*','other:fixture'),false);
  assert.equal(redisKeyAllowed('service:*','service:fixture\n'),false);
});
