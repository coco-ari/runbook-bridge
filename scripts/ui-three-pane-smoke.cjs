const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();
const root = path.resolve(__dirname,'..');
const dataRoot = path.join(os.tmpdir(),`ai-ops-three-pane-smoke-${process.pid}`);
app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));

const runtime = (projectId,environmentId,count = 0) => ({
  projectId,environmentId,desiredConnected:false,phase:'disconnected',eligibleCount:count,connectedCount:0,
  errorCount:0,blockedCount:0,draftCount:0,plugins:{},
});
const plugins = {
  prod:[
    {projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',pluginType:'server',displayName:'应用服务器',revision:1,configState:'ready',target:{host:'47.84.203.24',port:22,addressFamily:'ipv4Only'},auth:{username:'root',type:'password'},uplink:{type:'direct'},sources:[],limits:{maxBytes:262144}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'mysql-member',pluginType:'mysql',displayName:'会员业务库',revision:1,configState:'ready',target:{host:'127.0.0.1',port:3306,database:'member',addressFamily:'ipv4Preferred'},auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-app'},tls:{mode:'disabled'},limits:{maxRows:100,timeoutMs:10000}},
  ],
  gray:[{projectId:'member',environmentId:'gray',pluginInstanceId:'gray-server',pluginType:'server',displayName:'灰度服务器',revision:1,configState:'ready',target:{host:'10.0.0.8',port:22,addressFamily:'ipv4Only'},auth:{username:'deploy',type:'password'},uplink:{type:'direct'},sources:[],limits:{maxBytes:262144}}],
};
const environments = [
  {projectId:'member',environmentId:'prod',name:'正式环境',revision:1,pluginCount:2,readyPluginCount:2,pluginTypeCounts:{server:1,mysql:1,redis:0},resourcePreview:plugins.prod.map((plugin) => ({pluginInstanceId:plugin.pluginInstanceId,pluginType:plugin.pluginType,displayName:plugin.displayName,configState:plugin.configState,resource:plugin.pluginType === 'server' ? {host:plugin.target.host,port:plugin.target.port} : {database:plugin.target.database}})),runtime:runtime('member','prod',2)},
  {projectId:'member',environmentId:'gray',name:'灰度环境',revision:1,pluginCount:1,readyPluginCount:1,pluginTypeCounts:{server:1,mysql:0,redis:0},resourcePreview:[{pluginInstanceId:'gray-server',pluginType:'server',displayName:'灰度服务器',configState:'ready',resource:{host:'10.0.0.8',port:22}}],runtime:runtime('member','gray',1)},
];
const projects = [{schemaVersion:2,projectId:'member',name:'澳大利亚-zip',revision:1,environmentCount:2,pluginCount:3,environments}];
const confirmations = [
  {requestId:'confirm-upload',projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',clientInstanceId:'agent-smoke',projectNameSnapshot:'澳大利亚-zip',environmentNameSnapshot:'正式环境',pluginNameSnapshot:'应用服务器',capability:'fs.upload',capabilityLabel:'上传服务器文件',riskLevel:'write',approvalLevel:'standard',summary:'上传 121 字节：demo.txt → /tmp/demo.txt',createdAt:new Date().toISOString(),expiresAt:Date.now()+300000,presentation:{kind:'file-transfer',target:'应用服务器',source:'D:\\demo.txt',destination:'/tmp/demo.txt',bytes:121,sha256:'a'.repeat(64),overwrite:false}},
  {requestId:'confirm-shell',projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',clientInstanceId:'agent-smoke',projectNameSnapshot:'澳大利亚-zip',environmentNameSnapshot:'正式环境',pluginNameSnapshot:'应用服务器',capability:'shell.execute',capabilityLabel:'执行任意 Shell',riskLevel:'critical',approvalLevel:'strong',summary:'执行 Shell：systemctl status member.service',createdAt:new Date().toISOString(),expiresAt:Date.now()+300000,presentation:{kind:'shell',target:'应用服务器',command:'systemctl status member.service',workingDirectory:'/srv/member'}},
];
const ok = (data) => ({ok:true,data});
const handle = (channel,fn) => ipcMain.handle(channel,async (event,...args) => ok(await fn(...args,event)));

handle('v2:workspace-overview',() => projects);
handle('v2:project-update',({projectId,patch}) => {
  const project = projects.find((item) => item.projectId === projectId);
  Object.assign(project,patch,{revision:Number(project.revision ?? 0) + 1});
  return project;
});
handle('v2:environment-create',({projectId,input}) => {
  const environmentId = `created-${environments.length + 1}`;
  const environment = {projectId,environmentId,name:input.name,revision:1,pluginCount:0,readyPluginCount:0,pluginTypeCounts:{server:0,mysql:0,redis:0},resourcePreview:[],runtime:runtime(projectId,environmentId,0)};
  environments.push(environment);
  plugins[environmentId] = [];
  const project = projects.find((item) => item.projectId === projectId);
  Object.assign(project,{environmentCount:environments.length,revision:Number(project.revision ?? 0) + 1});
  return environment;
});
handle('v2:environment-list',() => environments);
handle('v2:plugin-list',({environmentId}) => plugins[environmentId] ?? []);
handle('v2:plugin-credential-status',() => ({fields:{primary:false,proxy:false}}));
handle('v2:environment-status',({projectId,environmentId}) => runtime(projectId,environmentId,(plugins[environmentId] ?? []).length));
handle('v2:runbook-read',() => ({content:'# 正式环境运维说明\n\n## 上线前检查\n\n- 确认应用包版本与发布单一致\n- 检查磁盘空间与当前服务状态',hash:'a'.repeat(64)}));
let auditEntries = [
  {id:'mysql-pending',time:'2026-08-17T08:01:00.000Z',type:'plugin-operation-decision',environmentId:'prod',pluginInstanceId:'mysql-member',capability:'select',result:'pending-confirmation',errorCode:'CONFIRMATION_REQUIRED'},
  {id:'mysql-op',time:'2026-08-17T08:00:00.000Z',type:'mysql-query',environmentId:'prod',pluginInstanceId:'mysql-member',operation:'SELECT 只读查询',result:'success',detail:'返回 12 行'},
  {id:'server-op',time:'2026-08-17T07:00:00.000Z',type:'plugin-operation',environmentId:'prod',pluginInstanceId:'server-app',capability:'status',result:'success',detail:'服务正常'},
];
handle('v2:audit-list',({environmentId}) => ({entries:auditEntries.filter((entry) => !environmentId || entry.environmentId === environmentId)}));
handle('v2:audit-clear',({environmentId,pluginInstanceId}) => {
  const previous = auditEntries.length;
  auditEntries = auditEntries.filter((entry) => entry.environmentId !== environmentId || (pluginInstanceId && entry.pluginInstanceId !== pluginInstanceId));
  return {deletedCount:previous - auditEntries.length,environmentId,pluginInstanceId:pluginInstanceId ?? null};
});
handle('v2:confirmation-list',() => confirmations);
handle('v2:confirmation-approve',(requestId,event) => {
  const index = confirmations.findIndex((item) => item.requestId === requestId);
  const [item] = index >= 0 ? confirmations.splice(index,1) : [];
  if (item) setTimeout(() => event.sender.send('v2:workspace-changed',{type:'confirmation-execution',status:'success',confirmationId:item.requestId,projectId:item.projectId,environmentId:item.environmentId,pluginInstanceId:item.pluginInstanceId,durationMs:37}),40);
  return {requestId,approvalToken:'smoke-approval-token'};
});
handle('v2:confirmation-reject',(requestId) => {
  const index = confirmations.findIndex((item) => item.requestId === requestId);
  if (index >= 0) confirmations.splice(index,1);
  return {requestId,rejected:true};
});
handle('v2:plugin-test',() => ({
  connected:true,diagnosticOnly:true,reused:false,totalElapsedMs:28,
  checks:[
    {id:'configuration',label:'配置与依赖',status:'success',detail:'当前配置有效',elapsedMs:4},
    {id:'connection',label:'路由、MySQL 与认证',status:'success',detail:'数据库路由与身份认证完成',elapsedMs:21},
    {id:'protocol',label:'SELECT 1 健康检查',status:'success',detail:'数据库返回有效结果',elapsedMs:3},
  ],
}));

async function run() {
  const errors = [];
  const win = new BrowserWindow({show:false,useContentSize:true,width:1600,height:960,webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(details) => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.on('did-fail-load',(_event,code,description) => errors.push(`${code}: ${description}`));
  await win.loadFile(path.join(root,'renderer','v2','index.html'));
  const result = await win.webContents.executeJavaScript(`(async()=>{
    const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    await wait(()=>document.querySelectorAll('.resource-environment-card').length===2,'environment cards');
    await wait(()=>!document.querySelector('#runbookView').classList.contains('hidden'),'environment runbook');
    const app=document.querySelector('#app'),rail=document.querySelector('.project-rail'),resources=document.querySelector('#resourcePane'),detail=document.querySelector('#detailPane');
    const initialRects=[rail,resources,detail].map(element=>element.getBoundingClientRect());
    const environmentTabs=[...document.querySelectorAll('#detailTopTabs .detail-top-tab')].map(item=>item.textContent.trim());
    const selectedHeaderContinuous=document.querySelector('.resource-environment-card.selected .resource-environment-head')!==null;
    const compactEnvironmentActions=[...document.querySelectorAll('.resource-environment-head')].every(head=>Boolean(head.querySelector(':scope > [data-environment-runtime-action]'))&&Boolean(head.querySelector(':scope > [data-resource-rename-environment]'))&&Boolean(head.querySelector(':scope > [data-resource-delete-environment]'))&&!head.querySelector('.action-menu'));
    const environmentActionsWrapCleanly=[...document.querySelectorAll('.resource-environment-head')].every(head=>{const center=control=>{const rect=control.getBoundingClientRect();return Math.round(rect.top+rect.height/2)};const top=[head.querySelector(':scope > .resource-environment-select'),head.querySelector(':scope > .resource-environment-status')].filter(Boolean).map(center);const bottom=[head.querySelector(':scope > .resource-runtime-action'),head.querySelector(':scope > .scope-confirmation-badge'),head.querySelector(':scope > .resource-rename'),head.querySelector(':scope > .resource-delete')].filter(Boolean).map(center);return Math.max(...top)-Math.min(...top)<=2&&Math.max(...bottom)-Math.min(...bottom)<=2&&Math.min(...bottom)>Math.max(...top);});
    const environmentHeaderHeight=Math.round(document.querySelector('.resource-environment-head').getBoundingClientRect().height);
    const railRefined=!document.querySelector('.rail-brand')&&!document.querySelector('.rail-project-manage')&&Boolean(document.querySelector('.rail-header .logo-mark use[href="#i-app"]'));
    const projectActionsExposed=!document.querySelector('#overviewAddEnvironment')&&!document.querySelector('.resource-project-actions .action-menu')&&['projectSettingsShortcut','resetWorkspaceWidths','projectDeleteShortcut'].every(id=>Boolean(document.querySelector('#'+id)));
    const environmentCaretRemoved=!document.querySelector('.resource-chevron');
    document.querySelector('.resource-environment-select[data-resource-environment-id="gray"]').click();
    await wait(()=>Boolean(document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="gray"]'))&&!document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="prod"]'),'exclusive environment expand');
    const switchedEnvironmentExclusive=document.querySelectorAll('.resource-environment-card.expanded').length===1;
    document.querySelector('.resource-environment-select[data-resource-environment-id="gray"]').click();
    await wait(()=>document.querySelectorAll('.resource-environment-card.expanded').length===0,'collapse selected environment');
    const selectedEnvironmentCollapsed=document.querySelectorAll('.resource-environment-card.expanded').length===0;
    document.querySelector('.resource-environment-select[data-resource-environment-id="prod"]').click();
    await wait(()=>Boolean(document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="prod"]')),'restore production environment');
    const environmentCardToggle=environmentCaretRemoved&&switchedEnvironmentExclusive&&selectedEnvironmentCollapsed;
    document.querySelector('#showInlineEnvironmentCreate').click();
    await wait(()=>!document.querySelector('#resourceEnvironmentCreateForm').classList.contains('hidden'),'inline environment create');
    const environmentCreateInline=!document.querySelector('#environmentManagerDialog').open;
    document.querySelector('#resourceEnvironmentName').value='新增测试环境';
    document.querySelector('#resourceEnvironmentCreateForm').requestSubmit();
    await wait(()=>[...document.querySelectorAll('.resource-environment-card')].some(card=>card.textContent.includes('新增测试环境')),'save inline environment');
    const environmentCreatedInline=environmentCreateInline&&document.querySelector('#resourceEnvironmentCreateForm').classList.contains('hidden')&&!document.querySelector('#showInlineEnvironmentCreate').classList.contains('hidden');
    document.querySelector('#projectSettingsShortcut').click();
    await wait(()=>!document.querySelector('#projectTitleEditor').classList.contains('hidden'),'inline project title editor');
    document.querySelector('#projectTitleInput').value='澳大利亚-zip · 新版';
    document.querySelector('#saveProjectTitle').click();
    await wait(()=>document.querySelector('#projectTitle').textContent.includes('新版')&&!document.querySelector('#projectTitle').classList.contains('hidden'),'save inline project title');
    const projectRenameInline=!document.querySelector('#projectSettingsDialog').open;
    document.querySelector('#projectDeleteShortcut').click();
    await wait(()=>document.querySelector('#deleteProjectDialog').open,'project delete shortcut');
    const projectDeleteDirect=document.querySelector('#deleteProjectScope').textContent.includes('新版');
    document.querySelector('#deleteProjectDialog [data-close="deleteProjectDialog"]').click();
    await wait(()=>document.querySelector('#confirmationCount').textContent==='2'&&document.querySelector('.resource-environment-head .scope-confirmation-badge'),'confirmation badges');
    const globalConfirmationEntry=Boolean(document.querySelector('.rail-confirmation-button.has-pending'))&&document.querySelectorAll('[data-confirmation-card]').length===0;
    document.querySelector('#confirmationButton').click();
    await wait(()=>!document.querySelector('#confirmationView').classList.contains('hidden')&&document.querySelectorAll('[data-confirmation-card]').length===2,'confirmation center');
    const shellCard=document.querySelector('[data-confirmation-card="confirm-shell"]');
    const shellApprove=shellCard.querySelector('[data-approve-confirmation="confirm-shell"]');
    const shellInitiallyBlocked=shellApprove.disabled&&!document.querySelector('#confirmationDialog');
    const acknowledgement=shellCard.querySelector('[data-confirmation-ack="confirm-shell"]');
    acknowledgement.checked=true;
    acknowledgement.dispatchEvent(new Event('change',{bubbles:true}));
    const shellInlineStrongConfirmation=!shellApprove.disabled&&shellCard.textContent.includes('完整命令')&&shellCard.textContent.includes('我已核对上面的完整命令');
    document.querySelector('[data-approve-confirmation="confirm-upload"]').click();
    await wait(()=>document.querySelector('#confirmationCount').textContent==='1'&&document.querySelector('.confirmation-feedback.success'),'confirmation execution result');
    const confirmationCenter={globalEntry:globalConfirmationEntry,cards:2,shellInitiallyBlocked,shellInlineStrongConfirmation,executionLinked:document.querySelector('.confirmation-feedback').textContent.includes('37 ms'),countAfterApproval:Number(document.querySelector('#confirmationCount').textContent)};
    document.querySelector('[data-close-confirmation-center]').click();
    await wait(()=>document.querySelector('#confirmationView').classList.contains('hidden'),'close confirmation center');
    document.querySelector('[data-resource-plugin-id="server-app"]').click();
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'),'plugin detail');
    const pluginTabs=[...document.querySelectorAll('#detailTopTabs .detail-top-tab')].map(item=>item.textContent.trim());
    document.querySelector('[data-detail-tab="permissions"]').click();
    await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')),'agent permissions');
    const permissionPage=document.querySelector('#pluginDetail .permissions-page');
    const permissionsRefined={hero:Boolean(permissionPage.querySelector('.permission-hero')),summary:permissionPage.querySelectorAll('.permission-summary-item').length,rows:permissionPage.querySelectorAll('.policy-row').length,fits:permissionPage.scrollWidth<=permissionPage.clientWidth};
    document.querySelector('[data-resource-plugin-id="mysql-member"]').click();
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('会员业务库')&&Boolean(document.querySelector('#connectionCheckPanel')),'mysql connection detail');
    document.querySelector('#connectionCheckPanel [data-action="test-plugin"]').click();
    await wait(()=>document.querySelector('#connectionCheckPanel .diagnostic-overview.success'),'inline connection check');
    const diagnosticPanel=document.querySelector('#connectionCheckPanel');
    const diagnosticInline=!document.querySelector('#diagnosticDialog')&&document.querySelector('.connection-page')?.firstElementChild===diagnosticPanel&&diagnosticPanel.querySelectorAll('.diagnostic-step.success').length===3&&[...diagnosticPanel.querySelectorAll('.diagnostic-step-time')].every(item=>item.textContent.includes('ms'))&&diagnosticPanel.textContent.includes('3 项检查通过')&&!diagnosticPanel.textContent.includes('结果依据');
    document.querySelector('[data-detail-tab="configuration"]').click();
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'configuration tab');
    const configurationInline=!document.querySelector('#pluginDialog')&&document.querySelector('#pluginInlineFormHost').textContent.includes('编辑插件配置')&&document.querySelector('#pluginDisplayName').value==='会员业务库';
    document.querySelector('#testPluginFromForm').click();
    await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'),'form connection check');
    const formDiagnostic=!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginFormDiagnostic').querySelectorAll('.diagnostic-step.success').length===3&&document.querySelector('#pluginFormDiagnostic').textContent.includes('28 ms');
    document.querySelector('[data-detail-tab="audit"]').click();
    await wait(()=>!document.querySelector('#auditView').classList.contains('hidden')&&document.querySelectorAll('#auditBody .audit-record').length===2,'plugin audit');
    const auditFiltered=document.querySelector('#auditBody').textContent.includes('会员业务库')&&!document.querySelector('#auditBody').textContent.includes('应用服务器');
    const auditResponsive=Boolean(document.querySelector('#auditBody .audit-event'))&&!/发起者\s*操作\s*对象\s*结果/.test(document.querySelector('#auditView').textContent);
    const auditPendingNamed=document.querySelector('#auditBody').textContent.includes('等待确认')&&!document.querySelector('#auditBody').textContent.includes('部分成功');
    document.querySelector('#clearAudit').click();
    await wait(()=>document.querySelector('#clearAuditDialog').open,'clear audit confirmation');
    const auditClearScoped=document.querySelector('#clearAuditScope').textContent.includes('会员业务库')&&document.querySelector('#clearAuditScope').textContent.includes('仅当前插件');
    document.querySelector('#confirmClearAudit').click();
    await wait(()=>document.querySelector('#auditEmpty')&&!document.querySelector('#auditEmpty').classList.contains('hidden'),'cleared plugin audit');
    const auditCleared=document.querySelector('#clearAudit').disabled&&document.querySelector('#toast').textContent.includes('2 条');
    document.querySelector('.resource-environment-select[data-resource-environment-id="prod"]').click();
    await wait(()=>!document.querySelector('#runbookView').classList.contains('hidden'),'return to environment');
    if (!document.querySelector('[data-resource-add-plugin="prod"]')) {
      document.querySelector('.resource-environment-select[data-resource-environment-id="prod"]').click();
      await wait(()=>Boolean(document.querySelector('[data-resource-add-plugin="prod"]')),'expand environment for add plugin');
    }
    document.querySelector('#toggleDetailPane').click();
    await frame();
    document.querySelector('[data-resource-add-plugin="prod"]').click();
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'inline add plugin');
    const addPluginInline=!document.querySelector('#pluginDialog')&&document.querySelector('#pluginDisplayName').value==='';
    const addPluginOpensDetail=!app.classList.contains('detail-collapsed')&&Math.round(detail.getBoundingClientRect().width)>58;
    document.querySelector('#pluginInlineFormHost [data-close="pluginForm"]').click();
    await wait(()=>!document.querySelector('#runbookView').classList.contains('hidden'),'cancel inline add plugin');
    document.querySelector('#toggleDetailPane').click();
    await frame();
    const collapsed={active:app.classList.contains('detail-collapsed'),detailWidth:Math.round(detail.getBoundingClientRect().width),resourceWidth:Math.round(resources.getBoundingClientRect().width),buttonVisible:getComputedStyle(document.querySelector('#expandDetailPane')).display!=='none'};
    document.querySelector('#expandDetailPane').click();
    await frame();
    return {environmentTabs,pluginTabs,selectedHeaderContinuous,compactEnvironmentActions,environmentActionsWrapCleanly,environmentCardToggle,environmentHeaderHeight,railRefined,projectActionsExposed,environmentCreatedInline,confirmationCenter,permissionsRefined,projectRenameInline,projectDeleteDirect,configurationInline,diagnosticInline,formDiagnostic,addPluginInline,addPluginOpensDetail,auditFiltered,auditResponsive,auditPendingNamed,auditClearScoped,auditCleared,collapsed,initialRects:initialRects.map(rect=>({left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width)})),expanded:!app.classList.contains('detail-collapsed'),separators:document.querySelectorAll('[role="separator"]').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  })()`);
  const screenshotPath = process.argv.find((value) => /\.png$/i.test(value)) || process.env.AI_OPS_SCREENSHOT_PATH;
  if (screenshotPath) {
    const screenshotMode = process.env.AI_OPS_SCREENSHOT_MODE === 'confirmation' ? 'confirmation' : 'permissions';
    await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: ${screenshotMode} screenshot');await new Promise(resolve=>setTimeout(resolve,20));}};if('${screenshotMode}'==='confirmation'){document.querySelector('#confirmationButton').click();await wait(()=>!document.querySelector('#confirmationView').classList.contains('hidden')&&document.querySelector('#detailTopTabs').textContent.includes('操作确认')&&document.querySelector('[data-confirmation-card]'));}else{document.querySelector('[data-resource-plugin-id="server-app"]').click();await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'));document.querySelector('[data-detail-tab="permissions"]').click();await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')));}})()`);
    await new Promise((resolve) => setTimeout(resolve,120));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath,image.toPNG());
  }
  win.setContentSize(960,720);
  await new Promise((resolve) => setTimeout(resolve,80));
  const compactLayout = await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};const app=document.querySelector('#app'),rail=document.querySelector('.project-rail'),resources=document.querySelector('#resourcePane'),detail=document.querySelector('#detailPane');document.querySelector('#toggleProjectRail').click();await new Promise(resolve=>setTimeout(resolve,340));document.querySelector('[data-resource-plugin-id="server-app"]').click();await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'),'compact plugin detail');document.querySelector('[data-detail-tab="permissions"]').click();await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')),'compact permissions');await new Promise(resolve=>requestAnimationFrame(resolve));const permissionPage=document.querySelector('#pluginDetail .permissions-page'),detailContent=document.querySelector('#pluginDetail .detail-content');const railRect=rail.getBoundingClientRect(),resourceRect=resources.getBoundingClientRect(),detailRect=detail.getBoundingClientRect();return{expanded:app.classList.contains('rail-expanded'),railWidth:Math.round(railRect.width),resourceLeft:Math.round(resourceRect.left),detailWidth:Math.round(detailRect.width),overlaid:railRect.right>resourceRect.left,permissionFits:permissionPage.scrollWidth<=permissionPage.clientWidth&&detailContent.scrollWidth<=detailContent.clientWidth,permissionRows:permissionPage.querySelectorAll('.policy-row').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};})()`);
  assert.deepEqual(result.environmentTabs,['运维说明','环境操作记录']);
  assert.deepEqual(result.pluginTabs,['插件详情','配置','Agent 权限','操作记录']);
  assert.equal(result.selectedHeaderContinuous,true);
  assert.equal(result.compactEnvironmentActions,true);
  assert.equal(result.environmentActionsWrapCleanly,true);
  assert.equal(result.environmentCardToggle,true);
  assert.ok(result.environmentHeaderHeight>=88&&result.environmentHeaderHeight<=104,'environment header should use two aligned compact rows');
  assert.equal(result.railRefined,true);
  assert.equal(result.projectActionsExposed,true);
  assert.equal(result.environmentCreatedInline,true);
  assert.deepEqual(result.permissionsRefined,{hero:true,summary:4,rows:8,fits:true});
  assert.equal(result.projectRenameInline,true);
  assert.equal(result.projectDeleteDirect,true);
  assert.deepEqual(result.confirmationCenter,{globalEntry:true,cards:2,shellInitiallyBlocked:true,shellInlineStrongConfirmation:true,executionLinked:true,countAfterApproval:1});
  assert.equal(result.configurationInline,true);
  assert.equal(result.diagnosticInline,true);
  assert.equal(result.formDiagnostic,true);
  assert.equal(result.addPluginInline,true);
  assert.equal(result.addPluginOpensDetail,true);
  assert.equal(result.auditFiltered,true);
  assert.equal(result.auditResponsive,true);
  assert.equal(result.auditPendingNamed,true);
  assert.equal(result.auditClearScoped,true);
  assert.equal(result.auditCleared,true);
  assert.equal(result.collapsed.active,true);
  assert.equal(result.collapsed.detailWidth,58);
  assert.equal(result.collapsed.buttonVisible,true);
  assert.ok(result.collapsed.resourceWidth>result.initialRects[1].width,'the second pane should expand when the third pane collapses');
  assert.equal(result.expanded,true);
  assert.equal(result.separators,2);
  assert.equal(result.overflow,false);
  assert.equal(result.initialRects[0].right,result.initialRects[1].left);
  assert.equal(result.initialRects[1].right,result.initialRects[2].left);
  assert.deepEqual(compactLayout,{expanded:true,railWidth:260,resourceLeft:72,detailWidth:560,overlaid:true,permissionFits:true,permissionRows:8,overflow:false});
  assert.deepEqual(errors,[]);
  win.destroy();
}

app.whenReady().then(run).then(() => { console.log('Three-pane UI smoke passed'); app.exit(0); }).catch((error) => { console.error(error); app.exit(1); });
