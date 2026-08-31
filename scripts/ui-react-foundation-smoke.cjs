const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {
  // The smoke owns its lifecycle and exits explicitly after all assertions.
});

const root = path.resolve(__dirname,'..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(),'runbook-bridge-react-production-'));
const pagePath = path.join(root,'renderer-build','v2','index.html');
const THEME_STORAGE_KEY = 'runbook-bridge:theme-preference:v1';
const screenshotDirectoryArgument = process.argv.find((value) => value.startsWith('--screenshot-dir='))
  ?.slice('--screenshot-dir='.length);
const commandLineScreenshotDirectory = app.commandLine.getSwitchValue('screenshot-dir') || null;
const screenshotRoot = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR || screenshotDirectoryArgument || commandLineScreenshotDirectory
  ? path.resolve(
      process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR
      ?? screenshotDirectoryArgument
      ?? commandLineScreenshotDirectory,
    )
  : null;
if (screenshotRoot) {
  const relativeScreenshotPath = path.relative(root,screenshotRoot);
  const screenshotInsideRepository = relativeScreenshotPath === ''
    || (!relativeScreenshotPath.startsWith(`..${path.sep}`)
      && relativeScreenshotPath !== '..'
      && !path.isAbsolute(relativeScreenshotPath));
  if (screenshotInsideRepository) {
    throw new Error('Screenshot evidence must be written outside the repository.');
  }
}
const requestedScreenshotTheme = ['light','dark'].includes(process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME)
  ? process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME
  : null;
const rendererErrors = [];
const rendererErrorSteps = [];
const rendererWindowErrors = [];
let currentSmokeStep = 'initial-load';
const externalRequests = [];
const readCalls = [];
const mutationCalls = [];
const registeredChannels = [];
const panelWidthEvidence = [];
const accessibilityFailures = [];
const accessibilityMediaEvidence = [];

app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));
if (requestedScreenshotTheme) nativeTheme.themeSource = requestedScreenshotTheme;

const ok = (data) => ({ok:true,data});

function assessment(kind,label,action = null) {
  return {phase:kind === 'connection-error' ? 'error' : kind,primaryStatus:{kind,label,action}};
}

const pluginsByEnvironment = {
  'env-production-east':[
    {
      projectId:'project-operations',environmentId:'env-production-east',pluginInstanceId:'plugin-app-server',
      pluginType:'server',displayName:'应用服务器（华东共享服务与跨区域资源拦截验证超长名称）',revision:7,
      configState:'ready',target:{host:'app-east.example.invalid',port:22,addressFamily:'ipv4Preferred'},
      auth:{username:'operator',type:'agent'},uplink:{type:'direct'},sources:[],limits:{maxBytes:262144},
      assessment:assessment('connected','已连接','disconnect'),
    },
    {
      projectId:'project-operations',environmentId:'env-production-east',pluginInstanceId:'plugin-orders-db',
      pluginType:'mysql',displayName:'订单数据库',revision:5,configState:'ready',
      target:{host:'db-east.example.invalid',port:3306,database:'orders',addressFamily:'ipv4Preferred'},
      auth:{username:'readonly'},transport:{kind:'serverTunnel',serverPluginInstanceId:'plugin-app-server'},
      tls:{mode:'verifyIdentity'},limits:{maxRows:100,timeoutMs:10000},
      assessment:assessment('connection-error','连接失败','retry'),
    },
    {
      projectId:'project-operations',environmentId:'env-production-east',pluginInstanceId:'plugin-shared-cache',
      pluginType:'redis',displayName:'共享缓存',revision:3,configState:'ready',
      target:{host:'cache-east.example.invalid',port:6379,db:0,addressFamily:'ipv4Preferred'},
      auth:{username:''},transport:{kind:'serverTunnel',serverPluginInstanceId:'plugin-app-server'},
      tls:{mode:'required'},limits:{maxKeys:100,timeoutMs:10000},
      assessment:assessment('dependency-blocked','依赖不可用','view-provider'),
    },
    {
      projectId:'project-operations',environmentId:'env-production-east',pluginInstanceId:'plugin-report-cache',
      pluginType:'redis',displayName:'报表缓存',revision:2,configState:'ready',
      target:{host:'report-cache.example.invalid',port:6379,db:2,addressFamily:'ipv4Preferred'},
      auth:{username:''},transport:{kind:'direct'},tls:{mode:'disabled'},assessment:{phase:'partial'},
    },
  ],
  'env-preview':[
    {
      projectId:'project-operations',environmentId:'env-preview',pluginInstanceId:'plugin-preview-server',
      pluginType:'server',displayName:'预发布应用服务器',revision:4,configState:'ready',
      target:{host:'preview.example.invalid',port:22,addressFamily:'ipv4Preferred'},
      auth:{username:'operator',type:'agent'},uplink:{type:'direct'},sources:[],
      assessment:assessment('preparing','正在准备连接'),
    },
  ],
  'env-drill':[
    {
      projectId:'project-operations',environmentId:'env-drill',pluginInstanceId:'plugin-drill-server',
      pluginType:'server',displayName:'灾备演练服务器',revision:2,configState:'ready',
      target:{host:'drill.example.invalid',port:22,addressFamily:'ipv4Preferred'},
      auth:{username:'operator',type:'agent'},uplink:{type:'direct'},sources:[],
      assessment:assessment('disconnected','未连接','connect'),
    },
  ],
};

function runtime(projectId,environmentId,phase,records,sequence = 10) {
  const plugins = Object.fromEntries(records.map((record) => [
    record.pluginInstanceId,
    {pluginInstanceId:record.pluginInstanceId,phase:record.assessment?.phase ?? 'disconnected',assessment:record.assessment},
  ]));
  const values = Object.values(plugins);
  return {
    projectId,environmentId,phase,sequence,desiredConnected:phase !== 'disconnected',
    eligibleCount:records.length,connectedCount:values.filter((item) => item.phase === 'connected').length,
    errorCount:values.filter((item) => item.phase === 'error').length,
    blockedCount:values.filter((item) => item.assessment?.primaryStatus?.kind === 'dependency-blocked').length,
    draftCount:0,plugins,pluginsPartial:false,
  };
}

function environment(environmentId,name,phase) {
  const records = pluginsByEnvironment[environmentId] ?? [];
  return {
    projectId:'project-operations',environmentId,name,revision:4,
    pluginCount:records.length,readyPluginCount:records.length,draftCount:0,
    resourcePreview:records.map((record) => ({
      projectId:record.projectId,environmentId:record.environmentId,
      pluginInstanceId:record.pluginInstanceId,pluginType:record.pluginType,
      displayName:record.displayName,revision:record.revision,configState:record.configState,
      assessment:record.assessment,
    })),
    resourcePreviewTruncated:false,
    runtime:runtime('project-operations',environmentId,phase,records),
  };
}

const operationEnvironments = [
  environment('env-production-east','生产环境 · 华东集群与共享服务','partial'),
  environment('env-preview','预发布环境','connecting'),
  environment('env-drill','灾备演练环境','disconnected'),
];
const workspaceProjects = [
  {
    schemaVersion:2,projectId:'project-operations',
    name:'海隅电商生产运维与跨区域灾备治理工作台（超长名称验证）',revision:9,
    environmentCount:operationEnvironments.length,
    pluginCount:operationEnvironments.reduce((total,item) => total + item.pluginCount,0),
    environments:operationEnvironments,
  },
  {schemaVersion:2,projectId:'project-data',name:'内部数据平台与批处理任务',revision:3,environmentCount:0,pluginCount:0,environments:[]},
  {
    schemaVersion:2,projectId:'project-isolated',name:'配置损坏的隔离项目',revision:1,
    environmentCount:0,pluginCount:0,environments:[],
    configurationError:{code:'PROJECT_CONFIG_INVALID',message:'项目配置无效。'},
  },
];

const confirmations = [
  {
    requestId:'confirmation-upload',projectId:'project-operations',environmentId:'env-production-east',
    pluginInstanceId:'plugin-app-server',capability:'fs.upload',capabilityLabel:'上传服务器文件',
    summary:'上传演示配置到临时目录',riskLevel:'write',approvalLevel:'standard',
    createdAt:new Date().toISOString(),expiresAt:Date.now()+600000,
    presentation:{kind:'file-transfer',target:'应用服务器',source:'fixture.txt',destination:'/tmp/fixture.txt',bytes:128,overwrite:false},
  },
  {
    requestId:'confirmation-shell',projectId:'project-operations',environmentId:'env-production-east',
    pluginInstanceId:'plugin-app-server',capability:'shell.execute',capabilityLabel:'执行任意 Shell',
    summary:'读取示例服务状态',riskLevel:'critical',approvalLevel:'strong',
    createdAt:new Date().toISOString(),expiresAt:Date.now()+600000,
    presentation:{kind:'shell',target:'应用服务器',command:'Get-Service -Name ExampleService',workingDirectory:'C:\\Temp'},
  },
  {
    requestId:'confirmation-other-scope',projectId:'project-data',environmentId:'environment-archive',
    pluginInstanceId:'plugin-other',capability:'fs.delete',capabilityLabel:'跨范围请求不得显示',
    summary:'另一个环境中的模拟请求',riskLevel:'destructive',approvalLevel:'standard',
    createdAt:new Date().toISOString(),expiresAt:Date.now()+600000,
  },
];

const auditPage = {
  entries:[
    {
      auditId:'audit-connected',type:'plugin-connected',result:'success',actor:'user',
      time:'2026-08-30T04:26:00.000Z',environmentId:'env-production-east',
      pluginInstanceId:'plugin-app-server',pluginNameSnapshot:'应用服务器',
      description:'应用服务器连接已建立。',
    },
    {
      auditId:'audit-policy',type:'policy-denied',result:'blocked',actor:'agent',
      time:'2026-08-30T04:18:00.000Z',environmentId:'env-production-east',
      pluginInstanceId:'plugin-orders-db',pluginNameSnapshot:'订单数据库',
      errorCode:'POLICY_DENIED',
    },
    {
      auditId:'audit-runbook',type:'runbook-updated',result:'success',actor:'user',
      time:'2026-08-29T10:12:00.000Z',environmentId:'env-production-east',
      description:'更新当前环境的运维说明。',
    },
  ],
  nextCursor:null,
};

function clone(value) {
  return structuredClone(value);
}

function registerRead(channel,handler) {
  registeredChannels.push(channel);
  ipcMain.handle(channel,async (_event,...args) => {
    readCalls.push({channel,args:clone(args)});
    return ok(clone(await handler(...args)));
  });
}

function registerForbiddenMutation(channel) {
  registeredChannels.push(channel);
  ipcMain.handle(channel,async () => {
    mutationCalls.push(channel);
    return {ok:false,error:{code:'SMOKE_READ_ONLY',message:'集成 smoke 禁止变更操作。'}};
  });
}

function registerMockApi() {
  registerRead('v2:project-list',() => workspaceProjects.map(({environments:_,...project}) => project));
  registerRead('v2:workspace-overview',() => workspaceProjects);
  registerRead('v2:environment-list',(projectId) => workspaceProjects.find((project) => project.projectId === projectId)?.environments ?? []);
  registerRead('v2:environment-status',({projectId,environmentId}) => {
    const environmentRecord = workspaceProjects.find((project) => project.projectId === projectId)
      ?.environments.find((candidate) => candidate.environmentId === environmentId);
    return environmentRecord?.runtime ?? runtime(projectId,environmentId,'disconnected',[],0);
  });
  registerRead('v2:plugin-list',({environmentId}) => pluginsByEnvironment[environmentId] ?? []);
  registerRead('v2:runbook-read',() => ({
    content:'# 模拟环境运维说明\n\n- 仅用于 Renderer 集成测试\n- 不包含真实地址、凭据或客户数据',
    hash:'0'.repeat(64),
  }));
  registerRead('v2:quick-question-opening-get',() => ({
    schemaVersion:1,
    text:'请使用 AI Ops MCP 对当前模拟环境进行只读排查。',
    defaultText:'请使用 AI Ops MCP 对当前模拟环境进行只读排查。',
    revision:1,
  }));
  registerRead('v2:quick-question-list',({projectId,environmentId}) => ({schemaVersion:1,projectId,environmentId,revision:1,items:[]}));
  registerRead('v2:plugin-assess',({projectId,environmentId,pluginInstanceId}) => (
    pluginsByEnvironment[environmentId]?.find((plugin) => plugin.projectId === projectId && plugin.pluginInstanceId === pluginInstanceId)?.assessment
      ?? assessment('disconnected','未连接','connect')
  ));
  registerRead('v2:plugin-credential-status',() => ({fields:{primary:false,proxy:false},legacyAvailable:false}));
  registerRead('v2:plugin-databases',() => []);
  registerRead('v2:audit-list',() => auditPage);
  registerRead('v2:confirmation-list',() => confirmations);

  [
    'v2:project-create','v2:project-update','v2:project-delete',
    'v2:quick-question-opening-save','v2:quick-question-save','v2:quick-question-delete','v2:quick-question-copy',
    'v2:environment-create','v2:environment-update','v2:environment-delete','v2:environment-reorder',
    'v2:connection-intent','v2:connection-challenge-confirm','v2:runbook-save',
    'v2:plugin-create','v2:plugin-update','v2:plugin-metadata-update','v2:plugin-agent-configuration-update',
    'v2:plugin-connection-update','v2:plugin-connection-edit-prepare','v2:plugin-connection-edit-begin',
    'v2:plugin-draft-validate','v2:plugin-validation-cancel','v2:plugin-probe','v2:plugin-probe-cancel',
    'v2:plugin-connection-edit-save','v2:plugin-connection-edit-cancel','v2:plugin-delete',
    'v2:plugin-credential-migration-confirm','v2:plugin-credential-reveal','v2:audit-clear',
    'v2:confirmation-approve','v2:confirmation-reject',
  ].forEach(registerForbiddenMutation);
}

function unregisterMockApi() {
  for (const channel of registeredChannels) ipcMain.removeHandler(channel);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve,ms));
}

async function captureRenderedFrame(win) {
  // Prime the hidden window's capture surface, then wait for a new renderer
  // frame. DOM visibility alone does not prove capturePage has a fresh frame.
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    true,
  );
  await wait(120);
  return win.webContents.capturePage();
}

async function waitFor(win,evaluate,label,timeoutMs = 10000) {
  currentSmokeStep = label;
  await win.webContents.executeJavaScript(`window.__foundationSmokeStep = ${JSON.stringify(label)}`,true);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(evaluate,true)) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function installWindowErrorDiagnostics(win) {
  await win.webContents.executeJavaScript(`(() => {
    if (window.__foundationWindowErrors) return;
    window.__foundationWindowErrors = [];
    window.addEventListener('error',(event) => {
      const identify = (element) => element instanceof HTMLElement ? {
        tag:element.tagName,role:element.getAttribute('role'),testId:element.dataset.testid ?? null,
        state:element.dataset.state ?? null,
        bounds:(() => { const rect = element.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height]; })(),
      } : null;
      window.__foundationWindowErrors.push({
        message:event.message,
        step:window.__foundationSmokeStep ?? 'initial-load',
        viewport:[window.innerWidth,window.innerHeight],
        active:identify(document.activeElement),
        modals:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(identify),
        shell:identify(document.querySelector('[data-testid="react-app-shell"]')),
      });
    });
  })()`,true);
}

async function collectWindowErrorDiagnostics(win) {
  rendererWindowErrors.push(...await win.webContents.executeJavaScript(
    `window.__foundationWindowErrors?.splice(0) ?? []`,true));
}

async function pressKey(win,keyCode,modifiers = []) {
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  await wait(100);
}

async function assertProjectDragSorting(win) {
  const originalProjects = [...workspaceProjects];
  const storageKey = 'ai-ops-project-order-v1';
  const operations = 'project-operations';
  const data = 'project-data';
  const isolated = 'project-isolated';
  const match = 'project-drag-search-match';
  const chromiumDebugger = win.webContents.debugger;
  const alreadyAttached = chromiumDebugger.isAttached();
  let interceptedDrag = null;
  let completed = false;
  let capturedPreview = false;
  const onDebuggerMessage = (_event,method,params) => {
    if (method === 'Input.dragIntercepted') interceptedDrag = params.data;
  };
  const readOrder = () => win.webContents.executeJavaScript(`(() => ({
    visible:[...document.querySelectorAll('[data-project-id]')].map((row) => row.dataset.projectId),
    saved:JSON.parse(localStorage.getItem('${storageKey}')),
    selected:document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId ?? null,
    selectionKind:document.querySelector('#detail-main')?.dataset.selectionKind,
  }))()`,true);
  const assertOrder = async (expected,label,{visible = expected,selected = operations} = {}) => {
    await waitFor(win,`JSON.stringify([...document.querySelectorAll('[data-project-id]')].map((row) => row.dataset.projectId)) === ${JSON.stringify(JSON.stringify(visible))}
      && localStorage.getItem('${storageKey}') === ${JSON.stringify(JSON.stringify(expected))}`,label);
    const snapshot = await readOrder();
    assert.deepEqual(snapshot.visible,visible,`${label}: visible order`);
    assert.deepEqual(snapshot.saved,expected,`${label}: saved full order`);
    assert.equal(snapshot.selected,selected,`${label}: dragging must preserve project selection`);
  };
  const refreshProjects = async (count) => {
    win.webContents.send('v2:workspace-changed',{});
    await waitFor(win,`document.querySelectorAll('[data-project-id]').length === ${count}`,
      `drag fixture workspace contains ${count} projects`);
    await captureRenderedFrame(win);
  };
  const projectPoint = (projectId,position = 'middle') => win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-project-id="' + ${JSON.stringify(projectId)} + '"]');
    if (!button) return null;
    button.scrollIntoView({block:'nearest'});
    const row = button.closest('[data-project-drop-id]');
    const rect = (${JSON.stringify(position)} === 'middle' ? button : row)?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {x:Math.round(rect.left + rect.width * 0.4),
      y:Math.round(rect.top + rect.height * (${JSON.stringify(position)} === 'before' ? 0.2 : ${JSON.stringify(position)} === 'after' ? 0.8 : 0.5))};
  })()`,true);
  const beginDrag = async (sourceId) => {
    const point = await projectPoint(sourceId);
    assert.ok(point,`drag source ${sourceId} is visible`);
    interceptedDrag = null;
    await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
    for (const delta of [8,18,30]) {
      await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{
        type:'mouseMoved',button:'left',buttons:1,x:point.x+delta,y:point.y,
      });
      if (interceptedDrag) break;
    }
    const deadline = Date.now() + 3000;
    while (!interceptedDrag && Date.now() < deadline) await wait(20);
    assert.ok(interceptedDrag,`Chromium must start a native HTML5 drag for ${sourceId}`);
    await waitFor(win,`document.querySelector('[data-project-drop-id="${sourceId}"]')?.dataset.projectDragging === 'true'`,
      `${sourceId} has native drag feedback`);
    return interceptedDrag;
  };
  const dragProject = async (sourceId,targetId,position,{cancel = false,preview = true} = {}) => {
    const dragData = await beginDrag(sourceId);
    const target = await projectPoint(targetId,position);
    assert.ok(target,`drag target ${targetId} is visible`);
    for (const type of ['dragEnter','dragOver']) {
      await chromiumDebugger.sendCommand('Input.dispatchDragEvent',{type,...target,data:dragData});
    }
    if (preview) {
      await waitFor(win,`document.querySelector('[data-project-drop-id="${targetId}"]')?.dataset.projectDropTarget === '${position}'
        && document.querySelector('[data-project-drop-id="${targetId}"] [data-project-drop-indicator]')?.dataset.position === '${position}'`,
      `native drag previews ${position} ${targetId}`);
    } else {
      assert.equal(await win.webContents.executeJavaScript(
        `document.querySelector('[data-project-drop-indicator]') === null`,true),true,
      'an invalid drag target must not show a drop indicator');
    }
    if (preview && screenshotRoot && !capturedPreview) {
      fs.mkdirSync(screenshotRoot,{recursive:true});
      fs.writeFileSync(path.join(screenshotRoot,'project-drag-before-preview.png'),(await captureRenderedFrame(win)).toPNG());
      capturedPreview = true;
    }
    await chromiumDebugger.sendCommand('Input.dispatchDragEvent',{
      type:cancel ? 'dragCancel' : 'drop',...target,data:dragData,
    });
    await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{
      type:'mouseReleased',button:'left',buttons:0,clickCount:1,...target,
    });
    await waitFor(win,`document.querySelector('[data-project-dragging="true"], [data-project-drop-indicator]') === null`,
      `${cancel ? 'cancelled' : 'completed'} native drag clears feedback`);
  };
  const setSearch = async (value) => {
    await clickThemeControl(win,'project-search');
    await pressKey(win,'a',['control']);
    if (value) await win.webContents.insertText(value);
    else await pressKey(win,'BACKSPACE');
    await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === ${JSON.stringify(value)}`,
      'native search input for project dragging');
  };
  try {
    workspaceProjects.push({schemaVersion:2,projectId:match,name:'海隅拖动排序验证',revision:1,
      environmentCount:0,pluginCount:0,environments:[]});
    await refreshProjects(4);
    const initialSelectionKind = (await readOrder()).selectionKind;
    assert.deepEqual(await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-project-id]')].map((button) => [button.dataset.projectId,button.draggable])`,true),
    [[operations,true],[data,true],[isolated,false],[match,true]],'only ordinary projects are draggable');
    await win.webContents.executeJavaScript(`(() => {
      window.__projectDragEvents = [];
      for (const type of ['dragstart','drop','dragend','click']) document.addEventListener(type,(event) => {
        window.__projectDragEvents.push({type:event.type,trusted:event.isTrusted,project:event.target.closest?.('[data-project-id]')?.dataset.projectId ?? null});
      },true);
    })()`,true);
    if (!alreadyAttached) chromiumDebugger.attach('1.3');
    chromiumDebugger.on('message',onDebuggerMessage);
    // Interception keeps the gesture inside Chromium instead of starting an OS
    // drag loop; dragstart still originates from genuine browser mouse input.
    await chromiumDebugger.sendCommand('Input.setInterceptDrags',{enabled:true});

    await dragProject(match,operations,'before');
    await assertOrder([match,operations,data,isolated],'native drag moves a project before another');
    await dragProject(operations,data,'after');
    await assertOrder([match,data,operations,isolated],'native drag moves a project after another');
    assert.equal((await readOrder()).selectionKind,initialSelectionKind,'dragging must preserve the selected detail scope');
    assert.match(await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="project-order-announcement"]')?.textContent ?? ''`,true),/已移至/u);

    await setSearch('海隅');
    await waitFor(win,`document.querySelectorAll('[data-project-id]').length === 2`,'filtered drag list hides unrelated projects');
    await dragProject(operations,match,'before');
    const persistedOrder = [operations,match,data,isolated];
    await assertOrder(persistedOrder,'filtered drag updates the full project order',{visible:[operations,match]});
    await setSearch('');
    await assertOrder(persistedOrder,'clearing search retains hidden projects and their relative order');

    await dragProject(operations,data,'after',{cancel:true});
    await assertOrder(persistedOrder,'cancelling a native drag retains the saved order');
    await dragProject(operations,match,'before');
    await assertOrder(persistedOrder,'dropping at the current position is a no-op');
    await dragProject(operations,isolated,'before',{preview:false});
    await assertOrder(persistedOrder,'dropping on an isolated project is ignored');

    const externalTarget = await projectPoint(match,'after');
    const externalData = {items:[{mimeType:'text/plain',data:operations}],dragOperationsMask:1};
    for (const type of ['dragEnter','dragOver','drop']) {
      await chromiumDebugger.sendCommand('Input.dispatchDragEvent',{type,...externalTarget,data:externalData});
    }
    await assertOrder(persistedOrder,'external text cannot reorder projects');
    assert.equal(await win.webContents.executeJavaScript(
      `document.querySelector('[data-project-drop-indicator]') === null`,true),true);

    await win.webContents.executeJavaScript(`(() => {
      window.__projectOrderSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) {
        if (key === '${storageKey}') throw new DOMException('Simulated storage limit','QuotaExceededError');
        return window.__projectOrderSetItem.call(this,key,value);
      };
    })()`,true);
    try {
      await dragProject(operations,data,'after');
      await assertOrder(persistedOrder,'failed persistence restores the prior project order');
      await waitFor(win,`[...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.textContent.includes('项目顺序保存失败'))`,
        'failed drag persistence displays a visible error toast');

      assert.match(await win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="project-order-announcement"]')?.textContent ?? ''`,true),/保存失败/u);
    } finally {
      await win.webContents.executeJavaScript(`Storage.prototype.setItem = window.__projectOrderSetItem; delete window.__projectOrderSetItem`,true);
    }
    const extraProjects = Array.from({length:12},(_,index) => ({
      schemaVersion:2,projectId:`project-drag-scroll-${index+1}`,name:`拖动滚动验证 ${index+1}`,revision:1,
      environmentCount:0,pluginCount:0,environments:[],
    }));
    workspaceProjects.push(...extraProjects);
    await refreshProjects(16);
    const longOrder = [...persistedOrder,...extraProjects.map((project) => project.projectId)];
    const viewportSelector = '[data-testid="project-list-scroll"] [data-slot="scroll-area-viewport"]';
    for (const direction of ['down','up']) {
      const sourceId = direction === 'down' ? operations : extraProjects.at(-1).projectId;
      const dragEndsBefore = await win.webContents.executeJavaScript(`window.__projectDragEvents.filter((event) => event.type === 'dragend').length`,true);
      const dragData = await beginDrag(sourceId);
      const edge = await win.webContents.executeJavaScript(`(() => {
        const viewport = document.querySelector('${viewportSelector}');
        const rect = viewport.getBoundingClientRect();
        return {x:Math.round(rect.left+rect.width*0.4),
          y:Math.round(${JSON.stringify(direction)} === 'down' ? rect.bottom-8 : rect.top+8),
          scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight};
      })()`,true);
      assert.ok(edge.scrollHeight > edge.clientHeight+100,'long drag fixture overflows the project viewport');
      for (const type of ['dragEnter','dragOver']) {
        await chromiumDebugger.sendCommand('Input.dispatchDragEvent',{type,x:edge.x,y:edge.y,data:dragData});
      }
      await waitFor(win,`document.querySelector('${viewportSelector}').scrollTop ${direction === 'down' ? '>' : '<'} ${edge.scrollTop + (direction === 'down' ? 40 : -40)}`,
        `a native drag automatically scrolls the long project list ${direction}`);
      if (direction === 'down') await pressKey(win,'ESCAPE');
      await chromiumDebugger.sendCommand('Input.dispatchDragEvent',{type:'dragCancel',x:edge.x,y:edge.y,data:dragData});
      await chromiumDebugger.sendCommand('Input.cancelDragging');
      await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{
        type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:edge.x,y:edge.y,
      });
      await waitFor(win,`document.querySelector('[data-project-dragging="true"], [data-project-drop-indicator]') === null`,
        'aborting an edge drag clears the preview and dragged state');
      // Hidden-window capture can keep Chromium's intercepted native edge scroll
      // moving after dragCancel, even after dragend. Verify the application abort
      // contract without using capturePage as a zero-motion assertion.
      await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,x:8,y:8});
      await waitFor(win,`window.__projectDragEvents.filter((event) => event.type === 'dragend' && event.trusted).length > ${dragEndsBefore}`,
        'aborting an edge drag delivers trusted native dragend');
      await assertOrder(longOrder,'aborting an edge drag keeps every project in its saved position');
    }
    workspaceProjects.splice(4);
    await refreshProjects(4);
    await assertOrder(persistedOrder,'removing temporary scroll fixtures preserves the dragged order');

    const nativeEvents = await win.webContents.executeJavaScript(`window.__projectDragEvents`,true);
    assert.ok(nativeEvents.some((event) => event.type === 'dragstart' && event.trusted),
      'project sorting coverage must include trusted browser dragstart events');
    assert.ok(nativeEvents.some((event) => event.type === 'drop' && event.trusted),
      'project sorting coverage must include trusted browser drop events');

    await collectWindowErrorDiagnostics(win);
    win.reload();
    await waitFor(win,`document.querySelector('[data-shell-ready="true"]') !== null
      && document.querySelectorAll('[data-project-id]').length === 4`,
    'drag order reload waits for the asynchronous workspace read');
    await installWindowErrorDiagnostics(win);
    await assertOrder(persistedOrder,'dragged project order survives Renderer reload');
    completed = true;
    process.stdout.write('Project drag sorting evidence: trusted browser before/after drops, filtered full-order preservation, cancellation, no-op, isolated/external rejection, storage failure, long-list edge scrolling/abort and reload persistence passed\n');
  } finally {
    if (chromiumDebugger.isAttached()) {
      await chromiumDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,x:8,y:8}).catch(() => {});
      await chromiumDebugger.sendCommand('Input.setInterceptDrags',{enabled:false}).catch(() => {});
      chromiumDebugger.removeListener('message',onDebuggerMessage);
      if (!alreadyAttached) chromiumDebugger.detach();
    }
    workspaceProjects.splice(0,workspaceProjects.length,...originalProjects);
    await refreshProjects(originalProjects.length);
    if (completed) await assertOrder(originalProjects.map((project) => project.projectId),'restore project fixture after drag sorting');
  }
}

async function assertKeyboardResizerPersistence(win,{testId,keyCode,panelId}) {
  const selector = `[data-testid="${testId}"]`;
  const readSnapshot = () => win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return null;
    return {
      focused:document.activeElement === target,
      nativeFocus:document.hasFocus(),
      visible:target.getClientRects().length > 0,
      role:target.getAttribute('role'),
      controls:target.getAttribute('aria-controls'),
      value:Number(target.getAttribute('aria-valuenow')),
      min:Number(target.getAttribute('aria-valuemin')),
      max:Number(target.getAttribute('aria-valuemax')),
      savedLayout:window.localStorage.getItem('runbook-bridge:app-shell-layout:v1'),
    };
  })()`,true);
  await captureRenderedFrame(win);
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.focus()`,true);
  await waitFor(win,
    `document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
    `${testId} native keyboard focus`);
  const before = await readSnapshot();
  assert.ok(before,`${testId} is missing`);
  assert.equal(before.visible,true,`${testId} must be visible`);
  assert.equal(before.role,'separator',`${testId} must expose separator semantics`);
  assert.equal(before.controls,panelId,`${testId} must control its exact panel`);
  assert.ok([before.value,before.min,before.max].every(Number.isFinite),`${testId} must expose finite ARIA values`);
  assert.ok(keyCode === 'RIGHT' ? before.value < before.max : before.value > before.min,
    `${testId} has no room for ${keyCode}: ${JSON.stringify(before)}`);
  await pressKey(win,keyCode);
  try {
    await waitFor(win,`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const saved = window.localStorage.getItem('runbook-bridge:app-shell-layout:v1');
      const value = Number(target?.getAttribute('aria-valuenow'));
      return document.hasFocus() && document.activeElement === target
        && Number.isFinite(value) && value !== ${before.value}
        && saved !== null && saved !== ${JSON.stringify(before.savedLayout)}
        && JSON.parse(saved).layout[${JSON.stringify(panelId)}] === value;
    })()`,`${testId} ${keyCode} updates ARIA value and persisted layout`);
  } catch (error) {
    throw new Error(`${error.message}\nResizer evidence: ${JSON.stringify({testId,keyCode,before,after:await readSnapshot()})}`);
  }
  const after = await readSnapshot();
  assert.equal(after.focused,true,`${testId} must retain focus after resizing`);
  assert.equal(after.nativeFocus,true);
  assert.ok(keyCode === 'RIGHT' ? after.value > before.value : after.value < before.value,
    `${testId} moved in the wrong direction: ${JSON.stringify({before,after})}`);
  assert.notEqual(after.savedLayout,before.savedLayout,`${testId} must persist its own keyboard change`);
  process.stdout.write(`Resizer keyboard evidence: ${JSON.stringify({testId,keyCode,before,after})}\n`);
  return after.savedLayout;
}

async function assertRendererKeyboardFocus(win) {
  win.webContents.focus();
  await wait(100);
  const focus = await win.webContents.executeJavaScript(`(() => {
    const previous = document.activeElement;
    const candidates = [
      document.querySelector('[data-testid="add-project-footer"]'),
      document.querySelector('[data-project-id="project-operations"]'),
    ];
    const target = candidates.find((element) => element instanceof HTMLElement && element !== previous);
    if (!(target instanceof HTMLElement)) throw new Error('keyboard focus probe target missing');
    let focusInCount = 0;
    let trustedFocusInCount = 0;
    const listener = (event) => {
      if (event.target !== target) return;
      focusInCount += 1;
      if (event.isTrusted) trustedFocusInCount += 1;
    };
    document.addEventListener('focusin',listener,true);
    target.focus({preventScroll:true});
    const snapshot = {
      documentHasFocus:document.hasFocus(),
      targetActive:document.activeElement === target,
      focusInCount,
      trustedFocusInCount,
      visibility:document.visibilityState,
    };
    document.removeEventListener('focusin',listener,true);
    if (previous instanceof HTMLElement && previous !== document.body) previous.focus({preventScroll:true});
    return snapshot;
  })()`,true);
  const evidence = {...focus,windowFocused:win.isFocused(),webContentsFocused:win.webContents.isFocused(),windowVisible:win.isVisible()};
  process.stdout.write(`Renderer keyboard focus evidence: ${JSON.stringify(evidence)}\n`);
  assert.equal(focus.documentHasFocus,true,`hidden renderer cannot provide real keyboard focus: ${JSON.stringify(evidence)}`);
  assert.equal(focus.targetActive,true,`native focus probe did not focus the target: ${JSON.stringify(evidence)}`);
  assert.ok(focus.focusInCount > 0,`native focusin was not dispatched: ${JSON.stringify(evidence)}`);
  assert.ok(focus.trustedFocusInCount > 0,`trusted focusin was not dispatched: ${JSON.stringify(evidence)}`);
}

async function setTheme(win,theme) {
  nativeTheme.themeSource = theme;
  await waitFor(
    win,
    `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
    `${theme} theme`,
  );
  await wait(80);
}

async function clickThemeControl(win,testId) {
  win.webContents.focus();
  // Floating UI can expose a focused menu before its first positioned frame.
  // Native input must use the painted target, never the initial offscreen rect.
  await captureRenderedFrame(win);
  await waitFor(win,`(() => {
    const target = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.left < 0
      || rect.bottom > innerHeight+1 || rect.right > innerWidth+1) return false;
    const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return Boolean(hit && target.contains(hit));
  })()`,`${testId} finishes positioning before native input`);
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return null;
    const rect = target.getBoundingClientRect();
    const point = {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
    const hit = document.elementFromPoint(point.x,point.y);
    window.__themeLastPointer = {testId:${JSON.stringify(testId)},point,
      hitTestId:hit?.closest('[data-testid]')?.getAttribute('data-testid'),insideTarget:Boolean(hit && target.contains(hit)),
      rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}};
    return point;
  })()`,true);
  assert.ok(point,`${testId} must be visible`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await wait(80);
}

async function openThemeMenu(win) {
  await clickThemeControl(win,'theme-menu-trigger');
  await waitFor(win,`document.querySelector('[data-testid="theme-menu"][data-state="open"]')?.contains(document.activeElement) === true`,
    'theme menu receives native focus');
  const options = await win.webContents.executeJavaScript(`(() => {
    const preference = document.documentElement.dataset.themePreference;
    return ['light','dark','system'].map((value) => {
      const option = document.querySelector('[data-testid="theme-option-' + value + '"]');
      return {value,role:option?.getAttribute('role'),checked:option?.getAttribute('aria-checked'),expected:value === preference};
    });
  })()`,true);
  assert.ok(options.every((option) => option.role === 'menuitemradio' && option.checked === String(option.expected)),
    'theme menu exposes exactly the current preference as checked');
}

async function assertThemeMenuClosed(win,label) {
  try {
    await waitFor(win,`document.querySelector('[data-testid="theme-menu"]') === null
      && document.activeElement === document.querySelector('[data-testid="theme-menu-trigger"]')`,
    `${label}: theme menu closes and restores its trigger focus`);
  } catch (error) {
    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('[data-testid="theme-menu"]');
      const trigger = document.querySelector('[data-testid="theme-menu-trigger"]');
      const active = document.activeElement;
      return {menuPresent:Boolean(menu),menuState:menu?.getAttribute('data-state'),triggerConnected:trigger?.isConnected,
        triggerExpanded:trigger?.getAttribute('aria-expanded'),triggerFocused:active === trigger,hasFocus:document.hasFocus(),
        active:{tag:active?.tagName,id:active?.id,testId:active?.getAttribute('data-testid'),role:active?.getAttribute('role')},
        preference:document.documentElement.dataset.themePreference,theme:document.documentElement.dataset.theme,
        stored:localStorage.getItem('${THEME_STORAGE_KEY}'),pointer:window.__themeLastPointer,
        bodyPointerEvents:getComputedStyle(document.body).pointerEvents};
    })()`,true);
    throw new Error(`${error.message}\nTheme menu failure evidence: ${JSON.stringify(snapshot)}`);
  }
}

async function selectThemePreference(win,preference) {
  await openThemeMenu(win);
  await clickThemeControl(win,`theme-option-${preference}`);
  await assertThemeMenuClosed(win,preference);
}

async function assertThemeState(win,preference,actual,label,{persisted = true,toast = true} = {}) {
  // This existing read-only action emits a real Sonner toast with no IPC while
  // the initial/reloaded workspace has no selected environment.
  if (toast) await clickThemeControl(win,'confirmation-center');
  await waitFor(win,`(() => {
    const root = document.documentElement;
    const toasters = [...document.querySelectorAll('[data-sonner-toaster]')];
    return root.dataset.themePreference === ${JSON.stringify(preference)}
      && root.dataset.theme === ${JSON.stringify(actual)}
      && (${persisted} === false || localStorage.getItem('${THEME_STORAGE_KEY}') === ${JSON.stringify(preference)})
      && (!${toast} || (toasters.length > 0 && toasters.every((toaster) => toaster.dataset.sonnerTheme === ${JSON.stringify(actual)})));
  })()`,`${label}: preference, effective theme, persistence and visible Toaster agree`);
}

async function assertThemeControlGeometry(win,{compact = false} = {}) {
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('[data-testid="project-rail"]');
    const trigger = document.querySelector('[data-testid="theme-menu-trigger"]');
    const footer = document.querySelector('[data-testid="add-project-footer"]');
    const rect = trigger?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return {width:railRect?.width,visible:Boolean(rect && rect.width > 0 && rect.height > 0
      && rect.left >= railRect.left && rect.right <= railRect.right+1 && rect.top >= 0 && rect.bottom <= innerHeight
      && hit && trigger.contains(hit) && !trigger.closest('[inert],[aria-hidden="true"]')),
      aboveFooter:Boolean(rect && footer && rect.bottom <= footer.getBoundingClientRect().top+1),
      noOverflow:Boolean(rail && rail.scrollWidth <= rail.clientWidth+1
        && document.documentElement.scrollWidth <= document.documentElement.clientWidth+1)};
  })()`,true);
  assert.equal(snapshot.visible,true,'theme control remains visible and reachable in the project rail');
  assert.equal(snapshot.aboveFooter,true,'theme has its own row above the existing project footer');
  assert.equal(snapshot.noOverflow,true,'theme control does not introduce horizontal overflow');
  if (compact) assert.ok(Math.abs(snapshot.width-128) <= 1,'theme entry is usable in the real 128px rail');
}

async function assertManualThemePreferences(win) {
  const originalSystemTheme = nativeTheme.themeSource;
  const readCount = readCalls.length;
  const mutationCount = mutationCalls.length;
  await assertThemeControlGeometry(win);
  await clickThemeControl(win,'project-search');
  await win.webContents.insertText('海隅');
  await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === '海隅'`,'unsaved search input before theme changes');
  await win.webContents.executeJavaScript(`window.__themeWorkspaceProbe = {
    search:document.querySelector('[data-testid="project-search"]'),
    detail:document.getElementById('detail-main'),
    selected:document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId,
    tab:document.querySelector('[data-detail-tab][aria-selected="true"]')?.dataset.detailTab,
  }`,true);
  nativeTheme.themeSource = 'light';
  await assertThemeState(win,'system','light','default follows system',{persisted:false});
  await selectThemePreference(win,'dark');
  await assertThemeState(win,'dark','dark','manual dark on a light system');
  nativeTheme.themeSource = 'dark';
  await assertThemeState(win,'dark','dark','manual dark survives system changes');
  await selectThemePreference(win,'light');
  await assertThemeState(win,'light','light','manual light on a dark system');
  nativeTheme.themeSource = 'light';
  await assertThemeState(win,'light','light','manual light remains explicit');
  nativeTheme.themeSource = 'dark';
  await assertThemeState(win,'light','light','system changes cannot override manual light');
  await selectThemePreference(win,'system');
  await assertThemeState(win,'system','dark','switch back to system');
  nativeTheme.themeSource = 'light';
  await assertThemeState(win,'system','light','system preference reacts live');

  await openThemeMenu(win);
  await pressKey(win,'ESCAPE');
  await assertThemeMenuClosed(win,'Escape');
  assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem('${THEME_STORAGE_KEY}')`,true),'system',
    'dismissing the theme menu does not change the preference');
  await pressKey(win,'ENTER');
  await waitFor(win,`document.querySelector('[data-testid="theme-menu"]')?.contains(document.activeElement) === true`,'keyboard opens theme menu');
  await pressKey(win,'HOME');
  await waitFor(win,`document.activeElement?.dataset.testid === 'theme-option-light'`,'Home focuses the light preference');
  await pressKey(win,'DOWN');
  await waitFor(win,`document.activeElement?.dataset.testid === 'theme-option-dark'`,'ArrowDown moves between theme options');
  await pressKey(win,'ENTER');
  await assertThemeMenuClosed(win,'keyboard selection');
  await assertThemeState(win,'dark','dark','keyboard selects manual dark');
  await selectThemePreference(win,'system');
  nativeTheme.themeSource = originalSystemTheme;
  await assertThemeState(win,'system',nativeTheme.shouldUseDarkColors ? 'dark' : 'light','restore system preference');
  const preserved = await win.webContents.executeJavaScript(`(() => {
    const before = window.__themeWorkspaceProbe;
    const search = document.querySelector('[data-testid="project-search"]');
    return {sameSearch:search === before.search,value:search?.value,sameDetail:document.getElementById('detail-main') === before.detail,
      sameSelection:document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId === before.selected,
      sameTab:document.querySelector('[data-detail-tab][aria-selected="true"]')?.dataset.detailTab === before.tab};
  })()`,true);
  assert.deepEqual(preserved,{sameSearch:true,value:'海隅',sameDetail:true,sameSelection:true,sameTab:true},
    'theme changes preserve the live unsaved search input, selected scope and detail tab without remounting the workspace');
  await clickThemeControl(win,'project-search');
  await pressKey(win,'a',['control']);
  await pressKey(win,'BACKSPACE');
  await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === ''`,'clear the theme regression search through native input');
  await win.webContents.executeJavaScript('delete window.__themeWorkspaceProbe',true);
  await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'theme evidence toasts dismiss before existing geometry assertions');
  assert.equal(readCalls.length,readCount,'theme controls perform no read IPC');
  assert.equal(mutationCalls.length,mutationCount,'theme controls perform no mutation IPC');
  process.stdout.write('Theme preference evidence: light, dark, live system changes, native menu keyboard/focus, matching Toaster, no IPC\n');
}

async function assertEnvironmentAccordionNavigation(win) {
  const trigger = (id) => `[data-testid="environment-trigger-${id}"]`;
  const nativeClick = async (selector) => {
    const point = await win.webContents.executeJavaScript(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) throw new Error('native click target missing: ' + ${JSON.stringify(selector)});
      target.scrollIntoView({block:'nearest'});
      const rect = target.getBoundingClientRect();
      return {x:Math.round(rect.left + Math.min(48,rect.width/2)),y:Math.round(rect.top + rect.height/2)};
    })()`,true);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await captureRenderedFrame(win);
  };
  const waitExpanded = async (id,expanded,label) => {
    try {
      await waitFor(win,`(() => {
        const row = document.querySelector('[data-testid="environment-row-${id}"]');
        const button = row?.querySelector('[data-testid="environment-trigger-${id}"]');
        const content = row?.querySelector('[data-slot="accordion-content"]');
        return button?.getAttribute('aria-expanded') === '${expanded}' && row.dataset.expanded === '${expanded}'
          && (${expanded} ? Boolean(content && content.getBoundingClientRect().height > 1) : !content || content.getBoundingClientRect().height <= 1);
      })()`,label);
    } catch (error) {
      const evidence = await win.webContents.executeJavaScript(`(() => ({
        trigger:document.querySelector(${JSON.stringify(trigger(id))})?.outerHTML,
        selectedKind:document.querySelector('#detail-main')?.dataset.selectionKind,
        rows:Array.from(document.querySelectorAll('[data-testid^="environment-row-"]')).map((row) => ({id:row.dataset.environmentId,expanded:row.dataset.expanded})),
      }))()`,true);
      throw new Error(`${error.message}\nEnvironment accordion evidence: ${JSON.stringify(evidence)}`);
    }
  };
  const selectedKind = () => win.webContents.executeJavaScript(`document.querySelector('#detail-main')?.dataset.selectionKind`,true);
  const waitEnvironmentDetails = async (id,tab,label) => {
    await waitFor(win,`document.querySelector('#detail-main')?.dataset.selectionKind === 'environment'
      && document.querySelector(${JSON.stringify(trigger(id))})?.getAttribute('aria-current') === 'page'
      && document.querySelector('[data-testid^="plugin-trigger-"][aria-current="page"]') === null
      && document.querySelector('[data-detail-tab="${tab}"]')?.getAttribute('aria-selected') === 'true'
      && (${tab === 'overview'} ? document.querySelector('[data-testid="environment-overview"]')?.getClientRects().length > 0 : true)`,label);
  };
  const nativeButtonKey = async (key) => {
    win.webContents.sendInputEvent({type:'keyDown',keyCode:key});
    if (key === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:key});
    await captureRenderedFrame(win);
  };
  const commandSelect = async (valuePrefix,query) => {
    await win.webContents.executeJavaScript(`document.querySelector('#detail-main')?.focus({preventScroll:true})`,true);
    await pressKey(win,'k',['control']);
    await waitFor(win,`document.querySelector('[data-testid="global-command"] [cmdk-input]') === document.activeElement`,
      'command input receives focus for external navigation');
    await win.webContents.insertText(query);
    const selector = `[data-testid="global-command"] [cmdk-item][data-value^="${valuePrefix} "]`;
    await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`,
      `command result ${valuePrefix}`);
    await nativeClick(selector);
    await waitFor(win,`document.querySelector('[data-testid="global-command"]') === null`,
      'command closes before applying external navigation');
    await captureRenderedFrame(win);
  };
  const prod = 'env-production-east';
  await waitExpanded(prod,true,'initial environment starts expanded');
  await nativeClick(trigger(prod));
  await waitEnvironmentDetails(prod,'overview','clicking an already expanded unselected environment opens its details');
  await waitExpanded(prod,true,'new environment navigation reveals its destination after native activation');
  await selectVisualTab(win,'runbook','[data-feature="runbook"]','environment runbook before repeated heading activation');
  for (const expanded of [false,true]) {
    await nativeClick(trigger(prod));
    await waitExpanded(prod,expanded,`repeated selected environment mouse toggle ${expanded}`);
    await waitEnvironmentDetails(prod,'runbook','mouse toggling the selected environment preserves its active detail tab');
  }
  for (const key of ['Enter','Space']) {
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(trigger(prod))})?.focus({preventScroll:true})`,true);
    for (const expanded of [false,true]) {
      await nativeButtonKey(key);
      await waitExpanded(prod,expanded,`native ${key} toggles selected environment ${expanded}`);
      await waitEnvironmentDetails(prod,'runbook',`${key} toggling the selected environment preserves its active detail tab`);
    }
  }
  for (const activation of ['Mouse','Enter','Space']) {
    await nativeClick('[data-testid="plugin-trigger-plugin-app-server"]');
    await waitFor(win,`document.querySelector('#detail-main')?.dataset.selectionKind === 'plugin'
      && document.querySelector('[data-testid="plugin-trigger-plugin-app-server"]')?.getAttribute('aria-current') === 'page'`,
    `select the same environment's plugin before ${activation} heading activation`);
    await selectVisualTab(win,'agent','[data-testid="plugin-agent-access"]',`plugin Agent view before ${activation} returns to its environment`);
    if (activation === 'Mouse') {
      await nativeClick(trigger(prod));
    } else {
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(trigger(prod))})?.focus({preventScroll:true})`,true);
      await nativeButtonKey(activation);
    }
    await waitExpanded(prod,false,`${activation} from the selected plugin still closes its expanded parent`);
    await waitEnvironmentDetails(prod,'overview',`${activation} on the plugin's environment heading clears plugin selection and opens environment details`);
    if (activation !== 'Space') {
      await nativeClick(trigger(prod));
      await waitExpanded(prod,true,'reopen the selected environment before another plugin-return regression');
      await waitEnvironmentDetails(prod,'overview','reopening an already selected environment preserves its detail tab');
    }
  }
  const collapsedNavigation = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('[data-testid="resource-pane"]');
    return Array.from(pane.querySelectorAll('[data-shell-nav-item][tabindex="0"]'))
      .filter((node) => node.getClientRects().length > 0).map((node) => node.dataset.testid);
  })()`,true);
  assert.deepEqual(collapsedNavigation,[`environment-trigger-${prod}`],'roving focus follows the selected environment after leaving a hidden plugin');
  const refresh = clone(runtime('project-operations',prod,'partial',pluginsByEnvironment[prod],11));
  refresh.plugins['plugin-app-server'] = {pluginInstanceId:'plugin-app-server',phase:'disconnected',assessment:assessment('disconnected','未连接','connect')};
  win.webContents.send('v2:environment-status-changed',refresh);
  await waitFor(win,`document.querySelector('[data-testid="environment-overview"]')?.textContent.includes('未连接') === true`,
    'ordinary runtime update reaches the selected environment details');
  await waitExpanded(prod,false,'runtime refresh must not reopen a manually closed card');
  const readsBefore = readCalls.filter((call) => call.channel === 'v2:workspace-overview').length;
  win.webContents.send('v2:workspace-changed',{projectId:'project-operations',environmentId:prod});
  for (let attempt = 0; attempt < 50 && readCalls.filter((call) => call.channel === 'v2:workspace-overview').length === readsBefore; attempt += 1) await wait(20);
  assert.ok(readCalls.filter((call) => call.channel === 'v2:workspace-overview').length > readsBefore,'workspace refresh executes a new overview read');
  await captureRenderedFrame(win);
  await waitExpanded(prod,false,'fresh overview object must preserve manual collapse');
  if (screenshotRoot && requestedScreenshotTheme === 'light') {
    await win.webContents.executeJavaScript(`document.activeElement?.blur()`,true);
    win.webContents.sendInputEvent({type:'mouseMove',x:8,y:8});
    const [width,height] = win.getContentSize();
    for (const theme of ['light','dark']) {
      await setTheme(win,theme);
      fs.mkdirSync(screenshotRoot,{recursive:true});
      fs.writeFileSync(path.join(screenshotRoot,`environment-collapsed-${theme}-${width}x${height}.png`),
        (await captureRenderedFrame(win)).toPNG());
    }
    await setTheme(win,'light');
  }
  await nativeClick(trigger(prod));
  await waitExpanded(prod,true,'reopening the same environment preserves environment navigation');
  assert.equal(await selectedKind(),'environment');
  await nativeClick(trigger(prod));
  await waitExpanded(prod,false,'close before external plugin navigation');
  await commandSelect('plugin:project-operations:env-production-east:plugin-orders-db','订单数据库');
  await waitExpanded(prod,true,'selecting another plugin through commands reveals its closed parent');
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-plugin-orders-db"]')?.getAttribute('aria-current') === 'page'`,
    'command selected the new plugin');
  await commandSelect('environment:project-operations:env-preview','预发布环境');
  await waitExpanded('env-preview',true,'external environment navigation reveals its card');
  await nativeClick(trigger(prod));
  await waitEnvironmentDetails(prod,'overview','an already expanded card in another environment navigates to its own details');
  await waitExpanded(prod,true,'cross-environment reconciliation reveals the newly selected destination');
  await nativeClick('[data-project-id="project-data"]');
  await waitFor(win,`document.querySelectorAll('[data-testid^="environment-row-"]').length === 0`,'switching projects removes old environment expansion state');
  await nativeClick('[data-project-id="project-operations"]');
  await waitExpanded(prod,true,'switching back initializes only the valid first environment');
  await waitExpanded('env-preview',false,'another project selection does not retain a previously expanded environment');
  await commandSelect('environment:project-operations:env-production-east','生产环境');
  await waitExpanded(prod,true,'restore the original production environment for subsequent scenarios');
  await waitFor(win,`document.querySelector('[data-testid="environment-overview"]') !== null`,'restore environment detail');
  process.stdout.write('Environment accordion navigation evidence: mouse, Enter, Space, plugin-to-environment navigation, retained environment tabs, runtime/overview refresh, external navigation and project switching passed\n');
}

async function captureLongProjectListEvidence(win,theme) {
  if (!screenshotRoot) return;
  const originalProjects = [...workspaceProjects];
  const separator = '[data-testid="project-resource-resizer"]';
  const refreshProjects = async (count) => {
    win.webContents.send('v2:workspace-changed',{});
    await waitFor(win,`document.querySelectorAll('[data-project-id]').length === ${count}`,
      `read-only long project list contains ${count} projects`);
    await captureRenderedFrame(win);
  };
  const readGeometry = () => win.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('[data-testid="project-rail"]');
    const title = rail.querySelector('[data-slot="sidebar-group-label"]');
    const search = rail.querySelector('[data-slot="input-group"]');
    const viewport = rail.querySelector('[data-slot="scroll-area-viewport"]');
    const footer = rail.querySelector('[data-testid="project-actions-footer"]');
    const rect = (node) => { const box = node.getBoundingClientRect(); return {top:box.top,bottom:box.bottom,left:box.left,right:box.right,height:box.height}; };
    const text = Array.from(title.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes('项目'));
    const range = document.createRange();
    if (text) { const start = text.textContent.indexOf('项目'); range.setStart(text,start); range.setEnd(text,start+2); }
    return {collapsed:rail.dataset.collapsed,title:rect(title),titleText:title.textContent.trim(),
      titleTextLeft:text ? range.getBoundingClientRect().left : null,
      search:rect(search),viewport:rect(viewport),footer:rect(footer),
      headingOutsideViewport:!viewport.contains(title),
      firstNameLeft:rail.querySelector('[data-project-name]').getBoundingClientRect().left,
      firstRowTop:rail.querySelector('[data-project-id]').getBoundingClientRect().top,
      lastRowBottom:Array.from(rail.querySelectorAll('[data-project-id]')).at(-1).getBoundingClientRect().bottom,
      scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight};
  })()`,true);
  try {
    workspaceProjects.push(...Array.from({length:12},(_,index) => ({
      schemaVersion:2,projectId:`project-heading-demo-${index+1}`,name:`演示项目 ${String(index+1).padStart(2,'0')} · 长列表滚动验证`,
      revision:1,environmentCount:0,pluginCount:0,environments:[],
    })));
    await refreshProjects(15);
    win.setContentSize(960,640);
    await waitFor(win,`innerWidth === 960 && innerHeight === 640`,'long-list screenshot viewport');
    await captureRenderedFrame(win);
    for (const collapsed of [false,true]) {
      const current = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-rail"]').dataset.collapsed === 'true'`,true);
      if (current !== collapsed) {
        await win.webContents.executeJavaScript(`document.querySelector('${separator}').focus({preventScroll:true})`,true);
        await pressKey(win,'b',['control']);
        await waitFor(win,`document.querySelector('[data-testid="project-rail"]').dataset.collapsed === '${collapsed}'`,'long-list rail mode');
      }
      await win.webContents.executeJavaScript(`document.activeElement?.blur(); document.querySelector('[data-testid="project-list-scroll"] [data-slot="scroll-area-viewport"]').scrollTop = 0`,true);
      win.webContents.sendInputEvent({type:'mouseMove',x:8,y:8});
      await captureRenderedFrame(win);
      const before = await readGeometry();
      assert.ok(before.headingOutsideViewport && before.title.bottom <= before.viewport.top + 1,
        'project heading remains outside the scrolling list');
      assert.ok(before.scrollHeight > before.clientHeight + 20,'15 project fixture genuinely overflows the list');
      const state = collapsed ? 'compact' : 'expanded';
      fs.writeFileSync(path.join(screenshotRoot,`project-heading-${state}-${theme}-top-960x640.png`),(await captureRenderedFrame(win)).toPNG());
      win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round((before.viewport.left+before.viewport.right)/2),
        y:Math.round((before.viewport.top+before.viewport.bottom)/2),deltaY:-10000,canScroll:true});
      await waitFor(win,`(() => {const viewport = document.querySelector('[data-testid="project-list-scroll"] [data-slot="scroll-area-viewport"]'); return viewport.scrollTop > 20 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight-1;})()`,
        'native wheel reaches the bottom of the long project list');
      await captureRenderedFrame(win);
      const after = await readGeometry();
      assert.deepEqual(after.title,before.title,'long-list scrolling does not move or clip the project heading');
      assert.deepEqual(after.footer,before.footer,'long-list scrolling does not move the add-project footer');
      assert.ok(after.firstRowTop < before.firstRowTop-20,'actual project rows scroll beneath the fixed heading');
      assert.ok(after.lastRowBottom <= after.viewport.bottom + 1 && after.viewport.bottom <= after.footer.top + 1,
        'the last project remains above the fixed footer at the end of the list');
      process.stdout.write(`Long project heading evidence: ${JSON.stringify({theme,state,before,after})}\n`);
      win.webContents.sendInputEvent({type:'mouseMove',x:8,y:8});
      fs.writeFileSync(path.join(screenshotRoot,`project-heading-${state}-${theme}-bottom-960x640.png`),(await captureRenderedFrame(win)).toPNG());
    }
  } finally {
    workspaceProjects.splice(0,workspaceProjects.length,...originalProjects);
    await refreshProjects(originalProjects.length);
    await win.webContents.executeJavaScript(`document.querySelector('${separator}').focus({preventScroll:true})`,true);
    const collapsed = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-rail"]').dataset.collapsed === 'true'`,true);
    if (collapsed) await pressKey(win,'b',['control']);
    win.setContentSize(1280,820);
    await waitFor(win,`innerWidth === 1280 && innerHeight === 820 && document.querySelector('[data-testid="project-rail"]').dataset.collapsed === 'false'`,
      'restore the original fixture and expanded viewport after long-list evidence');
    await captureRenderedFrame(win);
  }
}

async function assertProjectSearchPlaceholder(win,label) {
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="project-search"]');
    if (!input) return null;
    const group = input.closest('[data-slot="input-group"]');
    const icon = group?.querySelector('svg');
    const rect = input.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    const style = getComputedStyle(input);
    const placeholder = getComputedStyle(input,'::placeholder');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = [placeholder.fontStyle,placeholder.fontWeight,placeholder.fontSize,placeholder.fontFamily].join(' ');
    const spacing = Number.parseFloat(placeholder.letterSpacing) || 0;
    const textWidth = context.measureText(input.placeholder).width + spacing * Math.max(0,Array.from(input.placeholder).length-1);
    const textLeft = rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    const textRight = rect.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight);
    return {placeholder:input.placeholder,fontSize:style.fontSize,placeholderFontSize:placeholder.fontSize,
      availableWidth:textRight-textLeft,textWidth,visible:input.getClientRects().length > 0,
      iconRight:iconRect?.right,textLeft,textRight,
      fits:textLeft + textWidth <= textRight + 0.5,
      noIconOverlap:Boolean(iconRect && textLeft >= iconRect.right + 1)};
  })()`,true);
  const alreadyAttached = win.webContents.debugger.isAttached();
  if (!alreadyAttached) win.webContents.debugger.attach('1.3');
  try {
    const evaluated = await win.webContents.debugger.sendCommand('Runtime.evaluate',{
      expression:'document.querySelector(\'[data-testid="project-search"]\')',returnByValue:false,
    });
    const {node} = await win.webContents.debugger.sendCommand('DOM.describeNode',{
      objectId:evaluated.result.objectId,depth:-1,pierce:true,
    });
    const candidates = [];
    const visit = (entry,inUserAgentShadow = false) => {
      const shadow = inUserAgentShadow || entry.shadowRootType === 'user-agent';
      if (shadow && entry.nodeType === 1) {
        const attributes = Object.fromEntries(Array.from({length:(entry.attributes?.length ?? 0) / 2},(_,index) =>
          [entry.attributes[index*2],entry.attributes[index*2+1]]));
        const hasPlaceholder = entry.children?.some((child) => child.nodeType === 3 && child.nodeValue === snapshot.placeholder);
        if (hasPlaceholder || ['true','plaintext-only'].includes(attributes.contenteditable)) {
          candidates.push({backendNodeId:entry.backendNodeId,kind:hasPlaceholder ? 'placeholder' : 'editor'});
        }
      }
      for (const child of [...(entry.children ?? []),...(entry.shadowRoots ?? []),...(entry.pseudoElements ?? [])]) visit(child,shadow);
    };
    visit(node);
    snapshot.nativeTextBoxes = [];
    for (const candidate of candidates) {
      const {model} = await win.webContents.debugger.sendCommand('DOM.getBoxModel',{backendNodeId:candidate.backendNodeId});
      const xs = model.content.filter((_value,index) => index % 2 === 0);
      snapshot.nativeTextBoxes.push({kind:candidate.kind,left:Math.min(...xs),right:Math.max(...xs),width:Math.max(...xs)-Math.min(...xs)});
    }
    assert.ok(snapshot.nativeTextBoxes.some((box) => box.kind === 'placeholder'),'Chromium exposes the actual native placeholder viewport');
    const usableBoxes = snapshot.nativeTextBoxes.filter((box) => box.width > 0);
    snapshot.nativeAvailableWidth = Math.min(snapshot.availableWidth,...usableBoxes.map((box) => box.width));
    snapshot.fitsNativeViewport = snapshot.textWidth <= snapshot.nativeAvailableWidth + 0.5;
  } finally {
    if (!alreadyAttached) win.webContents.debugger.detach();
  }
  process.stdout.write(`Project search placeholder evidence: ${JSON.stringify({label,...snapshot})}\n`);
  assert.ok(snapshot?.visible && snapshot.placeholder === '搜索项目' && snapshot.fits && snapshot.fitsNativeViewport && snapshot.noIconOverlap,
    `${label}: complete project search placeholder must fit without overlapping its icon: ${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.fontSize,'12px',`${label}: project search uses its intended 12px font instead of inheriting 16px`);
  assert.equal(snapshot.placeholderFontSize,'12px');
}

async function assertCompactProjectRail(win,theme) {
  const separatorSelector = '[data-testid="project-resource-resizer"]';
  const storageKey = 'runbook-bridge:app-shell-layout:v1';
  const toggleWithShortcut = () => pressKey(win,'b',['control']);
  const focusSeparator = () => win.webContents.executeJavaScript(
    `document.querySelector('${separatorSelector}')?.focus({preventScroll:true})`,true);
  const captureCleanRail = async (collapsed,width,height) => {
    if (!screenshotRoot || width !== 1280) return;
    // Keep focus assertions above intact; delivery images show the same verified
    // geometry with only the separator's temporary keyboard focus removed.
    await win.webContents.executeJavaScript(`if (document.activeElement?.matches('${separatorSelector}')) document.activeElement.blur()`,true);
    for (const cleanTheme of theme === 'light' ? ['light','dark'] : [theme]) {
      if (cleanTheme !== nativeTheme.themeSource) await setTheme(win,cleanTheme);
      fs.writeFileSync(path.join(screenshotRoot,`app-shell-project-${collapsed ? 'collapsed' : 'expanded'}-clean-${cleanTheme}-${width}x${height}.png`),
        (await captureRenderedFrame(win)).toPNG());
    }
    if (nativeTheme.themeSource !== theme) await setTheme(win,theme);
    await focusSeparator();
  };
  const assertProjectMenuStatusHandoff = async (collapsed) => {
    const point = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('[data-project-id="project-operations"]');
      const action = row?.closest('[data-sidebar="menu-item"]')?.querySelector('[data-sidebar="menu-action"]');
      const rect = action?.getBoundingClientRect();
      if (!rect) throw new Error('project more action missing');
      return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)};
    })()`,true);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await waitFor(win,`(() => {
      const menu = document.querySelector('[role="menu"][data-state="open"]');
      return menu && menu.contains(document.activeElement);
    })()`,`${collapsed ? 'compact' : 'expanded'} project menu receives portal focus`);
    const outside = await win.webContents.executeJavaScript(`({x:innerWidth-24,y:innerHeight-24})`,true);
    win.webContents.sendInputEvent({type:'mouseMove',...outside});
    await captureRenderedFrame(win);
    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('[data-project-id="project-operations"]');
      const item = row.closest('[data-sidebar="menu-item"]');
      const action = item.querySelector('[data-sidebar="menu-action"]');
      const status = row.querySelector('[data-project-status-badge]');
      const menu = document.querySelector('[role="menu"][data-state="open"]');
      return {open:action.getAttribute('aria-expanded') === 'true',
        portalFocus:Boolean(menu && menu.contains(document.activeElement)),
        rowHovered:item.matches(':hover'),rowFocused:item.contains(document.activeElement),
        actionOpacity:Number(getComputedStyle(action).opacity),statusOpacity:Number(getComputedStyle(status).opacity)};
    })()`,true);
    assert.deepEqual(snapshot,{open:true,portalFocus:true,rowHovered:false,rowFocused:false,actionOpacity:1,statusOpacity:0},
      `${collapsed ? 'compact' : 'expanded'} open project menu must hide status after pointer and focus leave the row`);
    await pressKey(win,'ESCAPE');
    await waitFor(win,`document.querySelector('[role="menu"][data-state="open"]') === null`,
      'project more menu closes without changing selection');
    await focusSeparator();
  };
  const rememberStableRail = () => win.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('[data-testid="project-rail"]');
    const selectors = ['[data-slot="sidebar-header"]','[data-testid="project-search"]',
      '[data-slot="sidebar-group-label"]','[data-testid="confirmation-center"]',
      '[data-testid="add-project-footer"]',...Array.from(rail.querySelectorAll('[data-project-id]'))
        .flatMap((row) => ['[data-project-id="' + row.dataset.projectId + '"]',
          '[data-project-id="' + row.dataset.projectId + '"] [data-project-name]',
          '[data-project-id="' + row.dataset.projectId + '"] [data-project-status-badge]',
          '[data-sidebar="menu-item"]:has([data-project-id="' + row.dataset.projectId + '"]) [data-sidebar="menu-action"]'])];
    const structure = (element) => Array.from(element.querySelectorAll('*')).map((child) => child.tagName + ':' + (child.dataset.slot || '')).join('|');
    window.__stableProjectRail = selectors.map((selector) => {
      const node = rail.querySelector(selector);
      if (!node) throw new Error('stable project rail element missing: ' + selector);
      const rect = node.getBoundingClientRect();
      return {selector,node,top:rect.top,height:rect.height,structure:structure(node)};
    });
    window.__projectActionAppearance = ['add-project-footer','add-environment-footer'].map((id) => {
      const button = document.querySelector('[data-testid="' + id + '"]');
      if (!button) throw new Error('navigation action missing: ' + id);
      const style = getComputedStyle(button);
      return {color:style.color,background:style.backgroundColor,border:style.borderTopColor};
    });
  })()`,true);
  const assertStableRail = async (label) => {
    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const rail = document.querySelector('[data-testid="project-rail"]');
      const structure = (element) => Array.from(element.querySelectorAll('*')).map((child) => child.tagName + ':' + (child.dataset.slot || '')).join('|');
      return {
        noToggle:!rail.querySelector('[data-project-rail-toggle],[data-testid="project-expand"],[data-testid="project-collapse"]'),
        rowHeights:Array.from(rail.querySelectorAll('[data-project-id]')).map((row) => row.getBoundingClientRect().height),
        actions:['add-project-footer','add-environment-footer'].map((id,index) => {
          const button = document.querySelector('[data-testid="' + id + '"]');
          const style = getComputedStyle(button);
          const appearance = {color:style.color,background:style.backgroundColor,border:style.borderTopColor};
          return {id,appearance,sameAppearance:JSON.stringify(appearance) === JSON.stringify(window.__projectActionAppearance[index]),
            outlined:parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle === 'solid',
            transparent:style.backgroundColor === 'rgba(0, 0, 0, 0)',
            noInlineShortcut:!button.querySelector('[data-slot="kbd"]'),height:button.getBoundingClientRect().height};
        }),
        nodes:window.__stableProjectRail.map((before) => {
          const node = rail.querySelector(before.selector);
          const rect = node?.getBoundingClientRect();
          return {selector:before.selector,sameNode:node === before.node,connected:before.node.isConnected,
            sameStructure:Boolean(node && structure(node) === before.structure),
            sameTop:Boolean(rect && Math.abs(rect.top - before.top) <= 1),
            sameHeight:Boolean(rect && Math.abs(rect.height - before.height) <= 1),
            before:[before.top,before.height],after:rect ? [rect.top,rect.height] : null};
        }),
      };
    })()`,true);
    assert.equal(snapshot.noToggle,true,'project rail has no top collapse arrow');
    assert.ok(snapshot.rowHeights.every((height) => Math.abs(height - 36) <= 1),'expanded and compact rows both stay 36px high');
    assert.ok(snapshot.actions.every((action) => action.sameAppearance && action.outlined && action.transparent && action.noInlineShortcut && Math.abs(action.height - 40) <= 1),
      `${label}: navigation add actions must retain neutral outline appearance: ${JSON.stringify(snapshot.actions)}`);
    assert.deepEqual(snapshot.actions[0].appearance,snapshot.actions[1].appearance,'project and environment add actions use the same neutral colors');
    assert.ok(snapshot.nodes.every((node) => node.sameNode && node.connected && node.sameStructure && node.sameTop && node.sameHeight),
      `${label}: project rail changes structure or vertical placement: ${JSON.stringify(snapshot)}`);
  };
  const waitCollapsed = async (collapsed,label) => {
    try {
    await waitFor(win,`(() => {
      const rail = document.querySelector('[data-testid="project-rail"]');
      const saved = JSON.parse(localStorage.getItem('${storageKey}') ?? 'null');
      return rail?.dataset.collapsed === '${collapsed}' && saved?.projectCollapsed === ${collapsed}
        && (${collapsed} ? Math.abs(rail.getBoundingClientRect().width - 128) <= 1 : rail.getBoundingClientRect().width >= 175.5);
    })()`,label);
    } catch (error) {
      const evidence = await win.webContents.executeJavaScript(`(() => ({
        separator:document.querySelector('${separatorSelector}')?.outerHTML,
        focused:document.activeElement?.outerHTML?.slice(0,900),
        railWidth:document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width,
        panelWidth:document.getElementById('project-panel')?.getBoundingClientRect().width,
        collapsed:document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed,
        layout:localStorage.getItem('${storageKey}'),
      }))()`,true);
      if (screenshotRoot) fs.writeFileSync(path.join(screenshotRoot,`compact-rail-failure-${theme}.png`),(await captureRenderedFrame(win)).toPNG());
      throw new Error(error.message + '\nCompact rail failure evidence: ' + JSON.stringify(evidence));
    }
    await captureRenderedFrame(win);
  };
  for (const [width,height] of [[960,640],[1280,820],[1680,980]]) {
    win.setContentSize(width,height);
    await waitFor(win,`innerWidth === ${width} && innerHeight === ${height}`,
      `compact project rail viewport ${width}x${height}`);
    await captureRenderedFrame(win);
    await assertRendererKeyboardFocus(win);
    await rememberStableRail();
    await assertStableRail('expanded baseline');
    if (width === 960) await assertProjectMenuStatusHandoff(false);
    await focusSeparator();
    await toggleWithShortcut();
    await waitCollapsed(true,`compact project rail ${width}x${height}`);
    await assertThemeControlGeometry(win,{compact:true});
    if (width === 960) {
      await openThemeMenu(win);
      await pressKey(win,'ESCAPE');
      await assertThemeMenuClosed(win,'compact theme menu');
      await focusSeparator();
    }
    await assertProjectSearchPlaceholder(win,`compact ${theme} ${width}x${height}`);
    if (width === 960) {
      await win.webContents.executeJavaScript(`window.__zoomSearchInput = document.querySelector('[data-testid="project-search"]')`,true);
      for (const zoom of [1.25,1.5]) {
        win.webContents.setZoomFactor(zoom);
        await waitFor(win,`Math.abs(innerWidth - ${width / zoom}) <= 1`,'zoomed project search viewport');
        await captureRenderedFrame(win);
        await assertProjectSearchPlaceholder(win,`compact ${theme} ${zoom*100}% zoom`);
        assert.equal(await win.webContents.executeJavaScript(`window.__zoomSearchInput === document.querySelector('[data-testid="project-search"]')`,true),true,
          'browser zoom retains the visible search input node');
      }
      win.webContents.setZoomFactor(1);
      await waitFor(win,`innerWidth === ${width} && innerHeight === ${height}`,'restore project search zoom');
      await waitCollapsed(true,'restore compact geometry after project search zoom checks');
      await win.webContents.executeJavaScript(`delete window.__zoomSearchInput`,true);
    }
    await assertStableRail(`collapse at ${width}x${height}`);
    if (width === 960) await assertProjectMenuStatusHandoff(true);

    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const rail = document.querySelector('[data-testid="project-rail"]');
      const intersects = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d',{willReadFrequently:true});
      const rgba = (color) => {
        context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1);
        return [...context.getImageData(0,0,1,1).data].map((value,index) => index === 3 ? value / 255 : value);
      };
      const over = (front,back) => {
        const alpha = front[3] + back[3] * (1-front[3]);
        return [...front.slice(0,3).map((value,index) => alpha ?
          (value * front[3] + back[index] * back[3] * (1-front[3])) / alpha : 0),alpha];
      };
      const pixel = (element,foreground) => {
        let result = foreground ? rgba(getComputedStyle(element).color) : [0,0,0,0];
        for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
          const style = getComputedStyle(node);
          result = over(result,rgba(style.backgroundColor));
          result[3] *= Number(style.opacity);
        }
        return over(result,[255,255,255,1]);
      };
      const luminance = (color) => color.slice(0,3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum,value,index) => sum + value * [0.2126,0.7152,0.0722][index],0);
      const contrast = (element) => {
        const a = luminance(pixel(element,true)); const b = luminance(pixel(element,false));
        return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
      };
      const rows = [...rail.querySelectorAll('[data-project-id]')].map((button) => {
        const name = button.querySelector('[data-project-name]');
        const status = button.querySelector('[data-project-compact-status]');
        const indicator = status?.querySelector('[data-status]');
        const nameStyle = name && getComputedStyle(name);
        const elements = [name,status];
        const rects = elements.map((element) => element?.getBoundingClientRect());
        const rowRect = button.getBoundingClientRect();
        return {
          id:button.dataset.projectId, label:button.getAttribute('aria-label'),
          name:name?.textContent?.trim(), height:rowRect.height,
          status:indicator?.getAttribute('title'), statusKind:indicator?.dataset.status,
          avatar:button.querySelector('[data-project-monogram],[data-slot="avatar"]') !== null,
          present:elements.every((element) => element?.getClientRects().length > 0),
          overlap:rects.some((rect,index) => rect && rects.slice(index+1).some((other) => other && intersects(rect,other))),
          contained:rects.every((rect) => rect && rect.left >= rowRect.left-1 && rect.right <= rowRect.right+1
            && rect.top >= rowRect.top-1 && rect.bottom <= rowRect.bottom+1),
          singleLine:Boolean(rects[0] && rects[1] && rects[0].right <= rects[1].left
            && Math.abs((rects[0].top + rects[0].bottom) / 2 - (rects[1].top + rects[1].bottom) / 2) <= 1),
          nameTruncation:nameStyle?.whiteSpace === 'nowrap' && nameStyle?.textOverflow === 'ellipsis'
            && nameStyle?.overflow === 'hidden' && nameStyle?.textAlign === 'left',
          nameClipped:Boolean(name && name.scrollWidth > name.clientWidth+1),
          nameContrast:name ? contrast(name) : 0,
          statusAnimated:Boolean(indicator && [indicator,...indicator.querySelectorAll('*')]
            .some((element) => getComputedStyle(element).animationName !== 'none')),
          disconnectedRing:indicator?.dataset.status === 'disconnected'
            && [...indicator.querySelectorAll('*')].some((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return Math.abs(rect.width - 7) <= 1 && Math.abs(rect.height - 7) <= 1
                && parseFloat(style.borderTopWidth) >= 1 && parseFloat(style.borderRadius) >= 3.5;
            }),
          disabled:button.getAttribute('aria-disabled') === 'true',
        };
      });
      const footer = rail.querySelector('[data-testid="project-actions-footer"]');
      const add = rail.querySelector('[data-testid="add-project-footer"]');
      const addStyle = add && getComputedStyle(add);
      const addLabel = add && [...add.querySelectorAll('span')].find((element) => element.textContent?.trim() === '新增项目');
      const confirmation = rail.querySelector('[data-testid="confirmation-center"]');
      const confirmationLabel = confirmation && [...confirmation.querySelectorAll('span')]
        .find((element) => element.textContent?.trim() === '操作确认');
      const labelFits = (label,button) => {
        if (!label || !button || !label.getClientRects().length) return false;
        const rect = label.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return label.scrollWidth <= label.clientWidth+1 && rect.width > 0 && rect.height > 0
          && rect.left >= buttonRect.left && rect.right <= buttonRect.right
          && rect.top >= buttonRect.top && rect.bottom <= buttonRect.bottom;
      };
      const viewport = rail.querySelector('[data-slot="scroll-area-viewport"]');
      const before = footer?.getBoundingClientRect();
      const previousScrollTop = viewport?.scrollTop;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
      const after = footer?.getBoundingClientRect();
      if (viewport) viewport.scrollTop = previousScrollTop;
      const railRect = rail.getBoundingClientRect();
      return {
        width:rail.getBoundingClientRect().width, rows,
        confirmation:{label:confirmationLabel?.textContent?.trim(),labelFits:labelFits(confirmationLabel,confirmation)},
        footer:{
          height:add?.getBoundingClientRect().height,
          label:add?.textContent?.trim(),outlined:Boolean(addStyle && parseFloat(addStyle.borderTopWidth) >= 1
            && addStyle.borderTopStyle === 'solid'),
          labelFits:labelFits(addLabel,add),
          visible:Boolean(before && before.top >= railRect.top && before.bottom <= railRect.bottom+1),
          fixed:Boolean(before && after && Math.abs(before.top - after.top) <= 1),
        },
        selected:rail.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId,
        tabStops:rail.querySelectorAll('[data-project-id][tabindex="0"]').length,
        footerToggle:rail.querySelector('[data-slot="sidebar-footer"] [data-project-rail-toggle],[data-slot="sidebar-footer"] [data-testid="project-expand"]') !== null,
        unlabeled:[...rail.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0
          && !(button.getAttribute('aria-label') || button.textContent?.trim() || button.title)).map((button) => button.outerHTML),
        overflow:[document.documentElement,document.body,document.querySelector('[data-testid="react-app-shell"]'),rail]
          .some((element) => element && element.scrollWidth > element.clientWidth+1),
        overflowDetails:[document.documentElement,document.body,document.querySelector('[data-testid="react-app-shell"]'),rail,
          ...rail.querySelectorAll('*')].filter((element) => element && element.scrollWidth > element.clientWidth+1)
          .map((element) => ({tag:element.tagName,slot:element.dataset.slot,testId:element.dataset.testid,
            className:element.className,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,
            rect:element.getBoundingClientRect().toJSON()})),
      };
    })()`,true);
    const collapsedProjectGeometry = snapshot.rows.some((row) => row.overlap || !row.contained);
    assert.equal(collapsedProjectGeometry,false,`compact project geometry: ${JSON.stringify(snapshot)}`);
    assert.ok(Math.abs(snapshot.width - 128) <= 1);
    assert.equal(snapshot.rows.length,workspaceProjects.length);
    assert.equal(snapshot.tabStops,1);
    assert.equal(snapshot.footerToggle,false);
    assert.deepEqual(snapshot.confirmation,{label:'操作确认',labelFits:true},'compact confirmation label must be fully visible');
    assert.deepEqual(snapshot.footer,{height:40,label:'新增项目',outlined:true,labelFits:true,visible:true,fixed:true});
    if (snapshot.overflow && screenshotRoot) fs.writeFileSync(path.join(screenshotRoot,`compact-rail-overflow-${theme}.png`),(await captureRenderedFrame(win)).toPNG());
    assert.equal(snapshot.overflow,false,`compact rail overflow: ${JSON.stringify(snapshot.overflowDetails)}`);
    assert.deepEqual(snapshot.unlabeled,[]);
    for (const row of snapshot.rows) {
      const project = workspaceProjects.find((item) => item.projectId === row.id);
      assert.ok(row.present && row.name && row.status,`compact identity/status missing: ${JSON.stringify(row)}`);
      assert.equal(row.name,project.name,'compact navigation keeps the full name in the DOM');
      assert.equal(row.avatar,false,'compact rows do not duplicate the name with a monogram');
      assert.ok(Math.abs(row.height - 36) <= 1 && row.singleLine && row.nameTruncation,
        `compact project row must be a 36px left-aligned single line: ${JSON.stringify(row)}`);
      assert.ok(row.label?.includes(project.name) && row.label.includes(row.status));
      if (row.statusKind === 'disconnected') {
        assert.equal(row.statusAnimated,false,'disconnected status remains static');
        assert.equal(row.disconnectedRing,true,'disconnected status uses a small outlined ring');
      }
      // Isolated rows are explicitly disabled; still record their actual composite
      // contrast, while applying WCAG text contrast to the actionable project rows.
      if (!row.disabled) {
        assert.ok(row.nameContrast >= 4.5,
          `compact project text contrast must be >=4.5: ${JSON.stringify(row)}`);
      }
    }
    assert.ok(snapshot.rows.some((row) => row.nameClipped),'fixture must exercise long-name ellipsis');

    if (width === 960) {
      for (const row of snapshot.rows) {
        // Separate blur and focus tasks so a controlled Radix Tooltip has committed
        // its close before the next trusted focus opens another tooltip.
        await win.webContents.executeJavaScript(`document.querySelector('#detail-main')?.focus({preventScroll:true})`,true);
        await waitFor(win,`document.activeElement?.id === 'detail-main' && document.querySelectorAll('[data-slot="tooltip-content"]').length === 0`,
          `compact tooltip close before ${row.id}`);
        const focused = await win.webContents.executeJavaScript(`(() => {
          const target = document.querySelector('[data-project-id="${row.id}"]');
          let trusted = false;
          const listener = (event) => { if (event.target === target && event.isTrusted) trusted = true; };
          document.addEventListener('focusin',listener,true); target?.focus({preventScroll:true});
          document.removeEventListener('focusin',listener,true);
          return document.hasFocus() && document.activeElement === target && trusted;
        })()`,true);
        assert.equal(focused,true,`${row.id} receives trusted keyboard focus`);
        const project = workspaceProjects.find((item) => item.projectId === row.id);
        await waitFor(win,`[...document.querySelectorAll('[data-slot="tooltip-content"]')].some((tooltip) =>
          tooltip.getClientRects().length > 0 && tooltip.textContent.includes(${JSON.stringify(project.name)})
          && tooltip.textContent.includes(${JSON.stringify(row.status)})
          && tooltip.textContent.includes(${JSON.stringify(project.configurationError ? '项目配置已隔离' : `${project.environmentCount} 个环境`)}))`,
        `compact ${row.id} keyboard tooltip exposes full project identity`);
      }
      const ids = snapshot.rows.map((row) => row.id);
      for (const [key,index] of [['HOME',0],['DOWN',1],['END',ids.length-1],['UP',ids.length-2]]) {
        await pressKey(win,key);
        await waitFor(win,`document.activeElement?.dataset.projectId === ${JSON.stringify(ids[index])}
          && document.querySelectorAll('[data-project-id][tabindex="0"]').length === 1
          && document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId === ${JSON.stringify(snapshot.selected)}`,
        `compact project roving ${key}`);
      }
      await focusSeparator();
      await pressKey(win,'b',['control']);
      await waitCollapsed(false,'Ctrl+B expands project rail');
      await assertStableRail('shortcut expansion');
      await pressKey(win,'b',['control']);
      await waitCollapsed(true,'Ctrl+B collapses project rail');
      await assertStableRail('shortcut collapse');
    }
    await focusSeparator();
    await pressKey(win,'ESCAPE');
    const image = await captureRenderedFrame(win);
    if (screenshotRoot) {
      fs.writeFileSync(path.join(screenshotRoot,`app-shell-project-collapsed-${theme}-${width}x${height}.png`),image.toPNG());
    }
    await captureCleanRail(true,width,height);
    if (screenshotRoot && width === 1280) {
      await toggleWithShortcut();
      await waitCollapsed(false,'expand the unchanged selected scope for the clean comparison');
      await assertStableRail('clean comparison expansion');
      await captureCleanRail(false,width,height);
      await toggleWithShortcut();
      await waitCollapsed(true,'restore collapsed intent before the reload regression');
      await assertStableRail('clean comparison collapse');
    }
    process.stdout.write(`Compact project rail evidence: ${JSON.stringify({theme,viewport:[width,height],...snapshot})}\n`);

    if (width === 1280) {
      await collectWindowErrorDiagnostics(win);
      const loaded = new Promise((resolve) => win.webContents.once('did-finish-load',resolve));
      win.reload();
      await loaded;
      await installWindowErrorDiagnostics(win);
      await waitFor(win,`document.querySelector('[data-shell-ready="true"]') !== null
        && document.querySelectorAll('[data-project-id]').length === ${workspaceProjects.length}`,
      'collapsed project rail reload ready');
      await waitCollapsed(true,'collapsed project rail persists across reload');
      await waitFor(win,`document.documentElement.dataset.themePreference === 'system'
        && localStorage.getItem('${THEME_STORAGE_KEY}') === 'system'`,
      'system theme preference persists across a Renderer reload');
      await assertRendererKeyboardFocus(win);
      await rememberStableRail();
      await focusSeparator();
      await assertStableRail('collapsed reload baseline');
    }
    await toggleWithShortcut();
    await waitCollapsed(false,`project rail restored after ${width}x${height}`);
    await assertStableRail(`expansion at ${width}x${height}`);
    if (width === 960) {
      await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-search"]')?.focus({preventScroll:true})`,true);
      const searchFocused = await win.webContents.executeJavaScript(`document.activeElement?.tagName === 'INPUT'`,true);
      assert.equal(searchFocused,true,'project search receives focus for editable shortcut guard');
      await pressKey(win,'b',['control']);
      await waitCollapsed(false,'Ctrl+B in project search does not collapse the rail');
      await win.webContents.insertText('内部');
      await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === '内部'
        && document.querySelectorAll('[data-project-id]').length === 1
        && document.querySelector('[data-project-id]')?.dataset.projectId === 'project-data'`,
        'native project search filters the list before resizing');
      await rememberStableRail();
      await focusSeparator();
      await toggleWithShortcut();
      await waitCollapsed(true,'collapse a filtered project list');
      await assertStableRail('filtered list collapse');
      await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === '内部'
        && document.querySelectorAll('[data-project-id]').length === 1
        && document.querySelector('[data-project-id]')?.dataset.projectId === 'project-data'`,
        'collapse retains the visible search field, query and filtered project');
      await toggleWithShortcut();
      await waitCollapsed(false,'expand a filtered project list');
      await assertStableRail('filtered list expansion');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-search"]')?.value`,true),'内部');
      await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-search"]')?.focus({preventScroll:true})`,true);
      await pressKey(win,'a',['control']);
      await pressKey(win,'BACKSPACE');
      await waitFor(win,`document.querySelector('[data-testid="project-search"]')?.value === ''
        && document.querySelectorAll('[data-project-id]').length === ${workspaceProjects.length}`,
        'clear the search using native keyboard input after resizing');
    }
    await win.webContents.executeJavaScript(`delete window.__stableProjectRail; delete window.__projectActionAppearance`,true);
  }
  const readNarrowRail = () => win.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('[data-testid="project-rail"]');
    const separator = document.querySelector('${separatorSelector}');
    return {
      viewport:innerWidth,width:rail?.getBoundingClientRect().width,
      panelWidth:document.getElementById('project-panel')?.getBoundingClientRect().width,
      collapsed:rail?.dataset.collapsed,
      focused:document.hasFocus() && document.activeElement === separator,
      saved:localStorage.getItem('${storageKey}'),
      overflow:[document.documentElement,document.body,document.querySelector('[data-testid="react-app-shell"]')]
        .some((element) => element && element.scrollWidth > element.clientWidth+1),
    };
  })()`,true);
  const narrowViewport = async (width,label) => {
    win.setContentSize(width,640);
    await waitFor(win,`innerWidth === ${width} && innerHeight === 640`,label);
    await captureRenderedFrame(win);
  };
  const resizeWithPointer = async (action) => {
    const point = await win.webContents.executeJavaScript(`(() => {
      const separator = document.querySelector('[data-testid="project-resource-resizer"]');
      const rect = separator?.getBoundingClientRect();
      if (!rect) throw new Error('project resize handle missing');
      return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)};
    })()`,true);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    if (action === 'double-click') {
      for (const clickCount of [1,2]) {
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount,...point});
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount,...point});
      }
    } else {
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      for (const distance of [24,48,72,96]) {
        win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:point.x+distance,y:point.y});
        await wait(20);
      }
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+96,y:point.y});
    }
    await captureRenderedFrame(win);
  };
  const expandedIntent = (await readNarrowRail()).saved;
  assert.equal(JSON.parse(expandedIntent).projectCollapsed,false);
  // Reach a genuinely constrained width via viewport resizing only. Returning
  // to 800px preserves that compact pixel width, exercising the effective-state
  // expand path without manually changing panel sizes or persisted layout.
  await narrowViewport(640,'project rail first enters a constrained viewport');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'true'
    && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 128) <= 1`,
  'project rail automatically compacts without changing expanded intent');
  assert.equal((await readNarrowRail()).saved,expandedIntent);
  await narrowViewport(800,'project rail compact recovery viewport 800');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'true'
    && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 128) <= 1`,
  '800px project rail retains automatically compact geometry');
  await assertRendererKeyboardFocus(win);
  await focusSeparator();
  const compact800 = await readNarrowRail();
  assert.equal(compact800.focused,true);
  assert.equal(compact800.overflow,false);
  await toggleWithShortcut();
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'false'
    && document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width >= 175.5`,
  '800px Ctrl+B restores the project rail to at least 176px');
  await captureRenderedFrame(win);
  const expanded800 = await readNarrowRail();
  assert.equal(expanded800.focused,true);
  assert.equal(expanded800.saved,expandedIntent);
  assert.equal(expanded800.overflow,false);

  await narrowViewport(640,'project rail disabled expansion viewport 640');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'true'
    && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 128) <= 1`,
  '640px project rail remains within its constrained width');
  await assertRendererKeyboardFocus(win);
  await focusSeparator();
  const compact640 = await readNarrowRail();
  assert.equal(compact640.focused,true,'constrained separator remains keyboard focusable');
  assert.equal(compact640.saved,expandedIntent);
  assert.equal(compact640.overflow,false);
  for (const activation of ['Enter','Ctrl+B']) {
    if (activation === 'Enter') await pressKey(win,'ENTER');
    else await pressKey(win,'b',['control']);
    await captureRenderedFrame(win);
    const unchanged = await readNarrowRail();
    assert.equal(unchanged.saved,compact640.saved,`${activation} at 640px must preserve the user's expanded intent`);
    assert.equal(unchanged.collapsed,'true');
    assert.equal(unchanged.focused,true);
    assert.equal(unchanged.overflow,false);
    assert.ok(Math.abs(unchanged.width - compact640.width) <= 1);
  }
  await resizeWithPointer('drag');
  const constrainedDrag = await readNarrowRail();
  assert.equal(constrainedDrag.collapsed,'true');
  assert.ok(Math.abs(constrainedDrag.width - 128) <= 1,'constrained rail must not widen while showing collapsed contents');
  assert.equal(constrainedDrag.saved,compact640.saved,'constrained drag preserves the expanded desktop intent');
  assert.equal(constrainedDrag.overflow,false);
  await resizeWithPointer('double-click');
  const constrainedReset = await readNarrowRail();
  assert.equal(constrainedReset.collapsed,'true');
  assert.ok(Math.abs(constrainedReset.width - 128) <= 1,'constrained double-click stays within the fixed rail width');
  assert.equal(constrainedReset.saved,compact640.saved);
  assert.equal(constrainedReset.overflow,false);

  await narrowViewport(800,'project rail pointer resize viewport 800');
  try {
    await waitFor(win,`(() => {
      const rail = document.querySelector('[data-testid="project-rail"]');
      if (!rail) return false;
      const width = rail.getBoundingClientRect().width;
      return rail.dataset.collapsed === 'true'
        ? Math.abs(width - 128) <= 1
        : rail.dataset.collapsed === 'false' && width >= 175.5;
    })()`, '800px restored rail presentation matches its actual geometry');
  } catch (error) {
    throw new Error(`${error.message}\nNarrow restoration evidence: ${JSON.stringify({constrainedDrag,constrainedReset,restored:await readNarrowRail()})}`);
  }
  const restored800 = await readNarrowRail();
  process.stdout.write(`Narrow viewport restoration evidence: ${JSON.stringify({theme,constrainedDrag,constrainedReset,restored800})}\n`);
  assert.equal(restored800.saved,compact640.saved,'returning from the constrained viewport preserves desktop intent');
  assert.equal(restored800.overflow,false);
  assert.ok(Math.abs(restored800.width - restored800.panelWidth) <= 1);
  await focusSeparator();
  // The panel library may restore the user's previous expanded pixel size when
  // constraints relax. Both valid geometries preserve expanded intent; explicitly
  // prepare the collapsed state with the native shortcut before testing resizing.
  if (restored800.collapsed === 'true') {
    await toggleWithShortcut();
    await waitCollapsed(false,'restore expanded state before deliberate narrow collapse');
  }
  await toggleWithShortcut();
  await waitCollapsed(true,'deliberate narrow collapse persists');
  await resizeWithPointer('drag');
  await waitCollapsed(false,'dragging a deliberately collapsed narrow rail expands its content and saved intent');
  const dragged800 = await readNarrowRail();
  assert.equal(dragged800.overflow,false);
  assert.ok(Math.abs(dragged800.width - dragged800.panelWidth) <= 1,'rendered rail fills the dragged panel');
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="project-resource-resizer"]')?.focus({preventScroll:true})`,true);
  await waitFor(win,`document.hasFocus() && document.activeElement?.dataset.testid === 'project-resource-resizer'`,
    'project separator receives native focus before keyboard collapse');
  await pressKey(win,'ENTER');
  await waitCollapsed(true,'native separator Enter collapses the narrow rail and persists the matching intent');
  await pressKey(win,'ENTER');
  await waitCollapsed(false,'native separator Enter expands the narrow rail and persists the matching intent');
  const keyboard800 = await readNarrowRail();
  assert.equal(keyboard800.overflow,false);
  assert.equal(await win.webContents.executeJavaScript(`document.activeElement?.dataset.testid === 'project-resource-resizer'`,true),true,
    'project separator retains focus across keyboard collapse and expansion');
  await focusSeparator();
  await toggleWithShortcut();
  await waitCollapsed(true,'collapse before double-clicking the narrow rail separator');
  await resizeWithPointer('double-click');
  await waitCollapsed(false,'double-clicking a collapsed narrow rail restores expanded content and saved intent');
  const reset800 = await readNarrowRail();
  assert.ok(Math.abs(reset800.width - 224) <= 1,`separator double-click restores 224px: ${JSON.stringify(reset800)}`);
  assert.equal(reset800.overflow,false);

  await collectWindowErrorDiagnostics(win);
  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load',resolve));
  win.reload();
  await loaded;
  await installWindowErrorDiagnostics(win);
  await waitFor(win,`document.querySelector('[data-shell-ready="true"]') !== null`,
    'pointer-resized narrow project rail reload ready');
  await waitCollapsed(false,'pointer-expanded narrow project rail survives reload without stale collapsed content');
  const reloaded800 = await readNarrowRail();
  assert.equal(reloaded800.overflow,false);
  assert.ok(Math.abs(reloaded800.width - reloaded800.panelWidth) <= 1);
  process.stdout.write(`Narrow project rail evidence: ${JSON.stringify({theme,compact800,expanded800,compact640,constrainedDrag,constrainedReset,restored800,dragged800,keyboard800,reset800,reloaded800})}\n`);
  win.setContentSize(1280,820);
  await waitFor(win,`innerWidth === 1280 && innerHeight === 820`,'viewport restored after compact rail regression');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'false'
    && document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width >= 175.5`,
  'wide viewport restores the persisted expanded project rail intent');
  await captureRenderedFrame(win);
  assert.equal((await readNarrowRail()).overflow,false);
  await resizeWithPointer('double-click');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'false'
    && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 224) <= 1`,
    'wide separator double-click establishes a 224px expanded width');
  const wideBeforeConstraint = await readNarrowRail();
  assert.equal(JSON.parse(wideBeforeConstraint.saved).projectCollapsed,false);
  await narrowViewport(640,'compress the explicit wide 224px rail temporarily');
  await waitFor(win,`document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'true'
    && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 128) <= 1`,
    'explicit wide width temporarily uses the constrained 128px rail');
  assert.equal((await readNarrowRail()).saved,wideBeforeConstraint.saved);
  win.setContentSize(1280,820);
  try {
    await waitFor(win,`innerWidth === 1280 && innerHeight === 820
      && document.querySelector('[data-testid="project-rail"]')?.dataset.collapsed === 'false'
      && Math.abs(document.querySelector('[data-testid="project-rail"]')?.getBoundingClientRect().width - 224) <= 1`,
      'returning to the same wide viewport restores 224px without shrinking to the 176px minimum');
  } catch (error) {
    throw new Error(`${error.message}\nWide width restoration evidence: ${JSON.stringify({before:wideBeforeConstraint,after:await readNarrowRail()})}`);
  }
  await captureRenderedFrame(win);
  const wideAfterConstraint = await readNarrowRail();
  assert.equal(wideAfterConstraint.saved,wideBeforeConstraint.saved);
  assert.equal(wideAfterConstraint.overflow,false);
  process.stdout.write(`Wide project rail restoration evidence: ${JSON.stringify({theme,before:wideBeforeConstraint,after:wideAfterConstraint})}\n`);
}

const visualEvidenceViewports = [
  [960,640],
  [1280,820],
];

async function selectVisualScope(win,kind) {
  const selectors = {
    project:'[data-project-id="project-operations"]',
    environment:'[data-environment-id="env-production-east"] [data-shell-nav-item]',
    plugin:'[data-testid="plugin-trigger-plugin-app-server"]',
  };
  const selector = selectors[kind];
  assert.ok(selector,`unknown visual scope ${kind}`);
  if (kind === 'environment') {
    const point = await win.webContents.executeJavaScript(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) throw new Error('environment scope trigger missing');
      target.scrollIntoView({block:'nearest'});
      const rect = target.getBoundingClientRect();
      return {x:Math.round(rect.left+32),y:Math.round(rect.top+rect.height/2)};
    })()`,true);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point});
    await waitFor(win,`Array.from(document.querySelectorAll('[role="menuitem"]')).some((item) => item.textContent.trim() === '查看环境')`,
      'environment context menu exposes the explicit view action');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.trim() === '查看环境')?.click()`,true);
  } else {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  })()`,true);
  assert.equal(clicked,true,`${kind} visual scope trigger missing`);
  }
  await waitFor(
    win,
    `document.querySelector('#detail-main')?.dataset.selectionKind === ${JSON.stringify(kind)}`,
    `${kind} visual scope`,
  );
}

async function selectVisualTab(win,tab,readySelector,label) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector(${JSON.stringify(`[data-detail-tab="${tab}"]`)});
    if (!(tab instanceof HTMLElement)) return false;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown',{
      bubbles:true,
      cancelable:true,
      code:'Enter',
      key:'Enter',
    }));
    return true;
  })()`,true);
  assert.equal(clicked,true,`${label} tab trigger missing`);
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(`[data-detail-tab="${tab}"]`)})?.getAttribute('aria-selected') === 'true'`,
    `${label} selected tab`,
  );
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(readySelector)})?.getClientRects().length > 0`,
    `${label} feature`,
  );
}

async function captureVisualScenario(win,{name,readySelector,theme,viewports = visualEvidenceViewports}) {
  for (const [width,height] of viewports) {
    win.setContentSize(width,height);
    await waitFor(
      win,
      `Math.abs(window.innerWidth - ${width}) <= 2 && Math.abs(window.innerHeight - ${height}) <= 2`,
      `${name} viewport at ${width}x${height}`,
    );
    await waitFor(
      win,
      `document.querySelector(${JSON.stringify(readySelector)})?.getClientRects().length > 0`,
      `${name} at ${width}x${height}`,
    );
    // setContentSize changes CSS geometry before the hidden renderer has
    // painted and delivered the Resizable observer/layout commits. Request a
    // fresh frame before measuring; a fixed delay is not a render barrier.
    await captureRenderedFrame(win);
    const automaticTabScroll = await win.webContents.executeJavaScript(`(() => {
      const selected = document.querySelector('[data-testid="detail-tabs"] [role="tab"][aria-selected="true"]');
      const list = selected?.closest('[data-testid="detail-tabs"]');
      const viewport = list?.closest('[data-slot="scroll-area"]')
        ?.querySelector('[data-slot="scroll-area-viewport"]');
      const selectedRect = selected?.getBoundingClientRect() ?? null;
      const viewportRect = viewport?.getBoundingClientRect() ?? null;
      return {
        selectedRect:selectedRect
          ? [selectedRect.left,selectedRect.top,selectedRect.right,selectedRect.bottom]
          : null,
        selectedVisible:Boolean(
          selectedRect && viewportRect
          && selectedRect.left >= viewportRect.left - 1
          && selectedRect.right <= viewportRect.right + 1
        ),
        viewportRect:viewportRect
          ? [viewportRect.left,viewportRect.top,viewportRect.right,viewportRect.bottom]
          : null,
        viewportScroll:viewport
          ? [viewport.scrollLeft,viewport.clientWidth,viewport.scrollWidth]
          : null,
      };
    })()`,true);
    await win.webContents.executeJavaScript(`(() => {
      const selected = document.querySelector('[data-testid="detail-tabs"] [role="tab"][aria-selected="true"]');
      if (!(selected instanceof HTMLElement)) return false;
      selected.focus();
      selected.scrollIntoView({block:'nearest',inline:'nearest'});
      const list = selected.closest('[data-testid="detail-tabs"]');
      const viewport = list?.closest('[data-slot="scroll-area"]')
        ?.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport instanceof HTMLElement) {
        const selectedRect = selected.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        if (selectedRect.right > viewportRect.right) viewport.scrollLeft += selectedRect.right - viewportRect.right;
        if (selectedRect.left < viewportRect.left) viewport.scrollLeft -= viewportRect.left - selectedRect.left;
      }
      return true;
    })()`,true);
    await wait(200);

    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const shell = document.querySelector('[data-testid="react-app-shell"]');
      const projectRail = document.querySelector('[data-testid="project-rail"]');
      const projectPanel = projectRail?.closest('[data-slot="resizable-panel"]') ?? null;
      const list = document.querySelector('[data-testid="detail-tabs"]');
      const selectedTabs = list ? [...list.querySelectorAll('[role="tab"][aria-selected="true"]')] : [];
      const selectedTab = selectedTabs[0] ?? null;
      const viewport = list?.closest('[data-slot="scroll-area"]')
        ?.querySelector('[data-slot="scroll-area-viewport"]') ?? null;
      const selectedRect = selectedTab?.getBoundingClientRect() ?? null;
      const viewportRect = viewport?.getBoundingClientRect() ?? null;
      const auditCompact = document.querySelector('[data-audit-layout="compact"]');
      const auditTable = document.querySelector('[data-audit-layout="table"]');
      const visible = (element) => {
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const overlapArea = (left,right) => ({
        x:Math.min(left.right,right.right) - Math.max(left.left,right.left),
        y:Math.min(left.bottom,right.bottom) - Math.max(left.top,right.top),
      });
      const actionGroups = [...document.querySelectorAll('[data-slot="button-group"], div, header, footer, form')]
        .map((group) => ({
          group,
          buttons:[...group.querySelectorAll(':scope > button')].filter(visible),
        }))
        .filter(({buttons}) => buttons.length >= 2)
        .map(({group,buttons},groupIndex) => {
          const rects = buttons.map((button) => button.getBoundingClientRect());
          const overlaps = [];
          for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
              const area = overlapArea(rects[leftIndex],rects[rightIndex]);
              if (area.x > 1 && area.y > 1) {
                overlaps.push([
                  buttons[leftIndex].textContent?.trim() || buttons[leftIndex].getAttribute('aria-label'),
                  buttons[rightIndex].textContent?.trim() || buttons[rightIndex].getAttribute('aria-label'),
                ]);
              }
            }
          }
          return {
            group:group.getAttribute('aria-label') || group.dataset.slot || group.tagName + '-' + groupIndex,
            labelsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
            overlaps,
          };
        });
      return {
        auditLayouts:{compact:visible(auditCompact),table:visible(auditTable)},
        body:[body.clientWidth,body.scrollWidth],
        root:[root.clientWidth,root.scrollWidth],
        shell:[shell?.clientWidth ?? 0,shell?.scrollWidth ?? 0],
        featureVisible:document.querySelector(${JSON.stringify(readySelector)})?.getClientRects().length > 0,
        projectRail:projectRail && projectPanel ? {
          collapsed:projectRail.getAttribute('data-collapsed') === 'true',
          width:projectPanel.getBoundingClientRect().width,
          offsetWidth:projectPanel.offsetWidth,
          viewport:[window.innerWidth,window.innerHeight],
          groupWidth:projectPanel.parentElement?.getBoundingClientRect().width ?? null,
          flexGrow:getComputedStyle(projectPanel).flexGrow,
        } : null,
        tabs:list ? {
          focused:document.activeElement === selectedTab,
          selectedCount:selectedTabs.length,
          selectedRect:selectedRect
            ? [selectedRect.left,selectedRect.top,selectedRect.right,selectedRect.bottom]
            : null,
          selectedVisible:Boolean(
            selectedRect && viewportRect
            && selectedRect.left >= viewportRect.left - 1
            && selectedRect.right <= viewportRect.right + 1
          ),
          viewportRect:viewportRect
            ? [viewportRect.left,viewportRect.top,viewportRect.right,viewportRect.bottom]
            : null,
          viewportScroll:viewport
            ? [viewport.scrollLeft,viewport.clientWidth,viewport.scrollWidth]
            : null,
        } : null,
        actionGroups,
      };
    })()`,true);

    assert.equal(snapshot.featureVisible,true,`${name} ${width}x${height} feature not visible`);
    assert.ok(snapshot.body[1] <= snapshot.body[0] + 1,`${name} ${width}x${height} body overflow`);
    assert.ok(snapshot.root[1] <= snapshot.root[0] + 1,`${name} ${width}x${height} root overflow`);
    assert.ok(snapshot.shell[1] <= snapshot.shell[0] + 1,`${name} ${width}x${height} shell overflow`);
    if (snapshot.projectRail && !snapshot.projectRail.collapsed) {
      assert.ok(
        snapshot.projectRail.width >= 175.5,
        `${name} ${width}x${height} project rail is partially collapsed: ${JSON.stringify(snapshot.projectRail)}`,
      );
    }
    if (snapshot.tabs) {
      assert.equal(snapshot.tabs.focused,true,`${name} ${width}x${height} selected detail tab is not focused`);
      assert.equal(snapshot.tabs.selectedCount,1,`${name} ${width}x${height} detail tab selection count`);
      if (!automaticTabScroll.selectedVisible) accessibilityFailures.push({
        automaticTabScroll,height,kind:'selected-detail-tab-auto-scroll-failed',name,width,
      });
      if (!snapshot.tabs.selectedVisible) accessibilityFailures.push({
        automaticTabScroll,height,kind:'selected-detail-tab-clipped',name,tabs:snapshot.tabs,width,
      });
    }
    if (name === 'audit') {
      assert.deepEqual(
        snapshot.auditLayouts,
        width === 960 ? {compact:true,table:false} : {compact:false,table:true},
        `${name} ${width}x${height} responsive layout`,
      );
    }
    for (const group of snapshot.actionGroups) {
      assert.deepEqual(group.overlaps,[],`${name} ${width}x${height} button overlap in ${group.group}`);
      assert.equal(group.labelsFit,true,`${name} ${width}x${height} clipped button label in ${group.group}`);
    }

    if (readySelector === '[data-testid="environment-overview"]') {
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('[data-testid="environment-connection-panel"]');
        const visible = (element) => element.getClientRects().length > 0;
        const fits = (element,container) => {
          const rect = element.getBoundingClientRect();
          const bounds = container.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        };
        const controls = [...panel.querySelectorAll('button')].filter(visible);
        const badges = [...panel.querySelectorAll('[data-testid="environment-plugin-list"] [data-status]')].filter(visible);
        const names = controls.filter((button) => button.dataset.testid?.startsWith('environment-plugin-detail-'));
        return {
          controlsInside:controls.every((button) => fits(button,button.closest('[data-slot="card"]'))),
          badgesInside:badges.every((badge) => fits(badge,badge.closest('[data-slot="card"]'))),
          namesFit:names.every((button) => button.scrollWidth <= button.clientWidth + 1),
          mobileStatusClear:names.every((button) => {
            const item = button.closest('[data-slot="item"]');
            const badge = item?.querySelector('[data-status]');
            if (!badge) return true;
            const nameRect = button.getBoundingClientRect();
            const badgeRect = badge.getBoundingClientRect();
            return nameRect.right <= badgeRect.left + 1 || nameRect.bottom <= badgeRect.top + 1;
          }),
        };
      })()`,true);
      assert.deepEqual(geometry,{controlsInside:true,badgesInside:true,namesFit:true,mobileStatusClear:true},
        `${name} ${width}x${height} environment controls and long plugin names stay inside their cards`);
    }

    const image = await captureRenderedFrame(win);
    fs.writeFileSync(
      path.join(screenshotRoot,`scenario-${name}-${theme}-${width}x${height}.png`),
      image.toPNG(),
    );
  }
}

async function captureOverlayVisualEvidence(win,{name,readySelector,restoreFocusSelector,theme}) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(readySelector)})?.getClientRects().length > 0`,
    `${name} visual evidence`,
  );
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    true,
  );
  win.webContents.invalidate();
  await waitFor(
    win,
    `(() => {
      const surface = document.querySelector(${JSON.stringify(readySelector)});
      if (!(surface instanceof HTMLElement)) return false;
      const style = getComputedStyle(surface);
      const rect = surface.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + Math.min(rect.height / 2,80),
      );
      return parseFloat(style.opacity) >= 0.99
        && style.visibility === 'visible'
        && target !== null
        && (surface === target || surface.contains(target));
    })()`,
    `${name} painted top layer`,
  );
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const surface = document.querySelector(${JSON.stringify(readySelector)});
    if (!(surface instanceof HTMLElement)) return null;
    const rect = surface.getBoundingClientRect();
    const surfaceStyle = getComputedStyle(surface);
    const centerTarget = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + Math.min(rect.height / 2,80),
    );
    const visible = (element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...surface.querySelectorAll('button,input,textarea')]
      .filter(visible);
    const buttons = controls.filter((control) => control instanceof HTMLButtonElement);
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < buttons.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < buttons.length; rightIndex += 1) {
        const left = buttons[leftIndex].getBoundingClientRect();
        const right = buttons[rightIndex].getBoundingClientRect();
        const overlapX = Math.min(left.right,right.right) - Math.max(left.left,right.left);
        const overlapY = Math.min(left.bottom,right.bottom) - Math.max(left.top,right.top);
        if (overlapX > 1 && overlapY > 1) overlaps.push([leftIndex,rightIndex]);
      }
    }
    return {
      body:[body.clientWidth,body.scrollWidth],
      buttonsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
      controlsInside:controls.every((control) => {
        const candidate = control.getBoundingClientRect();
        return candidate.left >= -1 && candidate.top >= -1
          && candidate.right <= window.innerWidth + 1
          && candidate.bottom <= window.innerHeight + 1;
      }),
      overlaps,
      painted:Boolean(
        parseFloat(surfaceStyle.opacity) >= 0.99
        && surfaceStyle.display !== 'none'
        && surfaceStyle.visibility === 'visible'
        && centerTarget
        && (surface === centerTarget || surface.contains(centerTarget))
      ),
      paintTarget:centerTarget instanceof HTMLElement ? {
        slot:centerTarget.dataset.slot ?? null,
        tag:centerTarget.tagName,
        testId:centerTarget.dataset.testid ?? null,
      } : null,
      root:[root.clientWidth,root.scrollWidth],
      state:surface.getAttribute('data-state'),
      surfaceInside:rect.left >= -1 && rect.top >= -1
        && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
      viewport:[window.innerWidth,window.innerHeight],
    };
  })()`,true);
  assert.ok(snapshot,`${name} visual surface missing`);
  assert.equal(snapshot.surfaceInside,true,`${name} surface exceeds viewport`);
  assert.equal(snapshot.state,'open',`${name} surface is not open`);
  assert.equal(snapshot.painted,true,`${name} surface is not the painted top layer: ${JSON.stringify(snapshot)}`);
  assert.ok(Math.abs(snapshot.viewport[0] - 1280) <= 2,`${name} screenshot width is not 1280: ${snapshot.viewport}`);
  assert.ok(Math.abs(snapshot.viewport[1] - 820) <= 2,`${name} screenshot height is not 820: ${snapshot.viewport}`);
  assert.equal(snapshot.controlsInside,true,`${name} control exceeds viewport`);
  assert.equal(snapshot.buttonsFit,true,`${name} button label is clipped`);
  assert.deepEqual(snapshot.overlaps,[],`${name} buttons overlap`);
  assert.ok(snapshot.body[1] <= snapshot.body[0] + 1,`${name} body overflow`);
  assert.ok(snapshot.root[1] <= snapshot.root[0] + 1,`${name} root overflow`);
  const image = await captureRenderedFrame(win);
  fs.writeFileSync(
    path.join(screenshotRoot,`overlay-${name}-${theme}-1280x820.png`),
    image.toPNG(),
  );
  if (restoreFocusSelector) {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(restoreFocusSelector)})?.focus()`,
      true,
    );
    await waitFor(
      win,
      `document.activeElement?.matches(${JSON.stringify(restoreFocusSelector)}) === true`,
      `${name} focus restoration after screenshot`,
    );
  }
}

async function captureReadOnlyVisualEvidence(win,theme) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});

  await selectVisualScope(win,'project');
  await waitFor(win,`document.querySelector('[data-testid="project-overview"]') !== null`,'project overview evidence');
  await captureVisualScenario(win,{
    name:'project-overview',
    readySelector:'[data-testid="project-overview"]',
    theme,
  });

  await selectVisualScope(win,'environment');
  await waitFor(win,`document.querySelector('[data-testid="environment-overview"]') !== null`,'environment overview evidence');
  await captureVisualScenario(win,{
    name:'environment-overview',
    readySelector:'[data-testid="environment-overview"]',
    theme,
  });

  await selectVisualTab(win,'runbook','[data-feature="runbook"]','runbook');
  await captureVisualScenario(win,{
    name:'runbook',
    readySelector:'[data-feature="runbook"]',
    theme,
  });

  await selectVisualTab(win,'questions','[data-feature="quick-questions"]','quick questions');
  await captureVisualScenario(win,{
    name:'quick-questions',
    readySelector:'[data-feature="quick-questions"]',
    theme,
  });
  win.setContentSize(1280,820);
  await waitFor(
    win,
    `Math.abs(window.innerWidth - 1280) <= 2 && Math.abs(window.innerHeight - 820) <= 2`,
    'date picker screenshot viewport',
  );
  const openedDatePicker = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('#quick-question-date');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.focus();
    trigger.click();
    return true;
  })()`,true);
  assert.equal(openedDatePicker,true,'quick-question date picker trigger missing');
  await captureOverlayVisualEvidence(win,{
    name:'date-picker',
    readySelector:'[data-slot="popover-content"]',
    restoreFocusSelector:'#quick-question-date',
    theme,
  });
  await pressKey(win,'ESCAPE');
  await waitFor(
    win,
    `document.querySelector('[data-slot="popover-content"]') === null`,
    'date picker Escape close',
  );

  await selectVisualTab(win,'audit','[data-feature="audit"]','audit');
  await captureVisualScenario(win,{
    name:'audit',
    readySelector:'[data-feature="audit"]',
    theme,
  });

  await selectVisualTab(win,'confirmations','[data-feature="confirmations"]','confirmations');
  await captureVisualScenario(win,{
    name:'confirmations',
    readySelector:'[data-feature="confirmations"]',
    theme,
  });

  await selectVisualScope(win,'environment');
  await selectVisualScope(win,'plugin');
  await waitFor(win,`document.querySelector('[data-testid="plugin-overview"]') !== null`,'plugin overview evidence');
  await captureVisualScenario(win,{
    name:'plugin-overview',
    readySelector:'[data-testid="plugin-overview"]',
    theme,
  });

  await selectVisualTab(win,'agent','[data-testid="plugin-agent-access"]','plugin agent access');
  await captureVisualScenario(win,{
    name:'plugin-agent-access',
    readySelector:'[data-testid="plugin-agent-access"]',
    theme,
  });

  await selectVisualTab(win,'overview','[data-testid="plugin-overview"]','plugin overview restore');
}

async function assertFocusLoop(win,{containerSelector,initialSelector,label}) {
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    if (!(container instanceof HTMLElement)) return null;
    const candidates = [...container.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )].filter((element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
    });
    const first = candidates[0] ?? null;
    const last = candidates.at(-1) ?? null;
    first?.setAttribute('data-smoke-focus-boundary','first');
    last?.setAttribute('data-smoke-focus-boundary','last');
    const active = document.activeElement;
    return {
      activeInside:Boolean(active && container.contains(active)),
      count:candidates.length,
      initialMatches:${initialSelector ? `active?.matches(${JSON.stringify(initialSelector)}) === true` : 'true'},
      initialTag:active instanceof HTMLElement
        ? active.id || active.getAttribute('data-slot') || active.getAttribute('aria-label') || active.tagName
        : null,
    };
  })()`,true);
  assert.ok(snapshot,`${label} missing`);
  assert.equal(snapshot.activeInside,true,`${label} initial focus escaped: ${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.initialMatches,true,`${label} unexpected initial focus: ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.count >= 2,`${label} has fewer than two focusable controls: ${JSON.stringify(snapshot)}`);

  await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(`${containerSelector} [data-smoke-focus-boundary="last"]`)})?.focus()`,
    true,
  );
  await pressKey(win,'TAB');
  await waitFor(
    win,
    `document.activeElement?.matches(${JSON.stringify(`${containerSelector} [data-smoke-focus-boundary="first"]`)}) === true`,
    `${label} forward focus loop`,
  );

  await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(`${containerSelector} [data-smoke-focus-boundary="first"]`)})?.focus()`,
    true,
  );
  await pressKey(win,'TAB',['shift']);
  await waitFor(
    win,
    `document.activeElement?.matches(${JSON.stringify(`${containerSelector} [data-smoke-focus-boundary="last"]`)}) === true`,
    `${label} reverse focus loop`,
  );
  return snapshot;
}

async function assertEscapeFocusRestore(win,{containerSelector,label,restoreSelector}) {
  await pressKey(win,'ESCAPE');
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(containerSelector)}) === null`,
    `${label} Escape close`,
  );
  await captureRenderedFrame(win);
  let restoreTimedOut = false;
  try {
    await waitFor(win,
      `document.activeElement?.matches(${JSON.stringify(restoreSelector)}) === true`,
      `${label} exact return focus after Radix teardown`);
  } catch {
    restoreTimedOut = true;
  }
  const restored = await win.webContents.executeJavaScript(`(() => {
    const active = document.activeElement;
    const target = document.querySelector(${JSON.stringify(restoreSelector)});
    const hiddenAncestor = target?.closest('[inert],[aria-hidden="true"]');
    const describe = (element) => element instanceof HTMLElement ? {
      tag:element.tagName,id:element.id || null,slot:element.dataset.slot ?? null,
      testId:element.dataset.testid ?? null,state:element.dataset.state ?? null,
      ariaHidden:element.getAttribute('aria-hidden'),inert:element.hasAttribute('inert'),
      visible:element.getClientRects().length > 0,
    } : null;
    return {
      active:active instanceof HTMLElement ? {
        tag:active.tagName,
        role:active.getAttribute('role'),
        id:active.id || null,
        slot:active.getAttribute('data-slot'),
        testId:active.getAttribute('data-testid'),
      } : null,
      documentHasFocus:document.hasFocus(),
      hiddenAncestor:describe(hiddenAncestor),
      modals:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(describe),
      matches:active?.matches(${JSON.stringify(restoreSelector)}) === true,
      restoreTarget:describe(target),
      restoreTargetConnected:Boolean(target?.isConnected),
    };
  })()`,true);
  if (!restored.matches) {
    const failure = {kind:'focus-restore-failed',label,restoreSelector,restoreTimedOut,restored};
    accessibilityFailures.push(failure);
    process.stderr.write(`Focus restoration evidence: ${JSON.stringify(failure)}\n`);
  }
}

async function openCreateProjectDialog(win) {
  const opened = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('[data-testid="add-project-footer"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.focus();
    trigger.click();
    return true;
  })()`,true);
  assert.equal(opened,true,'create-project trigger missing');
  await waitFor(
    win,
    `document.querySelector('[data-testid="create-project-dialog"]') !== null`,
    'real create-project dialog',
  );
  await waitFor(win,`document.activeElement?.id === 'new-project-name'`,'create-project initial focus');
}

async function assertModalShortcutIsolation(win) {
  await win.webContents.executeJavaScript(`(() => {
    const probe = {
      original:document.querySelector('[data-testid="create-project-dialog"]'),
      maxVisible:0,
      samples:[],
    };
    probe.sample = () => {
      const visible = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      const sample = {
        count:visible.length,
        command:document.querySelector('[data-testid="global-command"]') !== null,
        create:document.querySelector('[data-testid="create-project-dialog"]') !== null,
      };
      probe.maxVisible = Math.max(probe.maxVisible,sample.count);
      if (JSON.stringify(sample) !== JSON.stringify(probe.samples.at(-1))) probe.samples.push(sample);
      return sample;
    };
    probe.observer = new MutationObserver(probe.sample);
    probe.observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state','hidden','style']});
    probe.sample();
    window.__foundationModalProbe = probe;
  })()`,true);
  try {
    const initial = await win.webContents.executeJavaScript(`window.__foundationModalProbe.sample()`,true);
    assert.deepEqual(initial,{count:1,command:false,create:true},
      'modal shortcut regression must begin after the previous Command has unmounted');
    for (const key of ['k','n']) {
      await pressKey(win,key,['control']);
      const blocked = await win.webContents.executeJavaScript(`(() => {
        const probe = window.__foundationModalProbe;
        return {
          ...probe.sample(),
          sameDialog:probe.original === document.querySelector('[data-testid="create-project-dialog"]'),
          focused:probe.original?.contains(document.activeElement) === true,
        };
      })()`,true);
      assert.deepEqual(blocked,{count:1,command:false,create:true,sameDialog:true,focused:true},
        `Ctrl+${key.toUpperCase()} must not stack or replace an active create-project Dialog`);
    }
    await pressKey(win,'ESCAPE');
    await waitFor(win,
      `document.querySelector('[data-testid="create-project-dialog"]') === null`,
      'create-project closes before the Command handoff');
    await pressKey(win,'k',['control']);
    await waitFor(win,
      `document.querySelector('[data-testid="global-command"]') !== null && document.activeElement?.matches('[cmdk-input]') === true`,
      'real Ctrl+K opens Command after the Dialog closes');
    await win.webContents.insertText('新增项目');
    await waitFor(win,
      `[...document.querySelectorAll('[cmdk-item][aria-selected="true"]')].some((item) => item.getAttribute('data-value')?.startsWith('action:create-project '))`,
      'keyboard search selects the create-project command');
    await pressKey(win,'ENTER');
    await captureRenderedFrame(win);
    await waitFor(win,
      `document.querySelector('[data-testid="global-command"]') === null
        && document.querySelector('[data-testid="create-project-dialog"]') !== null
        && document.activeElement?.id === 'new-project-name'`,
      'Command hands focus to create-project only after closing');
    const handoff = await win.webContents.executeJavaScript(`(() => {
      const probe = window.__foundationModalProbe;
      return {...probe.sample(),maxVisible:probe.maxVisible,samples:probe.samples};
    })()`,true);
    assert.equal(handoff.count,1,'Command-to-create handoff must end with one modal');
    assert.equal(handoff.maxVisible,1,`Command-to-create handoff stacked modals: ${JSON.stringify(handoff)}`);
    assert.deepEqual(mutationCalls,[],'modal shortcut navigation must remain zero-mutation');
    process.stdout.write(`Modal shortcut evidence: ${JSON.stringify(handoff)}\n`);
  } catch (error) {
    const modalState = await win.webContents.executeJavaScript(`(() => ({
      maxVisible:window.__foundationModalProbe?.maxVisible,
      samples:window.__foundationModalProbe?.samples,
      active:document.activeElement instanceof HTMLElement ? {
        tag:document.activeElement.tagName,id:document.activeElement.id,
        slot:document.activeElement.dataset.slot ?? null,
      } : null,
      modals:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((element) => ({
        state:element.getAttribute('data-state'),testId:element.getAttribute('data-testid'),
        containsCommand:element.querySelector('[data-testid="global-command"]') !== null,
        opacity:getComputedStyle(element).opacity,display:getComputedStyle(element).display,
      })),
    }))()`,true);
    throw new Error(`${error.message}: ${JSON.stringify(modalState)}`,{cause:error});
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      window.__foundationModalProbe?.observer.disconnect();
      delete window.__foundationModalProbe;
    })()`,true);
  }
}

async function openProjectSettings(win) {
  await selectVisualScope(win,'project');
  await waitFor(win,`document.querySelector('[data-testid="project-overview"]') !== null`,'project overview before settings');
  const openedMenu = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('button[aria-label="当前范围更多操作"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.focus();
    return true;
  })()`,true);
  assert.equal(openedMenu,true,'project settings menu trigger missing');
  await pressKey(win,'ENTER');
  await waitFor(
    win,
    `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent?.includes('项目设置') && item.getClientRects().length > 0)`,
    'project settings menu item',
  );
  const selected = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((candidate) => candidate.textContent?.includes('项目设置') && candidate.getClientRects().length > 0);
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`,true);
  assert.equal(selected,true,'project settings menu selection failed');
  await waitFor(
    win,
    `document.querySelector('[data-testid="project-settings-dialog"]') !== null
      && document.querySelector('[role="menu"]') === null
      && document.activeElement?.id === 'project-settings-name'`,
    'project settings dialog receives focus after its menu has closed',
  );
}

async function openDeleteProjectAlert(win) {
  await selectVisualScope(win,'project');
  const opened = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('[data-project-id="project-operations"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.setAttribute('data-smoke-alert-opener','true');
    trigger.focus();
    const rect = trigger.getBoundingClientRect();
    trigger.dispatchEvent(new MouseEvent('contextmenu',{
      bubbles:true,cancelable:true,button:2,
      clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,
    }));
    return true;
  })()`,true);
  assert.equal(opened,true,'delete-project context-menu trigger missing');
  await waitFor(win,
    `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent?.trim() === '删除项目' && item.getClientRects().length > 0)`,
    'direct delete-project menu item');
  const selected = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((candidate) => candidate.textContent?.trim() === '删除项目' && candidate.getClientRects().length > 0);
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`,true);
  assert.equal(selected,true,'direct delete-project menu selection failed');
  await waitFor(
    win,
    `document.querySelector('[data-testid="delete-project-dialog"]') !== null`,
    'delete-project alert dialog',
  );
  const modalCount = await win.webContents.executeJavaScript(`(() => (
    [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((surface) => surface.getClientRects().length > 0).length
  ))()`,true);
  assert.equal(modalCount,1,'project deletion must open one standalone AlertDialog, not stacked settings');
  assert.equal(await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="project-settings-dialog"]') === null`,true,
  ),true,'direct deletion must not open project settings');
}

async function assertCreatePluginWorkspace(win,theme) {
  await setZoomFactorAndWait(win,1,{width:1280,height:820});
  await selectVisualScope(win,'environment');
  await selectVisualScope(win,'plugin');
  const opened = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('[data-testid="add-plugin-env-production-east"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.focus();
    trigger.click();
    return true;
  })()`,true);
  assert.equal(opened,true,'create-plugin trigger missing');
  await waitFor(win,
    `document.querySelector('[data-testid="plugin-editor-workspace"]') !== null && document.querySelector('#plugin-display-name') !== null`,
    'non-modal create-plugin workspace');

  for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
    win.setContentSize(width,height);
    await waitFor(win,
      `Math.abs(window.innerWidth-${width}) <= 2 && Math.abs(window.innerHeight-${height}) <= 2`,
      `create-plugin workspace ${width}x${height}`);
    await wait(180);
    const snapshot = await win.webContents.executeJavaScript(`(() => {
      const workspace = document.querySelector('[data-testid="plugin-editor-workspace"]');
      const resource = document.querySelector('[data-testid="resource-pane"]');
      const project = document.querySelector('[data-testid="project-rail"]');
      const footer = workspace?.querySelector('[data-testid="plugin-editor-footer"]');
      if (!(workspace instanceof HTMLElement) || !(footer instanceof HTMLElement)) return null;
      const rect = workspace.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const inside = (candidate) => candidate.left >= -1 && candidate.top >= -1
        && candidate.right <= window.innerWidth+1 && candidate.bottom <= window.innerHeight+1;
      const metrics = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          bounds:[bounds.left,bounds.top,bounds.right,bounds.bottom,bounds.width,bounds.height],
          client:[element.clientWidth,element.clientHeight],
          scroll:[element.scrollWidth,element.scrollHeight,element.scrollLeft,element.scrollTop],
          style:{
            display:style.display,height:style.height,minHeight:style.minHeight,maxHeight:style.maxHeight,
            width:style.width,minWidth:style.minWidth,overflowX:style.overflowX,overflowY:style.overflowY,
            flex:style.flex,flexDirection:style.flexDirection,position:style.position,
          },
        };
      };
      const buttons = [...footer.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0);
      return {
        viewport:[window.innerWidth,window.innerHeight],
        bounds:[rect.left,rect.top,rect.right,rect.bottom,rect.width,rect.height],
        footerBounds:[footerRect.left,footerRect.top,footerRect.right,footerRect.bottom],
        geometry:{
          html:metrics(document.documentElement),body:metrics(document.body),root:metrics(document.querySelector('#root')),
          shell:metrics(document.querySelector('[data-testid="react-app-shell"]')),
          group:metrics(workspace.closest('[data-slot="resizable-panel-group"]')),
          panel:metrics(workspace.closest('[data-slot="resizable-panel"]')),
          workspace:metrics(workspace),
          scrollArea:metrics(workspace.querySelector('[data-testid="plugin-editor-scroll"]')),
          scrollViewport:metrics(workspace.querySelector('[data-testid="plugin-editor-scroll"] [data-slot="scroll-area-viewport"]')),
          footer:metrics(footer),
        },
        scope:workspace.dataset.scope,
        title:document.querySelector('#plugin-editor-title')?.textContent?.trim(),
        inLastPanel:workspace.closest('[data-slot="resizable-panel"]') === [...document.querySelectorAll('[data-slot="resizable-panel"]')].at(-1),
        modals:document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length,
        railsVisible:Boolean(project?.getClientRects().length && resource?.getClientRects().length),
        railsInert:Boolean(project?.closest('[inert],[aria-hidden="true"]') || resource?.closest('[inert],[aria-hidden="true"]')),
        workspaceInside:inside(rect),
        footerInside:inside(footerRect),
        footerControlsInside:buttons.every((button) => inside(button.getBoundingClientRect())),
        footerLabelsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth+1),
        bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
        rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        workspaceOverflow:workspace.scrollWidth-workspace.clientWidth,
      };
    })()`,true);
    if (!snapshot || !snapshot.workspaceInside || !snapshot.footerInside
      || !snapshot.footerControlsInside || !snapshot.footerLabelsFit
      || snapshot.bodyOverflow > 1 || snapshot.rootOverflow > 1 || snapshot.workspaceOverflow > 1) {
      const failureDirectory = screenshotRoot ?? path.join(dataRoot,'failures');
      fs.mkdirSync(failureDirectory,{recursive:true});
      const failurePath = path.join(failureDirectory,`failure-plugin-create-${theme}-${width}x${height}.png`);
      fs.writeFileSync(failurePath,(await captureRenderedFrame(win)).toPNG());
      process.stderr.write(`Plugin workspace geometry failure screenshot: ${failurePath}\n`);
    }
    assert.ok(snapshot,`create-plugin workspace ${width}x${height} missing`);
    assert.equal(snapshot.scope,'project-operations/env-production-east');
    assert.equal(snapshot.title,'新增插件');
    assert.equal(snapshot.inLastPanel,true,'plugin creation belongs to the third panel');
    assert.equal(snapshot.modals,0,'plugin creation must not open a Dialog or Sheet');
    assert.equal(snapshot.railsVisible,true,'project and environment context remains visible');
    assert.equal(snapshot.railsInert,false,'plugin creation must not make the rails inert');
    assert.equal(snapshot.workspaceInside,true,`create-plugin workspace ${width}x${height} exceeds viewport: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshot.footerInside,true,`create-plugin footer ${width}x${height} exceeds viewport: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshot.footerControlsInside,true,`create-plugin footer control ${width}x${height} exceeds viewport: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshot.footerLabelsFit,true,`create-plugin footer label ${width}x${height} is clipped: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.bodyOverflow <= 1 && snapshot.rootOverflow <= 1 && snapshot.workspaceOverflow <= 1,
      `create-plugin workspace ${width}x${height} horizontal overflow: ${JSON.stringify(snapshot)}`);
    if (screenshotRoot) {
      fs.mkdirSync(screenshotRoot,{recursive:true});
      fs.writeFileSync(path.join(screenshotRoot,`workspace-plugin-create-${theme}-${width}x${height}.png`),
        (await captureRenderedFrame(win)).toPNG());
    }
  }
  await setZoomFactorAndWait(win,1,{width:1280,height:820});
  await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="project-operations"]')?.focus()`,true);
  await waitFor(win,
    `document.activeElement === document.querySelector('[data-project-id="project-operations"]')`,
    'non-modal plugin workspace allows rail focus');
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-testid="plugin-editor-footer"] button:not([disabled])')].at(-1);
    button?.focus();
  })()`,true);
  await pressKey(win,'TAB');
  assert.equal(await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="plugin-editor-workspace"]')?.contains(document.activeElement)`,true,
  ),false,'non-modal plugin workspace must not trap Tab focus');

  const draftName = '零变更草稿验证';
  await win.webContents.executeJavaScript(`(() => {
    const probe = {phase:'enter-draft',events:[]};
    probe.listener = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      probe.events.push({
        phase:probe.phase,event:event.type,id:target.id,tag:target.tagName,
        testId:target.dataset.testid ?? null,slot:target.dataset.slot ?? null,
      });
      if (probe.events.length > 48) probe.events.shift();
    };
    document.addEventListener('focusin',probe.listener,true);
    document.addEventListener('focusout',probe.listener,true);
    window.__foundationPluginFocusProbe = probe;
    const input = document.querySelector('#plugin-display-name');
    if (!(input instanceof HTMLInputElement)) throw new Error('plugin display-name input missing');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(draftName)});
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`,true);
  await waitFor(win,
    `document.querySelector('[data-testid="plugin-editor-workspace"]')?.textContent?.includes('未保存') === true`,
    'plugin draft becomes dirty without an API call');
  await win.webContents.executeJavaScript(`(() => {
    window.__foundationPluginFocusProbe.phase = 'request-project-navigation';
    document.querySelector('[data-project-id="project-data"]')?.click();
  })()`,true);
  await waitFor(win,
    `document.querySelector('[data-testid="plugin-unsaved-changes-confirmation"]') !== null`,
    'project navigation asks before discarding a plugin draft');
  assert.equal(await win.webContents.executeJavaScript(`(() => (
    document.querySelector('[data-testid="plugin-editor-workspace"]')?.dataset.scope === 'project-operations/env-production-east'
    && document.querySelector('#plugin-display-name')?.value === ${JSON.stringify(draftName)}
    && document.querySelector('[data-project-id="project-operations"]')?.getAttribute('aria-current') === 'page'
  ))()`,true),true,'pending navigation must preserve the original editor scope and draft');
  await captureOverlayVisualEvidence(win,{
    name:'plugin-unsaved-changes',
    readySelector:'[data-testid="plugin-unsaved-changes-confirmation"]',
    restoreFocusSelector:'[data-testid="plugin-unsaved-changes-confirmation"] [data-slot="alert-dialog-cancel"]',
    theme,
  });
  await win.webContents.executeJavaScript(`window.__foundationPluginFocusProbe.phase = 'cancel-navigation'`,true);
  await pressKey(win,'ESCAPE');
  try {
    await waitFor(win,
      `document.querySelector('[data-testid="plugin-unsaved-changes-confirmation"]') === null
        && document.querySelector('#plugin-display-name')?.value === ${JSON.stringify(draftName)}
        && document.activeElement?.id === 'plugin-display-name'`,
      'cancelled navigation keeps the draft and restores editor focus');
  } catch (error) {
    const navigationState = await win.webContents.executeJavaScript(`(() => {
      const active = document.activeElement;
      const workspace = document.querySelector('[data-testid="plugin-editor-workspace"]');
      return {
        active:active instanceof HTMLElement ? {
          id:active.id,tag:active.tagName,testId:active.dataset.testid ?? null,
          slot:active.dataset.slot ?? null,role:active.getAttribute('role'),
        } : null,
        editorContainsFocus:workspace?.contains(active) === true,
        scopePreserved:workspace?.getAttribute('data-scope') === 'project-operations/env-production-east',
        draftRetained:document.querySelector('#plugin-display-name')?.value === ${JSON.stringify(draftName)},
        dirty:workspace?.textContent?.includes('未保存') === true,
        alertState:document.querySelector('[data-testid="plugin-unsaved-changes-confirmation"]')?.getAttribute('data-state') ?? null,
        selectedProjectPreserved:document.querySelector('[data-project-id="project-operations"]')?.getAttribute('aria-current') === 'page',
        modalCount:document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length,
        focusEvents:window.__foundationPluginFocusProbe?.events ?? [],
      };
    })()`,true);
    const failureDirectory = screenshotRoot ?? path.join(dataRoot,'failures');
    fs.mkdirSync(failureDirectory,{recursive:true});
    const failurePath = path.join(failureDirectory,`failure-plugin-discard-focus-${theme}.png`);
    fs.writeFileSync(failurePath,(await captureRenderedFrame(win)).toPNG());
    throw new Error(`${error.message}: ${JSON.stringify(navigationState)}; screenshot: ${failurePath}`,{cause:error});
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      const probe = window.__foundationPluginFocusProbe;
      if (!probe) return;
      document.removeEventListener('focusin',probe.listener,true);
      document.removeEventListener('focusout',probe.listener,true);
      delete window.__foundationPluginFocusProbe;
    })()`,true);
  }
  assert.deepEqual(mutationCalls,[],'creating a local draft and cancelling navigation must remain zero-mutation');

  await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-testid="plugin-editor-cancel"]');
    button?.focus();
    button?.click();
  })()`,true);
  await waitFor(win,
    `document.querySelector('[data-testid="plugin-unsaved-changes-confirmation"]') !== null`,
    'plugin-editor-cancel requests local draft disposal');
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-testid="plugin-unsaved-changes-confirmation"] button')]
      .find((candidate) => candidate.textContent?.trim() === '放弃更改');
    if (!(button instanceof HTMLButtonElement)) throw new Error('plugin discard action missing');
    button.click();
  })()`,true);
  await waitFor(win,
    `document.querySelector('[data-testid="plugin-editor-workspace"]') === null
      && document.querySelector('[data-testid="plugin-overview"]') !== null`,
    'cancelled new-plugin workspace returns to the original detail page');
  await waitFor(win,
    `document.activeElement?.matches('[data-testid="add-plugin-env-production-east"]') === true`,
    'plugin-editor-cancel restores the original create trigger');
  assert.deepEqual(mutationCalls,[],'discarding an unsubmitted create-plugin draft must not call edit-session APIs');
}

async function assertEnvironmentShortSurfaces(win,theme) {
  await setZoomFactorAndWait(win,1,{width:1280,height:820});
  await selectVisualScope(win,'environment');
  for (const kind of ['create','settings','delete']) {
    const testId = kind === 'create' ? 'create-environment-dialog'
      : kind === 'settings' ? 'environment-settings-dialog' : 'delete-environment-dialog';
    const opener = kind === 'create' ? '[data-testid="add-environment-footer"]'
      : '[data-testid="environment-trigger-env-production-east"]';
    await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector(${JSON.stringify(opener)});
      if (!(trigger instanceof HTMLElement)) throw new Error('environment surface trigger missing');
      trigger.focus();
      if (${JSON.stringify(kind)} === 'create') trigger.click();
      else {
        const rect = trigger.getBoundingClientRect();
        trigger.dispatchEvent(new MouseEvent('contextmenu',{
          bubbles:true,cancelable:true,button:2,
          clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,
        }));
      }
    })()`,true);
    if (kind !== 'create') {
      const action = kind === 'settings' ? '环境设置' : '删除环境';
      await waitFor(win,
        `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent?.trim() === ${JSON.stringify(action)} && item.getClientRects().length > 0)`,
        `${kind} environment context-menu item`);
      await win.webContents.executeJavaScript(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(action)} && candidate.getClientRects().length > 0);
        if (!(item instanceof HTMLElement)) throw new Error('environment menu action missing');
        item.click();
      })()`,true);
    }
    const containerSelector = `[data-testid="${testId}"]`;
    const initialSelector = kind === 'create' ? '#new-environment-name'
      : kind === 'settings' ? '#environment-settings-name'
        : `${containerSelector} [data-slot="alert-dialog-cancel"]`;
    await waitFor(win,
      `document.querySelector(${JSON.stringify(containerSelector)}) !== null
        && document.activeElement?.matches(${JSON.stringify(initialSelector)}) === true`,
      `${kind} environment initial focus`);
    await captureOverlayVisualEvidence(win,{
      name:`environment-${kind}`,readySelector:containerSelector,restoreFocusSelector:initialSelector,theme,
    });
    if (kind === 'delete') {
      assert.equal(await win.webContents.executeJavaScript(`(() => {
        const surface = document.querySelector(${JSON.stringify(containerSelector)});
        return surface.textContent.includes('暂时不能删除环境')
          && ![...surface.querySelectorAll('button')].some((button) => button.textContent?.trim() === '确认删除');
      })()`,true),true,'non-empty environment deletion must remain blocked');
      for (const modifiers of [[],['shift']]) {
        await pressKey(win,'TAB',modifiers);
        await waitFor(win,
          `document.activeElement?.matches(${JSON.stringify(initialSelector)}) === true`,
          'single-action blocked environment deletion retains the focus loop');
      }
    } else {
      await assertFocusLoop(win,{containerSelector,initialSelector,label:`environment ${kind} Dialog`});
    }
    await assertEscapeFocusRestore(win,{containerSelector,label:`environment ${kind}`,restoreSelector:opener});
    assert.deepEqual(mutationCalls,[],`closing environment ${kind} must not mutate`);
  }
}

async function assertOverlayGeometry(win,selector,label,zoomFactor) {
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.querySelector(${JSON.stringify(selector)});
    if (!(overlay instanceof HTMLElement)) return null;
    const rect = overlay.getBoundingClientRect();
    const visibleButtons = [...overlay.querySelectorAll('button')].filter((button) => (
      button.getClientRects().length > 0
      && getComputedStyle(button).display !== 'none'
      && getComputedStyle(button).visibility !== 'hidden'
    ));
    const insideViewport = (candidate) => (
      candidate.left >= -1 && candidate.top >= -1
      && candidate.right <= window.innerWidth + 1
      && candidate.bottom <= window.innerHeight + 1
    );
    return {
      inner:[window.innerWidth,window.innerHeight],
      overlay:[rect.left,rect.top,rect.right,rect.bottom,rect.width,rect.height],
      overlayInside:insideViewport(rect),
      overlayScroll:[overlay.clientWidth,overlay.scrollWidth,overlay.clientHeight,overlay.scrollHeight],
      buttons:visibleButtons.map((button) => {
        const buttonRect = button.getBoundingClientRect();
        return {
          label:button.textContent?.trim() || button.getAttribute('aria-label'),
          inside:insideViewport(buttonRect),
          labelFits:button.scrollWidth <= button.clientWidth + 1,
          rect:[buttonRect.left,buttonRect.top,buttonRect.right,buttonRect.bottom,buttonRect.width,buttonRect.height],
        };
      }),
    };
  })()`,true);
  assert.ok(snapshot,`${label} missing at ${zoomFactor}x zoom`);
  if (!snapshot.overlayInside) accessibilityFailures.push({
    kind:'overlay-outside-viewport',label,zoomFactor,snapshot,
  });
  if (snapshot.overlayScroll[1] > snapshot.overlayScroll[0] + 1) accessibilityFailures.push({
    kind:'overlay-horizontal-overflow',label,zoomFactor,snapshot,
  });
  assert.ok(snapshot.buttons.length >= 1,`${label} has no visible CTA at ${zoomFactor}x zoom`);
  for (const button of snapshot.buttons) {
    if (!button.inside || !button.labelFits) accessibilityFailures.push({
      button,kind:'overlay-cta-clipped',label,zoomFactor,
    });
  }
  return snapshot;
}

async function setZoomFactorAndWait(win,zoomFactor,{width = 960,height = 640} = {}) {
  currentSmokeStep = `${width}x${height} layout at ${zoomFactor}x zoom`;
  await win.webContents.executeJavaScript(`window.__foundationSmokeStep = ${JSON.stringify(currentSmokeStep)}`,true);
  win.setContentSize(width,height);
  win.webContents.setZoomFactor(zoomFactor);
  const expectedWidth = Math.round(width / zoomFactor);
  const expectedHeight = Math.round(height / zoomFactor);
  await waitFor(
    win,
    `(() => {
      const shell = document.querySelector('[data-testid="react-app-shell"]');
      return Math.abs(window.innerWidth - ${expectedWidth}) <= 2
        && Math.abs(window.innerHeight - ${expectedHeight}) <= 2
        && shell instanceof HTMLElement
        && Math.abs(shell.getBoundingClientRect().height - window.innerHeight) <= 2;
    })()`,
    `${width}x${height} layout at ${zoomFactor}x zoom`,
  );
  await wait(80);
}

async function assertZoomedShell(win,zoomFactor,stage) {
  await setZoomFactorAndWait(win,zoomFactor);
  assert.ok(Math.abs(win.webContents.getZoomFactor() - zoomFactor) < 0.01,`zoom factor ${zoomFactor}`);
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const shell = document.querySelector('[data-testid="react-app-shell"]');
    const panelGroup = document.querySelector('[data-slot="resizable-panel-group"]');
    const projectPanel = document.querySelector('[data-slot="resizable-panel"]');
    const projectRail = document.querySelector('[data-testid="project-rail"]');
    const sidebarWrapper = projectRail?.closest('[data-slot="sidebar-wrapper"]') ?? null;
    const panels = [
      document.querySelector('[data-testid="project-rail"]'),
      document.querySelector('[data-testid="resource-pane"]'),
      document.querySelector('[data-testid="detail-workspace"]'),
    ];
    const ctas = [
      document.querySelector('[data-testid="add-project-footer"]'),
      document.querySelector('[data-testid="add-environment-footer"]'),
    ];
    const insideViewport = (rect) => (
      rect.left >= -1 && rect.top >= -1
      && rect.right <= window.innerWidth + 1
      && rect.bottom <= window.innerHeight + 1
    );
    const heightGeometry = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        className:typeof element.className === 'string' ? element.className : null,
        clientHeight:element.clientHeight,
        computed:{
          display:style.display,
          height:style.height,
          maxHeight:style.maxHeight,
          minHeight:style.minHeight,
          overflowY:style.overflowY,
          position:style.position,
        },
        rect:[rect.top,rect.bottom,rect.height],
        scrollHeight:element.scrollHeight,
      };
    };
    return {
      body:[body.clientWidth,body.scrollWidth],
      root:[root.clientWidth,root.scrollWidth],
      shell:[shell?.clientWidth ?? 0,shell?.scrollWidth ?? 0],
      inner:[window.innerWidth,window.innerHeight],
      heightChain:{
        html:heightGeometry(root),
        body:heightGeometry(body),
        root:heightGeometry(document.querySelector('#root')),
        shell:heightGeometry(shell),
        panelGroup:heightGeometry(panelGroup),
        projectPanel:heightGeometry(projectPanel),
        sidebarWrapper:heightGeometry(sidebarWrapper),
        projectRail:heightGeometry(projectRail),
      },
      panels:panels.map((panel) => panel?.getBoundingClientRect().width ?? 0),
      storedLayout:window.localStorage.getItem('runbook-bridge:app-shell-layout:v1'),
      ctas:ctas.map((cta) => {
        if (!(cta instanceof HTMLElement)) return null;
        const rect = cta.getBoundingClientRect();
        return {
          inside:insideViewport(rect),
          label:cta.textContent?.trim() ?? null,
          labelFits:cta.scrollWidth <= cta.clientWidth + 1,
          rect:[rect.left,rect.top,rect.right,rect.bottom,rect.width,rect.height],
          visible:cta.getClientRects().length > 0,
        };
      }),
    };
  })()`,true);
  panelWidthEvidence.push({kind:'zoom',stage,zoomFactor,...snapshot});
  if (snapshot.body[1] > snapshot.body[0] + 1) accessibilityFailures.push({
    kind:'zoom-body-horizontal-overflow',snapshot,stage,zoomFactor,
  });
  if (snapshot.root[1] > snapshot.root[0] + 1) accessibilityFailures.push({
    kind:'zoom-root-horizontal-overflow',snapshot,stage,zoomFactor,
  });
  if (snapshot.shell[1] > snapshot.shell[0] + 1) accessibilityFailures.push({
    kind:'zoom-shell-horizontal-overflow',snapshot,stage,zoomFactor,
  });
  for (const cta of snapshot.ctas) {
    assert.ok(cta,`960x640 ${zoomFactor}x zoom CTA missing`);
    if (!cta.inside || !cta.labelFits || !cta.visible) accessibilityFailures.push({
      cta,kind:'zoom-main-cta-clipped',snapshot,stage,zoomFactor,
    });
  }
  return snapshot;
}

async function assertEmulatedAccessibilityMedia(win) {
  const chromiumDebugger = win.webContents.debugger;
  if (!chromiumDebugger.isAttached()) chromiumDebugger.attach('1.3');
  try {
    await chromiumDebugger.sendCommand('Emulation.setEmulatedMedia',{
      media:'screen',
      features:[{name:'prefers-reduced-motion',value:'reduce'}],
    });
    await waitFor(win,`matchMedia('(prefers-reduced-motion: reduce)').matches`,'reduced motion emulation');
    const reducedMotion = await win.webContents.executeJavaScript(`(() => {
      const target = document.querySelector('[data-detail-tab][aria-selected="true"]');
      const parseTimes = (value) => value.split(',').map((part) => {
        const text = part.trim();
        return text.endsWith('ms') ? parseFloat(text) / 1000 : parseFloat(text);
      });
      const style = target ? getComputedStyle(target) : null;
      const after = target ? getComputedStyle(target,'::after') : null;
      return {
        matches:matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionSeconds:style ? Math.max(...parseTimes(style.transitionDuration)) : 1,
        animationSeconds:style ? Math.max(...parseTimes(style.animationDuration)) : 1,
        indicatorTransitionSeconds:after ? Math.max(...parseTimes(after.transitionDuration)) : 1,
      };
    })()`,true);
    assert.equal(reducedMotion.matches,true);
    assert.ok(reducedMotion.transitionSeconds <= 0.00002,`reduced motion transition remains: ${JSON.stringify(reducedMotion)}`);
    assert.ok(reducedMotion.animationSeconds <= 0.00002,`reduced motion animation remains: ${JSON.stringify(reducedMotion)}`);
    assert.ok(reducedMotion.indicatorTransitionSeconds <= 0.00002,`reduced motion indicator remains: ${JSON.stringify(reducedMotion)}`);
    accessibilityMediaEvidence.push({kind:'prefers-reduced-motion',snapshot:reducedMotion});

    await chromiumDebugger.sendCommand('Emulation.setEmulatedMedia',{
      media:'screen',
      features:[{name:'forced-colors',value:'active'}],
    });
    await waitFor(win,`matchMedia('(forced-colors: active)').matches`,'forced colors emulation');
    const forcedColors = await win.webContents.executeJavaScript(`(() => {
      const describeOutline = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return {color:style.outlineColor,style:style.outlineStyle,width:parseFloat(style.outlineWidth)};
      };
      return {
        matches:matchMedia('(forced-colors: active)').matches,
        current:describeOutline(document.querySelector('[data-testid="plugin-trigger-plugin-app-server"][aria-current="page"]')),
        selectedTab:describeOutline(document.querySelector('[data-detail-tab][aria-selected="true"]')),
      };
    })()`,true);
    assert.equal(forcedColors.matches,true);
    for (const [name,outline] of Object.entries({current:forcedColors.current,selectedTab:forcedColors.selectedTab})) {
      assert.ok(outline,`forced colors ${name} target missing`);
      assert.equal(outline.style,'solid',`forced colors ${name} outline style: ${JSON.stringify(outline)}`);
      assert.ok(outline.width >= 2,`forced colors ${name} outline width: ${JSON.stringify(outline)}`);
    }
    accessibilityMediaEvidence.push({kind:'forced-colors',snapshot:forcedColors});
  } finally {
    if (chromiumDebugger.isAttached()) {
      await chromiumDebugger.sendCommand('Emulation.setEmulatedMedia',{media:'screen',features:[]});
      chromiumDebugger.detach();
    }
  }
}

async function assertViewport(win,width,height,theme,capture) {
  win.setContentSize(width,height);
  await wait(260);
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const shell = document.querySelector('[data-testid="react-app-shell"]');
    const project = document.querySelector('[data-testid="project-rail"]');
    const resources = document.querySelector('[data-testid="resource-pane"]');
    const detail = document.querySelector('[data-testid="detail-workspace"]');
    const rgba = (color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) return [];
      context.fillStyle = color;
      context.fillRect(0,0,1,1);
      return [...context.getImageData(0,0,1,1).data];
    };
    const luminance = (value) => {
      const channels = value.slice(0,3).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground,background) => {
      const a = luminance(rgba(foreground));
      const b = luminance(rgba(background));
      return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
    };
    const selectedPlugin = document.querySelector('[data-testid^="plugin-trigger-"][aria-current="page"]');
    const resourceNavigation = resources?.querySelector('nav');
    const heading = detail?.querySelector('h1');
    const projectRect = project?.getBoundingClientRect();
    const resourceRect = resources?.getBoundingClientRect();
    const detailRect = detail?.getBoundingClientRect();
    const intersects = (left,right) => Boolean(
      left && right &&
      left.left < right.right && left.right > right.left &&
      left.top < right.bottom && left.bottom > right.top
    );
    const footerGeometry = (pane,scrollTestId,footerTestId) => {
      const scrollRoot = document.querySelector('[data-testid="' + scrollTestId + '"]');
      const viewport = scrollRoot?.querySelector('[data-slot="scroll-area-viewport"]');
      const footer = document.querySelector('[data-testid="' + footerTestId + '"]');
      if (!pane || !viewport || !footer) return null;
      const paneRect = pane.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const before = footer.getBoundingClientRect();
      const previousScrollTop = viewport.scrollTop;
      viewport.scrollTop = viewport.scrollHeight;
      const after = footer.getBoundingClientRect();
      viewport.scrollTop = previousScrollTop;
      return {
        insidePane:before.top >= paneRect.top - 1 && before.bottom <= paneRect.bottom + 1,
        belowViewport:viewportRect.bottom <= before.top + 1,
        fixed:Math.abs(before.top - after.top) <= 1 && Math.abs(before.bottom - after.bottom) <= 1,
      };
    };
    const footerOpticalAlignment = (() => {
      const projectFooter = document.querySelector('[data-testid="project-actions-footer"]');
      const resourceFooter = document.querySelector('[data-testid="resource-actions-footer"]');
      const projectButton = document.querySelector('[data-testid="add-project-footer"]');
      const resourceButton = document.querySelector('[data-testid="add-environment-footer"]');
      if (!projectFooter || !resourceFooter || !projectButton || !resourceButton) return null;
      const projectFooterRect = projectFooter.getBoundingClientRect();
      const resourceFooterRect = resourceFooter.getBoundingClientRect();
      const projectButtonRect = projectButton.getBoundingClientRect();
      const resourceButtonRect = resourceButton.getBoundingClientRect();
      return {
        footerTopAligned:Math.abs(projectFooterRect.top - resourceFooterRect.top) <= 1,
        footerHeightAligned:Math.abs(projectFooterRect.height - resourceFooterRect.height) <= 1,
        buttonTopAligned:Math.abs(projectButtonRect.top - resourceButtonRect.top) <= 1,
        buttonHeightAligned:Math.abs(projectButtonRect.height - resourceButtonRect.height) <= 1,
      };
    })();
    const environmentRows = [...document.querySelectorAll('[data-testid^="environment-row-"]')].map((row) => {
      const trigger = row.querySelector('[data-testid^="environment-trigger-"]');
      const actions = row.querySelector('[data-testid^="environment-actions-"]');
      const content = row.querySelector('[data-slot="accordion-content"]');
      const rowRect = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const boxShadow = rowStyle.boxShadow;
      const visibleBoxShadow = boxShadow.replaceAll(
        'rgba(0, 0, 0, 0) 0px 0px 0px 0px, ',
        '',
      );
      const visibleShadowColorLayers = visibleBoxShadow
        .match(/(?:rgba?|hsla?|oklab|oklch|color)\\(/g)?.length ?? 0;
      const insetLayers = visibleBoxShadow.match(/\\binset\\b/g)?.length ?? 0;
      const indicators = trigger
        ? [...trigger.querySelectorAll('[data-slot="accordion-trigger-icon"]')]
        : [];
      return {
        expanded:row.dataset.expanded === 'true',
        boxShadow,
        outerGlowRemoved:visibleBoxShadow === 'none' || (
          visibleShadowColorLayers === 1
          && insetLayers === 1
          && visibleBoxShadow.endsWith('inset')
        ),
        hasStatus:Boolean(trigger?.querySelector('[data-status]')),
        indicatorHidden:indicators.every(
          (indicator) => getComputedStyle(indicator).display === 'none'
        ),
        actionsAreSibling:Boolean(trigger && actions && !trigger.contains(actions)),
        unifiedContainer:Boolean(
          row.getAttribute('data-slot') === 'accordion-item' &&
          parseFloat(rowStyle.borderTopWidth) >= 1 &&
          parseFloat(rowStyle.borderRadius) >= 8 &&
          (row.dataset.expanded !== 'true' || !content || (
            content.getBoundingClientRect().left >= rowRect.left - 1 &&
            content.getBoundingClientRect().right <= rowRect.right + 1
          ))
        ),
        noOverlap:Boolean(
          trigger && actions &&
          !intersects(trigger.getBoundingClientRect(),actions.getBoundingClientRect())
        ),
      };
    });
    const pluginRows = [...document.querySelectorAll('[data-testid^="plugin-row-"]')].map((row) => {
      const trigger = row.querySelector('[data-testid^="plugin-trigger-"]');
      const actions = row.querySelector('[data-testid^="plugin-actions-"]');
      return {
        hasStatus:Boolean(trigger?.querySelector('[data-status]')),
        actionsAreSibling:!actions || Boolean(trigger && !trigger.contains(actions)),
        noOverlap:!actions || Boolean(
          trigger && !intersects(trigger.getBoundingClientRect(),actions.getBoundingClientRect())
        ),
      };
    });
    const projectRows = [...document.querySelectorAll('[data-project-id]')].map((button) => {
      const item = button.closest('[data-sidebar="menu-item"]');
      const name = button.querySelector('[data-project-name]');
      const status = button.querySelector('[data-project-status-badge]');
      const action = item?.querySelector('[data-sidebar="menu-action"]');
      const style = name ? getComputedStyle(name) : null;
      return {
        id:button.dataset.projectId,
        noOverlap:Boolean(
          name && status && action &&
          !intersects(name.getBoundingClientRect(),status.getBoundingClientRect()) &&
          !intersects(name.getBoundingClientRect(),action.getBoundingClientRect()) &&
          (getComputedStyle(status).opacity === '0' || getComputedStyle(action).opacity === '0'
            || !intersects(status.getBoundingClientRect(),action.getBoundingClientRect()))
        ),
        truncation:Boolean(
          name && style && style.overflow === 'hidden' &&
          style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap'
        ),
      };
    });
    const detailTabStrip = (() => {
      const list = document.querySelector('[data-testid="detail-tabs"]');
      const viewport = list?.closest('[data-slot="scroll-area"]')
        ?.querySelector('[data-slot="scroll-area-viewport"]');
      const tabs = list ? [...list.querySelectorAll('[role="tab"]')] : [];
      const last = tabs.at(-1);
      if (!viewport || !last) return null;
      const listRect = list.getBoundingClientRect();
      const listStyle = getComputedStyle(list);
      const tabRects = tabs.map((tab) => tab.getBoundingClientRect());
      const tabStyles = tabs.map((tab) => getComputedStyle(tab));
      const tabHeights = tabRects.map((rect) => rect.height);
      const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      const activeStyle = activeTab ? getComputedStyle(activeTab) : null;
      const initialViewportRect = viewport.getBoundingClientRect();
      const initialLastRect = last.getBoundingClientRect();
      const initialLastVisible = initialLastRect.left >= initialViewportRect.left - 1
        && initialLastRect.right <= initialViewportRect.right + 1;
      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft = viewport.scrollWidth;
      const viewportRect = viewport.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const result = {
        activeFill:Boolean(
          activeStyle
          && activeStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
          && activeStyle.color !== getComputedStyle(list).color
        ),
        contentSized:listRect.width < initialViewportRect.width - 1 || viewport.scrollWidth > viewport.clientWidth + 1,
        equalHeights:Math.max(...tabHeights) - Math.min(...tabHeights) <= 1,
        horizontal:Boolean(viewport.closest('[data-scroll-orientation="horizontal"]')),
        initialLastVisible,
        labelsFit:tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1),
        lastVisible:lastRect.left >= viewportRect.left - 1 && lastRect.right <= viewportRect.right + 1,
        listHeight:listRect.height,
        listWidth:listRect.width,
        overflow:viewport.scrollWidth > viewport.clientWidth + 1,
        singleContainer:
          parseFloat(listStyle.borderTopLeftRadius) >= 8
          && listStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
          && listStyle.boxShadow !== 'none',
        triggersBorderless:tabStyles.every((style) => [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ].every((width) => parseFloat(width) === 0)),
        viewportWidth:initialViewportRect.width,
      };
      viewport.scrollLeft = previousScrollLeft;
      return result;
    })();
    const pluginActionGroup = (() => {
      const group = document.querySelector('[data-testid="plugin-overview-actions"]');
      const buttons = group ? [...group.querySelectorAll('button')] : [];
      if (!group || buttons.length === 0) return null;
      const groupRect = group.getBoundingClientRect();
      const groupStyle = getComputedStyle(group);
      const rects = buttons.map((button) => button.getBoundingClientRect());
      const heights = rects.map((rect) => rect.height);
      const rows = [...new Set(rects.map((rect) => Math.round(rect.top)))];
      const overlaps = rects.some((left,index) => rects.some(
        (right,rightIndex) => index !== rightIndex && intersects(left,right)
      ));
      return {
        buttonGroup:group.dataset.slot === 'button-group',
        contained:rects.every((rect) => (
          rect.left >= groupRect.left - 1 && rect.right <= groupRect.right + 1
          && rect.top >= groupRect.top - 1 && rect.bottom <= groupRect.bottom + 1
        )),
        count:buttons.length,
        equalHeights:Math.max(...heights) - Math.min(...heights) <= 1,
        joined:groupStyle.display === 'flex' && rects.every(
          (rect,index) => index === 0 || Math.abs(rect.left - rects[index - 1].right) <= 1
        ),
        noOverlap:!overlaps,
        primaryDistinct:getComputedStyle(buttons[0]).backgroundColor
          !== getComputedStyle(buttons[1]).backgroundColor,
        secondaryOutlined:buttons.slice(1).every(
          (button) => parseFloat(getComputedStyle(button).borderTopWidth) >= 1
        ),
        oneRow:rows.length === 1,
      };
    })();
    return {
      theme:root.dataset.theme,
      body:[body.clientWidth,body.scrollWidth],
      root:[root.clientWidth,root.scrollWidth],
      shell:[shell?.clientWidth ?? 0,shell?.scrollWidth ?? 0],
      panels:[projectRect?.width ?? 0,resourceRect?.width ?? 0,detailRect?.width ?? 0],
      separators:document.querySelectorAll('[role="separator"]').length,
      panelOrder:Boolean(
        projectRect && resourceRect && detailRect &&
        projectRect.left < resourceRect.left && resourceRect.left < detailRect.left
      ),
      projectRows,
      projectFooterHintRemoved:!document.querySelector('[data-testid="project-actions-footer"]')
        ?.textContent?.includes('项目范围彼此隔离'),
      projectFooter:footerGeometry(project,'project-list-scroll','project-actions-footer'),
      resourceFooter:footerGeometry(resources,'resource-list-scroll','resource-actions-footer'),
      footerOpticalAlignment,
      environmentRows,
      pluginRows,
      environmentConnectionButtons:document.querySelectorAll('[data-testid^="environment-connection-"]').length,
      pluginConnectionButtons:document.querySelectorAll('[data-testid^="plugin-connection-"]').length,
      invalidResourceButtonBlocks:document.querySelectorAll(
        '[data-testid^="environment-trigger-"] :is(div,p,section,article,header,footer,main,nav,ul,ol,li,table,form),'
        + '[data-testid^="plugin-trigger-"] :is(div,p,section,article,header,footer,main,nav,ul,ol,li,table,form)'
      ).length,
      detailTabStrip,
      pluginActionGroup,
      selectedPluginContrast:selectedPlugin && resources
        ? contrast(getComputedStyle(selectedPlugin).color,getComputedStyle(resources).backgroundColor)
        : 0,
      selectedPluginColors:selectedPlugin && resources
        ? {
            foreground:getComputedStyle(selectedPlugin).color,
            background:getComputedStyle(resources).backgroundColor,
            foregroundRgba:rgba(getComputedStyle(selectedPlugin).color),
            backgroundRgba:rgba(getComputedStyle(resources).backgroundColor),
          }
        : null,
      selectedPluginVisible:(() => {
        if (!selectedPlugin || !resourceNavigation) return false;
        const selectedRect = selectedPlugin.getBoundingClientRect();
        const navigationRect = resourceNavigation.getBoundingClientRect();
        return selectedRect.top >= navigationRect.top - 1 && selectedRect.bottom <= navigationRect.bottom + 1;
      })(),
      detailContrast:heading && detail
        ? contrast(getComputedStyle(heading).color,getComputedStyle(detail).backgroundColor)
        : 0,
    };
  })()`,true);

  assert.equal(snapshot.theme,theme);
  assert.ok(snapshot.body[1] <= snapshot.body[0] + 1,`${width}x${height} body overflow`);
  assert.ok(snapshot.root[1] <= snapshot.root[0] + 1,`${width}x${height} root overflow`);
  assert.ok(snapshot.shell[1] <= snapshot.shell[0] + 1,`${width}x${height} shell overflow`);
  panelWidthEvidence.push({kind:'viewport',theme,width,height,panels:snapshot.panels});
  assert.ok(snapshot.panels[0] >= 175.5,`${width}x${height} project panel below 176px minimum: ${snapshot.panels[0]}`);
  assert.ok(snapshot.panels[1] >= 239.5,`${width}x${height} resource panel below 240px minimum: ${snapshot.panels[1]}`);
  assert.ok(snapshot.panels[2] >= 359.5,`${width}x${height} detail panel below 360px minimum: ${snapshot.panels[2]}`);
  assert.equal(snapshot.separators,2);
  assert.equal(snapshot.panelOrder,true);
  assert.ok(snapshot.projectRows.length >= 3,`${width}x${height} project rows missing`);
  for (const row of snapshot.projectRows) {
    assert.equal(row.noOverlap,true,`${width}x${height} project row overlap ${row.id}`);
    assert.equal(row.truncation,true,`${width}x${height} project truncation ${row.id}`);
  }
  assert.deepEqual(snapshot.projectFooter,{insidePane:true,belowViewport:true,fixed:true});
  assert.equal(snapshot.projectFooterHintRemoved,true,`${width}x${height} project footer hint remains`);
  assert.deepEqual(snapshot.resourceFooter,{insidePane:true,belowViewport:true,fixed:true});
  assert.deepEqual(snapshot.footerOpticalAlignment,{
    footerTopAligned:true,
    footerHeightAligned:true,
    buttonTopAligned:true,
    buttonHeightAligned:true,
  },`${width}x${height} project and environment footer optical alignment`);
  assert.ok(snapshot.environmentRows.length >= 3,`${width}x${height} environment rows missing`);
  assert.ok(snapshot.environmentRows.some((row) => row.expanded),`${width}x${height} expanded environment missing`);
  assert.ok(snapshot.environmentRows.some((row) => !row.expanded),`${width}x${height} collapsed environment missing`);
  for (const row of snapshot.environmentRows) {
    assert.equal(
      row.outerGlowRemoved,
      true,
      `${width}x${height} environment outer glow remains: ${row.boxShadow}`,
    );
    assert.equal(row.hasStatus,true,`${width}x${height} environment status missing`);
    assert.equal(row.indicatorHidden,true,`${width}x${height} environment accordion indicator remains`);
    assert.equal(row.actionsAreSibling,true,`${width}x${height} nested environment action`);
    assert.equal(row.unifiedContainer,true,`${width}x${height} environment is not one accordion container`);
    assert.equal(row.noOverlap,true,`${width}x${height} environment action overlap`);
  }
  for (const row of snapshot.pluginRows) {
    assert.equal(row.hasStatus,true,`${width}x${height} plugin status missing`);
    assert.equal(row.actionsAreSibling,true,`${width}x${height} nested plugin action`);
    assert.equal(row.noOverlap,true,`${width}x${height} plugin action overlap`);
  }
  assert.ok(snapshot.environmentConnectionButtons >= 1,`${width}x${height} environment connection action missing`);
  assert.ok(snapshot.pluginConnectionButtons >= 1,`${width}x${height} plugin connection action missing`);
  assert.equal(snapshot.invalidResourceButtonBlocks,0,`${width}x${height} invalid resource button content`);
  assert.ok(snapshot.detailTabStrip,`${width}x${height} detail tab strip missing`);
  assert.equal(snapshot.detailTabStrip.horizontal,true,`${width}x${height} detail tab strip is not horizontal`);
  assert.equal(
    snapshot.detailTabStrip.initialLastVisible || snapshot.detailTabStrip.overflow,
    true,
    `${width}x${height} detail tabs neither fit nor expose horizontal scrolling ${JSON.stringify(snapshot.detailTabStrip)}`,
  );
  assert.equal(
    snapshot.detailTabStrip.contentSized,
    true,
    `${width}x${height} detail tabs are stretched instead of content-sized ${JSON.stringify(snapshot.detailTabStrip)}`,
  );
  assert.equal(snapshot.detailTabStrip.lastVisible,true,`${width}x${height} last detail tab cannot scroll into view`);
  assert.equal(snapshot.detailTabStrip.labelsFit,true,`${width}x${height} detail tab labels clipped`);
  assert.equal(snapshot.detailTabStrip.singleContainer,true,`${width}x${height} detail tabs are not one shadcn navigation surface`);
  assert.equal(snapshot.detailTabStrip.activeFill,true,`${width}x${height} active detail tab fill missing`);
  assert.equal(snapshot.detailTabStrip.triggersBorderless,true,`${width}x${height} detail tabs repeat borders`);
  assert.equal(snapshot.detailTabStrip.equalHeights,true,`${width}x${height} detail tabs have uneven heights`);
  assert.ok(
    snapshot.detailTabStrip.listHeight >= 39 && snapshot.detailTabStrip.listHeight <= 41,
    `${width}x${height} detail tab strip height ${snapshot.detailTabStrip.listHeight}`,
  );
  assert.deepEqual(snapshot.pluginActionGroup,{
    buttonGroup:true,
    contained:true,
    count:2,
    equalHeights:true,
    joined:true,
    noOverlap:true,
    oneRow:true,
    primaryDistinct:true,
    secondaryOutlined:true,
  },`${width}x${height} plugin action group misaligned`);
  snapshot.panels.forEach((panelWidth) => assert.ok(panelWidth > 40,`${width}x${height} hidden panel`));
  assert.ok(
    snapshot.selectedPluginContrast >= 4.5,
    `${width}x${height} selected plugin contrast ${snapshot.selectedPluginContrast} ${JSON.stringify(snapshot.selectedPluginColors)}`,
  );
  assert.equal(snapshot.selectedPluginVisible,true,`${width}x${height} selected plugin outside resource viewport`);
  assert.ok(snapshot.detailContrast >= 4.5,`${width}x${height} detail contrast ${snapshot.detailContrast}`);

  if (capture && screenshotRoot) {
    fs.mkdirSync(screenshotRoot,{recursive:true});
    const image = await captureRenderedFrame(win);
    fs.writeFileSync(
      path.join(screenshotRoot,`app-shell-${theme}-${width}x${height}.png`),
      image.toPNG(),
    );
  }
}

async function assertSecurity(win) {
  const preferences = win.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation,true);
  assert.equal(preferences.nodeIntegration,false);
  assert.equal(preferences.sandbox,true);

  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
    const styleAttributeProbe = document.createElement('div');
    styleAttributeProbe.setAttribute('style','position:absolute;left:-9999px;width:13px');
    styleAttributeProbe.dataset.cspStyleBlockProbe = 'true';
    const styleBlockProbe = document.createElement('style');
    styleBlockProbe.textContent = '[data-csp-style-block-probe="true"]{height:17px}';
    document.head.append(styleBlockProbe);
    document.body.append(styleAttributeProbe);
    const result = {
      apiNames:Object.keys(window.aiOps?.v2 ?? {}).sort(),
      csp,
      hasRequire:typeof window.require !== 'undefined',
      hasProcess:typeof window.process !== 'undefined',
      inlineStyleAttributeWidth:getComputedStyle(styleAttributeProbe).width,
      inlineStyleBlockHeight:getComputedStyle(styleAttributeProbe).height,
      localResources:performance.getEntriesByType('resource').every(
        (entry) => entry.name.startsWith('file:') || entry.name.startsWith('data:'),
      ),
      styleSheets:document.styleSheets.length,
      background:getComputedStyle(document.body).backgroundColor,
    };
    styleBlockProbe.remove();
    styleAttributeProbe.remove();
    return result;
  })()`,true);
  assert.equal(snapshot.apiNames.length,58);
  assert.equal(snapshot.hasRequire,false);
  assert.equal(snapshot.hasProcess,false);
  assert.equal(snapshot.inlineStyleAttributeWidth,'13px');
  assert.equal(snapshot.inlineStyleBlockHeight,'17px');
  assert.equal(snapshot.localResources,true);
  assert.ok(snapshot.styleSheets > 0);
  assert.notEqual(snapshot.background,'rgba(0, 0, 0, 0)');
  assert.match(snapshot.csp,/default-src 'self'/u);
  assert.match(snapshot.csp,/script-src 'self'/u);
  assert.match(snapshot.csp,/style-src 'self' 'unsafe-inline'/u);
  assert.match(snapshot.csp,/connect-src 'none'/u);
  assert.equal((snapshot.csp.match(/'unsafe-inline'/gu) ?? []).length,1);
  assert.doesNotMatch(snapshot.csp,/script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
  assert.doesNotMatch(snapshot.csp,/unsafe-eval/u);
}

async function run() {
  assert.ok(fs.existsSync(pagePath),'build:renderer must produce renderer-build/v2/index.html');
  await app.whenReady();
  registerMockApi();
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    if (!details.url.startsWith('file:') && !details.url.startsWith('devtools:')) {
      externalRequests.push(details.url);
    }
    callback({});
  });

  const win = new BrowserWindow({
    show:false,
    useContentSize:true,
    width:960,
    height:640,
    webPreferences:{
      preload:path.join(root,'src','preload.cjs'),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      backgroundThrottling:false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-attach-webview',(event) => event.preventDefault());
  win.webContents.on('will-navigate',(event) => event.preventDefault());
  win.webContents.on('console-message',(_event,level,message) => {
    if (level >= 2) {
      rendererErrors.push(message);
      rendererErrorSteps.push({step:currentSmokeStep,message});
    }
  });

  try {
    await win.loadFile(pagePath);
    await installWindowErrorDiagnostics(win);
    await waitFor(
      win,
      `document.querySelector('[data-shell-ready="true"]') !== null`,
      'React production App Shell mount',
    );
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-operations"]') !== null`,
      'workspace overview',
    );
    await assertSecurity(win);
    await assertRendererKeyboardFocus(win);

    const initial = await win.webContents.executeJavaScript(`(() => ({
      selected:document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId ?? null,
      confirmationAboveProjects:(() => {
        const confirmation = document.querySelector('[data-testid="confirmation-center"]');
        const project = document.querySelector('[data-project-id]');
        return Boolean(
          confirmation && project &&
          confirmation.getBoundingClientRect().bottom <= project.getBoundingClientRect().top
        );
      })(),
      addProjectBelowProjects:(() => {
        const add = document.querySelector('[data-testid="add-project-footer"]');
        const last = [...document.querySelectorAll('[data-project-id]')].at(-1);
        return Boolean(
          add && last &&
          (add.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING)
        );
      })(),
    }))()`,true);
    assert.equal(initial.selected,'project-operations');
    assert.equal(initial.confirmationAboveProjects,true);
    assert.equal(initial.addProjectBelowProjects,true);
    if (app.commandLine.hasSwitch('project-drag-regression-only')) {
      await assertProjectDragSorting(win);
      await collectWindowErrorDiagnostics(win);
      assert.deepEqual(mutationCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      assert.deepEqual(rendererWindowErrors,[]);
      process.stdout.write('Focused project drag sorting smoke passed; no mutations or external requests\n');
      return;
    }
    await assertManualThemePreferences(win);
    if (app.commandLine.hasSwitch('theme-regression-only')) {
      await collectWindowErrorDiagnostics(win);
      assert.deepEqual(mutationCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      assert.deepEqual(rendererWindowErrors,[]);
      process.stdout.write(`Focused theme preference smoke passed (${readCalls.length} read-only API calls; no mutations or external requests)\n`);
      return;
    }
    await assertProjectDragSorting(win);
    await assertEnvironmentAccordionNavigation(win);

    const projectRoving = await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('[data-project-id="project-operations"]');
      first?.focus();
      first?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      return document.activeElement?.dataset.projectId ?? null;
    })()`,true);
    assert.equal(projectRoving,'project-data');

    await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('[data-project-id="project-operations"]');
      first?.focus();
      first?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}));
    })()`,true);
    await waitFor(
      win,
      `window.localStorage.getItem('ai-ops-project-order-v1')?.startsWith('["project-data"') === true`,
      'Alt+Arrow project order',
    );
    const orderAnnouncement = await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="project-order-announcement"]')?.textContent ?? ''`,
      true,
    );
    assert.match(orderAnnouncement,/已移至/u);

    await waitFor(
      win,
      `document.querySelector('[data-testid="plugin-trigger-plugin-app-server"]')?.getClientRects().length > 0`,
      'production plugin list',
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="environment-overview"]') !== null`,
      'environment detail',
    );
    const environmentTabs = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-testid="detail-tabs"] [role="tab"]')].map((tab) => tab.textContent?.trim())`,
      true,
    );
    assert.deepEqual(environmentTabs,[
      '环境详情','运维说明','快捷提问','环境记录','操作确认',
    ]);
    const environmentDetails = await win.webContents.executeJavaScript(`(() => {
      const details = document.querySelector('[data-testid="environment-overview"]');
      const visibleCount = (selector) => [...(details?.querySelectorAll(selector) ?? [])]
        .filter((element) => element.getClientRects().length > 0).length;
      return {
        connectionPanel:visibleCount('[data-testid="environment-connection-panel"]'),
        primary:visibleCount('[data-testid="environment-connection-primary"]'),
        refresh:visibleCount('[data-testid="environment-connection-refresh"]'),
        summary:visibleCount('[data-testid="environment-connection-summary"]'),
        pluginLists:details?.querySelectorAll('[data-testid="environment-plugin-list"]').length,
        connectionTab:document.querySelector('[data-detail-tab="connection"]') !== null,
      };
    })()`,true);
    assert.deepEqual(environmentDetails,{
      connectionPanel:1,primary:1,refresh:1,summary:1,pluginLists:1,connectionTab:false,
    },'environment details expose one set of connection controls and one plugin list');
    assert.deepEqual(mutationCalls,[],'opening environment details must not initiate a connection');
    const pluginListNavigation = await win.webContents.executeJavaScript(`(() => {
      const matches = [...document.querySelectorAll('[data-testid="environment-plugin-detail-plugin-app-server"]')]
        .filter((button) => button.getClientRects().length > 0);
      if (matches.length !== 1) return false;
      matches[0].click();
      return true;
    })()`,true);
    assert.equal(pluginListNavigation,true,'the environment plugin list has one visible entry for the exact plugin');
    await waitFor(win,`document.querySelector('#detail-main')?.dataset.selectionKind === 'plugin'
      && document.querySelector('[data-testid="plugin-trigger-plugin-app-server"]')?.getAttribute('aria-current') === 'page'
      && document.querySelector('[data-testid="plugin-overview"]')?.getClientRects().length > 0`,
    'the environment plugin list opens the exact plugin details');
    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="environment-trigger-env-production-east"]')?.click()`,true);
    await waitFor(win,`document.querySelector('#detail-main')?.dataset.selectionKind === 'environment'
      && document.querySelector('[data-detail-tab="overview"]')?.getAttribute('aria-selected') === 'true'
      && document.querySelector('[data-testid="environment-overview"]')?.getClientRects().length > 0
      && document.querySelector('[data-testid^="plugin-trigger-"][aria-current="page"]') === null`,
    'the environment heading returns from its plugin list destination to environment details');
    assert.deepEqual(mutationCalls,[],'environment and plugin detail navigation remains read-only');
    if (process.env.RUNBOOK_BRIDGE_ENVIRONMENT_DETAILS_ONLY === '1') {
      assert.ok(screenshotRoot,'focused environment detail evidence requires an external screenshot directory');
      fs.mkdirSync(screenshotRoot,{recursive:true});
      for (const theme of requestedScreenshotTheme ? [requestedScreenshotTheme] : ['dark','light']) {
        await setTheme(win,theme);
        await captureVisualScenario(win,{
          name:'environment-details',
          readySelector:'[data-testid="environment-overview"]',
          theme,
          viewports:[...visualEvidenceViewports,[650,820]],
        });
      }
      await collectWindowErrorDiagnostics(win);
      assert.deepEqual(mutationCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      assert.deepEqual(rendererWindowErrors,[]);
      assert.deepEqual(accessibilityFailures,[]);
      process.stdout.write('Environment detail visual evidence passed in normal and narrow panels; no mutations or external requests\n');
      return;
    }
    await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('[data-environment-id="env-production-east"] [data-shell-nav-item]');
      if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
    })()`,true);
    await waitFor(
      win,
      `document.querySelector('[data-environment-id="env-production-east"] [data-shell-nav-item]')?.getAttribute('aria-expanded') === 'true'`,
      'expanded production environment',
    );

    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="plugin-trigger-plugin-app-server"]')?.click()`,
      true,
    );
    await waitFor(
      win,
      `document.querySelector('#detail-main')?.dataset.selectionKind === 'plugin'`,
      'plugin selection',
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="plugin-overview"]') !== null`,
      'plugin overview',
    );
    const pluginTabs = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-testid="detail-tabs"] [role="tab"]')].map((tab) => tab.textContent?.trim())`,
      true,
    );
    assert.deepEqual(pluginTabs,[
      '插件详情','Agent 权限','插件记录','操作确认',
    ]);
    const pluginDetails = await win.webContents.executeJavaScript(`(() => {
      const details = document.querySelector('[data-testid="plugin-overview"]');
      const visible = (selector) => (details?.querySelector(selector)?.getClientRects().length ?? 0) > 0;
      return {
        connectionVisible:visible('[data-testid="plugin-connection-panel"]'),
        connectionActionVisible:visible('[data-testid="plugin-connection-primary"]'),
        editActionVisible:visible('[data-testid="plugin-action-edit"]'),
        connectionTab:document.querySelector('[data-detail-tab="connection"]') !== null,
        duplicateNavigation:details?.querySelector('[data-testid="plugin-action-connection"],[data-testid="plugin-action-agent"],[data-testid="plugin-action-more"],[data-testid="plugin-action-audit"]') !== null,
        repeatedScope:details?.textContent?.includes('当前运维范围') === true,
      };
    })()`,true);
    assert.deepEqual(pluginDetails,{
      connectionVisible:true,connectionActionVisible:true,editActionVisible:true,
      connectionTab:false,duplicateNavigation:false,repeatedScope:false,
    },'plugin details expose direct actions without duplicate navigation');
    assert.deepEqual(mutationCalls,[],'opening plugin details must not connect or change permissions');

    const subscribedRuntime = clone(runtime(
      'project-operations',
      'env-production-east',
      'partial',
      pluginsByEnvironment['env-production-east'],
      12,
    ));
    subscribedRuntime.plugins['plugin-app-server'] = {
      pluginInstanceId:'plugin-app-server',
      phase:'error',
      assessment:assessment('connection-error','连接失败','retry'),
    };
    await wait(200);
    win.webContents.send('v2:environment-status-changed',subscribedRuntime);
    await wait(80);
    win.webContents.send('v2:environment-status-changed',subscribedRuntime);
    await waitFor(
      win,
      `document.querySelector('[data-testid="plugin-overview"]')?.textContent?.includes('错误') === true`,
      'environment status subscription',
    );

    await win.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('[data-detail-tab="overview"]');
      tab?.focus();
      tab?.dispatchEvent(new KeyboardEvent('keydown',{
        bubbles:true,
        cancelable:true,
        code:'ArrowRight',
        key:'ArrowRight',
      }));
    })()`,true);
    await waitFor(
      win,
      `document.activeElement?.getAttribute('data-detail-tab') === 'agent'
        && document.querySelector('[data-detail-tab="overview"]')?.getAttribute('aria-selected') === 'true'`,
      'detail tab arrow navigation',
    );
    await win.webContents.executeJavaScript(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{
        bubbles:true,
        cancelable:true,
        code:'Enter',
        key:'Enter',
      }));
    })()`,true);
    await waitFor(
      win,
      `document.querySelector('[data-detail-tab="agent"]')?.getAttribute('aria-selected') === 'true'
        && document.activeElement?.getAttribute('data-detail-tab') === 'agent'`,
      'detail tab keyboard activation',
    );
    await win.webContents.executeJavaScript(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{
        bubbles:true,
        cancelable:true,
        code:'Home',
        key:'Home',
      }));
    })()`,true);
    await waitFor(
      win,
      `document.activeElement?.getAttribute('data-detail-tab') === 'overview'
        && document.querySelector('[data-detail-tab="agent"]')?.getAttribute('aria-selected') === 'true'`,
      'detail tab home navigation',
    );
    await win.webContents.executeJavaScript(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{
        bubbles:true,
        cancelable:true,
        code:'Enter',
        key:'Enter',
      }));
    })()`,true);
    await waitFor(
      win,
      `document.querySelector('[data-detail-tab="overview"]')?.getAttribute('aria-selected') === 'true'
        && document.activeElement?.getAttribute('data-detail-tab') === 'overview'
        && document.querySelector('[data-testid="plugin-overview"]') !== null`,
      'detail tab home activation',
    );
    const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    await setTheme(win,theme);
    await assertViewport(win,960,640,theme,true);
    await assertViewport(win,1280,820,theme,true);
    await assertViewport(win,1680,980,theme,true);
    await assertCompactProjectRail(win,theme);
    await captureLongProjectListEvidence(win,theme);
    if (process.env.RUNBOOK_BRIDGE_RAIL_REGRESSION_ONLY === '1') {
      await collectWindowErrorDiagnostics(win);
      assert.deepEqual(mutationCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      assert.deepEqual(rendererWindowErrors,[]);
      assert.deepEqual(accessibilityFailures,[]);
      process.stdout.write(`Focused rail and environment regression smoke passed (${readCalls.length} read-only API calls; no mutations, external requests or renderer errors)\n`);
      return;
    }
    await captureReadOnlyVisualEvidence(win,theme);
    assert.deepEqual(mutationCalls,[]);
    win.setContentSize(1280,820);
    await wait(160);

    const resourceSearchRemoved = await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="resource-pane"] [role="search"], [aria-label="打开命令面板"]') === null`,
      true,
    );
    assert.equal(resourceSearchRemoved,true);
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`,
      true,
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="global-command"]') !== null`,
      'Ctrl+K command open',
    );
    const commandSnapshot = await win.webContents.executeJavaScript(`(() => ({
      dialogs:document.querySelectorAll('[role="dialog"]').length,
      inputFocused:document.activeElement?.matches('[cmdk-input]') === true,
      hasProject:document.body.textContent?.includes('海隅电商生产运维与跨区域灾备治理工作台') === true,
      hasPlugin:document.body.textContent?.includes('应用服务器（华东共享服务与跨区域资源拦截验证超长名称）') === true,
    }))()`,true);
    assert.equal(commandSnapshot.dialogs,1);
    assert.equal(commandSnapshot.inputFocused,true);
    assert.equal(commandSnapshot.hasProject,true);
    assert.equal(commandSnapshot.hasPlugin,true);
    await captureOverlayVisualEvidence(win,{
      name:'global-command',
      readySelector:'[role="dialog"]',
      restoreFocusSelector:'[cmdk-input]',
      theme,
    });
    await pressKey(win,'ESCAPE');
    await captureRenderedFrame(win);
    await waitFor(win,
      `document.querySelector('[data-testid="global-command"]') === null`,
      'Command is fully closed before invoking the project footer');

    await openCreateProjectDialog(win);
    const createDialog = await win.webContents.executeJavaScript(`(() => ({
      title:document.querySelector('[data-testid="create-project-dialog"]')?.textContent?.includes('新建项目') === true,
      fields:Boolean(
        document.querySelector('#new-project-name') &&
        document.querySelector('#new-project-environment-name')
      ),
      focused:document.activeElement?.id === 'new-project-name',
    }))()`,true);
    assert.deepEqual(createDialog,{title:true,fields:true,focused:true});
    await assertModalShortcutIsolation(win);
    await captureOverlayVisualEvidence(win,{
      name:'create-project',
      readySelector:'[data-testid="create-project-dialog"]',
      restoreFocusSelector:'#new-project-name',
      theme,
    });
    await assertFocusLoop(win,{
      containerSelector:'[data-testid="create-project-dialog"]',
      initialSelector:'#new-project-name',
      label:'create-project Dialog',
    });
    assert.deepEqual(mutationCalls,[]);
    await assertEscapeFocusRestore(win,{
      containerSelector:'[data-testid="create-project-dialog"]',
      label:'create-project Dialog',
      restoreSelector:'[data-testid="add-project-footer"]',
    });

    for (const zoomFactor of [1.25,1.5]) {
      await assertZoomedShell(win,zoomFactor,'dialog');
      await openCreateProjectDialog(win);
      await assertOverlayGeometry(
        win,
        '[data-testid="create-project-dialog"]',
        'create-project Dialog',
        zoomFactor,
      );
      await assertEscapeFocusRestore(win,{
        containerSelector:'[data-testid="create-project-dialog"]',
        label:`create-project Dialog at ${zoomFactor}x zoom`,
        restoreSelector:'[data-testid="add-project-footer"]',
      });
    }
    await setZoomFactorAndWait(win,1,{width:1280,height:820});

    await openProjectSettings(win);
    await waitFor(win,`document.activeElement?.id === 'project-settings-name'`,'project settings initial focus');
    await captureOverlayVisualEvidence(win,{
      name:'project-settings',
      readySelector:'[data-testid="project-settings-dialog"]',
      restoreFocusSelector:'#project-settings-name',
      theme,
    });
    await assertFocusLoop(win,{
      containerSelector:'[data-testid="project-settings-dialog"]',
      initialSelector:'#project-settings-name',
      label:'project settings Dialog',
    });
    await assertEscapeFocusRestore(win,{
      containerSelector:'[data-testid="project-settings-dialog"]',
      label:'project settings Dialog',
      restoreSelector:'[data-project-id="project-operations"]',
    });
    await openDeleteProjectAlert(win);
    await waitFor(
      win,
      `document.activeElement?.matches('[data-slot="alert-dialog-cancel"]') === true`,
      'delete-project AlertDialog initial focus',
    );
    await captureOverlayVisualEvidence(win,{
      name:'delete-project',
      readySelector:'[data-testid="delete-project-dialog"]',
      restoreFocusSelector:'[data-slot="alert-dialog-cancel"]',
      theme,
    });
    await assertFocusLoop(win,{
      containerSelector:'[data-testid="delete-project-dialog"]',
      initialSelector:'[data-slot="alert-dialog-cancel"]',
      label:'delete-project AlertDialog',
    });
    await assertEscapeFocusRestore(win,{
      containerSelector:'[data-testid="delete-project-dialog"]',
      label:'delete-project AlertDialog',
      restoreSelector:'[data-smoke-alert-opener="true"]',
    });
    for (const zoomFactor of [1.25,1.5]) {
      await assertZoomedShell(win,zoomFactor,'dialog');
      await openProjectSettings(win);
      await assertOverlayGeometry(
        win,
        '[data-testid="project-settings-dialog"]',
        'project settings Dialog',
        zoomFactor,
      );
      await assertEscapeFocusRestore(win,{
        containerSelector:'[data-testid="project-settings-dialog"]',
        label:`project settings Dialog at ${zoomFactor}x zoom`,
        restoreSelector:'[data-project-id="project-operations"]',
      });
      await openDeleteProjectAlert(win);
      await waitFor(
        win,
        `document.activeElement?.matches('[data-slot="alert-dialog-cancel"]') === true`,
        `delete-project AlertDialog initial focus at ${zoomFactor}x zoom`,
      );
      await assertFocusLoop(win,{
        containerSelector:'[data-testid="delete-project-dialog"]',
        initialSelector:'[data-slot="alert-dialog-cancel"]',
        label:`delete-project AlertDialog at ${zoomFactor}x zoom`,
      });
      await assertOverlayGeometry(
        win,
        '[data-testid="delete-project-dialog"]',
        'delete-project AlertDialog',
        zoomFactor,
      );
      await assertEscapeFocusRestore(win,{
        containerSelector:'[data-testid="delete-project-dialog"]',
        label:`delete-project AlertDialog at ${zoomFactor}x zoom`,
        restoreSelector:'[data-smoke-alert-opener="true"]',
      });
    }
    await setZoomFactorAndWait(win,1);
    await assertEnvironmentShortSurfaces(win,theme);
    await assertCreatePluginWorkspace(win,theme);

    await selectVisualScope(win,'environment');
    await selectVisualScope(win,'plugin');
    await waitFor(win,`document.querySelector('[data-testid="plugin-overview"]') !== null`,'plugin overview before media emulation');
    await assertEmulatedAccessibilityMedia(win);
    assert.deepEqual(mutationCalls,[]);

    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="confirmation-center"]')?.click()`,
      true,
    );
    await waitFor(
      win,
      `document.querySelector('[data-feature="confirmations"]') !== null`,
      'confirmation detail tab',
    );
    await waitFor(
      win,
      `document.querySelectorAll('[data-confirmation-id]').length === 2`,
      'confirmation cards',
    );
    const confirmationTab = await win.webContents.executeJavaScript(`(() => ({
      active:[...document.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? null,
      selected:document.querySelector('[data-feature="confirmations"]') !== null,
      crossScopeVisible:document.body.textContent?.includes('跨范围请求不得显示') === true,
      scopedCount:document.querySelector('[data-testid="confirmation-center"]')
        ?.getAttribute('aria-label')?.includes('2 项') === true,
    }))()`,true);
    assert.deepEqual(confirmationTab,{
      active:'操作确认',selected:true,crossScopeVisible:false,scopedCount:true,
    });
    const confirmationSelectionKind = await win.webContents.executeJavaScript(
      `document.querySelector('#detail-main')?.dataset.selectionKind ?? null`,
      true,
    );
    assert.equal(confirmationSelectionKind,'environment');
    win.webContents.send('v2:confirmations-changed',[confirmations[0]]);
    await waitFor(
      win,
      `document.querySelectorAll('[data-confirmation-id]').length === 1`,
      'confirmation subscription update',
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="confirmation-center"]')?.getAttribute('aria-label')?.includes('1 项') === true`,
      'confirmation counter subscription',
    );

    const accessibility = await win.webContents.executeJavaScript(`(() => {
      const visibleButtons = [...document.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0;
      });
      const unlabeled = visibleButtons.filter((button) => !(
        button.getAttribute('aria-label') ||
        button.textContent?.trim() ||
        button.title ||
        (button.id && document.querySelector('label[for="' + CSS.escape(button.id) + '"]')?.textContent?.trim())
      ));
      return {
        unlabeled:unlabeled.map((button) => button.outerHTML.slice(0,240)),
        h1:document.querySelectorAll('h1').length,
        selectedTabs:document.querySelectorAll('[role="tab"][aria-selected="true"]').length,
        tabVariant:document.querySelector('[data-testid="detail-tabs"]')?.dataset.variant ?? null,
      };
    })()`,true);
    assert.deepEqual(accessibility.unlabeled,[]);
    assert.equal(accessibility.h1,1);
    assert.equal(accessibility.selectedTabs,1);
    assert.equal(accessibility.tabVariant,'navigation');

    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="detail-collapse"]')?.click()`,
      true,
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="detail-workspace"]')?.dataset.collapsed === 'true'`,
      'detail collapse',
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('a[href="#detail-main"]')?.click()`,
      true,
    );
    await waitFor(
      win,
      `document.querySelector('[data-testid="detail-workspace"]')?.dataset.collapsed === 'false' && document.activeElement?.id === 'detail-main'`,
      'skip link detail focus',
    );

    // Finish the skip-link's deferred focus and hidden-window paint before
    // testing native keyboard input on either Resizable separator.
    await captureRenderedFrame(win);
    await assertRendererKeyboardFocus(win);
    const layoutBefore = await win.webContents.executeJavaScript(
      `window.localStorage.getItem('runbook-bridge:app-shell-layout:v1')`,
      true,
    );
    await assertKeyboardResizerPersistence(win,{
      testId:'project-resource-resizer',keyCode:'RIGHT',panelId:'project-panel',
    });
    const savedLayout = await assertKeyboardResizerPersistence(win,{
      testId:'resource-detail-resizer',keyCode:'LEFT',panelId:'resource-panel',
    });
    assert.ok(savedLayout);
    assert.notEqual(savedLayout,layoutBefore);

    const systemThemeBeforeReload = nativeTheme.themeSource;
    await selectThemePreference(win,'light');
    nativeTheme.themeSource = 'dark';
    await assertThemeState(win,'light','light','manual light before reload',{toast:false});
    await collectWindowErrorDiagnostics(win);
    currentSmokeStep = 'renderer-reload';
    await win.reload();
    await waitFor(
      win,
      `document.querySelector('[data-shell-ready="true"]') !== null`,
      'React production App Shell reload',
    );
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-operations"]') !== null`,
      'workspace reload',
    );
    const restoredLayout = await win.webContents.executeJavaScript(
      `window.localStorage.getItem('runbook-bridge:app-shell-layout:v1')`,
      true,
    );
    if (restoredLayout !== savedLayout) accessibilityFailures.push({
      kind:'layout-restore-mismatch',
      restored:JSON.parse(restoredLayout),
      saved:JSON.parse(savedLayout),
    });
    await assertThemeState(win,'light','light','manual light survives reload against a dark system');
    await selectThemePreference(win,'system');
    nativeTheme.themeSource = systemThemeBeforeReload;
    await assertThemeState(win,'system',nativeTheme.shouldUseDarkColors ? 'dark' : 'light','restore theme after reload evidence');

    const readOnlyChannels = new Set([
      'v2:project-list','v2:workspace-overview','v2:environment-list','v2:environment-status',
      'v2:plugin-list','v2:runbook-read','v2:quick-question-opening-get','v2:quick-question-list',
      'v2:plugin-assess','v2:plugin-credential-status','v2:plugin-databases','v2:audit-list',
      'v2:confirmation-list',
    ]);
    await collectWindowErrorDiagnostics(win);
    process.stdout.write(`React smoke final diagnostics: ${JSON.stringify({
      readOnlyCallCount:readCalls.length,
      mutationCallCount:mutationCalls.length,
      externalRequestCount:externalRequests.length,
      rendererErrorSteps,
      rendererWindowErrors,
      accessibilityFailures,
    })}\n`);
    assert.ok(readCalls.some((call) => call.channel === 'v2:workspace-overview'));
    assert.ok(readCalls.some((call) => call.channel === 'v2:environment-status'));
    assert.ok(readCalls.some((call) => call.channel === 'v2:plugin-list'));
    assert.ok(readCalls.some((call) => call.channel === 'v2:confirmation-list'));
    assert.deepEqual(readCalls.filter((call) => !readOnlyChannels.has(call.channel)),[]);
    assert.deepEqual(mutationCalls,[]);
    assert.deepEqual(externalRequests,[]);
    assert.deepEqual(rendererErrors,[]);
    assert.deepEqual(rendererWindowErrors,[]);
    assert.equal(
      accessibilityFailures.length,
      0,
      `Accessibility geometry failures: ${JSON.stringify({
        failures:accessibilityFailures,
        media:accessibilityMediaEvidence,
        panels:panelWidthEvidence,
      })}`,
    );
    process.stdout.write(
      `React production renderer smoke passed (${readCalls.length} read-only API calls)\n`,
    );
    process.stdout.write(`Panel CSS pixel evidence: ${JSON.stringify(panelWidthEvidence)}\n`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await wait(120);
    unregisterMockApi();
  }
}

run()
  .then(async () => {
    await wait(60);
    app.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    await wait(120);
    app.exit(1);
  });
