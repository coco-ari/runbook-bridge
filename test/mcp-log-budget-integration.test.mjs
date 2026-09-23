import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrokerServer } from '../src/broker-server.mjs';
import { rotateBrokerToken } from '../src/broker-auth.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';

// 使用真实 stdio MCP、Broker 和日志服务，只替换远端文件读取，防止中间层悄悄丢弃预算。
test('MCP 日志正文预算经 Broker 生效，分页完整且游标绑定预算', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-mcp-budget-'));
  let client, broker, contexts;
  t.after(async () => {
    await client?.close(); await broker?.stop(); contexts?.clear();
    const checked = await fs.realpath(root);
    assert.equal(checked, path.resolve(root)); assert.equal(path.dirname(checked), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('runbook-mcp-budget-'));
    await fs.rm(checked, { recursive: true, force: true });
  });
  const scope = { projectId: 'project', environmentId: 'environment', pluginInstanceId: 'server' };
  const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '测试服务器', sources: [] };
  const lines = Array.from({ length: 120 }, (_, index) => `hit ${index} ${'中文合成内容'.repeat(12)}`);
  const content = Buffer.from(lines.join('\n') + '\n'); let reads = 0, sessions = 0;
  const file = { type: 'file', path: '/fixture.log', canonicalPath: '/fixture.log', size: content.length, mtime: 1, mode: 0o100644 };
  const operations = new ServerOperations({ withRemoteReadSession: async (_plugin, action) => {
    sessions += 1;
    return action({ statPath: async () => file, readBuffer: async (_path, start = 0, bytes = content.length) => {
      reads += 1; const end = Math.min(content.length, start + bytes);
      return { ...file, content: content.subarray(start, end), startByte: start, endByte: end, truncated: end < content.length };
    } });
  } }, {});
  const store = { getPlugin: async () => plugin, listPlugins: async () => [plugin], getProject: async () => ({ name: '测试' }),
    getEnvironment: async () => ({ ...scope, name: '测试环境' }), readRunbook: async () => ({ content: '', hash: 'fixture', empty: true }),
    publicPlugin: value => value, appendAudit: async () => undefined };
  contexts = new EnvironmentContextManager(store);
  const service = new V2Service({ workspaceStore: store, contextManager: contexts, serverOperations: operations,
    connectionManager: { snapshot: () => ({ plugins: { server: { phase: 'connected' } } }) } });
  broker = new BrokerServer({ dataRoot: root, token: await rotateBrokerToken(root), v2Service: service }); await broker.start();
  client = new Client({ name: 'budget-regression', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp-v2.mjs')], env: { AI_OPS_DATA_DIR: root }, stderr: 'pipe' }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('open_environment', { projectId: scope.projectId, environmentId: scope.environmentId });
  const args = { ...scope, contextToken: opened.contextToken, path: '/fixture.log', queries: ['hit'], maxMatches: 500, maxScanBytes: 65536, maxExpandedBytes: 65536, maxResultBytes: 16384, beforeLines: 0, afterLines: 0 };
  const first = await call('server_search_logs', args);
  assert.equal(first.limitsApplied.maxResultBytes, 16384); assert.ok(first.resultBytes <= 16384); assert.ok(first.nextCursor);
  const initialReads = reads;
  const changed = await call('server_search_logs', { ...args, cursor: first.nextCursor, maxResultBytes: 32768 });
  assert.equal(changed.error.code, 'LOG_CURSOR_MISMATCH'); assert.equal(reads, initialReads);
  const matched = first.matches.map(match => match.text); let cursor = first.nextCursor;
  for (let page = 0; cursor && page < 10; page += 1) {
    const next = await call('server_search_logs', { ...args, cursor });
    assert.equal(next.limitsApplied.maxResultBytes, 16384); assert.ok(next.resultBytes <= 16384);
    matched.push(...next.matches.map(match => match.text)); cursor = next.nextCursor;
    if (!cursor) assert.equal(next.status, 'complete');
  }
  assert.equal(cursor, null); assert.deepEqual(matched, lines); assert.equal(reads, initialReads);
  const beforeInvalid = sessions;
  const invalid = await call('server_search_logs', { ...args, maxResultBytes: 1 });
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT'); assert.equal(sessions, beforeInvalid);
});
