import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginWithRunbookSources, sourcesFromRunbook } from '../src/runbook-sources.mjs';

const plugin = {
  pluginType: 'server',
  pluginInstanceId: 'server-app',
  displayName: '应用服务器',
  sources: [],
};

test('README registers human-readable log and config locations for one Server plugin', () => {
  const content = `# 华东正式

## 日志与配置

### 应用服务器
- 日志目录：\`/var/log/my-app\`
- 配置目录：\`/etc/my-app\`

### 日志归档节点
- 日志目录：\`/srv/archive\`
`;
  const sources = sourcesFromRunbook(content, plugin);
  assert.deepEqual(sources.map(({ kind, root }) => ({ kind, root })), [
    { kind: 'log', root: '/var/log/my-app' },
    { kind: 'config', root: '/etc/my-app' },
  ]);
  assert.deepEqual(sources[0].patterns, [
    '*.log', '*.txt', '*.log.*', '*.txt.gz', '*.out', '*.out.gz', '*.zip', '*.gz',
  ]);
  assert.equal(sources[1].redactSecrets, true);
});

test('README source parser ignores unsafe paths and deduplicates legacy plugin sources', () => {
  const content = `### 应用服务器
- 日志目录：\`/var/log/my-app\`
- 配置目录：\`/etc/../root\`
`;
  const value = pluginWithRunbookSources({ ...plugin, sources: [{ sourceId: 'logs', displayName: '日志', kind: 'log', root: '/var/log/my-app', patterns: ['*.log'], maxFileBytes: 1024 }] }, content);
  assert.equal(value.sources.length, 1);
  assert.equal(value.sources[0].sourceId, 'logs');
});

test('README locations only apply to an exactly named Server plugin section', () => {
  const content = `### 其他服务器
- 日志目录：\`/var/log/my-app\`
`;
  assert.deepEqual(sourcesFromRunbook(content, plugin), []);
  assert.deepEqual(sourcesFromRunbook(content, { ...plugin, pluginType: 'mysql' }), []);
});
