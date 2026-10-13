const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {app,ipcMain,nativeTheme} = require('electron');
const smoke = require('./ui-react-plugin-operations-smoke.cjs');
const {state,PROJECT_ID,ENVIRONMENT_ID,waitFor,click,clickText,fill,setExactViewport,wait} = smoke;
let runtime,root;
// The parent fixture predates these read-only surfaces; return their normal
// unavailable state without registering unrelated mutations.
for(const channel of ['v2:cloud-config','v2:update-center'])ipcMain.handle(channel,async()=>({ok:false,error:{code:'FIXTURE_UNAVAILABLE',message:'当前测试未配置'}}));
async function scenario(win) {
 const [{CodexPluginRuntime},{CodexProcess},{registerCodexWorkspaceIpc},{normalizePlugin},{SourceStore},{sourceHash}]=await Promise.all([
  import('../src/codex-plugin-runtime.mjs'),import('../src/codex-process.mjs'),import('../src/codex-workspace-ipc.mjs'),import('../src/plugin-config-model.mjs'),import('../src/source-store.mjs'),import('../src/source-protocol.mjs')]);
 root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-ui-'));
 const plugin=normalizePlugin({pluginType:'codex',pluginInstanceId:'codex-smoke',displayName:'排障助手',target:{authMode:'chatgpt',model:'test-model'}},{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
 const source=normalizePlugin({pluginType:'source',pluginInstanceId:'source-for-agent',displayName:'绑定应用源码',target:{serviceUrl:'https://source.example.invalid',remoteProjectId:'11111111-1111-4111-8111-111111111111'}},{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
 const sourceStore=new SourceStore(root);
 const content='export const answer = 42;\n',files=[{path:'app.js',type:'file',mode:420,size:Buffer.byteLength(content),sha256:sourceHash(content)}];
 const identity={projectId:source.target.remoteProjectId,revision:'1'.repeat(40),exportVersion:1,sourceIdentity:sourceHash('fixture'),files};
 const manifest={protocol:'cmr-source/1',...identity,snapshotId:sourceHash(JSON.stringify(identity)),fileCount:1,totalBytes:Buffer.byteLength(content),archiveBytes:22,archiveSha256:'0'.repeat(64),createdAt:'2026-01-01T00:00:00.000Z'};
 const emptyIdentity={...identity,files:[]},empty={...manifest,...emptyIdentity,snapshotId:sourceHash(JSON.stringify(emptyIdentity)),fileCount:0,totalBytes:0};
 await sourceStore.update(source,{manifest:async()=>empty},empty.snapshotId);
 await sourceStore.update(source,{manifest:async()=>manifest,files:async()=>[{sha256:sourceHash(content),data:Buffer.from(content).toString('base64')}]},manifest.snapshotId);
 const workspaceStore={getPlugin:async(_p,_e,id)=>{const value=[plugin,source].find(x=>x.pluginInstanceId===id);assert.ok(value);return value;}};
 runtime=new CodexPluginRuntime(root,{load:async()=>({})},{sourceStore,workspaceStore,resolveExecutable:async()=>({executable:process.execPath,version:'codex-cli fixture'}),processFactory:opts=>new CodexProcess({...opts,spawnImpl:(_exe,_args,options)=>spawn(process.execPath,[path.join(__dirname,'../test/fixtures/codex-app-server.mjs')],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}})}),openExternal:async url=>assert.equal(new URL(url).hostname,'auth.openai.com')});
 await runtime.connect(plugin);
 registerCodexWorkspaceIpc(ipcMain,{codexRuntime:runtime,workspaceStore,isWorkspaceRenderer:sender=>sender===win.webContents});
 runtime.on('changed',payload=>{if(!win.isDestroyed())win.webContents.send('v2:codex-changed',payload)});
 state.plugins.push(plugin,source);
 state.runtime={...state.runtime,sequence:state.runtime.sequence+1,plugins:{...state.runtime.plugins,[plugin.pluginInstanceId]:{pluginInstanceId:plugin.pluginInstanceId,pluginType:'codex',phase:'connected'}}};
 win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
 await click(win,`[data-environment-id="${ENVIRONMENT_ID}"]`);
 await waitFor(win,'document.querySelector(\'[data-testid="plugin-trigger-codex-smoke"]\')','Agent 插件');
 await click(win,'[data-testid="plugin-trigger-codex-smoke"]');await click(win,'[data-testid="plugin-workspace-open"]');
 await waitFor(win,'document.querySelector(\'[data-testid="codex-workspace"]\')?.getClientRects().length > 0','Agent 工作区');
 await clickText(win,'登录 ChatGPT','.codex-auth');
 await waitFor(win,'document.querySelector(".codex-auth")?.textContent.includes("test@example.invalid")','登录完成');
 await click(win,'[data-testid="codex-new"]');await click(win,'[role=dialog] input[type=checkbox]');
 await click(win,'[data-testid="codex-create-session"]');
 await waitFor(win,'Boolean(document.querySelector(\'[data-testid="codex-input"]\'))','会话输入');
 assert.ok(await win.webContents.executeJavaScript('document.querySelector(".codex-context").textContent.includes("111111111111")'),'会话固定源码版本');
 await fill(win,'[data-testid="codex-input"]','解释启动流程');await click(win,'[data-testid="codex-send"]');
 await waitFor(win,'document.querySelector(".codex-messages")?.textContent.includes("建议检查配置。")','流式回答完成');
 assert.ok(await win.webContents.executeJavaScript('document.querySelector(".codex-tool") !== null'),'工具事件');
 await fill(win,'[data-testid="codex-input"]','保留输入草稿');await click(win,'[data-testid="codex-workspace-back"]');await click(win,'[data-testid="plugin-workspace-open"]');
 assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-testid="codex-input"]\').value'),'保留输入草稿');
 await fill(win,'[data-testid="codex-input"]','wait');await click(win,'[data-testid="codex-send"]');await waitFor(win,'document.querySelector(\'[data-testid="codex-stop"]\')?.disabled === false','可停止');await click(win,'[data-testid="codex-stop"]');
 await waitFor(win,'document.querySelector(".codex-context")?.textContent.includes("已停止")','中止状态');
 await fill(win,'[data-testid="codex-input"]','ask');await click(win,'[data-testid="codex-send"]');await waitFor(win,'Boolean(document.querySelector(".codex-question"))','问题卡');
 await click(win,'.codex-question input[type=radio]');await clickText(win,'提交回答','.codex-question');await waitFor(win,'document.querySelector(".codex-messages")?.textContent.includes("已收到回答")','回答问题');
 await runtime.disconnect(plugin);await waitFor(win,'document.querySelector(\'[data-testid="codex-send"]\')?.disabled === true','离线记录保留');
 await runtime.connect(plugin);await runtime.login(plugin,'login');await wait(60);await waitFor(win,'document.querySelector(".codex-auth")?.textContent.includes("test@example.invalid")','重新连接');
 await fill(win,'[data-testid="codex-input"]','恢复对话');await click(win,'[data-testid="codex-send"]');await waitFor(win,'document.querySelectorAll(".codex-assistant").length >= 3','恢复会话并续问');
 for(const theme of ['light','dark']) {
  nativeTheme.themeSource=theme;await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await setExactViewport(win,960,640);await wait(120);
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth || document.querySelector(".codex-workspace").scrollWidth > window.innerWidth'),false);
  if(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR) {await fs.mkdir(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR,`codex-${theme}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 await click(win,'[data-testid="codex-workspace-back"]');
 for(const channel of ['v2:plugin-connection-edit-prepare','v2:plugin-connection-edit-begin','v2:plugin-connection-edit-cancel'])ipcMain.removeHandler(channel);
 ipcMain.handle('v2:plugin-connection-edit-prepare',async()=>({ok:true,data:{prepareToken:'codex-ui-edit',preEditConnectedSet:[],affectedIds:[plugin.pluginInstanceId]}}));
 ipcMain.handle('v2:plugin-connection-edit-begin',async()=>({ok:true,data:{editSessionId:'codex-ui-session'}}));
 ipcMain.handle('v2:plugin-connection-edit-cancel',async()=>({ok:true,data:{cancelled:true}}));
 await clickText(win,'修改配置');await waitFor(win,'document.querySelector(\'[data-testid="codex-save"]\')?.disabled === false','Agent 编辑器');
 assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-testid="codex-auth-mode"]\').value'),'chatgpt');
 process.stdout.write('Codex UI passed: login, source pin, new session, stream, tools, draft, stop, question, reconnect/resume, themes, editor\n');
}
smoke.runScenario(scenario).then(async()=>{await runtime?.closeAll();if(root)await fs.rm(root,{recursive:true,force:true});app.exit(0)}).catch(async e=>{process.stderr.write(e.stack+'\n');await runtime?.closeAll();if(root)await fs.rm(root,{recursive:true,force:true});app.exit(1)});
