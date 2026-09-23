import assert from 'node:assert/strict';
import test from 'node:test';
import { redisKeySearch } from '../src/redis-key-search.mjs';

test('关键词包含和通配符支持前缀、后缀、多段匹配及转义', () => {
  const cases = [
    ['', 'cache:user:1', true], ['user', 'cache:user:1', true], ['User', 'cache:user:1', false],
    ['*user*', 'cache:user:1', true], ['user:*', 'cache:user:1', false], ['cache:*', 'cache:user:1', true],
    ['*:1', 'cache:user:1', true], ['*:1', 'cache:user:10', false],
    ['cache:*:profile', 'cache:users:1:profile', true], ['cache:*:profile', 'cache:users:1:profile:more', false],
    ['u?er', 'cache:user:1', true], ['cache:?', 'cache:中', true], ['*cache:?', 'cache:中文', false],
    ['cache:*a*b', 'cache:aab', true], ['cache:*a*b', 'cache:abc', false],
    ['cache:**', 'cache:', true], ['cache:?', 'cache:', false],
    [String.raw`\*user\*`, 'cache:*user*:1', true], [String.raw`\*user\*`, 'cache:user:1', false],
    [String.raw`cache:\?:*`, 'cache:?:1', true], [String.raw`cache:\\*`, 'cache:\\name', true],
    ['cache:[1]', 'cache:[1]', true], ['cache:[1]', 'cache:1', false],
  ];
  for (const [query, key, expected] of cases) assert.equal(redisKeySearch(query)(key), expected, query + ' / ' + key);
});

test('大量交错星号的未命中查询保持有界，不产生正则回溯', () => {
  assert.equal(redisKeySearch('*a'.repeat(400) + 'b')('a'.repeat(1000)), false);
});
