import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/Agent运维工作台.exe');
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
await fs.access(executable);
const mcpEntrypoint = path.join(path.dirname(executable), 'resources', 'app.asar', 'src', 'mcp-v2.mjs');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-package-'));
try {
  const transport = new StdioClientTransport({
    command: executable,
    args: [mcpEntrypoint],
    env: { ...process.env, AI_OPS_DATA_DIR: dataRoot, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const client = new Client({ name: 'package-verifier', version: '1.0.0' });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, manifest.version);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['list_projects', 'list_environments', 'open_environment', 'add_plugin', 'server_list_actions', 'server_run_action', 'server_system_snapshot', 'server_service_inspect', 'server_journal_query', 'server_container_inspect', 'server_list_sources', 'server_list_files', 'server_read_log', 'server_search_logs', 'server_read_config', 'server_stat', 'server_list_directory', 'server_find_files', 'server_read_file', 'server_search_files', 'server_download_file', 'server_upload_file', 'server_write_file', 'server_move_path', 'server_delete_path', 'server_control_service', 'server_execute_shell', 'mysql_list_tables', 'mysql_describe_table', 'mysql_query_readonly', 'mysql_explain', 'redis_scan', 'redis_read', 'redis_ttl'],
  );
  const logSearch = tools.tools.find((tool) => tool.name === 'server_search_logs');
  assert.equal(logSearch.inputSchema.properties.path.type, 'string');
  assert.equal(logSearch.inputSchema.properties.sourceId.type, 'string');
  assert.equal(logSearch.inputSchema.properties.queries.maxItems, 10);
  assert.equal(logSearch.inputSchema.properties.includeArchives.type, 'boolean');
  assert.deepEqual(
    logSearch.inputSchema.allOf.map((group) => group.oneOf.map((branch) => branch.required)),
    [[['fileIds'], ['sourceId'], ['path']], [['contains'], ['queries']]],
  );
  await client.close();
  console.log(`verified: ${executable}`);
} finally {
  await fs.rm(dataRoot, { recursive: true, force: true });
}
