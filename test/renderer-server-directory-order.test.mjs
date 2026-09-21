import assert from 'node:assert/strict';
import test from 'node:test';
import { compareServerDirectoryEntries } from '../renderer/v2/src/features/server-workspace/workspace-model.ts';

const entry = (name, type = 'file', linkTargetType) => ({ name, type, path: '/' + name, linkTargetType });
const names = entries => [...entries].sort(compareServerDirectoryEntries).map(item => item.name);

test('同级文件夹优先，文件夹和文件分别按数字自然顺序排列', () => {
  const entries = [
    entry('file10.txt'), entry('z-folder10', 'directory'), entry('.env'),
    entry('file2.txt'), entry('z-folder2', 'directory'), entry('file1.txt'),
  ];
  assert.deepEqual(names(entries), ['z-folder2', 'z-folder10', '.env', 'file1.txt', 'file2.txt', 'file10.txt']);
});

test('目录链接补齐后归入文件夹组，文件链接和不可用链接保留在文件组', () => {
  const entries = [
    entry('z-folder', 'directory'), entry('a-file'), entry('b-link', 'symlink'),
    entry('c-link', 'symlink', 'file'), entry('d-link', 'symlink', 'unavailable'),
    entry('e-link', 'symlink', 'special'),
  ];
  assert.deepEqual(names(entries), ['z-folder', 'a-file', 'b-link', 'c-link', 'd-link', 'e-link']);
  const resolved = entries.map(item => item.name === 'b-link' ? { ...item, linkTargetType: 'directory' } : item);
  assert.deepEqual(names(resolved), ['b-link', 'z-folder', 'a-file', 'c-link', 'd-link', 'e-link']);
  assert.equal(entries[2].linkTargetType, undefined);
});

test('大小写及数字等价的名称保持确定顺序，不依赖远端枚举次序', () => {
  const entries = ['file2', 'File2', 'file02', 'FILE2'].map(name => entry(name));
  assert.deepEqual(names(entries), ['FILE2', 'File2', 'file02', 'file2']);
  assert.deepEqual(names([...entries].reverse()), names(entries));
});
