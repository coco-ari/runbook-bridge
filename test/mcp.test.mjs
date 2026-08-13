import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureBrokerToken } from '../src/broker-auth.mjs';
import { BrokerServer } from '../src/broker-server.mjs';
import { AppError } from '../src/errors.mjs';
import { ProjectStore } from '../src/project-store.mjs';

async function startMcpClient(t, root, name = 'ai-ops-test') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp.mjs')],
    env: { ...process.env, AI_OPS_DATA_DIR: root },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close().catch(() => undefined));
  return client;
}

function commandResult(command, index, overrides = {}) {
  const stdout = overrides.stdout ?? `stdout:${command}`;
  const stderr = overrides.stderr ?? '';
  return {
    exitCode: overrides.exitCode ?? 0,
    signal: overrides.signal ?? null,
    stdout,
    stderr,
    operationId: `operation-${index}`,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    outputLimitBytes: 512 * 1024,
    truncated: false,
    auditWarning: false,
  };
}

async function startBatchFixture(t, execute) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-batch-mcp-'));
  const store = new ProjectStore(root);
  await store.create({
    id: 'batch-project',
    name: '批量执行测试',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const token = await ensureBrokerToken(root);
  const broker = {
    execute,
    status() { return { connected: true, generation: 1 }; },
    listStatuses() { return { 'batch-project': { connected: true, generation: 1 } }; },
  };
  const brokerServer = new BrokerServer({ dataRoot: root, token, broker, appVersion: '0.3.0' });
  await brokerServer.start();
  t.after(async () => {
    await brokerServer.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return startMcpClient(t, root, 'execute-batch-test');
}

test('execute and execute_batch wait longer than the configured Broker command timeout', async () => {
  const source = await fs.readFile('src/mcp.mjs', 'utf8');
  assert.match(source, /COMMAND_BROKER_TIMEOUT_MS = 3600 \* 1000 \+ 30_000/);
  assert.match(source, /callBroker\(dataRoot, 'execute', args, COMMAND_BROKER_TIMEOUT_MS\)/);
  assert.match(source, /}, COMMAND_BROKER_TIMEOUT_MS\)/);
  assert.doesNotMatch(source, /store\.get\(projectId\)/);
});

test('MCP advertises execute_batch with a bounded strict schema and returns README before server operations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'demo-project',
    name: '演示项目',
    ssh: { host: '127.0.0.1', port: 22, username: 'demo' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const client = await startMcpClient(t, root);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ['list_projects', 'open_project', 'execute', 'execute_batch', 'upload', 'download', 'search_logs'],
  );
  const batchTool = listed.tools.find((tool) => tool.name === 'execute_batch');
  assert.deepEqual(batchTool.inputSchema.required, ['projectId', 'contextToken', 'commands']);
  assert.equal(batchTool.inputSchema.additionalProperties, false);
  assert.equal(batchTool.inputSchema.properties.commands.minItems, 1);
  assert.equal(batchTool.inputSchema.properties.commands.maxItems, 10);
  assert.equal(batchTool.inputSchema.properties.commands.items.additionalProperties, false);
  assert.deepEqual(batchTool.inputSchema.properties.commands.items.required, ['command']);
  assert.equal(batchTool.inputSchema.properties.commands.items.properties.command.maxLength, 16_384);
  assert.equal(batchTool.inputSchema.properties.commands.items.properties.workingDirectory.maxLength, 4096);
  assert.equal(batchTool.inputSchema.properties.stopOnError.default, true);
  const projects = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.equal(projects.isError, false);
  assert.equal('accessMode' in projects.structuredContent.projects[0], false);
  assert.equal('displayTimezone' in projects.structuredContent.projects[0], false);
  assert.equal('logRootCount' in projects.structuredContent.projects[0], false);
  const opened = await client.callTool({ name: 'open_project', arguments: { projectId: project.id } });
  assert.equal(opened.isError, false);
  assert.equal('accessMode' in opened.structuredContent, false);
  assert.equal('displayTimezone' in opened.structuredContent, false);
  assert.equal('allowedLogRoots' in opened.structuredContent, false);
  assert.equal(opened.structuredContent.connected, false);
  assert.equal(opened.structuredContent.contextToken, null);
  assert.equal(opened.structuredContent.documents[0].name, 'README.md');
  assert.match(opened.structuredContent.documents[0].content, /部署流程/);
});

test('Electron can run MCP directly in lightweight Node mode without a GUI parent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-electron-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const electron = path.resolve('node_modules/electron/dist/electron.exe');
  const transport = new StdioClientTransport({
    command: electron,
    args: [path.resolve('src/mcp.mjs')],
    env: { ...process.env, AI_OPS_DATA_DIR: root, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'electron-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 7);
});

test('execute_batch runs commands sequentially and stops on the first non-zero exit by default', async (t) => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const client = await startBatchFixture(t, async (_projectId, _contextToken, command, workingDirectory) => {
    const index = calls.length;
    calls.push({ command, workingDirectory });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, command === 'first' ? 20 : 5));
    active -= 1;
    return commandResult(command, index, { exitCode: command === 'non-zero' ? 7 : 0 });
  });

  const response = await client.callTool({
    name: 'execute_batch',
    arguments: {
      projectId: 'batch-project',
      contextToken: 'context-token',
      commands: [
        { command: 'first', workingDirectory: '/srv/first' },
        { command: 'non-zero' },
        { command: 'must-not-run' },
      ],
    },
  });

  assert.equal(response.isError, false);
  const batch = response.structuredContent;
  assert.match(batch.batchId, /^[0-9a-f-]{36}$/i);
  assert.equal(batch.stopOnError, true);
  assert.equal(batch.requestedCount, 3);
  assert.equal(batch.executedCount, 2);
  assert.equal(batch.stoppedEarly, true);
  assert.deepEqual(calls, [
    { command: 'first', workingDirectory: '/srv/first' },
    { command: 'non-zero', workingDirectory: undefined },
  ]);
  assert.equal(maxActive, 1);
  assert.equal(batch.results[0].index, 0);
  assert.equal(batch.results[0].ok, true);
  assert.equal(batch.results[1].index, 1);
  assert.equal(batch.results[1].ok, false);
  assert.equal(batch.results[1].exitCode, 7);
  assert.equal(batch.results[1].error.code, 'COMMAND_EXIT_NONZERO');
  assert.equal(batch.results[1].operationId, 'operation-1');
});

test('execute_batch stops on COMMAND_BLOCKED by default and can continue explicitly', async (t) => {
  await t.test('default stop', async (t) => {
    const calls = [];
    const client = await startBatchFixture(t, async (_projectId, _contextToken, command) => {
      const index = calls.length;
      calls.push(command);
      if (command === 'blocked') {
        throw new AppError('COMMAND_BLOCKED', '命令已被安全策略拦截。', {
          ruleId: 'FILE_DELETE',
          operationId: `operation-${index}`,
        });
      }
      return commandResult(command, index);
    });

    const response = await client.callTool({
      name: 'execute_batch',
      arguments: {
        projectId: 'batch-project',
        contextToken: 'context-token',
        commands: [{ command: 'first' }, { command: 'blocked' }, { command: 'must-not-run' }],
      },
    });

    assert.equal(response.isError, false);
    assert.deepEqual(calls, ['first', 'blocked']);
    assert.equal(response.structuredContent.stoppedEarly, true);
    assert.equal(response.structuredContent.results[1].ok, false);
    assert.equal(response.structuredContent.results[1].error.code, 'COMMAND_BLOCKED');
    assert.equal(response.structuredContent.results[1].error.details.ruleId, 'FILE_DELETE');
  });

  await t.test('explicit continue', async (t) => {
    const calls = [];
    const client = await startBatchFixture(t, async (_projectId, _contextToken, command) => {
      const index = calls.length;
      calls.push(command);
      if (command === 'blocked') {
        throw new AppError('COMMAND_BLOCKED', '命令已被安全策略拦截。', {
          ruleId: 'FILE_DELETE',
          operationId: `operation-${index}`,
        });
      }
      return commandResult(command, index, { exitCode: command === 'non-zero' ? 3 : 0 });
    });

    const response = await client.callTool({
      name: 'execute_batch',
      arguments: {
        projectId: 'batch-project',
        contextToken: 'context-token',
        stopOnError: false,
        commands: [
          { command: 'blocked' },
          { command: 'non-zero' },
          { command: 'last' },
        ],
      },
    });

    assert.equal(response.isError, false);
    const batch = response.structuredContent;
    assert.equal(batch.stopOnError, false);
    assert.equal(batch.stoppedEarly, false);
    assert.equal(batch.executedCount, 3);
    assert.deepEqual(calls, ['blocked', 'non-zero', 'last']);
    assert.deepEqual(batch.results.map((result) => result.ok), [false, false, true]);
    assert.equal(batch.results[0].error.code, 'COMMAND_BLOCKED');
    assert.equal(batch.results[1].error.code, 'COMMAND_EXIT_NONZERO');
  });
});

test('execute_batch enforces the command count and a one MiB aggregate UTF-8 output budget', async (t) => {
  const calls = [];
  // 510 KB per stream stays below SshBroker.execute's 512 KB stream limit,
  // while two commands still exceed the batch-wide one MiB response budget.
  const largeOutput = '中'.repeat(170_000);
  const client = await startBatchFixture(t, async (_projectId, _contextToken, command) => {
    const index = calls.length;
    calls.push(command);
    return commandResult(command, index, { stdout: largeOutput, stderr: largeOutput });
  });

  const oversized = await client.callTool({
    name: 'execute_batch',
    arguments: {
      projectId: 'batch-project',
      contextToken: 'context-token',
      commands: Array.from({ length: 11 }, (_, index) => ({ command: `command-${index}` })),
    },
  });
  assert.equal(oversized.isError, true);
  assert.equal(oversized.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(calls, []);

  const response = await client.callTool({
    name: 'execute_batch',
    arguments: {
      projectId: 'batch-project',
      contextToken: 'context-token',
      stopOnError: false,
      commands: [{ command: 'large-one' }, { command: 'large-two' }],
    },
  });

  assert.equal(response.isError, false);
  const batch = response.structuredContent;
  assert.equal(batch.outputLimitBytes, 1024 * 1024);
  assert.ok(batch.outputBytes <= batch.outputLimitBytes);
  assert.equal(batch.outputTruncated, true);
  const returnedOutputBytes = batch.results.reduce(
    (total, result) => total
      + Buffer.byteLength(result.stdout ?? '', 'utf8')
      + Buffer.byteLength(result.stderr ?? '', 'utf8'),
    0,
  );
  assert.equal(returnedOutputBytes, batch.outputBytes);
  assert.ok(returnedOutputBytes <= 1024 * 1024);
  assert.doesNotMatch(batch.results.map((result) => `${result.stdout}${result.stderr}`).join(''), /\uFFFD/u);
  assert.deepEqual(calls, ['large-one', 'large-two']);
});
