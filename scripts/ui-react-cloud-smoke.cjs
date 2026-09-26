const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {app,BrowserWindow,ipcMain,session} = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {});
const root = path.resolve(__dirname,'..');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
let window, server, dataRoot;
const errors = [], network = [];
const additionalProjects = Array.from({length:21},(_,index) => ({projectId:'cloud-list-'+String(index+1).padStart(2,'0'),name:'示例项目 · '+String(index+1).padStart(2,'0')}));
const projectCount = 3+additionalProjects.length;
async function wait(expression) {
  const until = Date.now()+15_000;
  while (Date.now() < until) {
    if (await window.webContents.executeJavaScript(expression).catch(() => { throw new Error('云配置 UI 检查失败：'+expression); })) return;
    await delay(50);
  }
  throw new Error('云配置 UI 等待超时：'+expression);
}
async function clickText(text) {
  return window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('[data-testid="cloud-config-panel"] button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('按钮不可用'); button.click(); })()`).catch(() => { throw new Error('云配置按钮不可用：'+text); });
}
async function clickTestId(testId) {
  await wait(`Boolean(document.querySelector('[data-testid="${testId}"]')) && !document.querySelector('[data-testid="${testId}"]').disabled`);
  await window.webContents.executeJavaScript(`(() => { const button = document.querySelector('[data-testid="'+${JSON.stringify(testId)}+'"]'); if (!button || button.disabled) throw new Error('按钮不可用'); button.click(); })()`);
}
async function fill(id,value) {
  await window.webContents.executeJavaScript(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function assertLayout() {
  const layout = await window.webContents.executeJavaScript('(() => { const panel=document.querySelector("[data-testid=cloud-config-panel]"), page=document.querySelector("[data-testid=settings-main]"); return {overflow:panel.scrollWidth>panel.clientWidth || page.scrollWidth>page.clientWidth || document.documentElement.scrollWidth>innerWidth,inside:panel.getBoundingClientRect().left>=0 && panel.getBoundingClientRect().right<=innerWidth}; })()');
  assert.deepEqual(layout,{overflow:false,inside:true},'云配置及长项目名不得产生水平溢出');
}
async function capture(suffix='') {
  const destination = process.env.RUNBOOK_BRIDGE_CLOUD_SCREENSHOT || (process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR ? path.join(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR, 'cloud-config.png') : null);
  if (!destination) return;
  const original = path.resolve(destination);
  const extension = path.extname(original);
  const target = suffix ? original.slice(0,extension ? -extension.length : undefined)+suffix+(extension || '.png') : original;
  assert.ok(target.toLowerCase() !== root.toLowerCase() && !target.toLowerCase().startsWith((root+path.sep).toLowerCase()),'截图必须保存在仓库外');
  await fs.mkdir(path.dirname(target),{recursive:true});
  await window.webContents.executeJavaScript('(() => { const style=document.createElement("style"); style.id="cloud-smoke-screenshot-mask"; style.textContent="#cloud-url, #cloud-password, #cloud-admin-token, input[type=password], [data-sonner-toaster] { visibility: hidden !important; } *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }"; document.head.append(style); document.querySelector("[data-testid=settings-main]").scrollTo({top:0,left:0,behavior:"instant"}); })()');
  try {
    // A hidden Electron window may expose the new DOM while capturePage still
    // returns the previous compositor frame. Prime it before requesting paint.
    const captureOptions = {stayHidden:true,stayAwake:true};
    await window.webContents.capturePage(undefined,captureOptions);
    window.webContents.invalidate();
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(180);
    const expected = await window.webContents.executeJavaScript('(() => { const page=document.querySelector("[data-testid=settings-main]"), bounds=page.getBoundingClientRect(), background=getComputedStyle(document.querySelector("[data-testid=settings-page]")).backgroundColor, context=document.createElement("canvas").getContext("2d"); context.fillStyle=background; context.fillRect(0,0,1,1); return {theme:document.documentElement.dataset.theme,background,rgb:[...context.getImageData(0,0,1,1).data].slice(0,3),scrollTop:page.scrollTop,x:Math.floor(bounds.left+3),y:Math.floor(bounds.top+3),width:innerWidth,height:innerHeight}; })()');
    assert.equal(expected.scrollTop,0,'截图时配置页面必须已回到顶部');
    const mean = expected.rgb.reduce((total,value) => total+value,0)/3;
    assert.ok(expected.theme === 'dark' ? mean < 80 : mean > 200,'截图的 computed 背景必须匹配当前浅色/深色主题');
    const frame = await window.webContents.capturePage(undefined,captureOptions);
    const size = frame.getSize(), pixels = frame.toBitmap();
    const x = Math.round(expected.x*size.width/expected.width), y = Math.round(expected.y*size.height/expected.height);
    const offset = (y*size.width+x)*4;
    const actual = [pixels[offset+2],pixels[offset+1],pixels[offset]];
    if (!await window.webContents.executeJavaScript('Boolean(document.querySelector("[role=alertdialog]"))')) assert.ok(actual.every((value,index) => Math.abs(value-expected.rgb[index]) <= 3),'截图必须捕获与 computed 背景一致的新画面，不能沿用隐藏窗口旧帧');
    await fs.writeFile(target,frame.toPNG());
  } finally {
    await window.webContents.executeJavaScript('document.getElementById("cloud-smoke-screenshot-mask")?.remove()');
  }
}
async function run() {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-cloud-ui-'));
  app.setPath('userData',dataRoot);
  app.setPath('sessionData',path.join(dataRoot,'session'));
  await app.whenReady();
  const load = file => import(pathToFileURL(path.join(root,file)).href);
  const [{createCloudServer},{WorkspaceStore},{PluginCredentialVault},{CloudConfigWorkspace},{CloudConfigService},{CloudConfigClient},{WorkspaceMutationCoordinator},{registerCloudConfigIpc}] = await Promise.all([
    load('services/cloud-config/server.mjs'),load('src/workspace-store.mjs'),load('src/plugin-credential-vault.mjs'),load('src/cloud-config-workspace.mjs'),load('src/cloud-config-service.mjs'),load('src/cloud-config-client.mjs'),load('src/workspace-mutation-coordinator.mjs'),load('src/cloud-config-ipc.mjs'),
  ]);
  const admin = crypto.randomBytes(32).toString('base64url');
  server = createCloudServer({adminToken:admin});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const key = crypto.randomBytes(32);
  const encryption = {isEncryptionAvailable:() => true,
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv); return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]); },
    decryptString(value) { const decipher = crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8'); },
  };
  const store = new WorkspaceStore(dataRoot); await store.init();
  const vault = new PluginCredentialVault(dataRoot,encryption);
  const project = await store.createProject({projectId:'cloud-demo',name:'云配置演示项目 · Alpha',environmentId:'demo-env'});
  await store.createProject({projectId:'cloud-secondary',name:'云配置演示项目 · Beta',environmentId:'secondary-env'});
  await store.createProject({projectId:'cloud-long',name:'Cloud UX Example · '+ 'VeryLongSyntheticProjectName'.repeat(3)+' · Gamma',environmentId:'long-env'});
  for (const item of additionalProjects) await store.createProject({...item,environmentId:'sample-env'});
  const plugin = await store.createPlugin(project.projectId,'demo-env',{pluginType:'server',pluginInstanceId:'demo-server',displayName:'演示服务器',target:{host:'demo.example.invalid'},auth:{type:'password',username:'demo'}});
  await vault.save(plugin,{password:'synthetic-ui-only-secret'});
  const service = new CloudConfigService({workspace:new CloudConfigWorkspace(store,vault,encryption),mutationCoordinator:new WorkspaceMutationCoordinator(),client:new CloudConfigClient(),connectionManager:{disconnect:async () => {},forgetProject:async () => {}},contextManager:{invalidateProject(){}},confirmationManager:{invalidateProject(){}}});
  await service.init();
  let checkFailure = false, checks = 0;
  const originalRemote = service.remote.bind(service);
  service.remote = async (...args) => { if (checkFailure) throw new Error('synthetic network failure'); return originalRemote(...args); };
  const originalCheck = service.check.bind(service);
  service.check = async (...args) => { checks++; return originalCheck(...args); };
  registerCloudConfigIpc(ipcMain,{cloudConfigService:service,isWorkspaceRenderer:sender => sender === window?.webContents});
  ipcMain.handle('v2:workspace-overview',async () => ({ok:true,data:(await store.listProjects()).map(p => ({...p,environments:[],environmentCount:1,pluginCount:0}))}));
  for (const name of ['project-list','confirmation-list','audit-list']) ipcMain.handle('v2:'+name,() => ({ok:true,data:[]}));
  ipcMain.handle('v2:quick-question-opening-get',() => ({ok:true,data:{schemaVersion:1,text:'',defaultText:'',revision:0}}));
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback) => { network.push(details.url); callback({cancel:true}); });
  window = new BrowserWindow({show:false,width:1264,height:846,webPreferences:{preload:path.join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.on('console-message',(_event,details) => { if (details.level === 'error') errors.push(details.message); });
  await window.loadFile(path.join(root,'renderer-build/v2/index.html'));
  if (process.platform === 'darwin') { window.show(); window.focus(); }
  window.webContents.focus();
  const js = expression => window.webContents.executeJavaScript(expression).catch(() => { throw new Error('UI expression failed: '+expression); });
  const idle = () => wait('document.querySelector("[data-testid=cloud-config-panel]")?.getAttribute("aria-busy") === "false"');
  const openSettings = async () => { await clickTestId('settings-open'); await wait('Boolean(document.querySelector("[data-testid=settings-cloud]"))'); await clickTestId('settings-cloud'); await idle(); };
  const createRepository = async name => {
    await clickText('创建新仓库');
    assert.equal(await js('document.getElementById("cloud-password").value.length'),48);
    await fill('cloud-name',name); await fill('cloud-url',`http://127.0.0.1:${server.address().port}`);
    await fill('cloud-admin-token',admin); await fill('cloud-password','synthetic-ui-password-long-enough');
    await clickText('创建仓库');
    await wait('Boolean(document.querySelector("[data-testid=cloud-check]"))'); await idle();
  };
  await wait('Boolean(document.querySelector("[data-testid=settings-open]"))');
  await openSettings();
  await createRepository('团队仓库');
  console.log('UI: created repository');
  const repositoryId = service.state.activeRepositoryId;
  await clickTestId('settings-back');
  await wait('!document.querySelector("[data-testid=settings-page]")');
  await js('document.querySelector("[data-project-id=cloud-demo] button,button[data-project-id=cloud-demo]").click()');
  await wait('Boolean(document.querySelector("[data-testid=cloud-project-upload]"))');
  await clickTestId('cloud-project-upload');
  await wait('Boolean(document.querySelector("button[data-project-id=cloud-demo] [data-cloud-status=synced]"))');
  const owner = `renderer:${window.webContents.id}`;
  const cloudProjectId = service.state.repositories.find(r=>r.repositoryId===repositoryId).catalog[0].projectId;
  // Seed the long-list fixture through the service; the UI intentionally has no bulk upload.
  const seeded = await service.invoke(owner,'prepare',{repositoryId,direction:'upload',projectIds:['cloud-secondary','cloud-long',...additionalProjects.map(p => p.projectId)]});
  await service.invoke(owner,'confirm',{planId:seeded.planId,choices:Object.fromEntries(seeded.rows.map(row => [row.rowId,'local']))});
  console.log('UI: uploaded project and seeded catalog');
  await openSettings(); await clickTestId('cloud-check');
  await wait(`document.querySelectorAll('[data-testid=cloud-project-card]').length === ${projectCount}`);
  assert.equal(await js('document.querySelector("[data-testid=cloud-project-toolbar]").textContent.includes("上传")'),false,'仓库不提供批量上传');
  assert.equal(await js('[...document.querySelectorAll("[data-testid=cloud-project-card]")].every(card => card.querySelector("[data-testid=cloud-project-update]") && card.querySelector("[data-testid=cloud-project-upload]") && card.querySelector("[role=switch]"))'),true);
  await fill('cloud-project-search','Alpha');
  await wait('document.querySelectorAll("[data-testid=cloud-project-card]").length === 1');
  await fill('cloud-project-search','');
  await wait(`document.querySelectorAll('[data-testid=cloud-project-card]').length === ${projectCount}`);
  console.log('UI: card catalog and search ready');
  for (const theme of ['light','dark']) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const [width,height] of [[1264,846],[900,700],[520,620]]) {
      window.setContentSize(width,height); await wait(`innerWidth === ${width}`); await assertLayout();
      const scroll = await js('(() => { const list=document.querySelector("[data-testid=cloud-project-list]"), toolbar=document.querySelector("[data-testid=cloud-project-toolbar]"); list.scrollTop=list.scrollHeight; const last=list.lastElementChild.lastElementChild, rect=last.getBoundingClientRect(), bounds=list.getBoundingClientRect(); const hit=document.elementFromPoint(rect.left+rect.width/2,Math.min(rect.bottom-2,bounds.bottom-2)); const result={scroll:list.scrollTop>0,reachable:last.contains(hit),toolbar:toolbar.getBoundingClientRect().bottom<=bounds.top,outer:document.querySelector("[data-testid=settings-main]").scrollTop}; list.scrollTop=0; return result; })()');
      assert.deepEqual(scroll,{scroll:true,reachable:true,toolbar:true,outer:0});
      await capture(`-${theme}-${width}`);
    }
  }
  window.setContentSize(1264,846); await wait('innerWidth === 1264');
  await js('document.documentElement.dataset.theme="light"');
  const cardAction = async action => { await js(`document.querySelector('[data-testid=cloud-project-card][data-project-id=${cloudProjectId}] [data-testid=cloud-project-${action}]').click()`); };
  console.log('UI: responsive layouts verified');
  checkFailure = true; await clickTestId('cloud-check');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("检测失败")');
  assert.equal(await js('document.querySelectorAll("[data-testid=cloud-project-card]").length'),projectCount,'离线保留缓存项目');
  checkFailure = false; await clickTestId('cloud-check');
  await wait('!document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("检测失败")');
  await store.updateProject(project.projectId,{name:'本地尚未上传的修改'});
  await clickTestId('cloud-check');
  await wait(`Boolean(document.querySelector('[data-testid=cloud-project-card][data-project-id="${cloudProjectId}"] [data-cloud-status=modified]'))`);
  assert.equal((await store.getProject(project.projectId)).name,'本地尚未上传的修改','检测不得覆盖本地修改');
  await cardAction('update');
  await wait('Boolean(document.querySelector("[data-testid=cloud-update-confirmation]"))');
  assert.equal((await store.getProject(project.projectId)).name,'本地尚未上传的修改','打开确认不得覆盖');
  assert.equal(await js('document.querySelector("[data-testid=settings-back]").disabled'),true);
  await capture('-confirmation');
  await js('[...document.querySelectorAll("[role=alertdialog] button")].find(button => button.textContent === "保留本地").click()');
  await wait('!document.querySelector("[role=alertdialog]")'); await idle();
  await cardAction('update'); await wait('Boolean(document.querySelector("[data-testid=cloud-confirm-update]"))');
  await clickTestId('cloud-confirm-update'); await idle();
  assert.equal((await store.getProject(project.projectId)).name,'云配置演示项目 · Alpha');
  assert.equal(await js('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("synthetic-ui-only-secret")'),false);
  console.log('UI: conflict confirmation and cancellation verified');
  await store.updateProject(project.projectId,{name:'上传后的 Alpha'});
  await cardAction('upload'); await idle();
  assert.equal(service.state.repositories[0].catalog.find(p => p.projectId === cloudProjectId).name,'上传后的 Alpha');
  await js(`document.querySelector('[data-testid=cloud-project-card][data-project-id="${cloudProjectId}"] [role=switch]').click()`);
  await idle(); await wait(`document.querySelector('[data-testid=cloud-project-card][data-project-id="${cloudProjectId}"] [role=switch]').getAttribute('aria-checked') === 'false'`);
  await clickTestId('settings-back');
  await wait('!document.querySelector("button[data-project-id=cloud-demo]")');
  assert.equal(await js('document.querySelector("#project-list").textContent.includes("已同步")'),false,'左侧不显示同步状态文字');
  assert.equal((await store.listProjects()).length,projectCount,'隐藏不删除配置');
  await openSettings(); await clickText('全部显示'); await idle();
  await clickTestId('settings-back'); await wait('!document.querySelector("[data-testid=settings-page]")');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await js('document.querySelector("button[data-project-id=cloud-demo]").focus()');
  const orderBefore = await js('[...document.querySelectorAll("#project-list button[data-project-id]")].map(button=>button.dataset.projectId)');
  const beforeIndex = orderBefore.indexOf('cloud-demo');
  assert.ok(beforeIndex>=0 && beforeIndex<orderBefore.length-1);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down',modifiers:['alt']});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down',modifiers:['alt']});
  await wait(`[...document.querySelectorAll("#project-list button[data-project-id]")].findIndex(button=>button.dataset.projectId === "cloud-demo") === ${beforeIndex+1}`);
  await openSettings();
  console.log('UI: visibility and forced upload verified');
  // Speed up only the preference-controlled interval to exercise the real timer callback.
  await clickTestId('cloud-view-repository');
  await js('window.__cloudSetInterval=window.setInterval; window.setInterval=(callback,ms,...args)=>window.__cloudSetInterval(callback,ms===300000?200:ms,...args); void 0');
  await js('document.querySelector("[aria-label=定时检测间隔]").click()');
  await wait('Boolean(document.querySelector("[role=option]"))');
  await js('[...document.querySelectorAll("[role=option]")].find(option=>option.textContent.includes("每 5 分钟")).click()');
  await idle();
  const checksBefore = checks;
  await store.updateProject(project.projectId,{name:'定时检测不覆盖的修改'});
  const deadline = Date.now()+5000; while(checks<=checksBefore && Date.now()<deadline) await delay(50);
  assert.ok(checks>checksBefore,'定时器必须调用检测');
  assert.equal((await store.getProject(project.projectId)).name,'定时检测不覆盖的修改');
  await js('document.querySelector("[aria-label=定时检测间隔]").click()');
  await wait('Boolean(document.querySelector("[role=option]"))');
  await js('[...document.querySelectorAll("[role=option]")].find(option=>option.textContent === "关闭").click()');
  await idle(); await js('window.setInterval=window.__cloudSetInterval; void 0');
  await clickText('查看版本'); await idle();
  assert.equal(await js('Boolean(document.querySelector("[aria-label=历史版本]"))'),true);
  console.log('UI: timer and history verified');
  await clickTestId('cloud-view-backups');
  await clickTestId('cloud-add-repository'); await createRepository('个人仓库');
  const secondId = service.state.activeRepositoryId;
  await clickTestId('settings-back');
  await wait('!document.querySelector("[data-testid=settings-page]")');
  await js('document.querySelector("button[data-project-id=cloud-demo]").click()');
  await wait('Boolean(document.querySelector("[aria-label=上传到其他仓库]"))');
  await js('document.querySelector("[aria-label=上传到其他仓库]").focus()');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});
  await wait('Boolean(document.querySelector("[role=menuitem]"))');
  await js('[...document.querySelectorAll("[role=menuitem]")].find(item=>item.textContent.includes("个人仓库")).click()');
  await wait('Boolean(document.querySelector("[data-cloud-project-id]"))');
  const copiedId = service.state.repositories.find(r=>r.repositoryId===secondId).catalog[0].projectId;
  assert.notEqual(copiedId,cloudProjectId);
  assert.equal((await store.listProjects()).length,projectCount);
  await js(`document.querySelector('[data-cloud-project-id="${copiedId}"]').click()`);
  await wait(`Boolean(document.querySelector('button[data-project-id="${copiedId}"]'))`);
  assert.equal((await store.listProjects()).length,projectCount+1);
  if (process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(200);
    const directory = path.resolve(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR);
    assert.ok(!directory.startsWith(root+path.sep));
    await fs.writeFile(path.join(directory,'workbench-cloud.png'),(await window.webContents.capturePage()).toPNG());
  }
  await openSettings();
  for(let index=0;index<2;index++) { await clickTestId('cloud-view-repository'); await clickText('解除绑定'); await idle(); }
  await wait('Boolean(document.getElementById("cloud-password"))');
  await clickTestId('cloud-view-backups');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("恢复备份")');
  await clickText('恢复备份');
  await wait('document.querySelector("[role=alertdialog]")?.textContent.includes("恢复本机备份")');
  await js('[...document.querySelectorAll("[role=alertdialog] button")].find(button => button.textContent === "保留本地").click()');
  assert.deepEqual(network,[]); assert.deepEqual(errors,[]);
  console.log('云配置 Electron 冒烟通过：单项目双向同步、修改确认、图标状态、真实定时检测不写配置、多仓库独立 ID、显示开关、24 个项目卡片滚动、浅深色与窄屏、离线缓存、解绑后备份恢复入口。');
}
run().then(() => finish(0)).catch(error => { console.error(error); return finish(1); });
async function finish(code) {
  window?.destroy();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (dataRoot) await fs.rm(dataRoot,{recursive:true,force:true}).catch(() => undefined);
  app.exit(code);
}
