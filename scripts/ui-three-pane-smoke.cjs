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
    {projectId:'member',environmentId:'prod',pluginInstanceId:'server-worker',pluginType:'server',displayName:'任务服务器',revision:1,configState:'ready',target:{host:'47.84.203.25',port:22,addressFamily:'ipv4Only'},auth:{username:'root',type:'password'},uplink:{type:'direct'},sources:[],limits:{maxBytes:262144}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'mysql-audit',pluginType:'mysql',displayName:'审计数据库',revision:1,configState:'ready',target:{host:'127.0.0.1',port:3306,database:'audit',addressFamily:'ipv4Preferred'},auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-app'},tls:{mode:'disabled'},limits:{maxRows:100,timeoutMs:10000}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'redis-cache-1',pluginType:'redis',displayName:'会话缓存',revision:1,configState:'ready',target:{host:'127.0.0.1',port:6379,db:0,addressFamily:'ipv4Preferred'},auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},limits:{maxKeys:100,timeoutMs:10000}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'redis-cache-2',pluginType:'redis',displayName:'任务缓存',revision:1,configState:'ready',target:{host:'127.0.0.1',port:6380,db:1,addressFamily:'ipv4Preferred'},auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},limits:{maxKeys:100,timeoutMs:10000}},
  ],
  gray:[{projectId:'member',environmentId:'gray',pluginInstanceId:'gray-server',pluginType:'server',displayName:'灰度服务器',revision:1,configState:'ready',target:{host:'10.0.0.8',port:22,addressFamily:'ipv4Only'},auth:{username:'deploy',type:'password'},uplink:{type:'direct'},sources:[],limits:{maxBytes:262144}}],
};
const drafts = {prod:[],gray:[]};
let expectDraftSessionValidation = false;
const environmentUpdateCalls = [];
const environments = [
  {projectId:'member',environmentId:'prod',name:'正式环境',revision:1,pluginCount:6,readyPluginCount:6,pluginTypeCounts:{server:2,mysql:2,redis:2},resourcePreview:plugins.prod.map((plugin) => ({pluginInstanceId:plugin.pluginInstanceId,pluginType:plugin.pluginType,displayName:plugin.displayName,configState:plugin.configState,resource:plugin.pluginType === 'server' ? {host:plugin.target.host,port:plugin.target.port} : plugin.pluginType === 'mysql' ? {database:plugin.target.database} : {db:plugin.target.db}})),runtime:runtime('member','prod',6)},
  {projectId:'member',environmentId:'gray',name:'灰度环境',revision:1,pluginCount:1,readyPluginCount:1,pluginTypeCounts:{server:1,mysql:0,redis:0},resourcePreview:[{pluginInstanceId:'gray-server',pluginType:'server',displayName:'灰度服务器',configState:'ready',resource:{host:'10.0.0.8',port:22}}],runtime:runtime('member','gray',1)},
];
const projects = [{schemaVersion:2,projectId:'member',name:'澳大利亚-zip',revision:1,environmentCount:2,pluginCount:7,environments}];
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
  drafts[environmentId] = [];
  const project = projects.find((item) => item.projectId === projectId);
  Object.assign(project,{environmentCount:environments.length,revision:Number(project.revision ?? 0) + 1});
  return environment;
});
handle('v2:environment-list',() => environments);
handle('v2:environment-update',(payload) => {
  environmentUpdateCalls.push(structuredClone(payload));
  const environment = environments.find((item) => item.projectId === payload.projectId && item.environmentId === payload.environmentId);
  if (!environment) throw new Error('environment not found');
  Object.assign(environment,payload.patch,{revision:Number(environment.revision ?? 0) + 1});
  return environment;
});
handle('v2:plugin-list',({environmentId}) => plugins[environmentId] ?? []);
handle('v2:plugin-draft-list',({environmentId}) => drafts[environmentId] ?? []);
handle('v2:plugin-draft-save',(payload) => {
  const list = drafts[payload.environmentId] ??= [];
  const index = list.findIndex((item) => item.draftId === payload.draftId);
  const previous = index >= 0 ? list[index] : null;
  const draftId = previous?.draftId ?? 'draft-00000000-0000-4000-8000-000000000001';
  const value = {
    schemaVersion:1,draftId,projectId:payload.projectId,environmentId:payload.environmentId,
    ...(payload.basePluginInstanceId ? {basePluginInstanceId:payload.basePluginInstanceId,baseRevision:payload.baseRevision} : {}),
    pluginType:payload.pluginType,revision:(previous?.revision ?? 0) + 1,
    sanitizedDraft:{...payload.sanitizedDraft,projectId:payload.projectId,environmentId:payload.environmentId,pluginInstanceId:payload.sanitizedDraft.pluginInstanceId ?? 'smoke-draft-plugin',revision:1,configState:'draft'},
    credentialIntent:payload.credentialIntent,credentialState:Object.values(payload.temporarySecrets ?? {}).some(Boolean) ? 'stored-active' : 'absent',
    validationState:'stale',createdAt:previous?.createdAt ?? new Date().toISOString(),updatedAt:new Date().toISOString(),
  };
  if (index >= 0) list[index] = value; else list.push(value);
  const environment = environments.find((item) => item.environmentId === payload.environmentId);
  environment.sidecarDraftCount = list.length;
  environment.draftCount = list.length;
  environment.pluginCount = (plugins[payload.environmentId] ?? []).length + list.length;
  return value;
});
handle('v2:plugin-draft-resume',({environmentId,draftId}) => {
  const value = (drafts[environmentId] ?? []).find((item) => item.draftId === draftId);
  if (value?.basePluginInstanceId) expectDraftSessionValidation = true;
  return {...value,draftSessionId:'draft-session-smoke',draftGeneration:0,sequence:0};
});
handle('v2:plugin-draft-edit-cancel',() => ({cancelled:true}));
handle('v2:plugin-draft-delete',({environmentId,draftId}) => {
  drafts[environmentId] = (drafts[environmentId] ?? []).filter((item) => item.draftId !== draftId);
  const environment = environments.find((item) => item.environmentId === environmentId);
  environment.sidecarDraftCount = drafts[environmentId].length;
  environment.draftCount = drafts[environmentId].length;
  environment.pluginCount = (plugins[environmentId] ?? []).length + drafts[environmentId].length;
  return {deleted:true,environmentId,draftId,credentialsPreserved:true};
});
handle('v2:plugin-draft-promote',() => { throw new Error('promotion is not exercised by this smoke fixture'); });
handle('v2:plugin-credential-status',() => ({fields:{primary:false,proxy:false}}));
handle('v2:environment-status',({projectId,environmentId}) => runtime(projectId,environmentId,(plugins[environmentId] ?? []).length));
handle('v2:runbook-read',() => ({content:'# 正式环境运维说明\n\n## 上线前检查\n\n- 确认应用包版本与发布单一致\n- 检查磁盘空间与当前服务状态',hash:'a'.repeat(64)}));
const initialAuditEntries = [
  {id:'mysql-connect',time:'2026-08-17T08:02:00.000Z',type:'plugin-connected',environmentId:'prod',pluginInstanceId:'mysql-member',pluginNameSnapshot:'会员业务库',actor:'user',planId:'plan-connect',operationId:'operation-connect',result:'success',durationMs:28},
  {id:'mysql-pending',time:'2026-08-17T08:01:00.000Z',type:'plugin-operation-decision',environmentId:'prod',pluginInstanceId:'mysql-member',capability:'select',result:'pending-confirmation',errorCode:'CONFIRMATION_REQUIRED'},
  {id:'mysql-op',time:'2026-08-17T08:00:00.000Z',type:'mysql-query',environmentId:'prod',pluginInstanceId:'mysql-member',operation:'SELECT 只读查询',result:'success',detail:'返回 12 行'},
  {id:'server-op',time:'2026-08-17T07:00:00.000Z',type:'plugin-operation',environmentId:'prod',pluginInstanceId:'server-app',capability:'status',result:'success',detail:'服务正常'},
];
let auditEntries = structuredClone(initialAuditEntries);
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
handle('v2:plugin-connection-edit-prepare',({projectId,environmentId,pluginInstanceId}) => ({
  prepareToken:'prepare-smoke',affectedIds:[pluginInstanceId],preEditConnectedSet:[],activeOperations:{connection:[],workspace:[]},
  baseRecordRevision:1,baseConnectionFingerprint:'a'.repeat(64),projectId,environmentId,
}));
handle('v2:plugin-connection-edit-begin',({prepareToken}) => {
  assert.equal(prepareToken,'prepare-smoke');
  return {editSessionId:'edit-smoke',plugin:plugins.prod.find((plugin) => plugin.pluginInstanceId === 'mysql-member'),affectedIds:['mysql-member'],preEditConnectedSet:['mysql-member'],draftGeneration:0};
});
handle('v2:plugin-draft-validate',(payload) => {
  if (expectDraftSessionValidation) {
    assert.equal(payload.draftSessionId,'draft-session-smoke');
    assert.equal(payload.editSessionId,undefined);
    expectDraftSessionValidation = false;
  }
  return {
    editSessionId:payload.editSessionId,draftSessionId:payload.draftSessionId,
    requestId:payload.requestId,operationId:'validation-smoke',purpose:payload.purpose,
    draftGeneration:payload.draftGeneration,sequence:payload.sequence,
    configDigest:'b'.repeat(64),state:'valid',
    result:{connected:true,diagnosticOnly:true,reused:false,totalElapsedMs:28},
  };
});
handle('v2:plugin-validation-cancel',() => ({state:'cancelled'}));
handle('v2:plugin-connection-edit-cancel',() => ({cancelled:true,connectionPlan:null}));

async function run() {
  const errors = [];
  const win = new BrowserWindow({show:false,useContentSize:true,width:1280,height:900,webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(details) => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.on('did-fail-load',(_event,code,description) => errors.push(`${code}: ${description}`));
  await win.loadFile(path.join(root,'renderer','v2','index.html'));
  const result = await win.webContents.executeJavaScript(`(async()=>{
    const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing click target: '+selector);element.click();};
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
    click('[data-resource-rename-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('[data-resource-environment-editor="prod"]')),'inline environment rename');
    const environmentNameInput=document.querySelector('[data-resource-environment-editor="prod"] input');
    await wait(()=>document.activeElement===environmentNameInput,'focus inline environment rename');
    const renameFocused=document.activeElement===environmentNameInput;
    environmentNameInput.value='   ';
    document.querySelector('[data-resource-environment-editor="prod"]').requestSubmit();
    await wait(()=>document.querySelector('.resource-environment-rename-error').textContent.includes('请输入环境名称'),'reject empty environment name');
    const blankNameRejected=Boolean(document.querySelector('[data-resource-environment-editor="prod"]'));
    environmentNameInput.value='生产环境';
    environmentNameInput.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-resource-environment-editor="prod"]').requestSubmit();
    await wait(()=>document.querySelector('[data-resource-environment-id="prod"] .resource-environment-copy strong')?.textContent==='生产环境'&&document.querySelector('#runbookTitle').textContent.startsWith('生产环境'),'save inline environment rename');
    click('[data-resource-rename-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('[data-resource-environment-editor="prod"]')),'inline environment rename no-op');
    document.querySelector('[data-resource-environment-editor="prod"]').requestSubmit();
    await wait(()=>!document.querySelector('[data-resource-environment-editor="prod"]'),'close no-op environment rename');
    click('[data-resource-delete-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('[data-resource-environment-delete-prompt="prod"]')),'inline environment delete prompt');
    const environmentDeleteInline=document.querySelector('[data-resource-environment-delete-prompt="prod"]').textContent.includes('请先处理该环境的 6 个插件');
    click('[data-resource-cancel-environment-delete]');
    const environmentRenameInline=renameFocused&&blankNameRejected&&!document.querySelector('#environmentManagerDialog')&&environmentDeleteInline;
    click('.resource-environment-select[data-resource-environment-id="gray"]');
    await wait(()=>Boolean(document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="gray"]'))&&!document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="prod"]'),'exclusive environment expand');
    const switchedEnvironmentExclusive=document.querySelectorAll('.resource-environment-card.expanded').length===1;
    click('.resource-environment-select[data-resource-environment-id="gray"]');
    await wait(()=>document.querySelectorAll('.resource-environment-card.expanded').length===0,'collapse selected environment');
    const selectedEnvironmentCollapsed=document.querySelectorAll('.resource-environment-card.expanded').length===0;
    click('.resource-environment-select[data-resource-environment-id="prod"]');
    await wait(()=>Boolean(document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="prod"]')),'restore production environment');
    const environmentCardToggle=environmentCaretRemoved&&switchedEnvironmentExclusive&&selectedEnvironmentCollapsed;
    click('#showInlineEnvironmentCreate');
    await wait(()=>!document.querySelector('#resourceEnvironmentCreateForm').classList.contains('hidden'),'inline environment create');
    const environmentCreateInline=!document.querySelector('#environmentManagerDialog');
    document.querySelector('#resourceEnvironmentName').value='新增测试环境';
    document.querySelector('#resourceEnvironmentCreateForm').requestSubmit();
    await wait(()=>[...document.querySelectorAll('.resource-environment-card')].some(card=>card.textContent.includes('新增测试环境')),'save inline environment');
    const environmentCreatedInline=environmentCreateInline&&document.querySelector('#resourceEnvironmentCreateForm').classList.contains('hidden')&&!document.querySelector('#showInlineEnvironmentCreate').classList.contains('hidden');
    click('#projectSettingsShortcut');
    await wait(()=>!document.querySelector('#projectTitleEditor').classList.contains('hidden'),'inline project title editor');
    document.querySelector('#projectTitleInput').value='澳大利亚-zip · 新版';
    click('#saveProjectTitle');
    await wait(()=>document.querySelector('#projectTitle').textContent.includes('新版')&&!document.querySelector('#projectTitle').classList.contains('hidden'),'save inline project title');
    const projectRenameInline=!document.querySelector('#projectSettingsDialog').open;
    click('#projectDeleteShortcut');
    await wait(()=>document.querySelector('#deleteProjectDialog').open,'project delete shortcut');
    const projectDeleteDirect=document.querySelector('#deleteProjectScope').textContent.includes('新版');
    click('#deleteProjectDialog [data-close="deleteProjectDialog"]');
    await wait(()=>document.querySelector('#confirmationCount').textContent==='2'&&document.querySelector('.resource-environment-head .scope-confirmation-badge'),'confirmation badges');
    const globalConfirmationEntry=Boolean(document.querySelector('.rail-confirmation-button.has-pending'))&&document.querySelectorAll('[data-confirmation-card]').length===0;
    click('#confirmationButton');
    await wait(()=>!document.querySelector('#confirmationView').classList.contains('hidden')&&document.querySelectorAll('[data-confirmation-card]').length===2,'confirmation center');
    const shellCard=document.querySelector('[data-confirmation-card="confirm-shell"]');
    const shellApprove=shellCard.querySelector('[data-approve-confirmation="confirm-shell"]');
    const shellInitiallyBlocked=shellApprove.disabled&&!document.querySelector('#confirmationDialog');
    const acknowledgement=shellCard.querySelector('[data-confirmation-ack="confirm-shell"]');
    acknowledgement.checked=true;
    acknowledgement.dispatchEvent(new Event('change',{bubbles:true}));
    const shellInlineStrongConfirmation=!shellApprove.disabled&&shellCard.textContent.includes('完整命令')&&shellCard.textContent.includes('我已核对上面的完整命令');
    click('[data-approve-confirmation="confirm-upload"]');
    await wait(()=>document.querySelector('#confirmationCount').textContent==='1'&&document.querySelector('.confirmation-feedback.success'),'confirmation execution result');
    const confirmationCenter={globalEntry:globalConfirmationEntry,cards:2,shellInitiallyBlocked,shellInlineStrongConfirmation,executionLinked:document.querySelector('.confirmation-feedback').textContent.includes('37 ms'),countAfterApproval:Number(document.querySelector('#confirmationCount').textContent)};
    click('[data-close-confirmation-center]');
    await wait(()=>document.querySelector('#confirmationView').classList.contains('hidden'),'close confirmation center');
    click('[data-resource-plugin-id="server-app"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'),'plugin detail');
    const pluginTabs=[...document.querySelectorAll('#detailTopTabs .detail-top-tab')].map(item=>item.textContent.trim());
    click('[data-detail-tab="permissions"]');
    await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')),'agent permissions');
    const permissionPage=document.querySelector('#pluginDetail .permissions-page');
    const permissionsRefined={hero:Boolean(permissionPage.querySelector('.permission-hero')),summary:permissionPage.querySelectorAll('.permission-summary-item').length,rows:permissionPage.querySelectorAll('.policy-row').length,fits:permissionPage.scrollWidth<=permissionPage.clientWidth};
    click('[data-resource-plugin-id="mysql-member"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('会员业务库')&&Boolean(document.querySelector('.connection-information')),'mysql connection detail');
    const diagnosticInline=!document.querySelector('#diagnosticDialog')&&!document.querySelector('[data-action="test-plugin"]')&&!document.querySelector('#connectionCheckPanel');
    click('[data-detail-tab="configuration"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'),'readonly configuration tab');
    const renameOnlyMetadata=document.querySelector('#pluginDetail').textContent.includes('插件名称')&&document.querySelector('#pluginDetail').textContent.includes('修改名称')&&!/说明|标签|展示顺序/.test(document.querySelector('#pluginDetail').textContent);
    const readonlyBeforeEdit=document.querySelector('#pluginConfigView').classList.contains('hidden')&&Boolean(document.querySelector('#pluginsView:not(.hidden)'));
    window.confirm=()=>true;
    click('[data-action="edit-plugin"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'fenced configuration editor');
    const configurationInline={readonlyBeforeEdit,renameOnlyMetadata,noDialog:!document.querySelector('#pluginDialog'),title:document.querySelector('#pluginInlineFormHost').textContent.includes('编辑连接配置'),namePreserved:document.querySelector('#pluginDisplayName').value==='会员业务库',typeCardsHidden:document.querySelector('#pluginTypeChoices').classList.contains('hidden'),credentialUnchanged:document.querySelector('#primaryCredentialStatus').textContent.includes('未修改'),draftActionCollapsed:document.querySelector('#savePluginDraft').classList.contains('hidden')&&!document.querySelector('#pluginDraftOverflow').classList.contains('hidden'),visibleFooterActions:document.querySelectorAll('.plugin-form-actions>button:not(.hidden)').length};
    click('#validateMysqlDatabase');
    await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'),'form connection check');
    const formDiagnostic=!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginFormDiagnostic').querySelectorAll('.diagnostic-step.success').length===3&&document.querySelector('#pluginFormDiagnostic').textContent.includes('28 ms');
    click('[data-detail-tab="audit"]');
    await wait(()=>!document.querySelector('#auditView').classList.contains('hidden')&&document.querySelectorAll('#auditBody .audit-record').length===3,'plugin audit');
    const auditFiltered=document.querySelector('#auditBody').textContent.includes('会员业务库')&&!document.querySelector('#auditBody').textContent.includes('应用服务器');
    const auditConnectionVisible=document.querySelector('#auditBody').textContent.includes('连接插件');
    const auditResponsive=Boolean(document.querySelector('#auditBody .audit-event'))&&!/发起者\s*操作\s*对象\s*结果/.test(document.querySelector('#auditView').textContent);
    const auditPendingNamed=document.querySelector('#auditBody').textContent.includes('等待确认')&&!document.querySelector('#auditBody').textContent.includes('部分成功');
    click('#clearAudit');
    await wait(()=>document.querySelector('#clearAuditDialog').open,'clear audit confirmation');
    const auditClearScoped=document.querySelector('#clearAuditScope').textContent.includes('会员业务库')&&document.querySelector('#clearAuditScope').textContent.includes('仅当前插件');
    click('#confirmClearAudit');
    await wait(()=>document.querySelector('#auditEmpty')&&!document.querySelector('#auditEmpty').classList.contains('hidden'),'cleared plugin audit');
    const auditCleared=document.querySelector('#clearAudit').disabled&&document.querySelector('#toast').textContent.includes('3 条');
    click('[data-detail-tab="configuration"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'),'return to mysql configuration');
    click('[data-action="edit-plugin"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden'),'edit mysql before saving draft');
    click('#replacePrimaryCredential');
    document.querySelector('#pluginPassword').value='saved-draft-password';
    document.querySelector('#pluginPassword').dispatchEvent(new Event('input',{bubbles:true}));
    click('#pluginDraftOverflow summary');
    await wait(()=>document.querySelector('#pluginDraftOverflow').open,'open formal draft actions');
    click('#savePluginDraftOverflow');
    await wait(()=>Boolean(document.querySelector('[data-resource-draft-id]'))&&!document.querySelector('#runbookView').classList.contains('hidden'),'save mysql draft');
    click('[data-resource-draft-id]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginFormTitle').textContent.includes('继续配置草稿'),'resume mysql draft');
    click('#validateMysqlDatabase');
    await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'),'validate resumed mysql draft');
    const basedDraftValidationUsesDraftSession=document.querySelector('#pluginFormDiagnostic').textContent.includes('28 ms');
    click('#deleteCurrentDraft');
    await wait(()=>!document.querySelector('[data-resource-draft-id]')&&!document.querySelector('#runbookView').classList.contains('hidden'),'delete mysql draft');
    await wait(()=>!document.querySelector('#runbookView').classList.contains('hidden'),'return to environment');
    if (!document.querySelector('[data-resource-add-plugin="prod"]')) {
      click('.resource-environment-select[data-resource-environment-id="prod"]');
      await wait(()=>Boolean(document.querySelector('[data-resource-add-plugin="prod"]')),'expand environment for add plugin');
    }
    click('#toggleDetailPane');
    await frame();
    click('[data-resource-add-plugin="prod"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'inline add plugin');
    const addPluginInline=!document.querySelector('#pluginDialog')&&document.querySelector('#pluginDisplayName').value==='';
    const addPluginOpensDetail=!app.classList.contains('detail-collapsed')&&Math.round(detail.getBoundingClientRect().width)>58;
    document.querySelector('#pluginDisplayName').value='未完成 Redis';
    document.querySelector('input[name="pluginTypeChoice"][value="redis"]').click();
    document.querySelector('#pluginHost').value='';
    click('#savePluginDraft');
    await wait(()=>Boolean(document.querySelector('[data-resource-draft-id]'))&&!document.querySelector('#runbookView').classList.contains('hidden'),'save persistent draft');
    const savedDraftRow=document.querySelector('[data-resource-draft-id]')?.closest('.resource-draft-row');
    const draftSaved=savedDraftRow?.textContent.includes('未完成 Redis')&&savedDraftRow.textContent.includes('继续配置');
    click('[data-resource-draft-id]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginDisplayName').value==='未完成 Redis','resume persistent draft');
    const draftResumed=document.querySelector('#pluginFormTitle').textContent.includes('继续配置草稿')&&!document.querySelector('#deleteCurrentDraft').classList.contains('hidden');
    click('#deleteCurrentDraft');
    await wait(()=>!document.querySelector('[data-resource-draft-id]')&&!document.querySelector('#runbookView').classList.contains('hidden'),'delete persistent draft');
    const draftDeleted=!document.querySelector('[data-resource-draft-id]');
    const resourceList=document.querySelector('#resourceEnvironmentList');
    resourceList.scrollTop=0;
    click('[data-resource-plugin-id="redis-cache-2"]');
    await wait(()=>document.querySelector('[data-resource-plugin-id="redis-cache-2"]')?.closest('.resource-plugin-row')?.classList.contains('selected'),'select last overflow plugin');
    await frame();
    const selectedOverflowRow=document.querySelector('[data-resource-plugin-id="redis-cache-2"]').closest('.resource-plugin-row').getBoundingClientRect();
    const resourceListRect=resourceList.getBoundingClientRect();
    const overflowSelectionVisible=selectedOverflowRow.top>=resourceListRect.top&&selectedOverflowRow.bottom<=resourceListRect.bottom;
    const expandedResourceCard=document.querySelector('.resource-environment-card.expanded');
    const resourceOverflowOwnedByList=expandedResourceCard.scrollHeight<=expandedResourceCard.clientHeight&&resourceList.scrollHeight>resourceList.clientHeight;
    click('#toggleDetailPane');
    await frame();
    const collapsed={active:app.classList.contains('detail-collapsed'),detailWidth:Math.round(detail.getBoundingClientRect().width),resourceWidth:Math.round(resources.getBoundingClientRect().width),buttonVisible:getComputedStyle(document.querySelector('#expandDetailPane')).display!=='none'};
    click('#expandDetailPane');
    await frame();
    return {environmentTabs,pluginTabs,selectedHeaderContinuous,compactEnvironmentActions,environmentActionsWrapCleanly,environmentCardToggle,environmentHeaderHeight,railRefined,projectActionsExposed,environmentRenameInline,environmentCreatedInline,confirmationCenter,permissionsRefined,projectRenameInline,projectDeleteDirect,configurationInline,diagnosticInline,formDiagnostic,basedDraftValidationUsesDraftSession,addPluginInline,addPluginOpensDetail,draftSaved,draftResumed,draftDeleted,overflowSelectionVisible,resourceOverflowOwnedByList,auditFiltered,auditConnectionVisible,auditResponsive,auditPendingNamed,auditClearScoped,auditCleared,collapsed,initialRects:initialRects.map(rect=>({left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width)})),expanded:!app.classList.contains('detail-collapsed'),separators:document.querySelectorAll('[role="separator"]').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  })()`);
  const screenshotPath = process.argv.find((value) => /\.png$/i.test(value)) || process.env.AI_OPS_SCREENSHOT_PATH;
  if (screenshotPath) {
    const screenshotMode = ['confirmation','editor','configuration','audit','resources','environment'].includes(process.env.AI_OPS_SCREENSHOT_MODE) ? process.env.AI_OPS_SCREENSHOT_MODE : 'permissions';
    if (screenshotMode === 'audit') auditEntries = structuredClone(initialAuditEntries);
    if (screenshotMode === 'resources') {
      win.setContentSize(815,900);
      await new Promise((resolve) => setTimeout(resolve,100));
    }
    const screenshotState = await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: ${screenshotMode} screenshot');await new Promise(resolve=>setTimeout(resolve,20));}};const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing screenshot target: '+selector);element.click();};const openMysql=async()=>{if(!document.querySelector('[data-resource-plugin-id="mysql-member"]')){click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>document.querySelector('[data-resource-plugin-id="mysql-member"]'));}click('[data-resource-plugin-id="mysql-member"]');await wait(()=>document.querySelector('[data-detail-tab="configuration"]')&&document.querySelector('#pluginDetail')?.textContent.includes('会员业务库'));};if('${screenshotMode}'==='confirmation'){click('#confirmationButton');await wait(()=>!document.querySelector('#confirmationView').classList.contains('hidden')&&document.querySelector('#detailTopTabs').textContent.includes('操作确认')&&document.querySelector('[data-confirmation-card]'));}else if('${screenshotMode}'==='editor'){await openMysql();click('[data-detail-tab="configuration"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'));window.confirm=()=>true;click('[data-action="edit-plugin"]');await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden'));click('#validateMysqlDatabase');await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'));document.querySelector('#pluginFormDiagnostic').scrollIntoView({block:'center'});}else if('${screenshotMode}'==='configuration'){await openMysql();click('[data-detail-tab="configuration"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('修改名称'));}else if('${screenshotMode}'==='audit'){await openMysql();click('[data-detail-tab="audit"]');await wait(()=>!document.querySelector('#auditView').classList.contains('hidden')&&document.querySelector('#auditBody')?.textContent.includes('连接插件'));}else if('${screenshotMode}'==='resources'){if(!document.querySelector('#app').classList.contains('detail-collapsed'))click('#toggleDetailPane');await wait(()=>document.querySelector('#app').classList.contains('detail-collapsed'));const list=document.querySelector('#resourceEnvironmentList');list.scrollTop=list.scrollHeight;await wait(()=>{const row=document.querySelector('[data-resource-plugin-id="redis-cache-2"]')?.closest('.resource-plugin-row');if(!row)return false;const rowRect=row.getBoundingClientRect(),listRect=list.getBoundingClientRect();return rowRect.bottom<=listRect.bottom&&rowRect.top>=listRect.top;});}else if('${screenshotMode}'==='environment'){click('[data-resource-rename-environment="prod"]');await wait(()=>document.querySelector('[data-resource-environment-editor="prod"]')&&document.activeElement===document.querySelector('[data-resource-environment-editor="prod"] input'));}else{click('[data-resource-plugin-id="server-app"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'));click('[data-detail-tab="permissions"]');await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')));}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return{mode:'${screenshotMode}',editorVisible:!document.querySelector('#pluginConfigView').classList.contains('hidden'),successfulChecks:document.querySelectorAll('#pluginFormDiagnostic .diagnostic-step.success').length,pendingChecks:document.querySelectorAll('#pluginFormDiagnostic .diagnostic-step.pending, #pluginFormDiagnostic .diagnostic-step.queued').length,visibleFooterActions:document.querySelectorAll('.plugin-form-actions>button:not(.hidden)').length};})()`);
    if (screenshotMode === 'editor') assert.deepEqual(screenshotState,{mode:'editor',editorVisible:true,successfulChecks:3,pendingChecks:0,visibleFooterActions:3});
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve,250));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath,image.toPNG());
    if (screenshotMode === 'resources') {
      await win.webContents.executeJavaScript("document.querySelector('#expandDetailPane').click()");
      win.setContentSize(1280,900);
      await new Promise((resolve) => setTimeout(resolve,80));
    }
  }
  win.setContentSize(960,720);
  await new Promise((resolve) => setTimeout(resolve,80));
  const compactLayout = await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing compact click target: '+selector);element.click();};const app=document.querySelector('#app'),rail=document.querySelector('.project-rail'),resources=document.querySelector('#resourcePane'),detail=document.querySelector('#detailPane');click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));click('[data-resource-plugin-id="server-app"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器')&&document.querySelector('[data-detail-tab="permissions"]'),'compact plugin detail and tabs');click('[data-detail-tab="permissions"]');await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')),'compact permissions');await new Promise(resolve=>requestAnimationFrame(resolve));const permissionPage=document.querySelector('#pluginDetail .permissions-page'),detailContent=document.querySelector('#pluginDetail .detail-content');const railRect=rail.getBoundingClientRect(),resourceRect=resources.getBoundingClientRect(),detailRect=detail.getBoundingClientRect();return{expanded:app.classList.contains('rail-expanded'),railWidth:Math.round(railRect.width),resourceLeft:Math.round(resourceRect.left),detailWidth:Math.round(detailRect.width),overlaid:railRect.right>resourceRect.left,permissionFits:permissionPage.scrollWidth<=permissionPage.clientWidth&&detailContent.scrollWidth<=detailContent.clientWidth,permissionRows:permissionPage.querySelectorAll('.policy-row').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};})()`);
  assert.deepEqual(result.environmentTabs,['运维说明','环境操作记录']);
  assert.deepEqual(result.pluginTabs,['插件详情','配置','Agent 权限','操作记录']);
  assert.equal(result.selectedHeaderContinuous,true);
  assert.equal(result.compactEnvironmentActions,true);
  assert.equal(result.environmentActionsWrapCleanly,true);
  assert.equal(result.environmentCardToggle,true);
  assert.ok(result.environmentHeaderHeight>=88&&result.environmentHeaderHeight<=104,'environment header should use two aligned compact rows');
  assert.equal(result.railRefined,true);
  assert.equal(result.projectActionsExposed,true);
  assert.equal(result.environmentRenameInline,true);
  assert.deepEqual(environmentUpdateCalls,[{projectId:'member',environmentId:'prod',patch:{name:'生产环境'},expectedRevision:1}]);
  assert.equal(result.environmentCreatedInline,true);
  assert.deepEqual(result.permissionsRefined,{hero:true,summary:4,rows:8,fits:true});
  assert.equal(result.projectRenameInline,true);
  assert.equal(result.projectDeleteDirect,true);
  assert.deepEqual(result.confirmationCenter,{globalEntry:true,cards:2,shellInitiallyBlocked:true,shellInlineStrongConfirmation:true,executionLinked:true,countAfterApproval:1});
  assert.deepEqual(result.configurationInline,{readonlyBeforeEdit:true,renameOnlyMetadata:true,noDialog:true,title:true,namePreserved:true,typeCardsHidden:true,credentialUnchanged:true,draftActionCollapsed:true,visibleFooterActions:3});
  assert.equal(result.diagnosticInline,true);
  assert.equal(result.formDiagnostic,true);
  assert.equal(result.basedDraftValidationUsesDraftSession,true);
  assert.equal(result.addPluginInline,true);
  assert.equal(result.addPluginOpensDetail,true);
  assert.equal(result.draftSaved,true);
  assert.equal(result.draftResumed,true);
  assert.equal(result.draftDeleted,true);
  assert.equal(result.overflowSelectionVisible,true);
  assert.equal(result.resourceOverflowOwnedByList,true);
  assert.equal(result.auditFiltered,true);
  assert.equal(result.auditConnectionVisible,true);
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
