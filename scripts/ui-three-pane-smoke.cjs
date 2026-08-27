const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();
const root = path.resolve(__dirname,'..');
const dataRoot = path.join(os.tmpdir(),`ai-ops-three-pane-smoke-${process.pid}`);
const disconnectedEditScreenshot = process.argv.some((value) => ['edit-form','edit-form-medium','edit-form-compact'].includes(value));
app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));

const runtime = (projectId,environmentId,count = 0) => ({
  projectId,environmentId,desiredConnected:false,phase:'disconnected',eligibleCount:count,connectedCount:0,
  errorCount:0,blockedCount:0,draftCount:0,plugins:{},
});
const connectedRuntime = (projectId,environmentId,count) => ({
  ...runtime(projectId,environmentId,count),desiredConnected:true,phase:'connected',connectedCount:count,
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
const pluginCreateCalls = [];
let editValidationUsesSession = false;
const environmentUpdateCalls = [];
const projectUpdateCalls = [];
const quickQuestionCalls = {openingGet:[],openingSave:[],list:[],save:[],delete:[],copy:[]};
let quickQuestionOpeningState = {
  schemaVersion:1,
  revision:2,
  text:'请使用 AI Ops MCP 排查当前项目和环境中的问题。',
  defaultText:'请使用 AI Ops MCP 排查当前项目和环境中的问题。',
};
let quickQuestionState = {schemaVersion:1,projectId:'member',environmentId:'prod',items:[],revision:3};
let quickQuestionUpdateConflictInjected = false;
const environments = [
  {projectId:'member',environmentId:'prod',name:'正式环境',revision:1,pluginCount:6,readyPluginCount:6,pluginTypeCounts:{server:2,mysql:2,redis:2},resourcePreview:plugins.prod.map((plugin) => ({pluginInstanceId:plugin.pluginInstanceId,pluginType:plugin.pluginType,displayName:plugin.displayName,configState:plugin.configState,resource:plugin.pluginType === 'server' ? {host:plugin.target.host,port:plugin.target.port} : plugin.pluginType === 'mysql' ? {database:plugin.target.database} : {db:plugin.target.db}})),runtime:connectedRuntime('member','prod',6)},
  {projectId:'member',environmentId:'gray',name:'灰度环境',revision:1,pluginCount:1,readyPluginCount:1,pluginTypeCounts:{server:1,mysql:0,redis:0},resourcePreview:[{pluginInstanceId:'gray-server',pluginType:'server',displayName:'灰度服务器',configState:'ready',resource:{host:'10.0.0.8',port:22}}],runtime:runtime('member','gray',1)},
];
const projects = [
  {schemaVersion:2,projectId:'member',name:'澳大利亚-zip',revision:1,environmentCount:2,pluginCount:7,environments},
  {schemaVersion:2,projectId:'idle',name:'未连接项目',revision:1,environmentCount:0,pluginCount:0,environments:[]},
];
const confirmations = [
  {requestId:'confirm-upload',projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',clientInstanceId:'agent-smoke',projectNameSnapshot:'澳大利亚-zip',environmentNameSnapshot:'正式环境',pluginNameSnapshot:'应用服务器',capability:'fs.upload',capabilityLabel:'上传服务器文件',riskLevel:'write',approvalLevel:'standard',summary:'上传 121 字节：demo.txt → /tmp/demo.txt',createdAt:new Date().toISOString(),expiresAt:Date.now()+300000,presentation:{kind:'file-transfer',target:'应用服务器',source:'D:\\demo.txt',destination:'/tmp/demo.txt',bytes:121,sha256:'a'.repeat(64),overwrite:false}},
  {requestId:'confirm-shell',projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',clientInstanceId:'agent-smoke',projectNameSnapshot:'澳大利亚-zip',environmentNameSnapshot:'正式环境',pluginNameSnapshot:'应用服务器',capability:'shell.execute',capabilityLabel:'执行任意 Shell',riskLevel:'critical',approvalLevel:'strong',summary:'执行 Shell：systemctl status member.service',createdAt:new Date().toISOString(),expiresAt:Date.now()+300000,presentation:{kind:'shell',target:'应用服务器',command:'systemctl status member.service',workingDirectory:'/srv/member'}},
];
const ok = (data) => ({ok:true,data});
const handle = (channel,fn) => ipcMain.handle(channel,async (event,...args) => ok(await fn(...args,event)));

handle('v2:workspace-overview',() => projects);
handle('v2:project-update',(payload) => {
  const {projectId,patch} = payload;
  const project = projects.find((item) => item.projectId === projectId);
  projectUpdateCalls.push({projectId,patch:structuredClone(patch),expectedRevision:payload.expectedRevision});
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
handle('v2:environment-update',(payload) => {
  environmentUpdateCalls.push(structuredClone(payload));
  const environment = environments.find((item) => item.projectId === payload.projectId && item.environmentId === payload.environmentId);
  if (!environment) throw new Error('environment not found');
  Object.assign(environment,payload.patch,{revision:Number(environment.revision ?? 0) + 1});
  return environment;
});
handle('v2:plugin-list',({environmentId}) => plugins[environmentId] ?? []);
handle('v2:plugin-create',(payload) => {
  pluginCreateCalls.push(structuredClone(payload));
  throw new Error('the cancel-flow smoke must not create a plugin');
});
handle('v2:plugin-credential-status',() => ({fields:{primary:false,proxy:false}}));
handle('v2:environment-status',({projectId,environmentId}) => environmentId === 'prod'
  ? connectedRuntime(projectId,environmentId,(plugins[environmentId] ?? []).length)
  : runtime(projectId,environmentId,(plugins[environmentId] ?? []).length));
handle('v2:runbook-read',() => ({content:'# 正式环境运维说明\n\n## 上线前检查\n\n- 确认应用包版本与发布单一致\n- 检查磁盘空间与当前服务状态',hash:'a'.repeat(64)}));
handle('v2:quick-question-opening-get',() => {
  quickQuestionCalls.openingGet.push({});
  return structuredClone(quickQuestionOpeningState);
});
handle('v2:quick-question-opening-save',(payload,event) => {
  quickQuestionCalls.openingSave.push(structuredClone(payload));
  assert.equal(payload.expectedRevision,quickQuestionOpeningState.revision);
  quickQuestionOpeningState = {...quickQuestionOpeningState,text:payload.text,revision:quickQuestionOpeningState.revision + 1};
  event.sender.send('v2:workspace-changed',{type:'quick-question-opening-updated'});
  return structuredClone(quickQuestionOpeningState);
});
handle('v2:quick-question-list',(payload) => {
  quickQuestionCalls.list.push(structuredClone(payload));
  return structuredClone(quickQuestionState);
});
ipcMain.handle('v2:quick-question-save',async (event,payload) => {
  quickQuestionCalls.save.push(structuredClone(payload));
  assert.equal(payload.expectedRevision,quickQuestionState.revision);
  if (payload.questionId && !quickQuestionUpdateConflictInjected) {
    quickQuestionUpdateConflictInjected = true;
    quickQuestionState = {...quickQuestionState,revision:quickQuestionState.revision + 1};
    event.sender.send('v2:workspace-changed',{type:'quick-questions-updated',projectId:payload.projectId,environmentId:payload.environmentId});
    return {ok:false,error:{code:'CONFIG_REVISION_CONFLICT',message:'常见问题已经变化，请刷新后重试。'}};
  }
  const questionId = payload.questionId ?? `quick-smoke-${quickQuestionState.items.length + 1}`;
  const previous = quickQuestionState.items.find((entry) => entry.questionId === questionId);
  const item = {questionId,text:payload.text,createdAt:previous?.createdAt ?? '2026-08-17T09:00:00.000Z'};
  quickQuestionState = {...quickQuestionState,items:[item,...quickQuestionState.items.filter((entry) => entry.questionId !== questionId)],revision:quickQuestionState.revision + 1};
  event.sender.send('v2:workspace-changed',{type:'quick-questions-updated',projectId:payload.projectId,environmentId:payload.environmentId});
  return ok(structuredClone(quickQuestionState));
});
handle('v2:quick-question-delete',(payload,event) => {
  quickQuestionCalls.delete.push(structuredClone(payload));
  assert.equal(payload.expectedRevision,quickQuestionState.revision);
  quickQuestionState = {...quickQuestionState,items:quickQuestionState.items.filter((item) => item.questionId !== payload.questionId),revision:quickQuestionState.revision + 1};
  event.sender.send('v2:workspace-changed',{type:'quick-questions-updated',projectId:payload.projectId,environmentId:payload.environmentId});
  return structuredClone(quickQuestionState);
});
handle('v2:quick-question-copy',(payload) => {
  quickQuestionCalls.copy.push(structuredClone(payload));
  return {copied:true};
});
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
  return {editSessionId:'edit-smoke',plugin:plugins.prod.find((plugin) => plugin.pluginInstanceId === 'mysql-member'),affectedIds:['mysql-member'],preEditConnectedSet:disconnectedEditScreenshot ? [] : ['mysql-member'],draftGeneration:0};
});
handle('v2:plugin-draft-validate',(payload) => {
  assert.equal(payload.editSessionId,'edit-smoke');
  assert.equal(payload.draftSessionId,undefined);
  editValidationUsesSession = true;
  return {
    editSessionId:payload.editSessionId,
    requestId:payload.requestId,operationId:'validation-smoke',purpose:payload.purpose,
    draftGeneration:payload.draftGeneration,sequence:payload.sequence,
    configDigest:'b'.repeat(64),state:'valid',
    result:{connected:true,diagnosticOnly:true,reused:false,totalElapsedMs:28},
  };
});
handle('v2:plugin-probe',(payload) => ({
  projectId:payload.projectId,environmentId:payload.environmentId,formInstanceId:payload.formInstanceId,
  requestId:payload.requestId,operationId:'probe-smoke',purpose:payload.purpose,
  draftGeneration:payload.draftGeneration,sequence:payload.sequence,
  configDigest:'c'.repeat(64),state:'valid',result:{connected:true,diagnosticOnly:true,reused:false,totalElapsedMs:24},
}));
handle('v2:plugin-probe-cancel',(payload) => ({...payload,state:'cancelled',cancelled:true}));
handle('v2:plugin-validation-cancel',() => ({state:'cancelled'}));
handle('v2:plugin-connection-edit-cancel',() => ({cancelled:true,connectionPlan:null}));

async function run() {
  const errors = [];
  const win = new BrowserWindow({show:false,useContentSize:true,width:1280,height:900,webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(details) => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.on('did-fail-load',(_event,code,description) => errors.push(`${code}: ${description}`));
  await win.loadFile(path.join(root,'renderer','v2','index.html'));
  const result = await win.webContents.executeJavaScript(`(async()=>{
    const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000){const formError=document.querySelector('#pluginFormError:not(.hidden)')?.textContent.trim();throw new Error('timeout: '+label+(formError?' | '+formError:''));}await new Promise(resolve=>setTimeout(resolve,20));}};
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing click target: '+selector);element.click();};
    await wait(()=>document.querySelectorAll('.resource-environment-card').length===2,'environment cards');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('环境概览'),'environment information');
    const app=document.querySelector('#app'),rail=document.querySelector('.project-rail'),resources=document.querySelector('#resourcePane'),detail=document.querySelector('#detailPane');
    const initialRects=[rail,resources,detail].map(element=>element.getBoundingClientRect());
    const environmentTabs=[...document.querySelectorAll('#detailTopTabs .detail-top-tab')].map(item=>item.textContent.trim());
    const skipLink=document.querySelector('.skip-link');
    skipLink.focus();
    skipLink.click();
    await frame();
    const skipLinkFocus=document.activeElement===document.querySelector('#detailWorkspace');
    click('#createProjectButton');
    await wait(()=>document.querySelector('#projectDialog').open,'project create dialog');
    click('#saveProject');
    await frame();
    const projectValidation=document.activeElement===document.querySelector('#projectName')&&document.querySelector('#projectName').getAttribute('aria-invalid')==='true'&&document.querySelector('#projectNameError').textContent.includes('项目名称')&&document.querySelector('#firstEnvironmentName').getAttribute('aria-invalid')==='true'&&document.querySelector('#firstEnvironmentNameError').textContent.includes('环境名称');
    click('[data-close="projectDialog"]');
    const quickQuestionTab=document.querySelector('[data-detail-tab="quick-questions"]');
    quickQuestionTab.focus();
    quickQuestionTab.click();
    await wait(()=>!document.querySelector('#quickQuestionsView').classList.contains('hidden'),'quick questions view');
    await frame();
    const tabFocusRestored=document.activeElement?.dataset.detailTab==='quick-questions'&&document.querySelectorAll('#detailTopTabs [aria-current="page"]').length===1;
    await wait(()=>document.querySelector('#quickQuestionLoading').classList.contains('hidden'),'quick questions loaded');
    const quickQuestionView=document.querySelector('#quickQuestionsView');
    const quickQuestionPage=quickQuestionView.querySelector('.quick-question-page');
    const quickQuestionInput=document.querySelector('#quickQuestionInput');
    const quickQuestionDiscoveredDate=document.querySelector('#quickQuestionDiscoveredDate');
    await wait(()=>!document.querySelector('#editQuickQuestionOpening').disabled,'quick question opening loaded');
    const quickQuestionInputs=[...document.querySelectorAll('#quickQuestionsView input')];
    const minimalSurface=quickQuestionInputs.length===1&&quickQuestionInputs[0]===quickQuestionDiscoveredDate&&quickQuestionDiscoveredDate.type==='date'&&document.querySelectorAll('#quickQuestionCustomList [data-quick-question-fill]').length===0;
    const scopeNamed=document.querySelector('#quickQuestionProjectName').textContent.trim()==='澳大利亚-zip'&&document.querySelector('#quickQuestionEnvironmentName').textContent.trim()==='正式环境'&&!document.querySelector('.quick-question-scope').textContent.includes('只读');
    const openingGlobalLabel=document.querySelector('#quickQuestionOpeningTitle').textContent.trim()==='全部环境通用';
    click('#editQuickQuestionOpening');
    await wait(()=>document.querySelector('#quickQuestionOpeningDialog').open,'opening editor');
    const openingInput=document.querySelector('#quickQuestionOpeningInput');
    openingInput.value='请排查当前问题';
    openingInput.dispatchEvent(new Event('input',{bubbles:true}));
    await frame();
    const openingInvalidBlocked=document.querySelector('#saveQuickQuestionOpening').disabled&&document.querySelector('#quickQuestionOpeningError').textContent.includes('AI Ops MCP');
    click('#resetQuickQuestionOpening');
    const openingResetFromBackend=openingInput.value==='请使用 AI Ops MCP 排查当前项目和环境中的问题。';
    openingInput.value='请使用 AI-Ops MCP 进行只读排查并给出证据。';
    openingInput.dispatchEvent(new Event('input',{bubbles:true}));
    click('#saveQuickQuestionOpening');
    await wait(()=>!document.querySelector('#quickQuestionOpeningDialog').open&&document.querySelector('#quickQuestionOpeningText').textContent.includes('AI-Ops MCP'),'opening saved');
    const openingGlobalSaved=openingGlobalLabel&&document.querySelector('#quickQuestionOpeningText').textContent==='请使用 AI-Ops MCP 进行只读排查并给出证据。';
    quickQuestionInput.value='password=smoke-secret-value';
    quickQuestionInput.dispatchEvent(new Event('input',{bubbles:true}));
    await frame();
    const sensitiveSaveDisabled=document.querySelector('#saveQuickQuestion').disabled&&!document.querySelector('#quickQuestionSensitiveWarning').classList.contains('hidden');
    quickQuestionInput.value='排查支付回调是否积压';
    quickQuestionInput.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>!document.querySelector('#saveQuickQuestion').disabled,'savable quick question');
    click('#saveQuickQuestion');
    await wait(()=>document.querySelector('#quickQuestionCommonDialog').open,'create common question dialog');
    const saveActionPrefilled=document.querySelector('#quickQuestionCommonInput').value==='排查支付回调是否积压';
    click('#saveQuickQuestionFromDialog');
    await wait(()=>!document.querySelector('#quickQuestionCommonDialog').open&&Boolean(document.querySelector('[data-quick-question-fill]')),'created common question');
    const customCreated=document.querySelector('#quickQuestionCustomList').textContent.includes('排查支付回调是否积压');
    click('[data-quick-question-edit]');
    await wait(()=>document.querySelector('#quickQuestionCommonDialog').open,'edit common question dialog');
    const commonInput=document.querySelector('#quickQuestionCommonInput');
    commonInput.value='排查支付回调积压并给出证据';
    commonInput.dispatchEvent(new Event('input',{bubbles:true}));
    click('#saveQuickQuestionFromDialog');
    await wait(()=>document.querySelector('#quickQuestionCommonDialog').open&&commonInput.value==='排查支付回调积压并给出证据'&&!document.querySelector('#saveQuickQuestionFromDialog').disabled,'common question conflict refresh and retry');
    const conflictRetryReady=commonInput.value==='排查支付回调积压并给出证据'&&!document.querySelector('#saveQuickQuestionFromDialog').disabled;
    click('#saveQuickQuestionFromDialog');
    await wait(()=>!document.querySelector('#quickQuestionCommonDialog').open&&document.querySelector('#quickQuestionCustomList').textContent.includes('排查支付回调积压并给出证据'),'updated common question');
    quickQuestionInput.value='';
    quickQuestionInput.dispatchEvent(new Event('input',{bubbles:true}));
    click('[data-quick-question-fill]');
    await wait(()=>quickQuestionInput.value==='排查支付回调积压并给出证据','fill saved quick question');
    const customFilled=document.activeElement===quickQuestionInput;
    const previewWithoutDate=['请使用 AI-Ops MCP 进行只读排查并给出证据。','','【当前范围】','项目：澳大利亚-zip','环境：正式环境','','【问题】','排查支付回调积压并给出证据'].join('\\n');
    const optionalDateOmitted=document.querySelector('#quickQuestionFinalPreview').textContent===previewWithoutDate&&!previewWithoutDate.includes('问题发现时间');
    quickQuestionDiscoveredDate.value='2026-08-24';
    quickQuestionDiscoveredDate.dispatchEvent(new Event('input',{bubbles:true}));
    const expectedPreview=['请使用 AI-Ops MCP 进行只读排查并给出证据。','','【当前范围】','项目：澳大利亚-zip','环境：正式环境','问题发现时间：8月24日','','【问题】','排查支付回调积压并给出证据'].join('\\n');
    const finalPreviewCorrect=document.querySelector('#quickQuestionFinalPreview').textContent===expectedPreview;
    click('#copyQuickQuestion');
    await wait(()=>document.querySelector('#toast').textContent.includes('已复制'),'text quick question copied');
    const quickDeleteButton=document.querySelector('[data-quick-question-delete]');
    quickDeleteButton.focus();
    quickDeleteButton.click();
    await wait(()=>document.querySelector('#deleteQuickQuestionDialog').open,'delete saved quick question confirmation');
    const deleteSafeFocus=document.activeElement===document.querySelector('#cancelDeleteQuickQuestion')&&Boolean(document.querySelector('[data-quick-question-delete]'));
    click('#cancelDeleteQuickQuestion');
    await wait(()=>!document.querySelector('#deleteQuickQuestionDialog').open,'cancel delete saved quick question');
    await frame();
    const deleteCancelPreserved=Boolean(document.querySelector('[data-quick-question-delete]'))&&document.activeElement===quickDeleteButton;
    click('[data-quick-question-delete]');
    await wait(()=>document.querySelector('#deleteQuickQuestionDialog').open,'reopen delete saved quick question confirmation');
    click('#confirmDeleteQuickQuestion');
    await wait(()=>!document.querySelector('[data-quick-question-delete]')&&!document.querySelector('#quickQuestionCommonEmpty').classList.contains('hidden'),'delete saved quick question');
    const commonCrud=saveActionPrefilled&&customCreated&&customFilled&&document.querySelector('#quickQuestionCustomList').classList.contains('hidden');
    await frame();
    const quickQuestionPageRect=quickQuestionPage.getBoundingClientRect();
    const quickQuestionFits=quickQuestionView.scrollWidth<=quickQuestionView.clientWidth+1&&quickQuestionPage.scrollWidth<=quickQuestionPage.clientWidth+1&&[...quickQuestionView.querySelectorAll('button,textarea,input')].filter((element)=>element.offsetParent!==null).every((element)=>{const rect=element.getBoundingClientRect();return rect.left>=quickQuestionPageRect.left-1&&rect.right<=quickQuestionPageRect.right+1;});
    const quickQuestionViewRect=quickQuestionView.getBoundingClientRect();
    const quickQuestionCopyRect=document.querySelector('#copyQuickQuestion').getBoundingClientRect();
    const primaryVisible=quickQuestionCopyRect.top>=quickQuestionViewRect.top-1&&quickQuestionCopyRect.bottom<=quickQuestionViewRect.bottom+1;
    const quickQuestions={minimalSurface,scopeNamed,openingInvalidBlocked,openingResetFromBackend,openingGlobalSaved,sensitiveSaveDisabled,conflictRetryReady,commonCrud,optionalDateOmitted,finalPreviewCorrect,tabFocusRestored,deleteConfirmation:deleteSafeFocus&&deleteCancelPreserved,fits:quickQuestionFits,primaryVisible};
    click('[data-detail-tab="information"]');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('环境概览'),'return from quick questions');
    const selectedHeaderContinuous=document.querySelector('.resource-environment-card.selected .resource-environment-head')!==null;
    const compactEnvironmentActions=[...document.querySelectorAll('.resource-environment-head')].every(head=>Boolean(head.querySelector(':scope > [data-environment-runtime-action]'))&&!head.querySelector(':scope > [data-resource-rename-environment]')&&!head.querySelector(':scope > [data-resource-delete-environment]')&&!head.querySelector('.action-menu'));
    const environmentActionsWrapCleanly=[...document.querySelectorAll('.resource-environment-head')].every(head=>{const headRect=head.getBoundingClientRect();return [...head.children].every(control=>{const rect=control.getBoundingClientRect();return rect.left>=headRect.left-1&&rect.right<=headRect.right+1&&rect.top>=headRect.top-1&&rect.bottom<=headRect.bottom+1;});});
    const environmentHeaderControlsAligned=[...document.querySelectorAll('.resource-environment-head')].every(head=>{const controls=[head.querySelector(':scope>.resource-environment-select'),head.querySelector(':scope>.resource-environment-status'),head.querySelector(':scope>.resource-runtime-action')].filter(Boolean);const centers=controls.map(control=>{const rect=control.getBoundingClientRect();return rect.top+rect.height/2;});return Math.max(...centers)-Math.min(...centers)<=1;});
    const environmentHeaderHeight=Math.round(document.querySelector('.resource-environment-head').getBoundingClientRect().height);
    const workspaceHeaderLinesAligned=(()=>{const bottoms=[document.querySelector('.rail-header'),document.querySelector('.resource-pane-head'),document.querySelector('.detail-topbar')].map(element=>element.getBoundingClientRect().bottom);return Math.max(...bottoms)-Math.min(...bottoms)<=1;})();
    const railRefined=!document.querySelector('.rail-brand')&&!document.querySelector('.rail-project-manage')&&Boolean(document.querySelector('.rail-header .logo-mark use[href="#i-app"]'));
    const projectRailWasExpanded=app.classList.contains('rail-expanded');
    if(!projectRailWasExpanded){click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));}
    const expandedWorkspaceFootersAligned=Math.abs(document.querySelector('.rail-footer').getBoundingClientRect().top-document.querySelector('.resource-pane-footer').getBoundingClientRect().top)<=1;
    const expandedCreateActionCentered=(()=>{const button=document.querySelector('#createProjectButton'),copy=button.querySelector('.rail-project-copy'),buttonRect=button.getBoundingClientRect(),copyRect=copy.getBoundingClientRect();return Math.abs((buttonRect.left+buttonRect.width/2)-(copyRect.left+copyRect.width/2))<=1;})();
    const connectedProject=document.querySelector('.project-tree-item.active[data-project-state="connected"]');
    const disconnectedProject=document.querySelector('.project-tree-item[data-tree-project="idle"][data-project-state="disconnected"]');
    const connectedHeadStyle=getComputedStyle(connectedProject.querySelector('.project-tree-head'));
    const disconnectedHeadStyle=getComputedStyle(disconnectedProject.querySelector('.project-tree-head'));
    const connectedSummaryStyle=getComputedStyle(connectedProject.querySelector('.rail-project-copy small'));
    const projectConnectionContrast={
      statesPresent:Boolean(connectedProject&&disconnectedProject),
      distinctBackground:connectedHeadStyle.backgroundImage!=='none'&&connectedHeadStyle.backgroundImage!==disconnectedHeadStyle.backgroundImage,
      greenStateBar:connectedHeadStyle.boxShadow.includes('85, 214, 161'),
      greenSummary:connectedSummaryStyle.color==='rgb(114, 220, 176)',
      purpleSelection:connectedHeadStyle.boxShadow.includes('131, 124, 246'),
    };
    const expandedDetailLeft=Math.round(detail.getBoundingClientRect().left);
    click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));
    if(Math.abs(expandedDetailLeft-Math.round(detail.getBoundingClientRect().left))>1)throw new Error('project rail toggle moved the detail pane boundary');
    if(projectRailWasExpanded){click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));}
    const secondPaneCommonOnly=!document.querySelector('#resetWorkspaceWidths')&&!document.querySelector('.resource-pane #projectSettingsShortcut')&&!document.querySelector('.resource-pane #projectDeleteShortcut')&&![...document.querySelectorAll('.resource-environment-head')].some(head=>head.querySelector('[data-resource-rename-environment],[data-resource-delete-environment]'));
    const environmentCaretRemoved=!document.querySelector('.resource-chevron');
    const environmentInformationPage=!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent').textContent.includes('正式环境')&&document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('环境概览');
    const environmentOverviewActions=[...document.querySelectorAll('#scopeInfoContent .scope-information-actions>button')].map(button=>button.textContent.trim());
    const environmentView=document.querySelector('#scopeInfoView');
    const environmentSections=[...document.querySelectorAll('.environment-overview-section>header h2')].map(heading=>heading.textContent.trim());
    const environmentOverviewCompact={
      summary:/6 个插件.+个已配置.+个已连接.+个待确认/.test(document.querySelector('.environment-summary-copy')?.textContent||''),
      noMetricCards:document.querySelectorAll('[data-environment-stat]').length===0,
      noRecentActivity:!document.querySelector('.environment-summary-page .scope-activity-row')&&!document.querySelector('.environment-summary-page .scope-overview-layout'),
      noFold:!document.querySelector('.environment-summary-page details'),
      usefulSections:environmentSections.join('|')==='需要处理|插件状态|环境资料|运维说明',
      metadataLabels:[...document.querySelectorAll('.environment-profile-summary dt')].map(item=>item.textContent.trim()).join('|')==='所属项目|环境 ID|创建时间|最近更新',
      pluginRows:document.querySelectorAll('.environment-plugin-summary .scope-plugin-row').length===3,
      pluginOverflowCue:document.querySelector('.environment-plugin-summary .scope-overview-more')?.textContent.includes('另有 3 个插件'),
      runbookVisible:Boolean(document.querySelector('.environment-runbook-section .scope-runbook-summary')),
      managementActionsGrouped:Boolean(document.querySelector('.scope-overview-head .scope-information-actions [data-resource-rename-environment="prod"]'))&&Boolean(document.querySelector('.scope-overview-head .scope-information-actions [data-resource-delete-environment="prod"]')),
      boundedToPage:environmentView.scrollHeight<=environmentView.clientHeight*1.15,
    };
    click('[data-resource-rename-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('#scopeInfoContent [data-resource-environment-editor="prod"]')),'environment information rename');
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
    await wait(()=>document.querySelector('[data-resource-environment-id="prod"] .resource-environment-copy strong')?.textContent==='生产环境'&&document.querySelector('#scopeInfoContent')?.textContent.includes('生产环境')&&!document.querySelector('[data-resource-environment-editor="prod"]'),'save environment information rename');
    click('[data-resource-rename-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('#scopeInfoContent [data-resource-environment-editor="prod"]')),'environment information rename no-op');
    document.querySelector('[data-resource-environment-editor="prod"]').requestSubmit();
    await wait(()=>!document.querySelector('[data-resource-environment-editor="prod"]'),'close no-op environment rename');
    click('[data-resource-delete-environment="prod"]');
    await wait(()=>Boolean(document.querySelector('#scopeInfoContent [data-resource-environment-delete-prompt="prod"]')),'environment information delete prompt');
    const environmentDeleteInInformation=document.querySelector('[data-resource-environment-delete-prompt="prod"]').textContent.includes('请先处理该环境的 6 个插件');
    click('[data-resource-cancel-environment-delete]');
    const environmentManagementInInformation=environmentInformationPage&&renameFocused&&blankNameRejected&&!document.querySelector('#environmentManagerDialog')&&environmentDeleteInInformation;
    click('.resource-environment-select[data-resource-environment-id="gray"]');
    await wait(()=>Boolean(document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="gray"]'))&&!document.querySelector('.resource-environment-card.expanded .resource-environment-select[data-resource-environment-id="prod"]')&&document.querySelector('#scopeInfoContent')?.textContent.includes('灰度环境'),'exclusive environment expand');
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
    click('[data-project-id="member"]');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('项目概览'),'project information');
    const projectTabs=[...document.querySelectorAll('#detailTopTabs .detail-top-tab')].map(item=>item.textContent.trim());
    const projectInformationPage=document.querySelector('#scopeInfoContent').textContent.includes('澳大利亚-zip')&&!document.querySelector('.resource-pane #projectSettingsShortcut')&&!document.querySelector('.resource-pane #projectDeleteShortcut');
    const projectOverviewActions=[...document.querySelectorAll('#scopeInfoContent .scope-information-actions>button')].map(button=>button.textContent.trim());
    click('#projectSettingsShortcut');
    await wait(()=>Boolean(document.querySelector('#scopeInfoContent #projectTitleEditor')),'project information title editor no-op');
    click('#saveProjectTitle');
    await wait(()=>!document.querySelector('#projectTitleEditor'),'close project title no-op');
    click('#projectSettingsShortcut');
    await wait(()=>Boolean(document.querySelector('#scopeInfoContent #projectTitleEditor')),'project information title editor');
    document.querySelector('#projectTitleInput').value='澳大利亚-zip · 新版';
    document.querySelector('#projectTitleInput').dispatchEvent(new Event('input',{bubbles:true}));
    click('#saveProjectTitle');
    await wait(()=>document.querySelector('#projectTitle').textContent.includes('新版')&&document.querySelector('#scopeInfoContent')?.textContent.includes('新版')&&!document.querySelector('#projectTitleEditor'),'save project information title');
    const projectManagementInInformation=projectInformationPage&&!document.querySelector('#projectSettingsDialog').open;
    click('#projectDeleteShortcut');
    await wait(()=>document.querySelector('#deleteProjectDialog').open,'project delete shortcut');
    const projectDeleteFromInformation=document.querySelector('#deleteProjectScope').textContent.includes('新版');
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
    const connectionEditButton=document.querySelector('.connection-information [data-action="edit-plugin"]');
    const connectButton=document.querySelector('.detail-head [data-action="connect-plugin"]');
    const pluginDetailHierarchy={
      targetRemovedFromHeader:!document.querySelector('#pluginDetail .detail-summary'),
      deleteRemovedFromHeader:!document.querySelector('#pluginDetail .detail-head [data-action="prepare-delete-plugin"]'),
      flatConnectionFacts:document.querySelectorAll('.connection-facts .connection-fact').length===4&&!document.querySelector('.connection-fact-card'),
      editIsSecondary:Boolean(connectionEditButton)&&!connectionEditButton.classList.contains('primary'),
      connectIsPrimary:!connectButton||connectButton.classList.contains('primary'),
      explicitPanelIcons:document.querySelector('#toggleProjectRail use').getAttribute('href')===(app.classList.contains('rail-expanded')?'#i-panel-left-close':'#i-panel-left-open')&&document.querySelector('#toggleDetailPane use').getAttribute('href')==='#i-panel-right-close'&&document.querySelector('#expandDetailPane use').getAttribute('href')==='#i-panel-right-open',
    };
    const diagnosticInline=!document.querySelector('#diagnosticDialog')&&!document.querySelector('[data-action="test-plugin"]')&&!document.querySelector('#connectionCheckPanel');
    click('[data-detail-tab="configuration"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'),'readonly configuration tab');
    const pluginInformationCopy=document.querySelector('.plugin-information-section .content-title h2')?.textContent.trim()==='基本信息'&&document.querySelector('.plugin-information-section .field-list dt')?.textContent.trim()==='插件名称';
    const pluginInformationActions=[...document.querySelectorAll('.plugin-information-section .scope-information-actions>button')].map(button=>button.textContent.trim());
    const deletionPlacement=Boolean(document.querySelector('.plugin-information-section .scope-information-actions [data-action="prepare-delete-plugin"]'))&&!document.querySelector('.detail-head [data-action="prepare-delete-plugin"]')&&!document.querySelector('.plugin-danger-zone');
    click('.plugin-information-section [data-action="prepare-delete-plugin"]');
    await wait(()=>document.querySelector('#deletePluginDialog').open,'plugin delete from information');
    const pluginDeleteFromInformation=document.querySelector('#deletePluginMessage').textContent.includes('会员业务库');
    click('#deletePluginDialog [data-close="deletePluginDialog"]');
    const renameOnlyMetadata=document.querySelector('#pluginDetail').textContent.includes('插件名称')&&document.querySelector('#pluginDetail').textContent.includes('修改名称')&&!/说明|标签|展示顺序/.test(document.querySelector('#pluginDetail').textContent);
    const readonlyBeforeEdit=document.querySelector('#pluginConfigView').classList.contains('hidden')&&Boolean(document.querySelector('#pluginsView:not(.hidden)'));
    window.confirm=()=>true;
    click('[data-action="edit-plugin"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'fenced configuration editor');
    const editFooterActions=[...document.querySelectorAll('.plugin-form-actions>button:not(.hidden)')];
    const editFooterRects=editFooterActions.map(button=>button.getBoundingClientRect());
    const editHostRect=document.querySelector('#pluginHost').getBoundingClientRect();
    const editPortRect=document.querySelector('#pluginPort').getBoundingClientRect();
    const editUsernameRect=document.querySelector('#pluginUsernameField').getBoundingClientRect();
    const editCredentialRect=document.querySelector('#primaryCredentialField').getBoundingClientRect();
    const configurationInline={
      readonlyBeforeEdit,
      renameOnlyMetadata,
      noDialog:!document.querySelector('#pluginDialog'),
      title:document.querySelector('#pluginInlineFormHost').textContent.includes('编辑连接配置'),
      namePreserved:document.querySelector('#pluginDisplayName').value==='会员业务库',
      typeCardsHidden:document.querySelector('#pluginTypePicker').classList.contains('hidden'),
      credentialUnchanged:document.querySelector('#primaryCredentialStatus').textContent.includes('未修改'),
      draftControlsAbsent:!document.querySelector('#savePluginDraft')&&!document.querySelector('#pluginDraftOverflow')&&!document.querySelector('#deleteCurrentDraft'),
      footerLabels:editFooterActions.map(button=>button.textContent.trim()),
      primaryFooterLabels:editFooterActions.filter(button=>button.classList.contains('primary')).map(button=>button.textContent.trim()),
      safetyCopy:document.querySelector('#pluginEditSafetyStatus').textContent.trim(),
      pairedFieldsAligned:Math.abs(editHostRect.top-editPortRect.top)<1&&Math.abs(editUsernameRect.top-editCredentialRect.top)<1,
      footerButtonsShareRow:new Set(editFooterRects.map(rect=>Math.round(rect.top))).size===1,
      footerButtonsOverlap:editFooterRects.some((rect,index)=>editFooterRects.slice(index+1).some(other=>rect.left<other.right&&rect.right>other.left&&rect.top<other.bottom&&rect.bottom>other.top)),
    };
    click('#validateMysqlDatabase');
    await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'),'form connection check');
    const formDiagnostic=!document.querySelector('#pluginConfigView').classList.contains('hidden')&&document.querySelector('#pluginFormDiagnostic').querySelectorAll('.diagnostic-step.success').length===3&&document.querySelector('#pluginFormDiagnostic').textContent.includes('28 ms');
    click('[data-detail-tab="audit"]');
    await wait(()=>!document.querySelector('#auditView').classList.contains('hidden')&&document.querySelectorAll('#auditBody .audit-record').length===3,'plugin audit');
    const auditFiltered=document.querySelector('#auditBody').textContent.includes('会员业务库')&&!document.querySelector('#auditBody').textContent.includes('应用服务器');
    const auditConnectionVisible=document.querySelector('#auditBody').textContent.includes('连接插件');
    const auditResponsive=Boolean(document.querySelector('#auditBody .audit-event'))&&!/发起者\s*操作\s*对象\s*结果/.test(document.querySelector('#auditView').textContent);
    const auditPendingNamed=document.querySelector('#auditBody').textContent.includes('等待确认')&&!document.querySelector('#auditBody').textContent.includes('部分成功');
    const firstAuditRecordStyle=getComputedStyle(document.querySelector('#auditBody .audit-record'));
    const auditRenderingBounded=firstAuditRecordStyle.contentVisibility==='auto'&&/(?:88|108)px/.test(firstAuditRecordStyle.containIntrinsicSize);
    const resourceContextBottom=document.querySelector('.resource-pane-label').getBoundingClientRect().bottom;
    const auditContextBottom=document.querySelector('#auditView .page-head').getBoundingClientRect().bottom;
    const firstResourceTop=document.querySelector('.resource-environment-card').getBoundingClientRect().top;
    const firstAuditControlTop=document.querySelector('#auditSearch').getBoundingClientRect().top;
    const workspaceTopBandsAligned=Math.abs(resourceContextBottom-auditContextBottom)<=1&&Math.abs(firstResourceTop-firstAuditControlTop)<=1;
    const workspaceFootersAligned=Math.abs(document.querySelector('.rail-footer').getBoundingClientRect().top-document.querySelector('.resource-pane-footer').getBoundingClientRect().top)<=1;
    const inactiveEnvironmentActionsSecondary=[...document.querySelectorAll('.resource-environment-card:not(.selected):not(:has(.resource-plugin-row.selected)) .resource-runtime-action')].every(button=>!button.classList.contains('primary'));
    const auditMetaAligned=(()=>{const record=document.querySelector('#auditBody .audit-record'),items=[record.querySelector('time'),record.querySelector('.audit-actor'),record.querySelector('.result')],centers=items.map(item=>{const rect=item.getBoundingClientRect();return rect.top+rect.height/2;});return Math.max(...centers)-Math.min(...centers)<=1;})();
    click('#clearAudit');
    await wait(()=>document.querySelector('#clearAuditDialog').open,'clear audit confirmation');
    const auditClearScoped=document.querySelector('#clearAuditScope').textContent.includes('会员业务库')&&document.querySelector('#clearAuditScope').textContent.includes('仅当前插件');
    click('#confirmClearAudit');
    await wait(()=>document.querySelector('#auditEmpty')&&!document.querySelector('#auditEmpty').classList.contains('hidden'),'cleared plugin audit');
    const auditCleared=document.querySelector('#clearAudit').disabled&&document.querySelector('#toast').textContent.includes('3 条');
    click('[data-detail-tab="configuration"]');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'),'return to mysql configuration');
    click('[data-action="edit-plugin"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden'),'edit mysql before cancelling changes');
    click('#replacePrimaryCredential');
    document.querySelector('#pluginPassword').value='discarded-password';
    document.querySelector('#pluginPassword').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#pluginHost').value='discarded.internal';
    document.querySelector('#pluginHost').dispatchEvent(new Event('input',{bubbles:true}));
    click('#cancelPluginEdit');
    await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'),'cancel mysql edit');
    const editCancelDiscarded=document.querySelector('#pluginDetail').textContent.includes('127.0.0.1')&&!document.querySelector('#pluginDetail').textContent.includes('discarded.internal');
    click('.resource-environment-select[data-resource-environment-id="prod"]');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden'),'return to environment');
    if (!document.querySelector('[data-resource-add-plugin="prod"]')) {
      click('.resource-environment-select[data-resource-environment-id="prod"]');
      await wait(()=>Boolean(document.querySelector('[data-resource-add-plugin="prod"]')),'expand environment for add plugin');
    }
    click('#toggleDetailPane');
    await frame();
    click('[data-resource-add-plugin="prod"]');
    await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden')&&!document.querySelector('#pluginTypePicker').classList.contains('hidden')&&!document.querySelector('#pluginInlineFormHost .plugin-card'),'plugin type picker');
    const typePickerCatalog=[...document.querySelectorAll('#pluginTypeChoices input[name="pluginTypeChoice"]')].map(input=>input.value);
    document.querySelector('input[name="pluginTypeChoice"][value="redis"]').click();
    await wait(()=>document.querySelector('#pluginTypePicker').classList.contains('hidden')&&document.querySelector('#pluginInlineFormHost .plugin-card'),'inline add plugin');
    const addPluginInline=!document.querySelector('#pluginDialog')&&document.querySelector('#pluginDisplayName').value==='';
    const createFooterLabels=[...document.querySelectorAll('.plugin-form-actions>button:not(.hidden)')].map(button=>button.textContent.trim());
    const typeIdentity=document.querySelector('#pluginTypeIdentity');
    const identityStyle=getComputedStyle(typeIdentity);
    const changeTypeButton=document.querySelector('#changeNewPluginType');
    const changeTypeStyle=getComputedStyle(changeTypeButton);
    const hostRect=document.querySelector('#pluginHost').getBoundingClientRect();
    const portRect=document.querySelector('#pluginPort').getBoundingClientRect();
    const sectionStyle=getComputedStyle(document.querySelector('#targetAddressSection'));
    const createActionModel={typePickerCatalog,createFooterLabels,validationHidden:document.querySelector('#pluginValidationSection').classList.contains('hidden'),draftControlsAbsent:!document.querySelector('#savePluginDraft')&&!document.querySelector('#pluginDraftOverflow')&&!document.querySelector('#deleteCurrentDraft'),typeIdentityPlain:identityStyle.backgroundColor==='rgba(0, 0, 0, 0)'&&identityStyle.borderTopWidth==='0px',changeTypeButtonObvious:changeTypeButton.tagName==='BUTTON'&&changeTypeStyle.borderTopWidth!=='0px'&&changeTypeStyle.backgroundColor!=='rgba(0, 0, 0, 0)',pairedFieldsAligned:Math.abs(hostRect.top-portRect.top)<1&&Math.abs(hostRect.height-portRect.height)<1,flatSections:sectionStyle.borderTopLeftRadius==='0px'&&sectionStyle.boxShadow==='none'&&sectionStyle.backgroundColor==='rgba(0, 0, 0, 0)',advancedSummary:document.querySelector('#pluginAdvancedSummary').textContent.includes('IPv4 优先')};
    const addPluginOpensDetail=!app.classList.contains('detail-collapsed')&&Math.round(detail.getBoundingClientRect().width)>58;
    document.querySelector('#pluginDisplayName').value='不应保存的 Redis';
    document.querySelector('#pluginDisplayName').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#pluginHost').value='cache.internal';
    document.querySelector('#pluginHost').dispatchEvent(new Event('input',{bubbles:true}));
    click('#cancelPluginEdit');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden'),'cancel new plugin');
    const cancelledPluginAbsent=![...document.querySelectorAll('.resource-plugin-copy strong')].some(element=>element.textContent.includes('不应保存的 Redis'));
    click('[data-resource-add-plugin="prod"]');
    await wait(()=>!document.querySelector('#pluginTypePicker').classList.contains('hidden'),'reopen plugin type picker');
    document.querySelector('input[name="pluginTypeChoice"][value="redis"]').click();
    await wait(()=>document.querySelector('#pluginInlineFormHost .plugin-card'),'reopen empty plugin form');
    const addCancelDiscarded=cancelledPluginAbsent&&document.querySelector('#pluginDisplayName').value===''&&document.querySelector('#pluginHost').value==='';
    click('#cancelPluginEdit');
    await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden'),'leave reopened plugin form');
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
    const initialProjectOrder=[...document.querySelectorAll('[data-tree-project]')].map(item=>item.dataset.treeProject);
    const sortableProject=document.querySelector('[data-project-id="member"]');
    const initialProjectIndex=initialProjectOrder.indexOf('member');
    const moveKey=initialProjectIndex===0?'ArrowDown':'ArrowUp';
    sortableProject.focus();
    sortableProject.dispatchEvent(new KeyboardEvent('keydown',{key:moveKey,altKey:true,bubbles:true}));
    const movedProjectOrder=[...document.querySelectorAll('[data-tree-project]')].map(item=>item.dataset.treeProject);
    const movedProjectIndex=movedProjectOrder.indexOf('member');
    const movedProjectButton=document.querySelector('[data-project-id="member"]');
    const projectMoveFocused=document.activeElement===movedProjectButton;
    movedProjectButton.dispatchEvent(new KeyboardEvent('keydown',{key:moveKey==='ArrowDown'?'ArrowUp':'ArrowDown',altKey:true,bubbles:true}));
    const restoredProjectOrder=[...document.querySelectorAll('[data-tree-project]')].map(item=>item.dataset.treeProject);
    const keyboardProjectSort=movedProjectIndex!==initialProjectIndex&&projectMoveFocused&&JSON.stringify(restoredProjectOrder)===JSON.stringify(initialProjectOrder);
    const detailToggle=document.querySelector('#toggleDetailPane');
    detailToggle.focus();
    detailToggle.click();
    await frame();
    const collapsed={active:app.classList.contains('detail-collapsed'),detailWidth:Math.round(detail.getBoundingClientRect().width),resourceWidth:Math.round(resources.getBoundingClientRect().width),buttonVisible:getComputedStyle(document.querySelector('#expandDetailPane')).display!=='none',focusTransferred:document.activeElement===document.querySelector('#expandDetailPane')};
    document.querySelector('#expandDetailPane').click();
    await frame();
    collapsed.focusReturned=document.activeElement===document.querySelector('#toggleDetailPane');
    return {accessibility:{skipLinkFocus,projectValidation,keyboardProjectSort},environmentTabs,quickQuestions,projectTabs,pluginTabs,selectedHeaderContinuous,compactEnvironmentActions,environmentActionsWrapCleanly,environmentHeaderControlsAligned,workspaceHeaderLinesAligned,environmentCardToggle,environmentHeaderHeight,railRefined,projectConnectionContrast,expandedWorkspaceFootersAligned,expandedCreateActionCentered,secondPaneCommonOnly,environmentOverviewActions,environmentOverviewCompact,environmentManagementInInformation,environmentCreatedInline,confirmationCenter,permissionsRefined,projectOverviewActions,projectManagementInInformation,projectDeleteFromInformation,pluginDetailHierarchy,pluginInformationCopy,pluginInformationActions,deletionPlacement,pluginDeleteFromInformation,configurationInline,diagnosticInline,formDiagnostic,editCancelDiscarded,addPluginInline,createActionModel,addPluginOpensDetail,addCancelDiscarded,overflowSelectionVisible,resourceOverflowOwnedByList,auditFiltered,auditConnectionVisible,auditResponsive,auditPendingNamed,auditRenderingBounded,workspaceTopBandsAligned,workspaceFootersAligned,inactiveEnvironmentActionsSecondary,auditMetaAligned,auditClearScoped,auditCleared,collapsed,initialRects:initialRects.map(rect=>({left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width)})),expanded:!app.classList.contains('detail-collapsed'),separators:document.querySelectorAll('[role="separator"]').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  })()`);
  const screenshotPath = process.argv.find((value) => /\.png$/i.test(value)) || process.env.AI_OPS_SCREENSHOT_PATH;
  if (screenshotPath) {
    const screenshotModes = ['add','add-compact','confirmation','editor','edit-form','edit-form-medium','edit-form-compact','configuration','connection','audit','resources','environment','project','projects','quick-questions'];
    const screenshotMode = process.argv.find((value) => screenshotModes.includes(value)) ?? (screenshotModes.includes(process.env.AI_OPS_SCREENSHOT_MODE) ? process.env.AI_OPS_SCREENSHOT_MODE : 'permissions');
    if (screenshotMode === 'audit') auditEntries = structuredClone(initialAuditEntries);
    if (screenshotMode === 'resources') {
      win.setContentSize(815,900);
      await new Promise((resolve) => setTimeout(resolve,100));
    }
    if (screenshotMode === 'edit-form-medium') {
      win.setContentSize(960,900);
      await new Promise((resolve) => setTimeout(resolve,100));
    }
    if (['add-compact','edit-form-compact'].includes(screenshotMode)) {
      win.setContentSize(815,900);
      await new Promise((resolve) => setTimeout(resolve,100));
    }
    const screenshotState = await win.webContents.executeJavaScript(`(async()=>{
      const wait=async(predicate)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: ${screenshotMode} screenshot');await new Promise(resolve=>setTimeout(resolve,20));}};
      const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing screenshot target: '+selector);element.click();};
      const openMysql=async()=>{if(!document.querySelector('[data-resource-plugin-id="mysql-member"]')){click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>document.querySelector('[data-resource-plugin-id="mysql-member"]'));}click('[data-resource-plugin-id="mysql-member"]');await wait(()=>document.querySelector('[data-detail-tab="configuration"]')&&document.querySelector('#pluginDetail')?.textContent.includes('会员业务库'));};
      if(['add','add-compact'].includes('${screenshotMode}')){
        click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>document.querySelector('[data-resource-add-plugin="prod"]'));click('[data-resource-add-plugin="prod"]');await wait(()=>!document.querySelector('#pluginTypePicker').classList.contains('hidden'));click('input[name="pluginTypeChoice"][value="mysql"]');await wait(()=>document.querySelector('#pluginInlineFormHost .plugin-card')&&!document.querySelector('#pluginInlineFormHost .plugin-card').classList.contains('hidden'));document.querySelector('#pluginHost').value='127.0.0.1';document.querySelector('#pluginHost').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#pluginUsername').value='root';document.querySelector('#pluginUsername').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.plugin-dialog-body').scrollTop=0;
      }else if('${screenshotMode}'==='quick-questions'){
        click('.resource-environment-select[data-resource-environment-id="prod"]');
        await wait(()=>document.querySelector('[data-detail-tab="quick-questions"]'));
        click('[data-detail-tab="quick-questions"]');
        await wait(()=>!document.querySelector('#quickQuestionsView').classList.contains('hidden')&&document.querySelector('#quickQuestionLoading').classList.contains('hidden')&&!document.querySelector('#editQuickQuestionOpening').disabled);
        const input=document.querySelector('#quickQuestionInput');
        input.value='排查订单为什么一直待支付，并给出证据。';
        input.dispatchEvent(new Event('input',{bubbles:true}));
        await wait(()=>document.querySelector('#quickQuestionFinalPreview').textContent.includes('订单为什么一直待支付'));
      }else if('${screenshotMode}'==='confirmation'){
        click('#confirmationButton');
        await wait(()=>!document.querySelector('#confirmationView').classList.contains('hidden')&&document.querySelector('#detailTopTabs').textContent.includes('操作确认')&&document.querySelector('[data-confirmation-card]'));
      }else if('${screenshotMode}'==='editor'){
        await openMysql();click('[data-detail-tab="configuration"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'));window.confirm=()=>true;click('[data-action="edit-plugin"]');await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden'));click('#validateMysqlDatabase');await wait(()=>document.querySelector('#pluginFormDiagnostic .diagnostic-overview.success'));document.querySelector('#pluginFormDiagnostic').scrollIntoView({block:'center'});
      }else if(['edit-form','edit-form-medium','edit-form-compact'].includes('${screenshotMode}')){
        await openMysql();click('[data-detail-tab="configuration"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('当前为只读详情'));window.confirm=()=>true;click('[data-action="edit-plugin"]');await wait(()=>!document.querySelector('#pluginConfigView').classList.contains('hidden'));document.querySelector('.plugin-dialog-body').scrollTop=0;
      }else if('${screenshotMode}'==='configuration'){
        await openMysql();click('[data-detail-tab="configuration"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('修改名称'));
      }else if('${screenshotMode}'==='connection'){
        click('[data-resource-plugin-id="server-app"]');await wait(()=>document.querySelector('[data-detail-tab="connection"]')&&document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'));click('[data-detail-tab="connection"]');await wait(()=>document.querySelector('#pluginDetail .connection-facts'));
      }else if('${screenshotMode}'==='audit'){
        await openMysql();click('[data-detail-tab="audit"]');await wait(()=>!document.querySelector('#auditView').classList.contains('hidden')&&document.querySelector('#auditBody')?.textContent.includes('连接插件'));
      }else if('${screenshotMode}'==='resources'){
        if(!document.querySelector('#app').classList.contains('detail-collapsed'))click('#toggleDetailPane');await wait(()=>document.querySelector('#app').classList.contains('detail-collapsed'));const list=document.querySelector('#resourceEnvironmentList');list.scrollTop=list.scrollHeight;await wait(()=>{const row=document.querySelector('[data-resource-plugin-id="redis-cache-2"]')?.closest('.resource-plugin-row');if(!row)return false;const rowRect=row.getBoundingClientRect(),listRect=list.getBoundingClientRect();return rowRect.bottom<=listRect.bottom&&rowRect.top>=listRect.top;});
      }else if('${screenshotMode}'==='environment'){
        click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent')?.textContent.includes('环境信息'));if(!document.querySelector('[data-resource-plugin-id="server-app"]')){click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>document.querySelector('[data-resource-plugin-id="server-app"]'));}
      }else if('${screenshotMode}'==='project'){
        click('[data-project-id="member"]');await wait(()=>!document.querySelector('#scopeInfoView').classList.contains('hidden')&&document.querySelector('#scopeInfoContent')?.textContent.includes('项目信息'));
      }else if('${screenshotMode}'==='projects'){
        if(!document.querySelector('#app').classList.contains('rail-expanded')){click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));}
      }else{
        click('[data-resource-plugin-id="server-app"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器'));click('[data-detail-tab="permissions"]');await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')));
      }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const form=document.querySelector('#pluginInlineFormHost .plugin-card');const footerButtons=[...document.querySelectorAll('.plugin-form-actions>button:not(.hidden)')];const buttonRects=footerButtons.map(button=>button.getBoundingClientRect());const footerButtonsOverlap=buttonRects.some((rect,index)=>buttonRects.slice(index+1).some(other=>rect.left<other.right&&rect.right>other.left&&rect.top<other.bottom&&rect.bottom>other.top));
      const hostRect=document.querySelector('#pluginHost')?.getBoundingClientRect();const portRect=document.querySelector('#pluginPort')?.getBoundingClientRect();const usernameRect=document.querySelector('#pluginUsernameField')?.getBoundingClientRect();const credentialRect=document.querySelector('#primaryCredentialField')?.getBoundingClientRect();
      return{mode:'${screenshotMode}',editorVisible:!document.querySelector('#pluginConfigView').classList.contains('hidden'),pluginType:document.querySelector('#pluginType')?.value??null,successfulChecks:document.querySelectorAll('#pluginFormDiagnostic .diagnostic-step.success').length,pendingChecks:document.querySelectorAll('#pluginFormDiagnostic .diagnostic-step.pending, #pluginFormDiagnostic .diagnostic-step.queued').length,visibleFooterActions:footerButtons.length,formHorizontalOverflow:Boolean(form&&form.scrollWidth>form.clientWidth),footerButtonsOverlap,footerButtonsShareRow:new Set(buttonRects.map(rect=>Math.round(rect.top))).size===1,footerLabels:footerButtons.map(button=>button.textContent.trim()),primaryLabels:footerButtons.filter(button=>button.classList.contains('primary')).map(button=>button.textContent.trim()),pairedFieldsAligned:Boolean(hostRect&&portRect&&usernameRect&&credentialRect&&Math.abs(hostRect.top-portRect.top)<1&&Math.abs(usernameRect.top-credentialRect.top)<1),footerButtonRects:footerButtons.map((button,index)=>({label:button.textContent.trim(),left:Math.round(buttonRects[index].left),right:Math.round(buttonRects[index].right),top:Math.round(buttonRects[index].top),bottom:Math.round(buttonRects[index].bottom)}))};
    })()`);
    if (screenshotState.footerButtonsOverlap || screenshotState.formHorizontalOverflow) console.error('Screenshot layout:',JSON.stringify(screenshotState));
    const {footerButtonRects,footerLabels,primaryLabels,pairedFieldsAligned,footerButtonsShareRow,...screenshotContract} = screenshotState;
    if (screenshotMode === 'editor') assert.deepEqual(screenshotContract,{mode:'editor',editorVisible:true,pluginType:'mysql',successfulChecks:3,pendingChecks:0,visibleFooterActions:3,formHorizontalOverflow:false,footerButtonsOverlap:false});
    if (['editor','edit-form','edit-form-medium','edit-form-compact'].includes(screenshotMode)) {
      const expectedPrimary = disconnectedEditScreenshot ? '保存并连接' : '保存并恢复 1 个连接';
      assert.deepEqual(footerLabels,['取消更改','保存但不连接',expectedPrimary]);
      assert.deepEqual(primaryLabels,[expectedPrimary]);
    }
    if (screenshotMode === 'edit-form') {
      assert.deepEqual(screenshotContract,{mode:'edit-form',editorVisible:true,pluginType:'mysql',successfulChecks:0,pendingChecks:0,visibleFooterActions:3,formHorizontalOverflow:false,footerButtonsOverlap:false});
      assert.equal(pairedFieldsAligned,true);
    }
    if (screenshotMode === 'edit-form-medium') {
      assert.deepEqual(screenshotContract,{mode:'edit-form-medium',editorVisible:true,pluginType:'mysql',successfulChecks:0,pendingChecks:0,visibleFooterActions:3,formHorizontalOverflow:false,footerButtonsOverlap:false});
      assert.equal(pairedFieldsAligned,true);
      assert.equal(footerButtonsShareRow,true);
    }
    if (screenshotMode === 'edit-form-compact') assert.deepEqual(screenshotContract,{mode:'edit-form-compact',editorVisible:true,pluginType:'mysql',successfulChecks:0,pendingChecks:0,visibleFooterActions:3,formHorizontalOverflow:false,footerButtonsOverlap:false});
    if (screenshotMode === 'add') assert.deepEqual(screenshotContract,{mode:'add',editorVisible:true,pluginType:'mysql',successfulChecks:0,pendingChecks:0,visibleFooterActions:2,formHorizontalOverflow:false,footerButtonsOverlap:false});
    if (screenshotMode === 'add-compact') assert.deepEqual(screenshotContract,{mode:'add-compact',editorVisible:true,pluginType:'mysql',successfulChecks:0,pendingChecks:0,visibleFooterActions:2,formHorizontalOverflow:false,footerButtonsOverlap:false});
    if (screenshotMode === 'quick-questions') {
      const quickQuestionLayout = await win.webContents.executeJavaScript("(()=>{const view=document.querySelector('#quickQuestionsView'),page=view?.querySelector('.quick-question-page'),copy=document.querySelector('#copyQuickQuestion');if(!view||!page||!copy||view.classList.contains('hidden'))return{fits:false,primaryVisible:false};const viewRect=view.getBoundingClientRect(),copyRect=copy.getBoundingClientRect();return{fits:view.scrollWidth<=view.clientWidth+1&&page.scrollWidth<=page.clientWidth+1,primaryVisible:copyRect.top>=viewRect.top-1&&copyRect.bottom<=viewRect.bottom+1};})()");
      assert.deepEqual(quickQuestionLayout,{fits:true,primaryVisible:true});
    }
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve,250));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath,image.toPNG());
    if (screenshotMode === 'quick-questions') {
      await win.webContents.executeJavaScript(`(async()=>{if(document.querySelector('[data-resource-plugin-id="server-app"]'))return;document.querySelector('.resource-environment-select[data-resource-environment-id="prod"]').click();const started=Date.now();while(!document.querySelector('[data-resource-plugin-id="server-app"]')){if(Date.now()-started>4000)throw new Error('timeout: restore resources after quick-questions screenshot');await new Promise(resolve=>setTimeout(resolve,20));}})()`);
    }
    if (screenshotMode === 'resources') {
      await win.webContents.executeJavaScript("document.querySelector('#expandDetailPane').click()");
      win.setContentSize(1280,900);
      await new Promise((resolve) => setTimeout(resolve,80));
    }
  }
  win.setContentSize(960,720);
  await new Promise((resolve) => setTimeout(resolve,80));
  const compactLayout = await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};const click=(selector)=>{const element=document.querySelector(selector);if(!element)throw new Error('missing compact click target: '+selector);element.click();};const app=document.querySelector('#app'),rail=document.querySelector('.project-rail'),resources=document.querySelector('#resourcePane'),detail=document.querySelector('#detailPane');if(!app.classList.contains('rail-expanded')){click('#toggleProjectRail');await new Promise(resolve=>setTimeout(resolve,340));}click('[data-resource-plugin-id="server-app"]');await wait(()=>document.querySelector('#pluginDetail')?.textContent.includes('应用服务器')&&document.querySelector('[data-detail-tab="permissions"]'),'compact plugin detail and tabs');click('[data-detail-tab="permissions"]');await wait(()=>Boolean(document.querySelector('#pluginDetail .permissions-page')),'compact permissions');await new Promise(resolve=>requestAnimationFrame(resolve));const permissionPage=document.querySelector('#pluginDetail .permissions-page'),detailContent=document.querySelector('#pluginDetail .detail-content');const connectedStyle=getComputedStyle(document.querySelector('.project-tree-item.active[data-project-state="connected"]>.project-tree-head')),disconnectedStyle=getComputedStyle(document.querySelector('.project-tree-item[data-tree-project="idle"]>.project-tree-head'));const railRect=rail.getBoundingClientRect(),resourceRect=resources.getBoundingClientRect(),detailRect=detail.getBoundingClientRect();return{expanded:app.classList.contains('rail-expanded'),railWidth:Math.round(railRect.width),resourceLeft:Math.round(resourceRect.left),detailWidth:Math.round(detailRect.width),overlaid:railRect.right>resourceRect.left,projectConnectionContrast:connectedStyle.backgroundImage!==disconnectedStyle.backgroundImage&&connectedStyle.boxShadow.includes('85, 214, 161')&&connectedStyle.boxShadow.includes('131, 124, 246'),projectLabelsFit:[...document.querySelectorAll('.rail-project-copy')].every(copy=>copy.scrollWidth<=copy.clientWidth+1),permissionFits:permissionPage.scrollWidth<=permissionPage.clientWidth&&detailContent.scrollWidth<=detailContent.clientWidth,permissionRows:permissionPage.querySelectorAll('.policy-row').length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};})()`);
  const compactScopeOverview = await win.webContents.executeJavaScript(`(async()=>{const wait=async(predicate,label)=>{const started=Date.now();while(!predicate()){if(Date.now()-started>4000)throw new Error('timeout: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};const click=(selector)=>document.querySelector(selector).click();const inspect=()=>{const page=document.querySelector('#scopeInfoContent .scope-overview-page'),head=page.querySelector('.scope-overview-head'),actions=page.querySelector('.scope-information-actions'),stats=[...page.querySelectorAll('.scope-overview-stat')],pageRect=page.getBoundingClientRect(),actionsRect=actions.getBoundingClientRect();return{buttons:[...actions.querySelectorAll(':scope>button')].map(button=>button.textContent.trim()),statRows:new Set(stats.map(stat=>Math.round(stat.getBoundingClientRect().top))).size,fits:page.scrollWidth<=page.clientWidth+1&&head.scrollWidth<=head.clientWidth+1&&actionsRect.left>=pageRect.left-1&&actionsRect.right<=pageRect.right+1};};click('.resource-environment-select[data-resource-environment-id="prod"]');await wait(()=>document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('环境概览'),'compact environment overview');await new Promise(resolve=>requestAnimationFrame(resolve));const environment={...inspect(),boundedOverview:document.querySelector('#scopeInfoView').scrollHeight<=document.querySelector('#scopeInfoView').clientHeight*1.65};click('[data-project-id="member"]');await wait(()=>document.querySelector('#scopeInfoContent .scope-information-kind')?.textContent.includes('项目概览'),'compact project overview');await new Promise(resolve=>requestAnimationFrame(resolve));return{environment,project:inspect()};})()`);
  assert.deepEqual(result.accessibility,{skipLinkFocus:true,projectValidation:true,keyboardProjectSort:true});
  assert.deepEqual(result.environmentTabs,['概览','运维说明','环境操作记录','快捷提问']);
  assert.deepEqual(result.quickQuestions,{minimalSurface:true,scopeNamed:true,openingInvalidBlocked:true,openingResetFromBackend:true,openingGlobalSaved:true,sensitiveSaveDisabled:true,conflictRetryReady:true,commonCrud:true,optionalDateOmitted:true,finalPreviewCorrect:true,tabFocusRestored:true,deleteConfirmation:true,fits:true,primaryVisible:true});
  assert.ok(quickQuestionCalls.openingGet.length>=1);
  assert.deepEqual(quickQuestionCalls.openingSave,[{text:'请使用 AI-Ops MCP 进行只读排查并给出证据。',expectedRevision:2}]);
  assert.deepEqual(Object.keys(quickQuestionCalls.openingSave[0]).sort(),['expectedRevision','text']);
  assert.deepEqual(quickQuestionCalls.list[0],{projectId:'member',environmentId:'prod'});
  assert.deepEqual(quickQuestionCalls.save,[
    {projectId:'member',environmentId:'prod',text:'排查支付回调是否积压',expectedRevision:3},
    {projectId:'member',environmentId:'prod',questionId:'quick-smoke-1',text:'排查支付回调积压并给出证据',expectedRevision:4},
    {projectId:'member',environmentId:'prod',questionId:'quick-smoke-1',text:'排查支付回调积压并给出证据',expectedRevision:5},
  ]);
  assert.equal(quickQuestionUpdateConflictInjected,true);
  assert.deepEqual(quickQuestionCalls.delete,[{projectId:'member',environmentId:'prod',questionId:'quick-smoke-1',expectedRevision:6}]);
  assert.equal(quickQuestionCalls.copy.length,1);
  assert.deepEqual(quickQuestionCalls.copy,[{projectId:'member',environmentId:'prod',text:'排查支付回调积压并给出证据',discoveredDate:'2026-08-24',expectedOpeningRevision:3}]);
  assert.deepEqual(result.projectTabs,['项目信息']);
  assert.deepEqual(result.pluginTabs,['插件详情','配置','Agent 权限','操作记录']);
  assert.equal(result.selectedHeaderContinuous,true);
  assert.equal(result.compactEnvironmentActions,true);
  assert.equal(result.environmentActionsWrapCleanly,true);
  assert.equal(result.environmentCardToggle,true);
  assert.ok(result.environmentHeaderHeight>=74&&result.environmentHeaderHeight<=80,'environment header should keep title, status, and action on one aligned row');
  assert.equal(result.railRefined,true);
  assert.deepEqual(result.projectConnectionContrast,{statesPresent:true,distinctBackground:true,greenStateBar:true,greenSummary:true,purpleSelection:true});
  assert.equal(result.secondPaneCommonOnly,true);
  assert.deepEqual(result.environmentOverviewActions,['修改名称','删除环境']);
  assert.deepEqual(result.environmentOverviewCompact,{summary:true,noMetricCards:true,noRecentActivity:true,noFold:true,usefulSections:true,metadataLabels:true,pluginRows:true,pluginOverflowCue:true,runbookVisible:true,managementActionsGrouped:true,boundedToPage:true});
  assert.equal(result.environmentManagementInInformation,true);
  assert.deepEqual(environmentUpdateCalls,[{projectId:'member',environmentId:'prod',patch:{name:'生产环境'},expectedRevision:1}]);
  assert.deepEqual(projectUpdateCalls,[{projectId:'member',patch:{name:'澳大利亚-zip · 新版'},expectedRevision:2}]);
  assert.equal(result.environmentCreatedInline,true);
  assert.deepEqual(result.permissionsRefined,{hero:true,summary:4,rows:8,fits:true});
  assert.deepEqual(result.pluginDetailHierarchy,{targetRemovedFromHeader:true,deleteRemovedFromHeader:true,flatConnectionFacts:true,editIsSecondary:true,connectIsPrimary:true,explicitPanelIcons:true});
  assert.equal(result.pluginInformationCopy,true);
  assert.deepEqual(result.pluginInformationActions,['修改名称','删除插件']);
  assert.equal(result.deletionPlacement,true);
  assert.equal(result.pluginDeleteFromInformation,true);
  assert.deepEqual(result.projectOverviewActions,['修改名称','删除项目']);
  assert.equal(result.projectManagementInInformation,true);
  assert.equal(result.projectDeleteFromInformation,true);
  assert.deepEqual(result.confirmationCenter,{globalEntry:true,cards:2,shellInitiallyBlocked:true,shellInlineStrongConfirmation:true,executionLinked:true,countAfterApproval:1});
  const expectedEditPrimary = disconnectedEditScreenshot ? '保存并连接' : '保存并恢复 1 个连接';
  const expectedEditSafetyCopy = disconnectedEditScreenshot ? '保存前不会更改当前运行状态' : '已暂停 1 个连接，保存后将自动恢复';
  assert.deepEqual(result.configurationInline,{readonlyBeforeEdit:true,renameOnlyMetadata:true,noDialog:true,title:true,namePreserved:true,typeCardsHidden:true,credentialUnchanged:true,draftControlsAbsent:true,footerLabels:['取消更改','保存但不连接',expectedEditPrimary],primaryFooterLabels:[expectedEditPrimary],safetyCopy:expectedEditSafetyCopy,pairedFieldsAligned:true,footerButtonsShareRow:true,footerButtonsOverlap:false});
  assert.equal(result.diagnosticInline,true);
  assert.equal(result.formDiagnostic,true);
  assert.equal(editValidationUsesSession,true);
  assert.equal(result.editCancelDiscarded,true);
  assert.equal(result.addPluginInline,true);
  assert.deepEqual(result.createActionModel,{typePickerCatalog:['server','mysql','redis'],createFooterLabels:['取消','检查并添加'],validationHidden:true,draftControlsAbsent:true,typeIdentityPlain:true,changeTypeButtonObvious:true,pairedFieldsAligned:true,flatSections:true,advancedSummary:true});
  assert.equal(result.addPluginOpensDetail,true);
  assert.equal(result.addCancelDiscarded,true);
  assert.equal(pluginCreateCalls.length,0);
  assert.equal(result.overflowSelectionVisible,true);
  assert.equal(result.resourceOverflowOwnedByList,true);
  assert.equal(result.auditFiltered,true);
  assert.equal(result.auditConnectionVisible,true);
  assert.equal(result.auditResponsive,true);
  assert.equal(result.auditPendingNamed,true);
  assert.equal(result.auditRenderingBounded,true);
  assert.equal(result.environmentHeaderControlsAligned,true);
  assert.equal(result.workspaceHeaderLinesAligned,true);
  assert.equal(result.workspaceTopBandsAligned,true);
  assert.equal(result.workspaceFootersAligned,true);
  assert.equal(result.expandedWorkspaceFootersAligned,true);
  assert.equal(result.expandedCreateActionCentered,true);
  assert.equal(result.inactiveEnvironmentActionsSecondary,true);
  assert.equal(result.auditMetaAligned,true);
  assert.equal(result.auditClearScoped,true);
  assert.equal(result.auditCleared,true);
  assert.equal(result.collapsed.active,true);
  assert.equal(result.collapsed.detailWidth,58);
  assert.equal(result.collapsed.buttonVisible,true);
  assert.equal(result.collapsed.focusTransferred,true);
  assert.equal(result.collapsed.focusReturned,true);
  assert.ok(result.collapsed.resourceWidth>result.initialRects[1].width,'the second pane should expand when the third pane collapses');
  assert.equal(result.expanded,true);
  assert.equal(result.separators,2);
  assert.equal(result.overflow,false);
  assert.equal(result.initialRects[0].right,result.initialRects[1].left);
  assert.equal(result.initialRects[1].right,result.initialRects[2].left);
  assert.deepEqual(compactLayout,{expanded:true,railWidth:260,resourceLeft:72,detailWidth:560,overlaid:true,projectConnectionContrast:true,projectLabelsFit:true,permissionFits:true,permissionRows:8,overflow:false});
  assert.deepEqual(compactScopeOverview,{environment:{buttons:['修改名称','删除环境'],statRows:0,fits:true,boundedOverview:true},project:{buttons:['修改名称','删除项目'],statRows:2,fits:true}});
  assert.deepEqual(errors,[]);
  win.destroy();
}

app.whenReady().then(run).then(() => { console.log('Three-pane UI smoke passed'); app.exit(0); }).catch((error) => { console.error(error); app.exit(1); });
