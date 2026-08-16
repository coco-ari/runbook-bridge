import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/Agent运维工作台.exe');
const appAsar = path.join(path.dirname(executable), 'resources', 'app.asar', 'src', 'mcp-v2.mjs');
const transport = new StdioClientTransport({
  command: executable,
  args: [appAsar],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stderr: 'pipe',
});
const client = new Client({ name: 'packaged-mcp-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.listTools();
  assert.ok(result.tools.some((tool) => tool.name === 'open_environment'));
  assert.ok(!result.tools.some((tool) => tool.name === 'execute'));
  console.log(`Packaged MCP smoke passed (${result.tools.length} structured tools)`);
} finally {
  await client.close().catch(() => undefined);
}
