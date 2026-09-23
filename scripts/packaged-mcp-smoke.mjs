import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const { packagedPaths } = await import('./packaged-paths.cjs');
const { executable, appAsar, mcpEntrypoint } = packagedPaths(process.argv[2]);
const transport = new StdioClientTransport({
  command: executable,
  args: [mcpEntrypoint],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stderr: 'pipe',
});
const client = new Client({ name: 'packaged-mcp-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.listTools();
  assert.equal(result.tools.length, 40);
  assert.ok(result.tools.some((tool) => tool.name === 'open_environment'));
  assert.ok(result.tools.some((tool) => tool.name === 'mysql_search_schema'));
  assert.ok(!result.tools.some((tool) => tool.name === 'execute'));
  assert.ok(!result.tools.some((tool) => /cloud|credential|private_key/i.test(tool.name)),'云配置和凭据不得暴露为 MCP 工具');
  for (const name of ['server_docker_list_containers','server_docker_inspect_container','server_docker_read_logs','server_docker_container_stats']) {
    const tool = result.tools.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.inputSchema.required.includes('contextToken'));
  }
  const logSearch = result.tools.find((tool) => tool.name === 'server_search_logs');
  assert.equal(logSearch.inputSchema.properties.queries.maxItems, 10);
  assert.equal(logSearch.inputSchema.properties.maxLines, undefined);
  assert.equal(logSearch.inputSchema.properties.cursor.pattern, '^[a-f0-9]{64}$');
  assert.equal(logSearch.inputSchema.properties.refresh.type, 'boolean');
  assert.deepEqual([logSearch.inputSchema.properties.maxResultBytes.minimum, logSearch.inputSchema.properties.maxResultBytes.maximum], [16384, 2097152]);
  assert.match(result.tools.find(tool => tool.name === 'server_control_service').description, /SERVICE_CONTROL_FAILED/u);
  const confirmation = result.tools.find(tool => tool.name === 'get_confirmation_status');
  assert.equal(confirmation.annotations.readOnlyHint, true);
  assert.equal(confirmation.inputSchema.properties.waitMs.maximum, 10000);
  const schemaSearch = result.tools.find(tool => tool.name === 'mysql_search_schema');
  assert.ok(schemaSearch.inputSchema.properties.searchIn.enum.includes('auto'));
  assert.equal(result.tools.find(tool => tool.name === 'mysql_describe_table').inputSchema.properties.includeIndexes.type, 'boolean');
  assert.equal(logSearch.inputSchema.properties.includeArchives.type, 'boolean');
  assert.equal(logSearch.inputSchema.allOf.length, 2);
  assert.match(logSearch.inputSchema.properties.maxExpandedBytes.description, /单个归档条目/u);
  assert.equal(result.tools.find((tool) => tool.name === 'server_read_file').inputSchema.properties.tail.type, 'boolean');
  for (const name of ['server_read_file','server_read_log','server_read_config']) {
    const tool = result.tools.find(item => item.name === name);
    assert.match(tool.description, /UTF-8/u); assert.match(tool.description, /INVALID_ARGUMENT/u);
    assert.equal(tool.inputSchema.properties.maxBytes.minimum, 1);
  }
  assert.match(client.getInstructions(), /coverage、truncated、skipped 和 guidance/u);
} finally {
  await client.close().catch(() => undefined);
}

const archiveModule = path.join(appAsar, 'src', 'log-archive.mjs');
const archiveSmoke = [
  "import assert from 'node:assert/strict';",
  "import { gzipSync } from 'node:zlib';",
  "import { pathToFileURL } from 'node:url';",
  "const { expandLogArchive } = await import(pathToFileURL(process.env.AI_OPS_ARCHIVE_MODULE).href);",
  "const result = await expandLogArchive({ filePath:'packaged.log.gz', content:gzipSync('PACKAGED_ARCHIVE_OK\\n') });",
  "assert.equal(result.archiveType, 'gzip');",
  "assert.equal(result.snapshots[0].content.toString('utf8'), 'PACKAGED_ARCHIVE_OK\\n');",
  "const zipName = Buffer.from('packaged.log');",
  "const zipBody = Buffer.from('PACKAGED_ZIP_OK\\nPACKAGED_ZIP_OK\\n');",
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
  "assert.equal(zipResult.snapshots[0].content.toString('utf8'), 'PACKAGED_ZIP_OK\\nPACKAGED_ZIP_OK\\n');",
  "const { ServerOperations } = await import(pathToFileURL(process.env.AI_OPS_OPERATIONS_MODULE).href);",
  "const runtime = { withRemoteReadSession:async (_plugin, operation) => operation({statPath:async () => ({type:'file',path:'/logs/packaged.zip',canonicalPath:'/logs/packaged.zip',size:zip.length,mtime:1}),readBuffer:async () => ({canonicalPath:'/logs/packaged.zip',content:zip,size:zip.length,mtime:1})}) };",
  "const operations = new ServerOperations(runtime, {});",
  "const searched = await operations.searchLogs({projectId:'package',environmentId:'test',pluginInstanceId:'server'}, {path:'/logs/packaged.zip',queries:['PACKAGED_ZIP_OK'],maxMatches:1});",
  "assert.equal(searched.matchCount, 1); assert.equal(searched.coverage[0].sourceGrew, false); assert.ok(Array.isArray(searched.guidance));",
  "assert.ok(searched.nextCursor); assert.equal(searched.status,'partial');",
  "assert.equal(searched.limitsApplied.maxResultBytes,32768); assert.ok(searched.resultBytes <= 32768);",
  "assert.ok(Object.keys(searched).indexOf('nextCursor') < Object.keys(searched).indexOf('matches'));",
  "const next = await operations.searchLogs({projectId:'package',environmentId:'test',pluginInstanceId:'server'}, {path:'/logs/packaged.zip',queries:['PACKAGED_ZIP_OK'],maxMatches:1,cursor:searched.nextCursor});",
  "assert.equal(next.matchCount,1); assert.equal(next.status,'complete'); assert.equal(next.cache.hits,1);",
  "const { ConfirmationManager } = await import(pathToFileURL(process.env.AI_OPS_CONFIRMATION_MODULE).href);",
  "const manager = new ConfirmationManager(); const scope = {projectId:'package',environmentId:'test',pluginInstanceId:'server',clientInstanceId:'fixture'};",
  "const entry = manager.request(scope,'service.control',{unit:'fixture.service',action:'restart'});",
  "const waiting = manager.status(scope,entry.requestId,1000); manager.approve(entry.requestId);",
  "assert.equal((await waiting).status,'approved'); assert.equal(manager.approved.size,1);",
  "await assert.rejects(manager.status({...scope,clientInstanceId:'other'},entry.requestId),{code:'CONFIRMATION_NOT_FOUND'});",
  "const failedService = new ServerOperations({executeApproved:async () => ({exitCode:1,stdout:'fixture-output',stderr:'fixture-output'})}, {});",
  "await assert.rejects(failedService.mutate({},'service.control',{unit:'fixture.service',action:'reload'}), error => error.code === 'SERVICE_CONTROL_FAILED' && error.details.exitCode === 1 && !JSON.stringify(error).includes('fixture-output'));",
  "const successfulService = new ServerOperations({executeApproved:async () => ({exitCode:0,stdout:'',stderr:''})}, {});",
  "assert.equal((await successfulService.mutate({},'service.control',{unit:'fixture.service',action:'start'})).exitCode,0);",
  "const { BrokerServer } = await import(pathToFileURL(process.env.AI_OPS_BROKER_MODULE).href);",
  "const forwarding = new BrokerServer({dataRoot:process.cwd(),token:'fixture-token',v2Service:{invoke:(_params,_capability,args) => args}});",
  "assert.equal(forwarding.dispatchV2('serverSearchLogs',{maxResultBytes:16384}).maxResultBytes,16384);",
  "const { SshBroker } = await import(pathToFileURL(process.env.AI_OPS_SSH_MODULE).href);",
  "let utfBody = Buffer.from('A中B'), readBytes = 0;",
  "const utfSftp = {realpath:(name, done) => done(null,name),stat:(_name,done) => done(null,{size:utfBody.length,mtime:1,mode:33188,isFile:() => true}),open:(...args) => args.at(-1)(null,Buffer.from('h')),close:(_handle,done) => done(),read:(_handle,buffer,offset,length,position,done) => {const part=utfBody.subarray(position,position+length);part.copy(buffer,offset);readBytes+=part.length;done(null,part.length,buffer);}};",
  "const utfBroker = new SshBroker({}); utfBroker.withInternalSftp = (_id,operation) => operation(utfSftp,{},{});",
  "const firstText = await utfBroker.readRemoteRange('fixture','/fixture.log',0,2); assert.equal(firstText.content,'A'); assert.equal(firstText.endByte,1); assert.equal(readBytes,2);",
  "await assert.rejects(utfBroker.readRemoteRange('fixture','/fixture.log',1,2),error => error.code==='INVALID_ARGUMENT' && error.details.minimumBytes===3); assert.equal(readBytes,4);",
  "const continuedText=await utfBroker.readRemoteRange('fixture','/fixture.log',1,3); assert.equal(continuedText.content,'中'); assert.equal(continuedText.endByte,4); assert.equal(readBytes,7);",
  "utfBody=Buffer.from([0x80,0x80,0x80]); let invalidOffset=0; for(let index=0;index<3;index+=1){const page=await utfBroker.readRemoteRange('fixture','/fixture.log',invalidOffset,3);assert.equal(page.content,'�');assert.equal(Buffer.byteLength(page.content),3);assert.ok(page.endByte>invalidOffset);invalidOffset=page.endByte;} assert.equal(invalidOffset,3);",
  "utfBody=Buffer.from('A中B'); const configOps=new ServerOperations({readRemoteRange:(_plugin,...args)=>utfBroker.readRemoteRange('fixture',...args)},{});",
  "const configSource={sourceId:'config',kind:'config',root:'/fixture',patterns:['*.conf'],maxFileBytes:1048576};const configPlugin={projectId:'package',environmentId:'test',pluginInstanceId:'server',sources:[configSource]};const configId=configOps.rememberFile(configPlugin,configSource,{canonicalPath:'/fixture/sample.conf',size:utfBody.length,mtime:1});",
  "const configPage=await configOps.readConfig(configPlugin,{fileId:configId,maxBytes:2});assert.equal(configPage.content,'A');assert.equal(configPage.nextCursor,'1');await assert.rejects(configOps.readConfig(configPlugin,{fileId:configId,cursor:'1',maxBytes:2}),error=>error.code==='INVALID_ARGUMENT'&&error.details.minimumBytes===3);configOps.docker.dispose();",
  "const { ServerWorkspaceFiles } = await import(pathToFileURL(process.env.AI_OPS_WORKSPACE_FILES_MODULE).href);",
  "const { registerServerWorkspaceIpc } = await import(pathToFileURL(process.env.AI_OPS_WORKSPACE_IPC_MODULE).href);",
  "const { EventEmitter } = await import('node:events'); const directoryScope={projectId:'packaged-directory',environmentId:'test',pluginInstanceId:'server'};",
  "let releasePlugin; const directoryPlugin={...directoryScope,pluginType:'server',configState:'ready',revision:1};",
  "const directoryFiles=new ServerWorkspaceFiles({workspaceStore:{getPlugin:()=>new Promise(resolve=>{releasePlugin=()=>resolve(directoryPlugin);})},serverRuntime:{status:()=>({connected:true,generation:1}),withWorkspaceReadSession:async()=>{throw new Error('已取消请求不得创建通道');}},serverOperations:{}});",
  "const directoryHandlers=new Map(), directorySender=Object.assign(new EventEmitter(),{id:77,mainFrame:{},isDestroyed:()=>false});",
  "registerServerWorkspaceIpc({handle:(name,handler)=>directoryHandlers.set(name,handler)},{serverWorkspaceFiles:directoryFiles,isWorkspaceRenderer:sender=>sender===directorySender});",
  "const directoryEvent={sender:directorySender,senderFrame:directorySender.mainFrame}, directoryRead=directoryHandlers.get('v2:server-workspace-list-directory'), directoryCancel=directoryHandlers.get('v2:server-workspace-cancel-directory-read');",
  "assert.equal((await directoryCancel({...directoryEvent,senderFrame:{}},{...directoryScope,requestId:'owned'})).error.code,'WORKSPACE_ACCESS_DENIED');",
  "assert.equal((await directoryCancel(directoryEvent,{...directoryScope,requestId:'owned',path:'/'})).error.code,'INVALID_ARGUMENT');",
  "const cancelledDirectory=directoryRead(directoryEvent,{...directoryScope,path:'/',deferLinks:true,requestId:'owned'});",
  "assert.equal((await directoryCancel(directoryEvent,{...directoryScope,requestId:'owned'})).data.cancelled,true);releasePlugin();",
  "assert.equal((await cancelledDirectory).error.code,'WORKSPACE_READ_CANCELLED');assert.equal(directoryFiles.directoryRequests.size,0);directoryFiles.dispose();",
  "process.stdout.write('archive-ok');",
].join('\n');
const archiveResult = await execFileAsync(executable, ['--input-type=module', '--eval', archiveSmoke], {
  env: { ...process.env, AI_OPS_ARCHIVE_MODULE: archiveModule, AI_OPS_WORKSPACE_FILES_MODULE:path.join(path.dirname(archiveModule), 'server-workspace-files.mjs'), AI_OPS_WORKSPACE_IPC_MODULE:path.join(path.dirname(archiveModule), 'server-workspace-ipc.mjs'), AI_OPS_SSH_MODULE:path.join(path.dirname(archiveModule), 'ssh-broker.mjs'), AI_OPS_BROKER_MODULE:path.join(path.dirname(archiveModule), 'broker-server.mjs'), AI_OPS_CONFIRMATION_MODULE:path.join(path.dirname(archiveModule), 'confirmation-manager.mjs'), AI_OPS_OPERATIONS_MODULE:path.join(path.dirname(archiveModule), 'server-operations.mjs'), ELECTRON_RUN_AS_NODE: '1' },
  timeout: 30_000,
  windowsHide: true,
});
assert.match(archiveResult.stdout, /archive-ok/u);
console.log('Packaged MCP smoke passed (40 structured tools; archive runtime available)');
