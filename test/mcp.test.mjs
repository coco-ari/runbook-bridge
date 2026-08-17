import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('the legacy free-form shell MCP is excluded from production packaging', async () => {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(manifest.bin['ai-ops-mcp'], 'src/mcp-v2.mjs');
  assert.ok(manifest.build.files.includes('!src/mcp.mjs'));
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
});

test('the V2 MCP exposes confirmed shell without restoring legacy generic calls', async () => {
  const source = await fs.readFile('src/mcp-v2.mjs', 'utf8');
  for (const forbidden of ['execute_batch', "name: 'execute'", "name: 'upload'", "name: 'download'", 'plugin_call']) {
    assert.equal(source.includes(forbidden), false, `unexpected legacy capability: ${forbidden}`);
  }
  assert.match(source, /open_environment/);
  assert.match(source, /add_plugin/);
  assert.match(source, /server_run_action/);
  assert.match(source, /server_execute_shell/);
  assert.match(source, /mysql_query_readonly/);
  assert.match(source, /redis_read/);
});
