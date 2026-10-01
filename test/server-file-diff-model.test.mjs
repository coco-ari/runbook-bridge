import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChangeBlocks } from '../renderer/v2/src/features/server-workspace/file-editor-model.ts';

function check(before, after, expectedBlocks) {
  const result = fileChangeBlocks(before, after);
  assert.equal(result.mode, 'changes');
  if (expectedBlocks !== undefined) assert.equal(result.blocks.length, expectedBlocks);
  const source = before ? before.split(/\r\n|\r|\n/) : [], target = after ? after.split(/\r\n|\r|\n/) : [];
  const rebuilt = [...source];
  let added = 0, removed = 0;
  for (const block of [...result.blocks].reverse()) {
    const inserted = target.slice(block.after.start - 1, block.after.end);
    const deleted = Math.max(0, block.before.end - block.before.start + 1);
    rebuilt.splice(block.before.start - 1, deleted, ...inserted);
    added += inserted.length; removed += deleted;
  }
  assert.deepEqual(rebuilt, target);
  assert.equal(result.added, added); assert.equal(result.removed, removed);
  return result;
}

test('分离的改动保留未变行，新增、删除及重复行能还原精确内容', () => {
  check('a\nb\nc\nd', 'a\nB\nc\nD', 2);
  assert.deepEqual(check('a\nb', 'a\nnew\nb', 1).blocks[0], {before:{start:2,end:1},after:{start:2,end:2}});
  check('a\nremoved\nb', 'a\nb', 1);
  check('a\na\nb\na\nc', 'a\nb\na\na\nc');
  assert.equal(check('', 'first\nsecond').removed, 0); assert.equal(check('first\nsecond', '').added, 0);
  check('same\n', 'same\n', 0);
});

test('BOM、换行、尾空行仅参与展示，输入文本不被规范化', () => {
  const before = '\uFEFFheader\r\nunchanged\r\nold\r\n';
  const after = '\uFEFFHEADER\r\nunchanged\r\nnew\r\n';
  check(before, after, 2);
  assert.equal(before, '\uFEFFheader\r\nunchanged\r\nold\r\n');
  check('a\rb\rc', 'a\rB\rc', 1);
});

test('长文件与复杂差异按预算降级，不把范围统计称为精确增删', () => {
  const long = 'same\n'.repeat(10_000);
  const result = fileChangeBlocks(long+'old', long+'new');
  assert.equal(result.mode, 'range');
  assert.equal(result.added, null); assert.equal(result.removed, null);
  assert.deepEqual(result.blocks, [{before:{start:10001,end:10001},after:{start:10001,end:10001}}]);
  assert.equal(fileChangeBlocks('old\n'.repeat(600), 'new\n'.repeat(600)).mode, 'range');
});

test('小输入组合的变更块始终能重建目标且不重叠', () => {
  const texts = ['', 'a', 'b', 'a\na', 'a\nb', 'b\na', 'a\nb\na', '\n', 'a\n'];
  for (const before of texts) for (const after of texts) check(before, after);
});
