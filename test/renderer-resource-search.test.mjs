import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceSearchFilter } from '../renderer/v2/src/components/app-shell/resource-search.ts';

test('资源搜索支持名称、环境、项目和类型的任意顺序组合，缺少任一条件不匹配', () => {
  const value = 'plugin:project-a:env-a:db-a 订单数据库';
  const keywords = ['电商平台', '华东生产环境', 'mysql', 'MySQL'];
  for (const search of ['订单', '生产 订单', '订单 生产', '电商 mysql 订单', '  MYSQL\t生产\n订单 ']) {
    assert.ok(resourceSearchFilter(value, search, keywords) > 0, search);
  }
  for (const search of ['生产 Redis', '测试 订单', '其他项目 订单']) {
    assert.equal(resourceSearchFilter(value, search, keywords), 0, search);
  }
  assert.equal(resourceSearchFilter(value, '  ', keywords), 1);
});

test('上下文检索仍区分不同环境中的同名资源，并保留精确名称排序', () => {
  assert.ok(resourceSearchFilter('订单数据库', '生产 订单', ['生产环境']) > 0);
  assert.equal(resourceSearchFilter('订单数据库', '生产 订单', ['测试环境']), 0);
  assert.ok(resourceSearchFilter('订单', '订单') > resourceSearchFilter('订单归档数据库', '订单'));
});
