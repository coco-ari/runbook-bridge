import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
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
  assert.equal(result.tools.length, 35);
  assert.ok(result.tools.some((tool) => tool.name === 'open_environment'));
  assert.ok(result.tools.some((tool) => tool.name === 'mysql_search_schema'));
  assert.ok(!result.tools.some((tool) => tool.name === 'execute'));
  const logSearch = result.tools.find((tool) => tool.name === 'server_search_logs');
  assert.equal(logSearch.inputSchema.properties.queries.maxItems, 10);
  assert.equal(logSearch.inputSchema.properties.includeArchives.type, 'boolean');
  assert.equal(logSearch.inputSchema.allOf.length, 2);
} finally {
  await client.close().catch(() => undefined);
}

const archiveModule = path.join(path.dirname(executable), 'resources', 'app.asar', 'src', 'log-archive.mjs');
const archiveSmoke = [
  "import assert from 'node:assert/strict';",
  "import { gzipSync } from 'node:zlib';",
  "import { pathToFileURL } from 'node:url';",
  "const { expandLogArchive } = await import(pathToFileURL(process.env.AI_OPS_ARCHIVE_MODULE).href);",
  "const result = await expandLogArchive({ filePath:'packaged.log.gz', content:gzipSync('PACKAGED_ARCHIVE_OK\\n') });",
  "assert.equal(result.archiveType, 'gzip');",
  "assert.equal(result.snapshots[0].content.toString('utf8'), 'PACKAGED_ARCHIVE_OK\\n');",
  "const zipName = Buffer.from('packaged.log');",
  "const zipBody = Buffer.from('PACKAGED_ZIP_OK\\n');",
  "let zipCrc = 0xffffffff;",
  "for (const byte of zipBody) { zipCrc ^= byte; for (let bit = 0; bit < 8; bit += 1) zipCrc = (zipCrc & 1) ? 0xedb88320 ^ (zipCrc >>> 1) : zipCrc >>> 1; }",
  "zipCrc = (zipCrc ^ 0xffffffff) >>> 0;",
  "const local = Buffer.alloc(30);",
  "local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(zipCrc, 14); local.writeUInt32LE(zipBody.length, 18); local.writeUInt32LE(zipBody.length, 22); local.writeUInt16LE(zipName.length, 26);",
  "const central = Buffer.alloc(46);",
  "central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(zipCrc, 16); central.writeUInt32LE(zipBody.length, 20); central.writeUInt32LE(zipBody.length, 24); central.writeUInt16LE(zipName.length, 28);",
  "const end = Buffer.alloc(22);",
  "end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + zipName.length, 12); end.writeUInt32LE(local.length + zipName.length + zipBody.length, 16);",
  "const zip = Buffer.concat([local, zipName, zipBody, central, zipName, end]);",
  "const zipResult = await expandLogArchive({ filePath:'packaged.zip', content:zip });",
  "assert.equal(zipResult.archiveType, 'zip');",
  "assert.equal(zipResult.snapshots[0].content.toString('utf8'), 'PACKAGED_ZIP_OK\\n');",
  "process.stdout.write('archive-ok');",
].join('\n');
const archiveResult = await execFileAsync(executable, ['--input-type=module', '--eval', archiveSmoke], {
  env: { ...process.env, AI_OPS_ARCHIVE_MODULE: archiveModule, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 30_000,
  windowsHide: true,
});
assert.match(archiveResult.stdout, /archive-ok/u);
console.log('Packaged MCP smoke passed (35 structured tools; archive runtime available)');
