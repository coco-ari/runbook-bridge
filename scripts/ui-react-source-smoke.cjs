const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, ipcMain, nativeTheme } = require('electron');
const smoke = require('./ui-react-plugin-operations-smoke.cjs');
const {state,PROJECT_ID,ENVIRONMENT_ID,waitFor,click,clickText,fill,setExactViewport} = smoke;
let runtime, root;
for (const channel of ['v2:cloud-config','v2:update-center']) ipcMain.handle(channel,async () => ({ok:false,error:{code:'FIXTURE_UNAVAILABLE',message:'当前测试未配置'}}));
async function scenario(win) {
  const [{SourceStore},{SourcePluginRuntime},{registerSourceWorkspaceIpc},{sourceHash,validateManifest}] = await Promise.all([
    import('../src/source-store.mjs'),import('../src/source-plugin-runtime.mjs'),import('../src/source-workspace-ipc.mjs'),import('../src/source-protocol.mjs'),
  ]);
  root = await fs.mkdtemp(path.join(os.tmpdir(),'source-ui-'));
  const projectId = '11111111-1111-4111-8111-111111111111';
  const plugin = {projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:'source-smoke',pluginType:'source',displayName:'应用源码',revision:1,configState:'ready',target:{serviceUrl:'https://source.example.invalid',remoteProjectId:projectId}};
  const manifests = new Map(), objects = new Map();
  function add(contents,revision) {
    const files = Object.entries(contents).map(([path,value]) => ({path,type:'file',mode:420,size:Buffer.byteLength(value),sha256:sourceHash(value)})).sort((a,b) => a.path < b.path ? -1 : 1);
    const identity = {projectId,revision:revision.repeat(40),exportVersion:1,sourceIdentity:sourceHash('fixture'),files};
    const manifest = {protocol:'cmr-source/1',...identity,snapshotId:sourceHash(JSON.stringify(identity)),fileCount:files.length,totalBytes:files.reduce((n,f) => n+f.size,0),archiveBytes:22,archiveSha256:'0'.repeat(64),createdAt:'2026-01-01T00:00:00.000Z'};
    manifests.set(manifest.snapshotId,manifest); for (const value of Object.values(contents)) objects.set(sourceHash(value),Buffer.from(value).toString('base64'));
    return manifest;
  }
  const empty = add({},'0'), first = add({'src/app.js':'// source fixture\nexport const answer = 42;\n','README.md':'# Test source\nRead me offline.\n'},'1'), next = add({'src/app.js':'export const answer = 43;\n','README.md':'# Test source\nRead me offline.\n'},'2');
  let remote = first;
  const client = {head:async () => ({snapshot:remote,syncStatus:'ready',error:null,lastAttempt:null}),manifest:async id => validateManifest(manifests.get(id),projectId,id),files:async (_id,hashes) => hashes.map(sha256 => ({sha256,data:objects.get(sha256)}))};
  const store = new SourceStore(root); await store.update(plugin,client,empty.snapshotId);
  runtime = new SourcePluginRuntime(root,{load:async () => ({password:'fixture'})},{store,clientFactory:() => client,pollMs:3600000});
  await runtime.connect(plugin);
  registerSourceWorkspaceIpc(ipcMain,{sourceRuntime:runtime,workspaceStore:{getPlugin:async () => plugin,appendAudit:async () => {}},isWorkspaceRenderer:sender => sender === win.webContents,openSourceDirectory:async directory => assert.ok(directory.startsWith(root))});
  runtime.on('changed',payload => { if (!win.isDestroyed()) win.webContents.send('v2:source-changed',payload); });
  state.plugins.push(plugin);
  state.runtime = {...state.runtime,sequence:state.runtime.sequence+1,plugins:{...state.runtime.plugins,[plugin.pluginInstanceId]:{pluginInstanceId:plugin.pluginInstanceId,pluginType:'source',phase:'connected'}}};
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await click(win,`[data-environment-id="${ENVIRONMENT_ID}"]`);
  await waitFor(win,'document.querySelector(\'[data-testid="plugin-trigger-source-smoke"]\')','源码插件出现在列表');
  await click(win,'[data-testid="plugin-trigger-source-smoke"]');
  await click(win,'[data-testid="plugin-workspace-open"]');
  await waitFor(win,'document.querySelector(\'[data-testid="source-workspace"]\')?.getClientRects().length > 0','源码工作区');
  await waitFor(win,'document.querySelector(\'[data-testid="source-update"]\')?.disabled === false','源码可更新');
  await click(win,'[data-testid="source-update"]');
  await waitFor(win,'document.querySelector(\'[data-testid="source-workspace"]\')?.textContent.includes("111111111111")','首次更新版本');
  await clickText(win,'app.js','.source-tree');
  await waitFor(win,'document.querySelector(\'[data-testid="source-code-view"]\')?.textContent.includes("answer = 42")','源码预览');
  assert.ok(await win.webContents.executeJavaScript('Boolean(document.querySelector(".source-keyword"))'),'代码语法高亮');
  await clickText(win,'README.md','.source-tree');
  await waitFor(win,'document.querySelectorAll(".source-tab").length === 2','多文件标签');
  await fill(win,'input[aria-label="搜索源码"]','answer');
  await click(win,'.source-search input[type=checkbox]');
  await clickText(win,'搜索','.source-search');
  await waitFor(win,'document.querySelector(".source-match")?.textContent.includes("src/app.js:2")','全文搜索行号');
  await click(win,'.source-match');
  await waitFor(win,'document.querySelector(\'[data-testid="source-code-view"]\')?.textContent.includes("answer = 42")','搜索结果打开代码');
  await click(win,'[data-testid="source-workspace-back"]');
  await click(win,'[data-testid="plugin-workspace-open"]');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".source-tab").length'),2,'工作区切换保留标签');
  await runtime.disconnect(plugin);
  await waitFor(win,'document.querySelector(\'[data-testid="source-update"]\')?.disabled === true','断线仍保留代码且禁止更新');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".source-tab").length'),2);
  remote = next; await runtime.connect(plugin);
  await waitFor(win,'document.querySelector(\'[data-testid="source-update"]\')?.disabled === false','新版本可选择更新');
  await click(win,'[data-testid="source-update"]');
  await waitFor(win,'document.querySelector(".source-version-bar strong")?.textContent === "222222222222"','增量切换版本');
  await clickText(win,'app.js','.source-tree');
  await waitFor(win,'document.querySelector(\'[data-testid="source-code-view"]\')?.textContent.includes("answer = 43")','新版本内容');
  for (const theme of ['light','dark']) {
    nativeTheme.themeSource = theme; await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await setExactViewport(win,960,640);
    const overflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth || document.querySelector(".source-workspace").scrollWidth > window.innerWidth');
    assert.equal(overflow,false,`${theme} 工作区无横向溢出`);
    if (process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR) { const directory = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR; await fs.mkdir(directory,{recursive:true}); await fs.writeFile(path.join(directory,`source-${theme}.png`),(await win.webContents.capturePage()).toPNG()); }
  }
  await click(win,'[data-testid="source-workspace-back"]');
  for (const channel of ['v2:plugin-connection-edit-prepare','v2:plugin-connection-edit-begin','v2:plugin-connection-edit-cancel']) ipcMain.removeHandler(channel);
  ipcMain.handle('v2:plugin-connection-edit-prepare',async (_event,payload) => { assert.equal(payload.pluginInstanceId,plugin.pluginInstanceId); return {ok:true,data:{prepareToken:'source-ui-edit',preEditConnectedSet:[],affectedIds:[plugin.pluginInstanceId]}}; });
  ipcMain.handle('v2:plugin-connection-edit-begin',async () => ({ok:true,data:{editSessionId:'source-ui-session'}}));
  ipcMain.handle('v2:plugin-connection-edit-cancel',async () => ({ok:true,data:{cancelled:true}}));
  await clickText(win,'修改配置');
  await waitFor(win,'document.querySelector(\'[data-testid="source-editor"]\')','独立源码编辑器');
  await waitFor(win,'document.querySelector(\'[data-testid="source-save"]\')?.disabled === false','源码编辑已准备完成');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-testid="source-service-url"]\').value'),plugin.target.serviceUrl);
  process.stdout.write('Source UI passed: workspace, update, tree, tabs, syntax, search, offline, version change, themes, editor\n');
}
smoke.runScenario(scenario).then(async () => { await runtime?.closeAll(); if(root) await fs.rm(root,{recursive:true,force:true}); app.exit(0); }).catch(async error => { process.stderr.write(error.stack+'\n'); await runtime?.closeAll(); if(root) await fs.rm(root,{recursive:true,force:true}); app.exit(1); });
