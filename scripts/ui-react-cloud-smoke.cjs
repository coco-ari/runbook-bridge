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
  await window.webContents.executeJavaScript(`(() => { const button = document.querySelector('[data-testid="'+${JSON.stringify(testId)}+'"]'); if (!button || button.disabled) throw new Error('按钮不可用'); button.click(); })()`);
}
async function fill(id,value) {
  await window.webContents.executeJavaScript(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function visibleProjects() {
  return window.webContents.executeJavaScript('[...document.querySelectorAll("[data-testid=cloud-project-row]")].filter(row => row.getClientRects().length).map(row => ({id:row.dataset.projectId,checked:row.querySelector("input").checked}))');
}
async function assertSelected(count) {
  const preview = await window.webContents.executeJavaScript('(() => { const button=document.querySelector("[data-testid=cloud-preview]"); return {label:button?.getAttribute("aria-label"),disabled:button?.disabled}; })()');
  assert.match(preview.label ?? '',new RegExp(`(?:^|\\D)${count}(?:\\D|$)`),'预览入口应准确读出所有已选项目数量，包括被搜索隐藏的项目');
  assert.equal(preview.disabled,count === 0);
}
async function assertLayout() {
  const layout = await window.webContents.executeJavaScript('(() => { const panel=document.querySelector("[data-testid=cloud-config-panel]"), page=document.querySelector("[data-testid=settings-main]"); return {overflow:panel.scrollWidth>panel.clientWidth || page.scrollWidth>page.clientWidth || document.documentElement.scrollWidth>innerWidth,inside:panel.getBoundingClientRect().left>=0 && panel.getBoundingClientRect().right<=innerWidth}; })()');
  assert.deepEqual(layout,{overflow:false,inside:true},'云配置及长项目名不得产生水平溢出');
}
async function assertScrollLayout() {
  const evidence = await window.webContents.executeJavaScript('(() => { const list=document.querySelector("[data-testid=cloud-project-list]"), toolbar=document.querySelector("[data-testid=cloud-project-toolbar]"), footer=document.querySelector("[data-testid=cloud-project-actions]"), page=document.querySelector("[data-testid=settings-main]"); const position=()=>{const l=list.getBoundingClientRect(),t=toolbar.getBoundingClientRect(),f=footer.getBoundingClientRect(); return {listTop:l.top,listBottom:l.bottom,listHeight:l.height,toolbarTop:t.top,toolbarBottom:t.bottom,footerTop:f.top,footerBottom:f.bottom,scrollTop:list.scrollTop,pageScroll:page.scrollTop,mainBottom:page.getBoundingClientRect().bottom};}; const result=[]; for(const fraction of [0,0.5,1]) {list.scrollTop=(list.scrollHeight-list.clientHeight)*fraction; result.push(position());} const last=list.querySelector("[data-testid=cloud-project-row]:last-child"), rect=last.getBoundingClientRect(), listRect=list.getBoundingClientRect(); const hit=document.elementFromPoint(rect.left+rect.width/2,Math.min(rect.bottom-4,listRect.bottom-4)); const lastReachable=last.contains(hit), rowHeight=list.querySelector("[data-project-id=cloud-secondary]").getBoundingClientRect().height; list.scrollTop=0; return {positions:result,lastReachable,rowHeight,pageOverflow:page.scrollHeight>page.clientHeight+1}; })()');
  assert.equal(evidence.pageOverflow,false,'项目同步外层页面不应形成第二个滚动区');
  assert.ok(evidence.rowHeight >= 40 && evidence.rowHeight <= 50,'普通项目行应紧凑且保留点击空间');
  assert.equal(evidence.lastReachable,true,'滚到末尾时最后一项必须完整可点击，不被操作栏盖住');
  for (const position of evidence.positions) {
    assert.ok(position.listHeight >= 96,'窄窗口也应为项目列表保留可用高度');
    assert.ok(position.toolbarBottom <= position.listTop && position.listBottom <= position.footerTop+1,'工具栏、列表和操作栏必须占据互不重叠的空间');
    assert.ok(position.footerBottom <= position.mainBottom,'预览入口始终在可见页面内');
    assert.equal(position.toolbarTop,evidence.positions[0].toolbarTop,'滚动项目不应移走工具栏');
    assert.equal(position.footerTop,evidence.positions[0].footerTop,'滚动项目不应移动操作栏');
    assert.equal(position.pageScroll,0,'滚动只发生在项目列表内');
  }
  assert.ok(evidence.positions[1].scrollTop>0 && evidence.positions[2].scrollTop>evidence.positions[1].scrollTop,'必须用足量项目覆盖列表中段和末尾');
  await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(180);
  await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  const center = await window.webContents.executeJavaScript('(() => { const rect=document.querySelector("[data-testid=cloud-project-list]").getBoundingClientRect(); return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}; })()');
  window.webContents.sendInputEvent({type:'mouseMove',...center});
  window.webContents.sendInputEvent({type:'mouseWheel',...center,deltaY:-10000,canScroll:true});
  await wait('(() => { const list=document.querySelector("[data-testid=cloud-project-list]"); return list.scrollTop>0 && list.scrollTop+list.clientHeight>=list.scrollHeight-1; })()');
  const checkbox = await window.webContents.executeJavaScript('(() => { const rect=document.querySelector("[data-testid=cloud-project-row]:last-child input").getBoundingClientRect(); return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}; })()');
  for (const count of [2,1]) {
    window.webContents.sendInputEvent({type:'mouseDown',...checkbox,button:'left',clickCount:1});
    window.webContents.sendInputEvent({type:'mouseUp',...checkbox,button:'left',clickCount:1});
    await wait('document.querySelector("[data-testid=cloud-preview]").getAttribute("aria-label").includes("（'+count+'）")');
  }
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-project-list]").scrollTop=0');
}
async function capture(suffix='') {
  if (!process.env.RUNBOOK_BRIDGE_CLOUD_SCREENSHOT) return;
  const original = path.resolve(process.env.RUNBOOK_BRIDGE_CLOUD_SCREENSHOT);
  const extension = path.extname(original);
  const target = suffix ? original.slice(0,extension ? -extension.length : undefined)+suffix+(extension || '.png') : original;
  assert.ok(target.toLowerCase() !== root.toLowerCase() && !target.toLowerCase().startsWith((root+path.sep).toLowerCase()),'截图必须保存在仓库外');
  await fs.mkdir(path.dirname(target),{recursive:true});
  await window.webContents.executeJavaScript('(() => { const style=document.createElement("style"); style.id="cloud-smoke-screenshot-mask"; style.textContent="#cloud-url, #cloud-password, #cloud-admin-token, input[type=password] { visibility: hidden !important; } *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }"; document.head.append(style); document.querySelector("[data-testid=settings-main]").scrollTo({top:0,left:0,behavior:"instant"}); })()');
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
    assert.ok(actual.every((value,index) => Math.abs(value-expected.rgb[index]) <= 3),'截图必须捕获与 computed 背景一致的新画面，不能沿用隐藏窗口旧帧');
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
  const originalCatalog = service.catalog.bind(service);
  let catalogHold = null, catalogFailure = false;
  service.catalog = async (...args) => {
    if (catalogHold) await catalogHold;
    if (catalogFailure) throw new Error('合成测试：项目列表暂时无法读取');
    return originalCatalog(...args);
  };
  registerCloudConfigIpc(ipcMain,{cloudConfigService:service,isWorkspaceRenderer:sender => sender === window?.webContents});
  for (const name of ['workspace-overview','project-list','confirmation-list']) ipcMain.handle('v2:'+name,() => ({ok:true,data:[]}));
  ipcMain.handle('v2:quick-question-opening-get',() => ({ok:true,data:{schemaVersion:1,text:'',defaultText:'',revision:0}}));
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback) => { network.push(details.url); callback({cancel:true}); });
  window = new BrowserWindow({show:false,width:1264,height:846,webPreferences:{preload:path.join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.on('console-message',(_event,details) => { if (details.level === 'error') errors.push(details.message); });
  await window.loadFile(path.join(root,'renderer-build/v2/index.html'));
  await wait('Boolean(document.querySelector("[data-testid=settings-open]"))');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-open]").click()');
  await wait('Boolean(document.querySelector("[data-testid=settings-page]"))');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("[role=dialog],[data-slot=dialog-overlay]"))'),false);
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-cloud]").click()');
  await wait('Boolean(document.querySelector("[data-testid=cloud-config-panel]")) && !document.querySelector("[data-testid=cloud-config-panel] fieldset").disabled');
  await clickText('创建新仓库');
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cloud-password").value.length'),48);
  await fill('cloud-url',`http://127.0.0.1:${server.address().port}`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("仓库访问凭证会明文传输")'),true);
  await fill('cloud-admin-token',admin);
  await fill('cloud-password','synthetic-ui-password-long-enough');
  await clickText('创建仓库');
  await wait('document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-appearance]").disabled'),true,'处理时禁止切换页面');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("仓库已解锁") && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.getElementById("cloud-password"))'),false);
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cloud-url").getClientRects().length'),0,'项目同步时仓库设置不占列表空间');
  await clickTestId('cloud-view-repository');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("#cloud-url[readonly]")?.getClientRects().length)'),true,'仓库设置页可查看完整链接');
  await clickTestId('cloud-view-sync');
  await clickTestId('cloud-direction-upload');
  assert.equal((await visibleProjects()).length,projectCount);
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cloud-project-search").getAttribute("aria-label")'),'搜索项目');
  await assertSelected(0);
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-project-row][data-project-id=cloud-demo] input").click()');
  await assertSelected(1);
  await window.webContents.executeJavaScript('document.getElementById("cloud-project-search").focus()');
  await window.webContents.insertText('cLoUd uX');
  await wait('document.getElementById("cloud-project-search").value === "cLoUd uX"');
  assert.deepEqual(await visibleProjects(),[{id:'cloud-long',checked:false}],'项目搜索忽略大小写');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await wait('document.activeElement?.getAttribute("aria-label") === "清除搜索"');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await wait('document.getElementById("cloud-project-search").value === ""');
  assert.equal((await visibleProjects()).length,projectCount,'键盘可以清除搜索并恢复项目列表');
  await fill('cloud-project-search','cLoUd uX');
  await assertSelected(1);
  await clickText('全选匹配项目');
  assert.deepEqual(await visibleProjects(),[{id:'cloud-long',checked:true}]);
  await assertSelected(2);
  await clickText('取消匹配选择');
  assert.deepEqual(await visibleProjects(),[{id:'cloud-long',checked:false}]);
  await assertSelected(1);
  await fill('cloud-project-search','云配置演示项目');
  assert.equal((await visibleProjects()).length,2);
  await clickText('全选匹配项目');
  assert.equal((await visibleProjects()).every(row => row.checked),true,'搜索后的全选仅作用于匹配项目');
  await assertSelected(2);
  await fill('cloud-project-search','no-synthetic-project-matches');
  assert.deepEqual(await visibleProjects(),[],'无匹配结果时不显示其他项目');
  await assertSelected(2);
  await fill('cloud-project-search','');
  assert.deepEqual(Object.fromEntries((await visibleProjects()).map(row => [row.id,row.checked])),{
    'cloud-demo':true,'cloud-secondary':true,'cloud-long':false,...Object.fromEntries(additionalProjects.map(project => [project.projectId,false])),
  },'清空搜索后保留隐藏项目的勾选状态');
  await clickText('全选');
  await assertSelected(projectCount);
  await clickText('取消全选');
  await assertSelected(0);
  await clickText('全选');
  await clickTestId('cloud-preview');
  await wait('Boolean(document.querySelector("[aria-label=同步预览]"))');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector("[aria-label=同步预览] h2")'),true,'进入预览后将焦点移至预览标题');
  assert.equal((await visibleProjects()).length,0,'预览阶段隐藏项目选择列表');
  await clickText('返回选择项目');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement?.id'),'cloud-project-selection','返回选择后将焦点移至项目选择标题');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("[aria-label=同步预览]"))'),false,'返回后清除旧同步预览');
  await assertSelected(projectCount);
  await clickTestId('cloud-preview');
  await wait('Boolean(document.querySelector("[aria-label=同步预览]"))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[aria-label=同步预览]").textContent.includes("synthetic-ui-only-secret")'),false);
  await clickText('确认上传');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("已完成 '+projectCount+' 个项目") && !document.querySelector("[data-testid=settings-back]").disabled');
  await store.updateProject(project.projectId,{name:'本地尚未上传的修改'});
  await clickTestId('cloud-direction-download');
  assert.equal((await visibleProjects()).length,projectCount);
  let releaseCatalog;
  catalogHold = new Promise(resolve => { releaseCatalog=resolve; });
  catalogFailure = true;
  await window.webContents.executeJavaScript('document.querySelector("[aria-label=刷新云配置]").click()');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("正在读取项目…")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-back]").disabled'),true,'项目列表读取中禁止离开配置');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("云仓库还没有项目")'),false,'读取中的仓库不能显示为空仓库');
  releaseCatalog();
  catalogHold = null;
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("项目读取失败") && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("云仓库还没有项目")'),false,'读取失败不能显示为空仓库');
  catalogFailure = false;
  await clickText('重新读取');
  await wait('document.querySelectorAll("[data-testid=cloud-project-row]").length === '+projectCount+' && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("项目读取失败")'),false,'重新读取成功后清除失败状态');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-project-row][data-project-id=cloud-demo] input").click()');
  await assertSelected(1);
  await assertLayout();
  await clickTestId('cloud-selected-only');
  assert.deepEqual(await visibleProjects(),[{id:'cloud-demo',checked:true}],'仅看已选能准确核对长列表中的项目');
  await clickText('清空选择');
  await assertSelected(0);
  assert.deepEqual(await visibleProjects(),[],'清空选择后仅看已选显示明确空状态');
  await clickText('查看全部项目');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-project-row][data-project-id=cloud-demo] input").click()');
  await assertSelected(1);
  await clickTestId('cloud-view-repository');
  await clickTestId('cloud-view-sync');
  await assertSelected(1);
  await assertScrollLayout();
  const originalTheme = await window.webContents.executeJavaScript('document.documentElement.getAttribute("data-theme")');
  try {
    await window.webContents.executeJavaScript('document.documentElement.dataset.theme="light"');
    const lightBackground = await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-testid=settings-page]")).backgroundColor');
    await capture();
    await window.webContents.executeJavaScript('(() => { const list=document.querySelector("[data-testid=cloud-project-list]"); list.scrollTop=(list.scrollHeight-list.clientHeight)/2; })()');
    await capture('-middle');
    await window.webContents.executeJavaScript('(() => { const list=document.querySelector("[data-testid=cloud-project-list]"); list.scrollTop=list.scrollHeight; })()');
    await capture('-bottom');
    await window.webContents.executeJavaScript('document.documentElement.dataset.theme="dark"');
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.dataset.theme'),'dark','深色截图使用实际生效的主题属性');
    assert.notEqual(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-testid=settings-page]")).backgroundColor'),lightBackground,'浅色和深色模式的 computed 背景必须实际改变');
    await capture('-dark');
  } finally {
    await window.webContents.executeJavaScript(originalTheme === null ? 'document.documentElement.removeAttribute("data-theme")' : `document.documentElement.setAttribute('data-theme',${JSON.stringify(originalTheme)})`);
  }
  window.setContentSize(520,620);
  await wait('innerWidth === 520');
  await assertLayout();
  await assertScrollLayout();
  await capture('-narrow');
  window.setContentSize(1264,780);
  await wait('innerWidth === 1264');
  await clickTestId('cloud-preview');
  await wait('document.querySelector("[aria-label=同步预览]")?.textContent.includes("需要选择")');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("[aria-label=同步预览] button")].find(b => b.textContent.trim() === "确认导入").disabled'),true);
  assert.equal(await window.webContents.executeJavaScript('(() => { const radio=document.querySelector("[aria-label=同步预览] input[type=radio]"); return Boolean(radio?.closest("fieldset")?.querySelector("legend")?.textContent.includes("选择配置")); })()'),true,'冲突选项通过 fieldset 和 legend 提供明确的选择范围');
  await window.webContents.executeJavaScript('[...document.querySelectorAll("[aria-label=同步预览] label")].find(label => label.textContent.includes("采用云端")).querySelector("input").click()');
  await capture('-preview');
  await assertLayout();
  await clickText('确认导入');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("已完成 1 个项目") && !document.querySelector("[data-testid=cloud-config-panel] fieldset").disabled');
  assert.equal((await store.getProject(project.projectId)).name,'云配置演示项目 · Alpha');
  await clickTestId('cloud-view-backups');
  await clickText('预览恢复');
  await wait('document.querySelector("[aria-label=同步预览]")?.textContent.includes("本地备份恢复预览")');
  await window.webContents.executeJavaScript('[...document.querySelectorAll("[aria-label=同步预览] label")].find(label => label.textContent.includes("采用备份")).querySelector("input").click()');
  await clickText('确认恢复');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("已完成 1 个项目") && !document.querySelector("[data-testid=cloud-config-panel] fieldset").disabled');
  assert.equal((await store.getProject(project.projectId)).name,'本地尚未上传的修改');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-back]").click()');
  await wait('!document.querySelector("[data-testid=settings-page]")');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-open]").click()');
  await wait('Boolean(document.querySelector("[data-testid=settings-cloud]"))');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-cloud]").click()');
  await wait('Boolean(document.querySelector("[data-testid=cloud-config-panel]")) && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("[aria-label=同步预览]"))'),false,'返回后清除旧同步预览');
  await clickTestId('cloud-view-repository');
  await clickText('解除绑定');
  await wait('Boolean(document.getElementById("cloud-password")) && !document.querySelector("[data-testid=settings-back]").disabled');
  await clickTestId('cloud-view-backups');
  await window.webContents.executeJavaScript('(() => { const backups=document.querySelector("[data-testid=cloud-backups]"); if(!backups) throw new Error("解除绑定后本地备份不可用"); backups.open=true; const button=[...backups.querySelectorAll("button")].find(item => item.textContent.trim() === "预览恢复"); button.dataset.smokeRestoreSource="true"; button.focus(); button.click(); })()');
  await wait('document.querySelector("[aria-label=同步预览]")?.textContent.includes("本地备份恢复预览") && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[aria-label=同步预览]").textContent.includes("返回本地备份")'),true,'未绑定仓库时恢复预览应提供返回本地备份入口');
  await clickText('返回本地备份');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("[aria-label=同步预览]"))'),false,'返回本地备份后清除恢复预览');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector("[data-smoke-restore-source=true]")'),true,'返回本地备份后恢复到原恢复按钮的焦点');
  await clickTestId('cloud-view-repository');
  await fill('cloud-password','synthetic-unsaved-password');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-back]").click()');
  await wait('!document.querySelector("[data-testid=settings-page]")');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-open]").click()');
  await wait('Boolean(document.querySelector("[data-testid=settings-cloud]"))');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=settings-cloud]").click()');
  await wait('Boolean(document.getElementById("cloud-password")) && !document.querySelector("[data-testid=settings-back]").disabled');
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cloud-password").value'),'', '离开配置页面后清除未提交的密码');
  window.setContentSize(520,620);
  await wait('innerWidth === 520');
  assert.equal(await window.webContents.executeJavaScript('(() => { const page=document.querySelector("[data-testid=settings-main]"); return page.scrollWidth <= page.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()'),true,'窄窗口云配置无水平溢出');
  assert.deepEqual(network,[]); assert.deepEqual(errors,[]);
  console.log('云配置 Electron 冒烟通过：搜索与跨筛选选择、读取失败重试、预览返回、24 项长列表顶部/中部/底部无覆盖、仅列表滚动、窄屏与长名称、创建上传、冲突导入、解绑后备份预览及凭据不回显。');
}
run().then(() => finish(0)).catch(error => { console.error(error); return finish(1); });
async function finish(code) {
  window?.destroy();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (dataRoot) await fs.rm(dataRoot,{recursive:true,force:true}).catch(() => undefined);
  app.exit(code);
}
