import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/Agent运维工作台.exe');
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
await fs.access(executable);
const appAsar = path.join(path.dirname(executable), 'resources', 'app.asar');
const mcpEntrypoint = path.join(appAsar, 'src', 'mcp-v2.mjs');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-package-'));
try {
  const rendererInspectionProgram = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import {createHash} from 'node:crypto';",
    "const appAsar=process.env.AI_OPS_APP_ASAR;",
    "const rendererRoot=path.join(appAsar,'renderer-build','v2');",
    "const indexPath=path.join(rendererRoot,'index.html');",
    "const walk=(root,prefix='')=>fs.readdirSync(root,{withFileTypes:true}).flatMap((entry)=>{const relative=prefix?prefix+'/'+entry.name:entry.name;return entry.isDirectory()?walk(path.join(root,entry.name),relative):[relative];});",
    "const files=walk(rendererRoot);",
    "const sourceFiles=walk(path.join(appAsar,'src'));",
    "const digest=(file)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');",
    "const sourceHashes=Object.fromEntries(sourceFiles.map((file)=>[file,digest(path.join(appAsar,'src',file))]));",
    "const rendererHashes=Object.fromEntries(files.map((file)=>[file,digest(path.join(rendererRoot,file))]));",
    "const html=fs.readFileSync(indexPath,'utf8');",
    'const references=[...html.matchAll(/(?:src|href)="\\.\\/([^"]+)"/gu)].map((match)=>match[1]);',
    "process.stdout.write(JSON.stringify({files,references,html,sourceHashes,rendererHashes,sourceRendererPresent:fs.existsSync(path.join(appAsar,'renderer'))}));",
  ].join('\n');
  const rendererInspectionResult = await execFileAsync(
    executable,
    ['--input-type=module', '--eval', rendererInspectionProgram],
    {
      env: {
        ...process.env,
        AI_OPS_APP_ASAR: appAsar,
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  const renderer = JSON.parse(rendererInspectionResult.stdout);
  for (const [relative,expected] of Object.entries(renderer.sourceHashes)) {
    const contents = await fs.readFile(new URL(`../src/${relative}`, import.meta.url));
    assert.equal(createHash('sha256').update(contents).digest('hex'), expected,
      `packaged source differs from verified checkout: ${relative}`);
  }
  for (const [relative,expected] of Object.entries(renderer.rendererHashes)) {
    const contents = await fs.readFile(new URL(`../renderer-build/v2/${relative}`, import.meta.url));
    assert.equal(createHash('sha256').update(contents).digest('hex'), expected,
      `packaged renderer differs from verified build: ${relative}`);
  }
  assert.ok(Object.hasOwn(renderer.sourceHashes, 'plugin-creation-identity.mjs'));
  const javascriptAssets = renderer.references.filter((item) => item.endsWith('.js'));
  const stylesheetAssets = renderer.references.filter((item) => item.endsWith('.css'));
  assert.ok(javascriptAssets.length >= 1, 'packaged renderer must reference a JavaScript asset');
  assert.ok(stylesheetAssets.length >= 1, 'packaged renderer must reference a stylesheet asset');
  for (const asset of [...javascriptAssets, ...stylesheetAssets]) {
    assert.ok(renderer.files.includes(asset), `missing packaged renderer asset: ${asset}`);
    assert.match(path.basename(asset), /-[A-Za-z0-9_-]{6,}\.(?:js|css)$/u);
  }
  assert.ok(renderer.files.includes('index.html'));
  assert.ok(!renderer.files.includes('react.html'));
  assert.equal(renderer.sourceRendererPresent, false, 'renderer source or legacy UI was packaged');
  assert.match(renderer.html, /default-src 'self'/u);
  assert.match(renderer.html, /script-src 'self'/u);
  assert.match(renderer.html, /style-src 'self' 'unsafe-inline'/u);
  assert.match(renderer.html, /connect-src 'none'/u);
  assert.doesNotMatch(renderer.html, /src="\/src\/main\.tsx"|https?:\/\//u);

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
    ['list_projects', 'list_environments', 'open_environment', 'add_plugin', 'server_list_actions', 'server_run_action', 'server_system_snapshot', 'server_service_inspect', 'server_journal_query', 'server_container_inspect', 'server_list_sources', 'server_list_files', 'server_read_log', 'server_search_logs', 'server_read_config', 'server_stat', 'server_list_directory', 'server_find_files', 'server_read_file', 'server_search_files', 'server_download_file', 'server_upload_file', 'server_write_file', 'server_move_path', 'server_delete_path', 'server_control_service', 'server_execute_shell', 'mysql_list_tables', 'mysql_search_schema', 'mysql_describe_table', 'mysql_query_readonly', 'mysql_explain', 'redis_scan', 'redis_read', 'redis_ttl'],
  );
  const logSearch = tools.tools.find((tool) => tool.name === 'server_search_logs');
  const schemaSearch = tools.tools.find((tool) => tool.name === 'mysql_search_schema');
  assert.equal(schemaSearch.inputSchema.properties.keywords.maxItems, 10);
  assert.equal(logSearch.inputSchema.properties.path.type, 'string');
  assert.equal(logSearch.inputSchema.properties.sourceId.type, 'string');
  assert.equal(logSearch.inputSchema.properties.queries.maxItems, 10);
  assert.equal(logSearch.inputSchema.properties.includeArchives.type, 'boolean');
  assert.deepEqual(
    logSearch.inputSchema.allOf.map((group) => group.oneOf.map((branch) => branch.required)),
    [[['fileIds'], ['sourceId'], ['path']], [['contains'], ['queries']]],
  );
  await client.close();
  console.log(`verified: ${executable} (React renderer: ${javascriptAssets.length} JS, ${stylesheetAssets.length} CSS)`);
} finally {
  await fs.rm(dataRoot, { recursive: true, force: true });
}
