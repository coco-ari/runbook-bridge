import assert from 'node:assert/strict';
import { createBuildMetadata } from './build-metadata.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const { packagedPaths } = await import('./packaged-paths.cjs');
const { executable, appAsar, mcpEntrypoint } = packagedPaths(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
await fs.access(executable);
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-package-'));
try {
  const rendererInspectionProgram = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import {createHash} from 'node:crypto';",
    "const appAsar=process.env.AI_OPS_APP_ASAR;",
    "const buildInfo=JSON.parse(fs.readFileSync(path.join(appAsar,'build','runtime.json'),'utf8'));",
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
    "process.stdout.write(JSON.stringify({buildInfo,files,references,html,sourceHashes,rendererHashes,sourceRendererPresent:fs.existsSync(path.join(appAsar,'renderer'))}));",
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
  const currentBuild = await createBuildMetadata(path.resolve(import.meta.dirname,'..'));
  assert.equal(renderer.buildInfo.buildId,currentBuild.buildId,'安装包构建指纹与源码不一致');
  assert.equal(renderer.buildInfo.gitCommit,currentBuild.gitCommit,'安装包提交与源码不一致');
  const runtimeResult = await execFileAsync(executable,['--input-type=module','--eval',
    "import {pathToFileURL} from 'node:url'; const {RUNTIME_INFO}=await import(pathToFileURL(process.env.AI_OPS_RUNTIME_MODULE).href); process.stdout.write(JSON.stringify(RUNTIME_INFO));"], {
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AI_OPS_RUNTIME_MODULE:path.join(appAsar,'src','package-metadata.mjs')},timeout:30000,windowsHide:true,
  });
  const runtime = JSON.parse(runtimeResult.stdout);
  assert.equal(runtime.buildId,renderer.buildInfo.buildId);
  assert.equal(runtime.version,manifest.version);
  assert.equal(runtime.platform,process.platform);
  assert.equal(runtime.arch,process.arch);
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
  for (const module of ['cloud-config-crypto.mjs','cloud-config-service.mjs','cloud-config-workspace.mjs','cloud-config-ipc.mjs']) assert.ok(Object.hasOwn(renderer.sourceHashes,module),'安装包缺少云配置模块');
  for (const module of ['server-workspace-manager.mjs', 'server-workspace-files.mjs', 'server-workspace-directory-cache.mjs', 'server-workspace-ipc.mjs']) {
    assert.ok(Object.hasOwn(renderer.sourceHashes, module), '安装包缺少服务器工作区模块：' + module);
  }
  for (const module of ['redis-workspace-manager.mjs', 'redis-workspace-reader.mjs', 'redis-workspace-ipc.mjs']) {
    assert.ok(Object.hasOwn(renderer.sourceHashes, module), '安装包缺少 Redis 工作区模块：' + module);
  }
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
    ['get_confirmation_status', 'list_projects', 'list_environments', 'open_environment', 'add_plugin', 'server_list_actions', 'server_run_action', 'server_system_snapshot', 'server_service_inspect', 'server_journal_query', 'server_container_inspect', 'server_docker_list_containers', 'server_docker_inspect_container', 'server_docker_read_logs', 'server_docker_container_stats', 'server_list_sources', 'server_list_files', 'server_read_log', 'server_search_logs', 'server_read_config', 'server_stat', 'server_list_directory', 'server_find_files', 'server_read_file', 'server_search_files', 'server_download_file', 'server_upload_file', 'server_write_file', 'server_move_path', 'server_delete_path', 'server_control_service', 'server_execute_shell', 'mysql_list_tables', 'mysql_search_schema', 'mysql_describe_table', 'mysql_query_readonly', 'mysql_explain', 'redis_scan', 'redis_read', 'redis_ttl'],
  );
  const logSearch = tools.tools.find((tool) => tool.name === 'server_search_logs');
  const schemaSearch = tools.tools.find((tool) => tool.name === 'mysql_search_schema');
  assert.equal(schemaSearch.inputSchema.properties.keywords.maxItems, 10);
  assert.ok(schemaSearch.inputSchema.properties.searchIn.enum.includes('auto'));
  assert.equal(logSearch.inputSchema.properties.maxLines,undefined);
  assert.equal(logSearch.inputSchema.properties.cursor.pattern,'^[a-f0-9]{64}$');
  assert.equal(tools.tools.find(tool => tool.name === 'get_confirmation_status').annotations.readOnlyHint,true);
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
