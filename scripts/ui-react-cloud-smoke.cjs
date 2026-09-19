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
async function fill(id,value) {
  await window.webContents.executeJavaScript(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
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
  const project = await store.createProject({projectId:'cloud-demo',name:'云配置演示项目',environmentId:'demo-env'});
  const plugin = await store.createPlugin(project.projectId,'demo-env',{pluginType:'server',pluginInstanceId:'demo-server',displayName:'演示服务器',target:{host:'demo.example.invalid'},auth:{type:'password',username:'demo'}});
  await vault.save(plugin,{password:'synthetic-ui-only-secret'});
  const service = new CloudConfigService({workspace:new CloudConfigWorkspace(store,vault,encryption),mutationCoordinator:new WorkspaceMutationCoordinator(),client:new CloudConfigClient(),connectionManager:{disconnect:async () => {},forgetProject:async () => {}},contextManager:{invalidateProject(){}},confirmationManager:{invalidateProject(){}}});
  await service.init();
  registerCloudConfigIpc(ipcMain,{cloudConfigService:service,isWorkspaceRenderer:sender => sender === window?.webContents});
  for (const name of ['workspace-overview','project-list','confirmation-list']) ipcMain.handle('v2:'+name,() => ({ok:true,data:[]}));
  ipcMain.handle('v2:quick-question-opening-get',() => ({ok:true,data:{schemaVersion:1,text:'',defaultText:'',revision:0}}));
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback) => { network.push(details.url); callback({cancel:true}); });
  window = new BrowserWindow({show:false,width:1100,height:880,webPreferences:{preload:path.join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
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
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("仓库已解锁")');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.getElementById("cloud-password"))'),false);
  await clickText('上传项目'); await clickText('全选'); await clickText('预览上传（1）');
  await wait('Boolean(document.querySelector("[aria-label=同步预览]"))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("[aria-label=同步预览]").textContent.includes("synthetic-ui-only-secret")'),false);
  await clickText('确认上传');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("已完成 1 个项目")');
  await store.updateProject(project.projectId,{name:'本地尚未上传的修改'});
  await clickText('下载项目'); await clickText('全选'); await clickText('预览下载（1）');
  await wait('document.querySelector("[aria-label=同步预览]")?.textContent.includes("需要选择")');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("[aria-label=同步预览] button")].find(b => b.textContent.trim() === "确认导入").disabled'),true);
  await window.webContents.executeJavaScript('[...document.querySelectorAll("[aria-label=同步预览] label")].find(label => label.textContent.includes("采用云端")).querySelector("input").click()');
  const screenshot = process.env.RUNBOOK_BRIDGE_CLOUD_SCREENSHOT;
  if (screenshot) {
    const target = path.resolve(screenshot);
    assert.ok(!target.startsWith(root+path.sep),'截图必须保存在仓库外');
    await fs.mkdir(path.dirname(target),{recursive:true});
    await window.webContents.executeJavaScript('document.getElementById("cloud-url").style.visibility="hidden"');
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(150);
    await fs.writeFile(target,(await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript('document.getElementById("cloud-url").style.visibility=""');
  }
  const layout = await window.webContents.executeJavaScript('(() => { const dialog=document.querySelector("[data-testid=cloud-config-panel]"); return {overflow:dialog.scrollWidth>dialog.clientWidth,inside:dialog.getBoundingClientRect().left>=0 && dialog.getBoundingClientRect().right<=innerWidth}; })()');
  assert.deepEqual(layout,{overflow:false,inside:true});
  await clickText('确认导入');
  await wait('document.querySelector("[data-testid=cloud-config-panel]").textContent.includes("已完成 1 个项目") && !document.querySelector("[data-testid=cloud-config-panel] fieldset").disabled');
  assert.equal((await store.getProject(project.projectId)).name,'云配置演示项目');
  await window.webContents.executeJavaScript('document.querySelector("[data-testid=cloud-config-panel] details").open=true');
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
  await clickText('解除绑定');
  await wait('Boolean(document.getElementById("cloud-password")) && !document.querySelector("[data-testid=settings-back]").disabled');
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
  console.log('云配置 Electron 冒烟通过：创建、上传、冲突确认、导入、备份恢复及凭据不回显。');
}
run().then(() => finish(0)).catch(error => { console.error(error); return finish(1); });
async function finish(code) {
  window?.destroy();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (dataRoot) await fs.rm(dataRoot,{recursive:true,force:true}).catch(() => undefined);
  app.exit(code);
}
