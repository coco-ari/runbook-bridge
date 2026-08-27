import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ServerOperations } from '../src/server-operations.mjs';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';
import { RedisPluginRuntime } from '../src/redis-plugin-runtime.mjs';

function assertCursorMatchesSchema(tool, cursor) {
  const schema = tool.inputSchema.properties.cursor;
  const stringSchema = schema.type === 'string'
    ? schema
    : schema.oneOf.find((candidate) => candidate.type === 'string');
  assert.ok(stringSchema);
  assert.equal(typeof cursor, 'string');
  assert.ok(cursor.length >= stringSchema.minLength);
  assert.ok(cursor.length <= stringSchema.maxLength);
  assert.match(cursor, new RegExp(stringSchema.pattern, 'u'));
}

test('V2 MCP exposes unrestricted bounded reads and confirmation-gated server changes', async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp-v2.mjs')], stderr: 'pipe' });
  const client = new Client({ name: 'mcp-v2-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close().catch(() => undefined));
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(client.getServerVersion(), { name: 'agent-ops-workbench', version: manifest.version });
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes('open_environment'));
  assert.ok(names.includes('server_run_action'));
  assert.ok(names.includes('mysql_query_readonly'));
  assert.ok(names.includes('redis_scan'));
  for (const name of ['server_stat','server_list_directory','server_find_files','server_read_file','server_search_files','server_system_snapshot','server_service_inspect','server_journal_query','server_container_inspect','server_upload_file','server_control_service','server_execute_shell']) assert.ok(names.includes(name));
  assert.ok(!names.some((name) => /execute_command|raw|connect/.test(name)));
  const addPlugin = listed.tools.find((tool) => tool.name === 'add_plugin');
  assert.ok(addPlugin.inputSchema.required.includes('configuration'));
  assert.doesNotMatch(addPlugin.description,/草稿/u);
  const serverAction = listed.tools.find((tool) => tool.name === 'server_run_action');
  assert.deepEqual(serverAction.inputSchema.properties.actionId.enum, ['system.summary', 'process.summary', 'network.listen', 'filesystem.usage', 'service.status']);
  assert.equal('command' in serverAction.inputSchema.properties, false);
  const shell = listed.tools.find((tool) => tool.name === 'server_execute_shell');
  assert.equal(shell.inputSchema.properties.command.maxLength, 16_384);
  assert.ok(shell.description.includes('确认'));
  const mysql = listed.tools.find((tool) => tool.name === 'mysql_query_readonly');
  assert.equal('host' in mysql.inputSchema.properties, false);
  assert.equal('database' in mysql.inputSchema.properties, false);
  assert.equal(mysql.inputSchema.properties.sql.maxLength, 65_536);

  const offsetCursorToolNames = [
    'server_list_files',
    'server_read_log',
    'server_read_config',
    'server_list_directory',
    'server_read_file',
    'mysql_list_tables',
  ];
  for (const name of offsetCursorToolNames) {
    const cursorTool = listed.tools.find((item) => item.name === name);
    const cursorSchema = cursorTool.inputSchema.properties.cursor;
    assert.deepEqual(cursorSchema.oneOf.map((candidate) => candidate.type), ['string', 'integer']);
    assert.equal(cursorSchema.oneOf[1].minimum, 0);
    assert.equal(cursorSchema.oneOf[1].maximum, Number.MAX_SAFE_INTEGER);
    assert.match(cursorSchema.description, /nextCursor/u);
  }
  const redisCursorSchema = listed.tools.find((item) => item.name === 'redis_scan').inputSchema.properties.cursor;
  assert.equal(redisCursorSchema.type, 'string');
  assert.match(redisCursorSchema.description, /nextCursor/u);

  const serverStarts = [];
  const serverRuntime = {
    readRemoteRange:async (_plugin, remotePath, start, maxBytes) => {
      serverStarts.push(start);
      const content = Buffer.from('abcdef');
      const end = Math.min(start + maxBytes, content.length);
      return {
        canonicalPath:remotePath,
        content:content.subarray(start, end).toString('utf8'),
        startByte:start,
        endByte:end,
        size:content.length,
        mtime:1,
        truncated:end < content.length,
      };
    },
  };
  const serverOperations = new ServerOperations(serverRuntime, {});
  const serverPlugin = {limits:{maxBytes:65_536}};
  const firstFilePage = await serverOperations.readFile(serverPlugin, {path:'/logs/app.log', maxBytes:2});
  const serverReadFile = listed.tools.find((item) => item.name === 'server_read_file');
  assertCursorMatchesSchema(serverReadFile, firstFilePage.nextCursor);
  await serverOperations.readFile(serverPlugin, {path:'/logs/app.log', cursor:firstFilePage.nextCursor, maxBytes:2});
  await serverOperations.readFile(serverPlugin, {path:'/logs/app.log', cursor:2, maxBytes:2});
  assert.deepEqual(serverStarts, [0, 2, 2]);

  const mysqlOffsets = [];
  const mysqlRuntime = new MysqlPluginRuntime({}, {}, {});
  mysqlRuntime.querySession = async (_plugin, request) => {
    const requestedLimit = request.values[1];
    const offset = request.values[2];
    mysqlOffsets.push(offset);
    const rows = [
      {TABLE_NAME:'alpha', TABLE_TYPE:'BASE TABLE'},
      {TABLE_NAME:'beta', TABLE_TYPE:'BASE TABLE'},
      {TABLE_NAME:'gamma', TABLE_TYPE:'BASE TABLE'},
    ];
    return [rows.slice(offset, offset + requestedLimit)];
  };
  const mysqlPlugin = {target:{database:'app'}, limits:{timeoutMs:1_000}};
  const firstTablePage = await mysqlRuntime.listTables(mysqlPlugin, {limit:1});
  const mysqlListTables = listed.tools.find((item) => item.name === 'mysql_list_tables');
  assertCursorMatchesSchema(mysqlListTables, firstTablePage.nextCursor);
  await mysqlRuntime.listTables(mysqlPlugin, {cursor:firstTablePage.nextCursor, limit:1});
  await mysqlRuntime.listTables(mysqlPlugin, {cursor:1, limit:1});
  assert.deepEqual(mysqlOffsets, [0, 1, 1]);

  const redisCursors = [];
  const redisRuntime = new RedisPluginRuntime({}, {});
  const redisPlugin = {
    projectId:'p1',
    environmentId:'e1',
    pluginInstanceId:'r1',
    patterns:[{patternId:'orders', pattern:'orders:*'}],
    limits:{timeoutMs:1_000, maxKeys:10},
  };
  redisRuntime.sessions.set('p1/e1/r1', {
    closing:false,
    client:{
      scan:async (cursor) => {
        redisCursors.push(cursor);
        return cursor === '0'
          ? {cursor:'17', keys:['orders:1']}
          : {cursor:'0', keys:['orders:2']};
      },
    },
  });
  const firstRedisPage = await redisRuntime.scan(redisPlugin, {patternId:'orders', limit:1});
  const redisScan = listed.tools.find((item) => item.name === 'redis_scan');
  assertCursorMatchesSchema(redisScan, firstRedisPage.nextCursor);
  await redisRuntime.scan(redisPlugin, {patternId:'orders', cursor:firstRedisPage.nextCursor, limit:1});
  assert.deepEqual(redisCursors, ['0', '17']);
});
