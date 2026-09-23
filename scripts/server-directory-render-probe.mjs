import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compareServerDirectoryEntries, displayServerDirectoryEntries } from '../renderer/v2/src/features/server-workspace/workspace-model.ts';

// 仅测量合成目录数据的视图计算，不连接服务器；耗时不代表完整点击到绘制延迟。
const directories = Array.from({ length: 25 }, (_, directory) => Array.from({ length: 200 }, (_, index) => ({
  name: (index % 17 ? 'file' : '.hidden') + ((index * 137) % 200) + '.txt',
  path: '/' + directory + '/' + index, type: index % 9 ? 'file' : 'directory',
})));
const previous = entries => entries.filter(entry => !entry.name.startsWith('.')).sort(compareServerDirectoryEntries);
for (const entries of directories) assert.deepEqual(displayServerDirectoryEntries(entries, false), previous(entries));
for (const [label, render] of [['previous', previous], ['cached', entries => displayServerDirectoryEntries(entries, false)]]) {
  const samples = [];
  for (let run = 0; run < 300; run += 1) {
    const start = performance.now();
    for (const entries of directories) render(entries);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  console.log(JSON.stringify({ label, directories: 25, entries: 5000, iterations: samples.length,
    medianMs: Number(samples[150].toFixed(4)), p95Ms: Number(samples[285].toFixed(4)) }));
}
