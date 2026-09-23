import assert from 'node:assert/strict';
import test from 'node:test';
import { redisKeySearch } from '../src/redis-key-search.mjs';
import { buildRedisKeyTree, defaultRedisTreeExpansion, redisKeyTreeRows, redisKeyAncestors, redisFolderSearch, REDIS_KEY_TREE_MAX_DEPTH } from '../renderer/v2/src/features/redis/redis-key-tree.ts';

const keysOf = (tree) => [...tree.nodes.values()].filter(node => node.kind === 'key').map(node => node.key).sort();

test('冒号目录保留完整 Key，目录计数按去重后的已加载叶子累计', () => {
  const keys = ['cache:user:10', 'cache:user:2', 'cache:config', 'session:token:a', 'cache:user:10'];
  const tree = buildRedisKeyTree(keys);
  assert.deepEqual(keysOf(tree), [...new Set(keys)].sort());
  assert.equal(tree.nodes.get('folder:cache:').count, 3);
  assert.equal(tree.nodes.get('folder:cache:user:').count, 2);
  assert.deepEqual(tree.nodes.get('folder:cache:user:').children.map(node => node.label), ['cache:user:2', 'cache:user:10']);
  assert.deepEqual(tree.nodes.get('folder:cache:').children.map(node => node.kind), ['folder', 'key']);
  assert.deepEqual(redisKeyAncestors(tree, 'cache:user:10'), ['folder:cache:', 'folder:cache:user:']);
});

test('同名 Key 和目录、连续冒号、尾部冒号、中文与特殊字符均不会丢失或合并', () => {
  const keys = ['a', 'a:b', 'a:b:c', 'a::c', ':a', 'a:', '中文:用户:张三', 'a:<img onerror=x>', 'a:__proto__:x', 'plain-key'];
  const tree = buildRedisKeyTree(keys);
  assert.deepEqual(keysOf(tree), [...keys].sort());
  assert.equal(tree.nodes.get('key:a:b').key, 'a:b');
  assert.equal(tree.nodes.get('folder:a:b:').count, 1);
  assert.equal(tree.nodes.get('folder:a::').label, '（空分段）');
  assert.equal(tree.nodes.get('key:a:').label, 'a:');
  for (const key of keys) assert.equal(tree.nodes.get('key:' + key).label, key, '叶子显示完整 Key，保留尾部分隔符');
  assert.deepEqual(redisKeyAncestors(tree, 'missing'), []);
});

test('默认展开公共前缀链，搜索展开匹配路径，折叠保持层级与键盘位置信息', () => {
  const tree = buildRedisKeyTree(['app:test:user:1', 'app:test:user:2', 'app:test:config:main']);
  const expanded = defaultRedisTreeExpansion(tree, false);
  assert.deepEqual([...expanded], ['folder:app:', 'folder:app:test:']);
  const rows = redisKeyTreeRows(tree, id => expanded.has(id));
  assert.deepEqual(rows.map(row => row.node.path), ['app:', 'app:test:', 'app:test:config:', 'app:test:user:']);
  assert.deepEqual(rows.at(-1).position, 2);
  assert.deepEqual(rows.at(-1).siblingCount, 2);
  const searching = defaultRedisTreeExpansion(tree, true);
  assert.equal(redisKeyTreeRows(tree, id => searching.has(id)).filter(row => row.node.kind === 'key').length, 3);
  assert.equal(redisKeyTreeRows(tree, () => false).length, 1);
});

test('继续扫描合并到同一目录，节点身份稳定，计数随实际加载数量更新', () => {
  const before = buildRedisKeyTree(['cache:user:1', 'cache:config']);
  const after = buildRedisKeyTree(['cache:user:1', 'cache:config', 'cache:user:2']);
  assert.equal(before.nodes.get('folder:cache:user:').id, after.nodes.get('folder:cache:user:').id);
  assert.equal(after.nodes.get('folder:cache:user:').count, 2);
  assert.equal(after.nodes.get('folder:cache:').count, 3);
});

test('深层或大量 Key 的目录深度有界，叶子仍保留精确原始名称', () => {
  const deep = 'segment:'.repeat(100) + 'leaf';
  const tree = buildRedisKeyTree([deep]);
  assert.equal(tree.folders.length, REDIS_KEY_TREE_MAX_DEPTH);
  assert.equal(tree.nodes.size, REDIS_KEY_TREE_MAX_DEPTH + 1);
  const leaf = tree.nodes.get('key:' + deep);
  assert.equal(leaf.depth, REDIS_KEY_TREE_MAX_DEPTH);
  assert.equal(leaf.key, deep);
  assert.ok(leaf.label.endsWith('leaf') && leaf.label.includes(':'));
  const many = buildRedisKeyTree(Array.from({ length: 5000 }, (_, index) => 'cache:user:' + index));
  assert.equal(many.nodes.get('folder:cache:').count, 5000);
  assert.equal(many.nodes.size, 5002);
  assert.equal(redisKeyTreeRows(many, () => true).length, 5002);
});


test('目录搜索转义真实前缀中的通配符，不匹配相似目录或任意位置的片段', () => {
  for (const prefix of ['cache:orders:', 'cache:a*b?:', 'cache:a\\b:', 'cache:[users]:', 'cache::']) {
    const matches = redisKeySearch(redisFolderSearch(prefix));
    assert.equal(matches(prefix + 'one'), true);
    assert.equal(matches(prefix + 'child:two'), true);
    assert.equal(matches('other:' + prefix + 'one'), false);
    assert.equal(matches(prefix.slice(0, -1) + '-other:one'), false);
  }
  const special = redisKeySearch(redisFolderSearch('cache:a*b?:'));
  assert.equal(special('cache:axby:one'), false);
});
