import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerStateLabel, logMatchSegments } from '../renderer/v2/src/features/server-workspace/docker-presentation.ts';

test('Docker已知状态统一中文，未知状态仍完整保留', () => {
  assert.equal(dockerStateLabel('exited'), '已退出');
  assert.equal(dockerStateLabel('paused'), '已暂停');
  assert.equal(dockerStateLabel('restarting'), '重启中');
  assert.equal(dockerStateLabel('vendor-custom-state'), 'vendor-custom-state');
  for (const unknown of ['constructor', 'toString', '__proto__']) assert.equal(dockerStateLabel(unknown), unknown);
});

test('日志匹配使用字面词，保持原始内容及大小写', () => {
  const text = 'WARN warn 中文 <script> [a+b]. WARN';
  const warn = logMatchSegments(text, 'warn');
  assert.equal(warn.filter(part => part.matched).length, 3);
  assert.equal(warn.map(part => part.text).join(''), text);
  assert.deepEqual(logMatchSegments(text, '[a+b].').filter(part => part.matched), [{ text: '[a+b].', matched: true }]);
  assert.deepEqual(logMatchSegments(text, '<script>').filter(part => part.matched), [{ text: '<script>', matched: true }]);
  assert.deepEqual(logMatchSegments(text, '中文').filter(part => part.matched), [{ text: '中文', matched: true }]);
});

test('日志无匹配和空搜索不改变文本，连续匹配不遗漏', () => {
  assert.deepEqual(logMatchSegments('', ''), [{ text: '', matched: false }]);
  assert.deepEqual(logMatchSegments('原始\n内容', '不存在'), [{ text: '原始\n内容', matched: false }]);
  assert.deepEqual(logMatchSegments('aaaa', 'aa'), [{ text: 'aa', matched: true }, { text: 'aa', matched: true }]);
});
