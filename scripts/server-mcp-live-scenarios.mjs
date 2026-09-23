import { loadProbeRuntime } from './server-probe-runtime.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const { BrokerServer } = await loadProbeRuntime('broker-server.mjs');
const { rotateBrokerToken } = await loadProbeRuntime('broker-auth.mjs');
const { WorkspaceStore } = await loadProbeRuntime('workspace-store.mjs');
const { ServerOperations } = await loadProbeRuntime('server-operations.mjs');
const { V2Service } = await loadProbeRuntime('v2-service.mjs');
const { EnvironmentContextManager } = await loadProbeRuntime('context-manager.mjs');
const { ConfirmationManager } = await loadProbeRuntime('confirmation-manager.mjs');

// 配置和凭据仅在内存；磁盘只保存本次合成项目、正式 Broker 令牌、下载及审计，结束后删除。
export async function runMcpScenarios({ runtime, plugin, store, scope, root, owned, localRoot, localNames, measure, forbiddenValues, packaged = false }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u); assert.ok(owned.has(root));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-mcp-probe-'));
  const disk = new WorkspaceStore(dataRoot);
  const originalAudit = store.appendAudit, originalProjectDir = store.projectDir, previousSources = plugin.sources;
  let broker, contexts, confirmations, operations, token;
  const clients = [], responses = []; let stderrBytes = 0;
  const forbidden = [...forbiddenValues];
  const safe = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); assert.ok(!forbidden.some(secret => secret && text.includes(secret)), '凭据或 Broker 令牌不能进入结果或审计'); };
  const remote = name => { assert.match(name, /^mcp-[a-z-]+\.(?:txt|log)$/u); return root + '/' + name; };
  try {
    await disk.init({ migrateLegacy: false });
    const project = await disk.createProject({ projectId: scope.projectId, environmentId: scope.environmentId, name: '隔离 MCP 实测', environmentName: '合成环境', runbook: '' });
    assert.equal(project.projectId, scope.projectId);
    token = await rotateBrokerToken(dataRoot); forbidden.push(token);
    store.appendAudit = async (projectId, entry) => { safe(entry); await originalAudit(projectId, entry); return disk.appendAudit(projectId, entry); };
    store.projectDir = projectId => { assert.equal(projectId, scope.projectId); return disk.projectDir(projectId); };
    plugin.sources = [
      { sourceId: 'probe-log', displayName: '合成日志', kind: 'log', root, patterns: ['events.log'], maxFileBytes: 1048576 },
      { sourceId: 'probe-config', displayName: '合成配置', kind: 'config', root, patterns: ['settings.conf'], maxFileBytes: 1048576 },
    ];
    const scopedStore = { ...store,
      getProject: disk.getProject.bind(disk), getEnvironment: disk.getEnvironment.bind(disk),
      listProjects: disk.listProjects.bind(disk), listEnvironments: disk.listEnvironments.bind(disk), readRunbook: disk.readRunbook.bind(disk),
      listPlugins: async (projectId, environmentId) => { assert.equal(projectId, scope.projectId); assert.equal(environmentId, scope.environmentId); return [plugin]; },
      publicPlugin: disk.publicPlugin.bind(disk),
    };
    contexts = new EnvironmentContextManager(scopedStore); confirmations = new ConfirmationManager(); operations = new ServerOperations(runtime, scopedStore);
    const connectionManager = { snapshot: () => ({ projectId: scope.projectId, environmentId: scope.environmentId, phase: 'connected', plugins: { [scope.pluginInstanceId]: { phase: runtime.status(plugin).connected ? 'connected' : 'disconnected' } } }) };
    const service = new V2Service({ workspaceStore: scopedStore, connectionManager, contextManager: contexts, confirmationManager: confirmations, serverOperations: operations });
    broker = new BrokerServer({ dataRoot, token, v2Service: service }); await broker.start();
    async function openClient() {
      const executable = packaged ? path.resolve('dist/win-unpacked/Agent运维工作台.exe') : process.execPath;
      const entry = packaged ? path.resolve('dist/win-unpacked/resources/app.asar/src/mcp-v2.mjs') : path.resolve('src/mcp-v2.mjs');
      const environment = { AI_OPS_DATA_DIR: dataRoot, ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
      const transport = new StdioClientTransport({ command: executable, args: [entry], env: environment, stderr: 'pipe' });
      const client = new Client({ name: 'owned-live-probe', version: '1.0.0' }); clients.push(client);
      transport.stderr?.on('data', chunk => { stderrBytes += chunk.length; safe(chunk.toString()); });
      await client.connect(transport); return client;
    }
    const client = await measure('mcp.connect-stdio-' + (packaged ? 'packaged' : 'source'), openClient);
    async function call(name, args = {}, target = client) {
      const result = await target.callTool({ name, arguments: args }); safe(result); responses.push(result);
      assert.ok(result.structuredContent && result.content[0]?.type === 'text');
      if (!result.isError) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return result.structuredContent;
    }
    async function ok(name, args = {}, target = client) { const result = await call(name, args, target); assert.notEqual(result.ok, false); return result; }
    async function fails(name, args, code, target = client) { const result = await call(name, args, target); assert.equal(result.ok, false); assert.equal(result.error.code, code); return result.error; }
    await measure('mcp.manifest-and-discovery', async () => {
      assert.equal((await client.listTools()).tools.length, 40); assert.equal(client.getServerVersion().name, 'agent-ops-workbench');
      assert.equal((await ok('list_projects')).projects.length, 1);
      assert.equal((await ok('list_environments', { projectId: scope.projectId })).environments.length, 1);
    });
    const opened = await measure('mcp.open-environment', async () => {
      const result = await ok('open_environment', { projectId: scope.projectId, environmentId: scope.environmentId });
      assert.equal(result.runtime.buildId, result.mcpRuntime.buildId);
      if (packaged) assert.match(result.runtime.buildId, /^[a-f0-9]{64}$/u);
      else assert.equal(result.runtime.buildId, 'development');
      assert.equal(result.runtimeWarning, undefined);
      return result;
    });
    const params = { ...scope, contextToken: opened.contextToken };
    const read = selected => ok('server_read_file', { ...params, path: selected, maxBytes: 65536 });
    await measure('mcp.broker-rejects-wrong-token', async () => {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(broker.endpoint); let output = '';
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('认证检查超时')); });
        socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ id: 'probe', auth: 'invalid-probe-auth', method: 'info', params: {} }) + '\n'));
        socket.on('data', chunk => { output += chunk; if (!output.includes('\n')) return; try { const result = JSON.parse(output.trim()); assert.equal(result.error.code, 'BROKER_UNAUTHORIZED'); socket.destroy(); resolve(); } catch (error) { socket.destroy(); reject(error); } });
      });
    });
    await measure('mcp.context-and-second-client', async () => {
      await fails('server_read_file', { ...params, contextToken: 'missing-context-token', path: root + '/settings.conf' }, 'CONTEXT_REQUIRED');
      const other = await openClient();
      await fails('server_read_file', { ...params, path: root + '/settings.conf' }, 'CLIENT_CONTEXT_MISMATCH', other);
    });
    await measure('mcp.descriptors-and-registered-reads', async () => {
      assert.ok((await ok('server_list_actions', params)).actions.length > 0);
      assert.equal((await ok('server_list_sources', params)).sources.length, 2);
      const logs = await ok('server_list_files', { ...params, sourceId: 'probe-log' });
      const configs = await ok('server_list_files', { ...params, sourceId: 'probe-config' });
      assert.equal((await ok('server_read_log', { ...params, fileId: logs.files[0].fileId, tail: false, maxBytes: 65536 })).content, 'INFO probe-ready\nWARN probe-delay\nERROR probe-failed\n');
      assert.equal((await ok('server_read_config', { ...params, fileId: configs.files[0].fileId })).content, 'probe_enabled=true\nprobe_mode=synthetic\n');
    });
    await measure('mcp.directory-pagination-stat-find-search', async () => {
      const first = await ok('server_list_directory', { ...params, path: root, limit: 1 }); assert.ok(first.nextCursor);
      const second = await ok('server_list_directory', { ...params, path: root, limit: 1, cursor: first.nextCursor }); assert.equal(second.nextCursor, null);
      assert.notEqual(first.entries[0].name, second.entries[0].name);
      assert.equal((await ok('server_stat', { ...params, path: root + '/settings.conf' })).type, 'file');
      assert.equal((await ok('server_find_files', { ...params, path: root, pattern: '*.conf', maxDepth: 0 })).files.length, 1);
      assert.equal((await ok('server_search_files', { ...params, path: root, pattern: '*.conf', contains: 'probe_', maxDepth: 0 })).matchCount, 2);
    });
    function guard(name, args) {
      if (name === 'server_execute_shell') { assert.equal(args.command, "printf '%s' 'mcp-shell-probe'"); assert.equal(args.workingDirectory, root); return; }
      assert.ok(['server_write_file', 'server_upload_file', 'server_move_path', 'server_delete_path'].includes(name));
      const selected = name === 'server_move_path' ? [args.sourcePath, args.destinationPath] : [args.path ?? args.remotePath];
      for (const target of selected) assert.ok(target.startsWith(root + '/mcp-') && path.posix.dirname(target) === root);
      if (name === 'server_move_path' || name === 'server_delete_path') assert.ok(owned.has(selected[0]));
      if (args.overwrite) assert.ok(owned.has(selected.at(-1)));
      if (name === 'server_upload_file') { assert.equal(path.dirname(args.localPath), localRoot); assert.ok(localNames.has(path.basename(args.localPath))); }
    }
    async function pending(name, args) { guard(name, args); const error = await fails(name, { ...params, ...args }, 'CONFIRMATION_REQUIRED'); assert.ok(error.details.requestId); return error.details.requestId; }
    function track(name, args) {
      if (name === 'server_write_file' || name === 'server_upload_file') owned.add(args.path ?? args.remotePath);
      if (name === 'server_move_path') { owned.delete(args.sourcePath); owned.add(args.destinationPath); }
      if (name === 'server_delete_path') owned.delete(args.path);
    }
    async function approved(name, args) {
      const requestId = await pending(name, args); confirmations.approve(requestId);
      const result = await ok(name, { ...params, ...args }); track(name, args);
      assert.equal((await ok('get_confirmation_status', { ...params, confirmationId: requestId })).status, 'succeeded');
      return result;
    }
    const writeArgs = { path: remote('mcp-write.txt'), content: 'mcp synthetic body 中文\n' };
    await measure('mcp.confirmation-long-poll-and-write', async () => {
      const requestId = await pending('server_write_file', writeArgs);
      assert.equal(await pending('server_write_file', writeArgs), requestId);
      const waiting = ok('get_confirmation_status', { ...params, confirmationId: requestId, waitMs: 1000 });
      await delay(50); confirmations.approve(requestId);
      assert.equal((await waiting).status, 'approved');
      await ok('server_write_file', { ...params, ...writeArgs }); track('server_write_file', writeArgs);
      assert.equal((await read(writeArgs.path)).content, writeArgs.content);
      assert.equal((await ok('get_confirmation_status', { ...params, confirmationId: requestId })).status, 'succeeded');
    });
    await measure('mcp.confirmed-overwrite', async () => {
      await approved('server_write_file', { ...writeArgs, content: 'mcp replacement\n', overwrite: true });
      assert.equal((await read(writeArgs.path)).content, 'mcp replacement\n');
    });
    await measure('mcp.changed-approval-parameters-rejected', async () => {
      const args = { path: remote('mcp-parameter.txt'), content: 'approved synthetic body' }, id = await pending('server_write_file', args);
      const { approvalToken } = confirmations.approve(id);
      await fails('server_write_file', { ...params, ...args, content: 'changed synthetic body', approvalToken }, 'CONFIRMATION_SCOPE_MISMATCH');
      await fails('server_stat', { ...params, path: args.path }, 'SOURCE_NOT_FOUND');
    });
    await measure('mcp.upload-download-and-content', async () => {
      const name = 'mcp-upload.txt', localPath = path.join(localRoot, name); localNames.add(name);
      await fs.writeFile(localPath, 'mcp upload synthetic body\n', { flag: 'wx', mode: 0o600 });
      await approved('server_upload_file', { localPath, remotePath: remote(name) });
      const result = await ok('server_download_file', { ...params, path: remote(name) });
      assert.equal(path.dirname(result.savedAs), path.join(disk.projectDir(scope.projectId), 'downloads', scope.environmentId, scope.pluginInstanceId));
      assert.equal(await fs.readFile(result.savedAs, 'utf8'), 'mcp upload synthetic body\n');
    });
    await measure('mcp.move-overwrite-and-delete', async () => {
      await approved('server_move_path', { sourcePath: writeArgs.path, destinationPath: remote('mcp-upload.txt'), overwrite: true });
      assert.equal((await read(remote('mcp-upload.txt'))).content, 'mcp replacement\n');
      await approved('server_delete_path', { path: remote('mcp-upload.txt') });
      await fails('server_stat', { ...params, path: remote('mcp-upload.txt') }, 'SOURCE_NOT_FOUND');
    });
    await measure('mcp.shell-strong-confirmation', async () => {
      const args = { command: "printf '%s' 'mcp-shell-probe'", workingDirectory: root }, id = await pending('server_execute_shell', args);
      assert.equal(confirmations.pending.get(id).approvalLevel, 'strong'); confirmations.approve(id);
      const result = await ok('server_execute_shell', { ...params, ...args }); assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'mcp-shell-probe');
    });
    const logPath = remote('mcp-budget.log');
    const logLines = Array.from({ length: 160 }, (_, index) => 'hit ' + index + ' ' + crypto.randomBytes(128).toString('hex'));
    await approved('server_write_file', { path: logPath, content: logLines.join('\n') + '\n' });
    const query = { ...params, path: logPath, queries: ['hit'], maxMatches: 500, maxScanBytes: 65536, maxExpandedBytes: 65536, maxResultBytes: 16384, beforeLines: 0, afterLines: 0 };
    await measure('mcp.log-result-budget-and-cursor', async () => {
      let cursor; const matches = [];
      for (let page = 0; page < 20; page += 1) {
        const result = await ok('server_search_logs', { ...query, ...(cursor ? { cursor } : {}) });
        assert.equal(result.limitsApplied.maxResultBytes, 16384); assert.ok(result.resultBytes <= 16384);
        matches.push(...result.matches.map(match => match.text)); cursor = result.nextCursor;
        if (page === 0 && cursor) await fails('server_search_logs', { ...query, cursor, maxResultBytes: 32768 }, 'LOG_CURSOR_MISMATCH');
        if (!cursor) { assert.equal(result.status, 'complete'); break; }
      }
      assert.equal(cursor, null); assert.deepEqual(matches, logLines);
      await fails('server_search_logs', { ...query, maxResultBytes: 1 }, 'INVALID_ARGUMENT');
    });
    await measure('mcp.context-invalidation', async () => {
      contexts.invalidateEnvironment(scope.projectId, scope.environmentId);
      await fails('server_read_file', { ...params, path: root + '/settings.conf' }, 'CONTEXT_REQUIRED');
    });
    await measure('mcp.persisted-audit-and-response-hygiene', async () => {
      const auditFile = path.join(disk.projectDir(scope.projectId), 'audit', 'operations-v3.jsonl');
      const text = await fs.readFile(auditFile, 'utf8'); safe(text); assert.ok(!text.includes(writeArgs.content.trim()));
      const result = await disk.listAudit(scope.projectId, { environmentId: scope.environmentId, pluginInstanceId: scope.pluginInstanceId, limit: 200 });
      assert.ok(result.entries.some(entry => entry.capability === 'fs.write' && entry.result === 'success'));
      assert.ok(result.entries.some(entry => entry.errorCode === 'CONFIRMATION_SCOPE_MISMATCH'));
      assert.ok(result.entries.some(entry => entry.capability === 'fs.delete' && entry.result === 'success'));
      assert.ok(responses.length > 30); assert.equal(stderrBytes, 0);
    });
  } finally {
    const closed = await Promise.allSettled(clients.map(client => client.close()));
    await broker?.stop(); contexts?.clear(); confirmations?.invalidateEnvironment(scope.projectId, scope.environmentId); operations?.docker.dispose();
    store.appendAudit = originalAudit; if (originalProjectDir) store.projectDir = originalProjectDir; else delete store.projectDir; plugin.sources = previousSources;
    await measure('mcp.cleanup-isolated-local-state', async () => {
      assert.ok(closed.every(result => result.status === 'fulfilled'));
      const actual = await fs.realpath(dataRoot); assert.equal(actual, path.resolve(dataRoot));
      assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir())); assert.match(path.basename(actual), /^runbook-mcp-probe-[A-Za-z0-9]+$/u);
      await fs.rm(actual, { recursive: true, force: true });
      await assert.rejects(fs.stat(dataRoot), { code: 'ENOENT' });
    });
  }
}
