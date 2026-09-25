const { browseFixture, assertSqlAssistanceAndBrowse } = require('./database-assist-ui.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session, clipboard } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {
  // 测试独立管理隐藏窗口和退出时机。
});

const root = path.resolve(__dirname,'..');
const packageRoot = process.argv.find(value=>value.startsWith('--package-root='))?.slice('--package-root='.length);
const runtimeRoot = packageRoot ? path.resolve(packageRoot) : root;
const pagePath = path.join(runtimeRoot,'renderer-build','v2','index.html');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(),'runbook-bridge-database-smoke-'));
const screenshotArgument = process.argv.find((value) => value.startsWith('--screenshot-dir='))?.slice('--screenshot-dir='.length);
const screenshotValue = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR || screenshotArgument || app.commandLine.getSwitchValue('screenshot-dir');
const screenshotRoot = screenshotValue ? path.resolve(screenshotValue) : null;
if (screenshotRoot) {
  const relative = path.relative(root,screenshotRoot);
  assert.ok(relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    '截图目录必须位于工作树之外。');
}
const requestedTheme = process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME;
if (['light','dark'].includes(requestedTheme)) nativeTheme.themeSource = requestedTheme;
app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));

const PROJECT_ID = 'project-database-smoke';
const ENVIRONMENT_ID = 'environment-database-smoke';
const SECOND_ENVIRONMENT_ID = 'environment-database-review-smoke';
const PRIMARY_ID = 'plugin-orders-smoke';
const OTHER_ID = 'plugin-reports-smoke';
const OFFLINE_ID = 'plugin-offline-smoke';
const MARKUP = '<img id="database-result-injection" src="https://untrusted.example.invalid/image" onerror="window.__databaseInjected=true">';
const SQL_MARKER = 'database-smoke-volatile-sql';
const LATE_MARKER = '迟到的订单范围结果';
const SHOWCASE_SQL = "SELECT order_no, customer_name, total_amount, status, created_at\nFROM orders\nWHERE status = '已完成'\nLIMIT 24";
const registeredChannels = new Set();
const databaseCalls = [];
const forbiddenCalls = [];
const externalRequests = [];
const rendererErrors = [];
const releases = new Set();
const state = { sequence:1, failList:false, failDescribe:false, failPreview:false, browseFixture:false, holdNext:null };
const ok = (data) => ({ok:true,data});
const failed = (message) => ({ok:false,error:{code:'MYSQL_QUERY_FAILED',message}});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
const scope = (pluginInstanceId) => ({projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId});
const testId = (value) => `[data-testid="${value}"]`;

function assessment(phase) {
  return {phase,primaryStatus:{kind:phase,label:phase === 'connected' ? '已连接' : '未连接',action:phase === 'connected' ? 'disconnect' : 'connect'}};
}

function plugin(pluginInstanceId,displayName,database,phase = 'connected') {
  return {
    ...scope(pluginInstanceId),pluginType:'mysql',displayName,revision:1,configState:'ready',
    target:{host:'database.smoke.invalid',port:3306,database,addressFamily:'ipv4Preferred'},
    auth:{username:'readonly'},transport:{kind:'direct'},tls:{mode:'verifyIdentity'},
    limits:{maxRows:250,maxBytes:262144,timeoutMs:10000},assessment:assessment(phase),
  };
}

const plugins = [
  plugin(PRIMARY_ID,'订单数据库','orders_fixture'),
  plugin(OTHER_ID,'报表数据库','reports_fixture'),
  plugin(OFFLINE_ID,'离线数据库','offline_fixture','disconnected'),
];

function runtime() {
  return {
    projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,phase:'partial',sequence:state.sequence,
    desiredConnected:true,eligibleCount:plugins.length,
    connectedCount:plugins.filter((record) => record.assessment.phase === 'connected').length,
    errorCount:0,blockedCount:0,draftCount:0,pluginsPartial:false,
    plugins:Object.fromEntries(plugins.map((record) => [record.pluginInstanceId,{
      pluginInstanceId:record.pluginInstanceId,phase:record.assessment.phase,assessment:record.assessment,
    }])),
  };
}

function environment(environmentId = ENVIRONMENT_ID) {
  if (environmentId === SECOND_ENVIRONMENT_ID) return {
    projectId:PROJECT_ID,environmentId,name:'隔离验证环境',revision:1,
    pluginCount:0,readyPluginCount:0,draftCount:0,resourcePreview:[],resourcePreviewTruncated:false,
    runtime:{...runtime(),environmentId,phase:'disconnected',desiredConnected:false,eligibleCount:0,connectedCount:0,plugins:{}},
  };
  return {
    projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,name:'数据库模拟环境',revision:1,
    pluginCount:plugins.length,readyPluginCount:plugins.length,draftCount:0,
    resourcePreview:plugins.map(({target:_,auth:__,transport:___,tls:____,limits:_____,...record}) => record),
    resourcePreviewTruncated:false,runtime:runtime(),
  };
}

function workspace() {
  return [{
    schemaVersion:2,projectId:PROJECT_ID,name:'数据库工作区验证',revision:1,
    environmentCount:2,pluginCount:plugins.length,environments:[environment(),environment(SECOND_ENVIRONMENT_ID)],
  }];
}

function queryResult(rows,{truncated = false,maxRows = 250} = {}) {
  return {
    rows,rowCount:rows.length,bytes:Buffer.byteLength(JSON.stringify(rows),'utf8'),truncated,
    columns:[{name:'id',table:'orders',type:3},{name:'label',table:'orders',type:253},{name:'optional',table:'orders',type:253}],
    durationMs:12,fingerprint:'fixture-query-fingerprint',
    limitsApplied:{maxRows,maxBytes:262144,timeoutMs:10000},
  };
}

function register(channel,handler) {
  registeredChannels.add(channel);
  ipcMain.handle(channel,handler);
}

function registerRead(channel,handler) {
  register(channel,async (_event,...args) => ok(structuredClone(await handler(...args))));
}

function registerDatabase(channel,handler) {
  register(channel,async (_event,payload) => {
    const call = {channel,payload:structuredClone(payload)};
    databaseCalls.push(call);
    assert.equal(payload.projectId,PROJECT_ID,'数据库请求必须保留项目范围。');
    assert.equal(payload.environmentId,ENVIRONMENT_ID,'数据库请求必须保留环境范围。');
    assert.ok([PRIMARY_ID,OTHER_ID].includes(payload.pluginInstanceId),'离线插件不得发送数据库请求。');
    if (state.holdNext?.channel === channel && state.holdNext.pluginInstanceId === payload.pluginInstanceId) {
      const hold = state.holdNext;
      state.holdNext = null;
      return new Promise((resolve) => {
        const release = () => {
          releases.delete(release);
          resolve(ok(hold.result));
        };
        releases.add(release);
        hold.release = release;
      });
    }
    return structuredClone(await handler(payload));
  });
}

function registerMockApi() {
  registerRead('v2:project-list',() => workspace().map(({environments:_,...record}) => record));
  registerRead('v2:workspace-overview',workspace);
  registerRead('v2:environment-list',() => [environment(),environment(SECOND_ENVIRONMENT_ID)]);
  registerRead('v2:environment-status',({environmentId}) => environment(environmentId).runtime);
  registerRead('v2:plugin-list',({environmentId}) => environmentId === ENVIRONMENT_ID ? plugins : []);
  registerRead('v2:plugin-assess',({pluginInstanceId}) => plugins.find((record) => record.pluginInstanceId === pluginInstanceId)?.assessment);
  registerRead('v2:plugin-credential-status',() => ({fields:{primary:false,proxy:false},legacyAvailable:false}));
  registerRead('v2:plugin-databases',() => []);
  registerRead('v2:audit-list',() => ({entries:[],nextCursor:null}));
  registerRead('v2:confirmation-list',() => []);
  registerRead('v2:runbook-read',() => ({content:'',bytes:0,hash:'0'.repeat(64),empty:true}));
  registerRead('v2:quick-question-opening-get',() => ({schemaVersion:1,text:'只读验证模拟数据库。',defaultText:'只读验证模拟数据库。',revision:1}));
  registerRead('v2:quick-question-list',() => ({schemaVersion:1,projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,revision:1,items:[]}));
  registerDatabase('v2:mysql-list-tables',({pluginInstanceId,cursor}) => {
    if (state.failList) return failed('模拟数据表列表读取失败。');
    if (state.extraTables) return ok({tables:Array.from({length:6},(_,index)=>({name:'fixture_'+(index+1),type:'BASE TABLE',queryable:true})),nextCursor:null,truncated:false});
    if (pluginInstanceId === OTHER_ID) return ok({tables:[{name:'reports',type:'BASE TABLE',queryable:true}],nextCursor:null,truncated:false});
    return ok(cursor ? {
      tables:[{name:'archived_orders',type:'BASE TABLE',queryable:true}],nextCursor:null,truncated:false,
    } : {
      tables:[{name:'orders',type:'BASE TABLE',queryable:true},{name:'order_summary',type:'VIEW',queryable:false}],
      nextCursor:'100',truncated:true,
    });
  });
  registerDatabase('v2:mysql-describe-table',({table}) => state.failDescribe
    ? failed('模拟表结构读取失败。')
    : ok({table,columns:[
      {name:'id',type:'bigint',nullable:false,key:'PRI',default:null,extra:'auto_increment'},
      {name:'label',type:'varchar(255)',nullable:true,key:null,default:null,extra:null},
      {name:'optional',type:'text',nullable:true,key:null,default:null,extra:null},
    ]}));
  registerDatabase('v2:mysql-preview-table',(payload) => state.failPreview
    ? failed('模拟数据预览失败。')
    : state.browseFixture ? ok(browseFixture(payload)) : ok(queryResult([{id:1,label:MARKUP,optional:null},{id:2,label:'已完成订单',optional:''}],{truncated:true,maxRows:100})));
  registerDatabase('v2:mysql-query-readonly',({pluginInstanceId,sql}) => {
    if (sql === 'SELECT sort_probe FROM orders') return ok(queryResult([{id:10,label:'ten'},{id:2,label:'two'},{id:1,label:'one'}]));
    if (sql === SHOWCASE_SQL) return ok({
      ...queryResult(Array.from({length:24},(_,index) => ({
        order_no:`DEMO-20260912-${String(index+1).padStart(4,'0')}`,customer_name:`演示客户 ${String(index+1).padStart(2,'0')}`,
        total_amount:(128+index*37.5).toFixed(2),status:'已完成',created_at:`2026-09-12 09:${String(index*2).padStart(2,'0')}:00`,
      }))),
      columns:['order_no','customer_name','total_amount','status','created_at'].map((name) => ({name,table:'orders',type:253})),
    });
    if (sql.includes('fixture_failure')) return failed('模拟只读 SQL 查询失败。');
    if (sql.includes('duplicate_columns')) return ok({
      ...queryResult([{id:1,label:'不得误展示的重名列值',optional:null}]),
      columns:[{name:'id',table:'orders',type:3},{name:'id',table:'archived_orders',type:3}],
    });
    if (sql.includes('audit_warning')) return ok({...queryResult([{id:1,label:'带审计提示的结果',optional:null}]),auditWarning:true});
    if (sql.includes('1 = 0')) return ok(queryResult([]));
    if (pluginInstanceId === OTHER_ID) return ok(queryResult([{id:301,label:'仅属于报表范围',optional:null}]));
    return ok(queryResult(Array.from({length:105},(_,index) => ({
      id:index+1,label:index === 0 ? MARKUP : `模拟订单 ${index+1}`,optional:index === 0 ? null : '',
    })),{truncated:true}));
  });
  register('v2:connection-intent',async (event,payload) => {
    assert.equal(state.allowDisconnect,true,'仅显式断开测试允许连接操作');
    assert.deepEqual(payload,{...scope(PRIMARY_ID),intent:'disconnect',source:'legacy-plugin'});
    if (state.failDisconnect) return failed('模拟断开失败');
    plugins.find(plugin => plugin.pluginInstanceId === PRIMARY_ID).assessment = assessment('disconnected');
    state.sequence++;
    event.sender.send('v2:environment-status-changed',runtime());
    return ok({snapshot:runtime()});
  });
  // 所有未列入本次测试范围的真实 preload 通道都明确禁止执行。
  const preload = fs.readFileSync(path.join(root,'src','preload.cjs'),'utf8');
  for (const [,channel] of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/gu)) {
    if (registeredChannels.has(channel)) continue;
    register(channel,async () => {
      forbiddenCalls.push(channel);
      return {ok:false,error:{code:'DATABASE_SMOKE_FORBIDDEN',message:'数据库测试禁止配置或连接变更。'}};
    });
  }
}

async function waitFor(win,expression,label,timeoutMs = 10000) {
  const deadline = Date.now()+timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression,true)) return;
    await wait(40);
  }
  throw new Error(`等待超时：${label}`);
}

async function waitUntil(predicate,label) {
  const deadline = Date.now()+10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(40);
  }
  throw new Error(`等待超时：${label}`);
}

async function click(win,selector) {
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`,selector);
  const isTab = await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).getAttribute('role') === 'tab'`,true);
  if (isTab) {
    win.webContents.focus();
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`,true);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`,'数据库子页签激活');
  } else {
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement) || element.matches(':disabled')) return false;
      element.click();
      return true;
    })()`,true),true,`操作必须可用：${selector}`);
  }
  await wait(70);
}

async function fill(win,selector,value) {
  assert.equal(await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});
    element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
    return element.value === ${JSON.stringify(value)};
  })()`,true),true,`输入控件必须可编辑：${selector}`);
  await wait(70);
}

async function activateDetailTab(win,tab) {
  const selector = `[data-detail-tab="${tab}"]`;
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)}) !== null`,`${tab} 详情页签`);
  win.webContents.focus();
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`,true);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`,`${tab} 页签激活`);
}

async function isVisible(win,id) {
  return win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(testId(id))})?.getClientRects().length > 0`,true);
}

async function returnToDetails(win) {
  if (!await isVisible(win,'mysql-workspace-back')) return;
  await click(win,testId('mysql-workspace-back'));
  await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}')?.getClientRects().length === 0`,'返回详情后工作区隐藏');
}

async function selectPluginDetails(win,pluginInstanceId) {
  await returnToDetails(win);
  await click(win,testId(`plugin-trigger-${pluginInstanceId}`));
  await waitFor(win,`document.querySelector(${JSON.stringify(testId(`plugin-trigger-${pluginInstanceId}`))})?.getAttribute('aria-current') === 'page'`,'插件范围切换');
  await activateDetailTab(win,'overview');
  await waitFor(win,`document.querySelector('${testId('plugin-workspace-open')}')?.getClientRects().length > 0`,'连接区的工作区入口');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-detail-tab="database"]') === null`,true),true,'数据库工作区不应继续占用详情页签。');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('plugin-workspace-open')}')?.closest('${testId('plugin-overview-actions')}')?.contains(document.querySelector('${testId('plugin-connection-primary')}')) === true`,true),true,'工作区入口必须紧邻插件连接操作。');
}

async function openDatabaseWorkspace(win) {
  await click(win,testId('plugin-workspace-open'));
  await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}')?.getClientRects().length > 0`,'数据库大窗口');
  await waitFor(win,`document.querySelector('${testId('mysql-database-workspace')}')?.getClientRects().length > 0`,'数据库工作区');
}

async function selectPlugin(win,pluginInstanceId) {
  await selectPluginDetails(win,pluginInstanceId);
  await openDatabaseWorkspace(win);
}

async function assertFullWindow(win) {
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector('${testId('mysql-full-window-workspace')}');
    const bounds = element.getBoundingClientRect();
    return {width:bounds.width,height:bounds.height,left:bounds.left,top:bounds.top,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth > innerWidth};
  })()`,true);
  assert.ok(geometry.width >= geometry.viewport[0]*0.95,'数据库工作区必须占满应用宽度。');
  assert.ok(geometry.height >= geometry.viewport[1]*0.95,'数据库工作区必须占满应用高度。');
  assert.ok(Math.abs(geometry.left) <= 2 && Math.abs(geometry.top) <= 2,'大窗口应从应用内容区起点展开。');
  assert.equal(geometry.overflow,false,'数据库工作区不得造成页面横向溢出。');
}

async function dragDivider(win,id,dx,dy) {
  const selector = `[role="separator"][id$="-${id.replace('mysql-','')}"]`;
  win.webContents.focus();
  await waitFor(win,'document.hasFocus()','分隔条拖动前的真实焦点');
  await captureFrame(win);
  const point = await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const bounds = element?.getBoundingClientRect();
    return bounds ? {x:Math.round(bounds.left+bounds.width/2),y:Math.round(bounds.top+bounds.height/2)} : null;
  })()`,true);
  assert.ok(point,`分隔条必须可见：${id}`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  await captureFrame(win);
  for (let step=1; step<=6; step+=1) {
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:point.x+Math.round(dx*step/6),y:point.y+Math.round(dy*step/6),movementX:Math.round(dx/6),movementY:Math.round(dy/6)});
    await captureFrame(win);
  }
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});
  await wait(100);
}

async function elementSize(win,id,dimension) {
  return win.webContents.executeJavaScript(`document.querySelector('${testId(id)}')?.getBoundingClientRect()[${JSON.stringify(dimension)}] ?? 0`,true);
}

async function pressBodyShortcut(win,keyCode) {
  win.webContents.focus();
  await win.webContents.executeJavaScript('document.activeElement?.blur()',true);
  await waitFor(win,'document.activeElement === document.body','快捷键测试焦点位于 body');
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:[process.platform === 'darwin' ? 'meta' : 'control']});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:[process.platform === 'darwin' ? 'meta' : 'control']});
  await wait(100);
}

async function assertBackgroundShortcutsDisabled(win) {
  const collapsed = await win.webContents.executeJavaScript(`document.querySelector('${testId('project-rail')}').dataset.collapsed`,true);
  for (const key of ['K','N','B']) await pressBodyShortcut(win,key);
  assert.equal(await isVisible(win,'global-command'),false,'body 焦点不得绕过工作区拦截打开全局命令。');
  assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some((element) => element.getClientRects().length > 0)`,true),false,'工作区中不得通过后台快捷键打开弹窗。');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('project-rail')}').dataset.collapsed`,true),collapsed,'工作区中的 Ctrl+B 不得改变后台栏布局。');
}

async function assertBackgroundShortcutsRestored(win) {
  await pressBodyShortcut(win,'K');
  await waitFor(win,`document.querySelector('${testId('global-command')}')?.getClientRects().length > 0`,'返回详情后恢复全局快捷键');
  await win.webContents.capturePage();
  win.webContents.focus();
  await waitFor(win,`document.querySelector('${testId('global-command')}')?.contains(document.activeElement)`,'全局命令已取得输入焦点');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await waitFor(win,`!document.querySelector('${testId('global-command')}') || document.querySelector('${testId('global-command')}').getClientRects().length === 0`,'关闭全局命令');
}

async function assertResizableWorkspace(win) {
  const sidebarWidth=await elementSize(win,'mysql-table-sidebar','width');
  await dragDivider(win,'mysql-sidebar-resizer',80,0);
  const sidebarAfter=await elementSize(win,'mysql-table-sidebar','width');
  assert.ok(sidebarAfter > sidebarWidth+40,`侧栏宽度必须响应真实鼠标拖动：${sidebarWidth} → ${sidebarAfter}`);
  await dragDivider(win,'mysql-sidebar-resizer',-80,0);
  const editorHeight=await elementSize(win,'mysql-query-editor-panel','height');
  await dragDivider(win,'mysql-editor-resizer',0,60);
  assert.ok(await elementSize(win,'mysql-query-editor-panel','height') > editorHeight+30,'编辑器高度必须响应真实鼠标拖动。');
  await dragDivider(win,'mysql-editor-resizer',0,-60);
  await click(win,testId('mysql-sidebar-toggle'));
  await captureFrame(win);
  await waitFor(win,`document.querySelector('${testId('mysql-table-sidebar')}').closest('[data-slot=resizable-panel]').getBoundingClientRect().width < 1`,'侧栏完全收起，不保留图标栏');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-testid=mysql-sidebar-toggle]').getAttribute('aria-label')",true),'恢复分栏');
  await click(win,testId('mysql-sidebar-toggle'));
  await captureFrame(win);
  assert.ok(await elementSize(win,'mysql-table-sidebar','width') >= 180,'恢复表列表宽度');
  await click(win,testId('mysql-editor-toggle'));
  await captureFrame(win);
  await waitFor(win,`document.querySelector('${testId('mysql-query-editor-panel')}').getBoundingClientRect().height < ${editorHeight-50}`,'编辑器收起后释放结果高度');
  await click(win,testId('mysql-editor-toggle'));
}

async function textContains(win,id,text) {
  await waitFor(win,`document.querySelector(${JSON.stringify(testId(id))})?.textContent.includes(${JSON.stringify(text)}) === true`,`${id} 显示预期文本`);
}

async function assertTextOnly(win,id) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(testId(id))});
    return {
      text:element?.textContent.includes(${JSON.stringify(MARKUP)}),
      htmlElements:element?.querySelectorAll('img,script,iframe,object').length,
      injected:window.__databaseInjected === true,
    };
  })()`,true);
  assert.deepEqual(result,{text:true,htmlElements:0,injected:false},'数据库值只能按文本渲染。');
}

async function assertNoPersistence(win) {
  const values = await win.webContents.executeJavaScript(`(async () => ({
    local:JSON.stringify({...localStorage}),
    session:JSON.stringify({...sessionStorage}),
    writes:JSON.stringify(window.__databaseStorageWrites),
    databases:await indexedDB.databases(),
  }))()`,true);
  for (const text of [values.local,values.session,values.writes]) {
    assert.ok(!text.includes(SQL_MARKER) && !text.includes(MARKUP) && !text.includes(LATE_MARKER),
      'SQL 和查询结果不得写入浏览器持久化存储。');
  }
  assert.deepEqual(values.databases,[],'数据库工作区不应创建本地查询历史数据库。');
}

async function openRowDetail(win,selector) {
  await win.webContents.executeJavaScript('document.querySelector('+JSON.stringify(selector+' td:last-child')+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:400,clientY:400}))',true);
  await waitFor(win,'document.querySelector("[data-testid=mysql-result-menu]")','右键菜单');
  await win.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent==="查看行详情").click()',true);
}
async function assertQueryDocuments(win,originalSql) {
  await fill(win,testId('mysql-query-filter'),'模拟订单');
  await click(win,testId('mysql-query-next-page'));
  await openRowDetail(win,`${testId('mysql-query-row')}[data-row-index="104"]`);
  await textContains(win,'mysql-query-row-detail','模拟订单 105');
  const editorView = await win.webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('${testId('mysql-sql-editor')}');
    editor.setSelectionRange(8,20);
    editor.scrollLeft=64;
    return {start:editor.selectionStart,end:editor.selectionEnd,left:editor.scrollLeft};
  })()`,true);
  await click(win,testId('mysql-query-new'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value`,true),'','新标签应使用独立的空编辑器。');
  await click(win,testId('mysql-sql-tab'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-filter')}').value`,true),'模拟订单','切换标签应保留每个结果筛选条件。');
  await textContains(win,'mysql-query-result','模拟订单 105');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-row')}').dataset.rowIndex`,true),'101','切换标签应保留结果当前页。');
  await textContains(win,'mysql-query-row-detail','模拟订单 105');
  const restoredEditor = await win.webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('${testId('mysql-sql-editor')}');
    return {start:editor.selectionStart,end:editor.selectionEnd,left:editor.scrollLeft};
  })()`,true);
  assert.deepEqual(restoredEditor,editorView,'切换标签应保留编辑器选区及水平滚动。');
  await click(win,testId('mysql-query-close-detail'));
  await fill(win,testId('mysql-query-filter'),'');
  await click(win,testId('mysql-sql-document-tab'));
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');
  await click(win,testId('mysql-query-run'));
  await textContains(win,'mysql-query-summary','0 行');
  await click(win,testId('mysql-sql-tab'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value`,true),originalSql,'每个 SQL 标签必须保留独立文本。');
  await textContains(win,'mysql-query-result','模拟订单 100');
  await click(win,testId('mysql-sql-document-tab'));
  const secondId = await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-document-tab')}').dataset.queryId`,true);
  const hold = {channel:'v2:mysql-query-readonly',pluginInstanceId:PRIMARY_ID,result:queryResult([{id:701,label:'仅属于第二个 SQL 标签',optional:null}])};
  state.holdNext = hold;
  await fill(win,testId('mysql-sql-editor'),'SELECT delayed_document FROM orders');
  await click(win,testId('mysql-query-run'));
  await waitUntil(() => Boolean(hold.release),'独立标签延迟请求');
  await click(win,testId('mysql-sql-tab'));
  hold.release();
  await wait(100);
  await textContains(win,'mysql-query-result','模拟订单 100');
  await click(win,testId('mysql-sql-document-tab'));
  await textContains(win,'mysql-query-result','仅属于第二个 SQL 标签');
  await click(win,`${testId('mysql-query-close')}[data-query-id="${secondId}"]`);
  await click(win,testId('mysql-query-new'));
  const thirdId = await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-document-tab')}').dataset.queryId`,true);
  const closedHold = {channel:'v2:mysql-query-readonly',pluginInstanceId:PRIMARY_ID,result:queryResult([{id:702,label:'已关闭标签的迟到结果',optional:null}])};
  state.holdNext = closedHold;
  await fill(win,testId('mysql-sql-editor'),'SELECT closed_document FROM orders');
  await click(win,testId('mysql-query-run'));
  await waitUntil(() => Boolean(closedHold.release),'关闭标签前挂起请求');
  await click(win,`${testId('mysql-query-close')}[data-query-id="${thirdId}"]`);
  closedHold.release();
  await wait(100);
  await textContains(win,'mysql-query-result','模拟订单 100');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-result')}').textContent.includes('已关闭标签的迟到结果')`,true),false,'关闭标签的请求不得回填。');
  for (let index=0; index<5; index+=1) await click(win,testId('mysql-query-new'));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-new')}').disabled`,true),true,'最多只能打开六个 SQL 标签。');
  const extraIds = await win.webContents.executeJavaScript(`[...document.querySelectorAll('${testId('mysql-sql-document-tab')}')].map((element) => element.dataset.queryId)`,true);
  for (const id of extraIds) await click(win,`${testId('mysql-query-close')}[data-query-id="${id}"]`);
  await click(win,testId('mysql-sql-tab'));
  await textContains(win,'mysql-query-result','模拟订单 100');
}

async function assertResultDetails(win) {
  const callCount = databaseCalls.length;
  await openRowDetail(win,`${testId('mysql-query-row')}[data-row-index="0"]`);
  await textContains(win,'mysql-query-row-detail',MARKUP);
  await assertTextOnly(win,'mysql-query-row-detail');
  await click(win,`${testId('mysql-query-copy-cell')}[data-column-name="label"]`);
  assert.equal(await win.webContents.executeJavaScript('window.__databaseClipboardWrites.at(-1)',true),MARKUP,'复制单元格必须保留原始文本。');
  await click(win,testId('mysql-query-copy-row'));
  const copiedRow = JSON.parse(await win.webContents.executeJavaScript('window.__databaseClipboardWrites.at(-1)',true));
  assert.deepEqual(copiedRow,{id:1,label:MARKUP,optional:null},'复制行必须保留字段和 NULL。');
  await screenshot(win,'row-detail');
  await click(win,testId('mysql-query-close-detail'));
  await fill(win,testId('mysql-query-filter'),'模拟订单 105');
  await waitFor(win,`document.querySelectorAll('${testId('mysql-query-row')}').length === 1`,'返回数据本地筛选');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-row')}').dataset.rowIndex`,true),'104','筛选结果应保留返回数组的行索引。');
  assert.equal(databaseCalls.length,callCount,'结果筛选、查看与复制不得重新查询数据库。');
  await fill(win,testId('mysql-query-filter'),'');
}

async function setExactViewport(win,width,height) {
  win.setContentSize(width,height);
  await waitFor(win,`innerWidth === ${width} && innerHeight === ${height}`,'截图窗口尺寸');
  win.webContents.invalidate();
  await wait(100);
}

async function captureFrame(win) {
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true);
  await wait(100);
  return win.webContents.capturePage();
}

async function screenshot(win,name) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});
  // 隐藏窗口截图暂停过渡，按最终主题样式采集，避免继承颜色停留在中间帧。
  await win.webContents.executeJavaScript(`(() => {const style=document.createElement('style');style.id='database-screenshot-motion';style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style)})()`,true);
  if (win.webContents.getZoomFactor() !== 1) {
    const originalTheme = nativeTheme.themeSource;
    for (const theme of ['dark','light']) {
      nativeTheme.themeSource = theme;
      await waitFor(win,`document.documentElement.dataset.theme === '${theme}'`,'缩放截图主题');
      await wait(200);
      fs.writeFileSync(path.join(screenshotRoot,`database-${name}-${theme}.png`),(await captureFrame(win)).toPNG());
    }
    nativeTheme.themeSource = originalTheme;
    await captureFrame(win);
    await win.webContents.executeJavaScript("document.getElementById('database-screenshot-motion')?.remove()",true);
    return;
  }
  const originalTheme = nativeTheme.themeSource;
  const originalSize = await win.webContents.executeJavaScript('[innerWidth,innerHeight]',true);
  for (const theme of ['dark','light']) {
    nativeTheme.themeSource=theme;
    await waitFor(win,`document.documentElement.dataset.theme === '${theme}'`,'截图主题切换');
    await win.webContents.capturePage();
    await wait(name === 'workspace-entry' ? 1000 : 350);
    for (const [width,height] of [[1600,1000],[1400,900],...(process.argv.includes('--mysql-edit') ? [[960,640]] : [])]) {
      await setExactViewport(win,width,height);
      if (await isVisible(win,'mysql-full-window-workspace')) await assertFullWindow(win);
      const frame = (await captureFrame(win)).toPNG();
      fs.writeFileSync(path.join(screenshotRoot,`database-${name}-${theme}-${width}x${height}.png`),frame);
      if (name === 'workspace-entry' && width === 1600) {
        fs.writeFileSync(path.join(screenshotRoot,`mysql-workspace-entry-${theme}.png`),frame);

      }
    }
  }
  nativeTheme.themeSource=originalTheme;
  await setExactViewport(win,...originalSize);
  await win.webContents.executeJavaScript("document.getElementById('database-screenshot-motion')?.remove()",true);
}

async function run() {
  assert.ok(fs.existsSync(pagePath),'请先执行 build:renderer。');
  await app.whenReady();
  registerMockApi();
  const editingFixture = process.argv.includes("--mysql-edit") ? await (await import("./mysql-edit-ui-fixture.mjs")).installMysqlEditUiFixture({ipcMain,registeredChannels,plugin:plugins[0],moduleRoot:runtimeRoot}) : null;
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    const blocked = !details.url.startsWith('file:') && !details.url.startsWith('devtools:');
    if (blocked) externalRequests.push(details.url);
    callback(blocked ? {cancel:true} : {});
  });
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  const win = new BrowserWindow({ enableLargerThanScreen:true,
    show:process.platform === 'darwin',useContentSize:true,width:1600,height:1000,
    webPreferences:{preload:path.join(runtimeRoot,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false},
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('did-finish-load',() => win.webContents.focus());
  win.webContents.on('will-attach-webview',(event) => event.preventDefault());
  win.webContents.on('will-navigate',(event) => event.preventDefault());
  win.webContents.on('console-message',(_event,level,message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  try {
    await win.loadFile(pagePath);
    await waitFor(win,'document.querySelector(\'[data-shell-ready="true"]\') !== null','React 工作区加载');
    await win.webContents.executeJavaScript(`(() => {
      window.__databaseStorageWrites = [];
      window.__databaseClipboardWrites = [];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (text) => { window.__databaseClipboardWrites.push(String(text)); }}});
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) {
        window.__databaseStorageWrites.push([String(key),String(value)]);
        return original.call(this,key,value);
      };
    })()`,true);
    await click(win,`[data-project-id="${PROJECT_ID}"]`);
    await click(win,testId(`environment-trigger-${ENVIRONMENT_ID}`));
    if (editingFixture) {
      await require('./database-edit-ui.cjs')({win,fixture:editingFixture,click,fill,waitFor,testId,screenshot,selectPlugin,PRIMARY_ID,plugins,state,runtime});
      await assertNoPersistence(win);
      assert.deepEqual(rendererErrors,[]);
      assert.deepEqual(externalRequests,[]);
      return;
    }
    await selectPluginDetails(win,OFFLINE_ID);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('plugin-workspace-open')}').disabled`,true),true,'未连接的工作区入口必须禁用。');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('plugin-workspace-open')}').getAttribute('aria-description')`,true),'请先连接数据库','离线入口必须说明不可用原因。');
    await win.webContents.executeJavaScript(`document.querySelector('${testId('plugin-workspace-open')}').click()`,true);
    assert.equal(await isVisible(win,'mysql-full-window-workspace'),false,'未连接不得展开工作区。');
    assert.equal(databaseCalls.length,0,'离线插件不得发起数据库请求。');
    await screenshot(win,'offline');

    await selectPluginDetails(win,PRIMARY_ID);
    assert.equal(databaseCalls.length,0,'详情页不得提前加载数据表。');
    await screenshot(win,'workspace-entry');
    await openDatabaseWorkspace(win);
    await assertFullWindow(win);
    await textContains(win,'mysql-table-list','orders');
    assert.deepEqual(databaseCalls[0],{channel:'v2:mysql-list-tables',payload:{...scope(PRIMARY_ID),limit:100}});
    await require('./workspace-controls-ui.cjs')({evaluate:source=>win.webContents.executeJavaScript(source,true),click:selector=>click(win,selector),until:(expression,label)=>waitFor(win,expression,label),win,root:'[data-testid=mysql-database-workspace]'});
    await require('./workspace-layout-ui.cjs')({evaluate:source=>win.webContents.executeJavaScript(source,true),until:(expression,label)=>waitFor(win,expression,label),win,root:'[data-testid=mysql-database-workspace]'});
    assert.equal(databaseCalls.length,1,'主题切换不得重新请求数据库');
    await assertResizableWorkspace(win);
    await assertBackgroundShortcutsDisabled(win);
    await fill(win,testId('mysql-table-search'),'orders');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('${testId('mysql-table-item')}').length`,true),1);
    const beforeClearSearch = databaseCalls.length;
    await click(win,testId('mysql-table-search-clear'));
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-testid=mysql-table-search]').value",true),'');
    assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('[data-testid=mysql-table-search]')",true),true,'清空后焦点保留在搜索框');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-testid=mysql-table-search-clear]')",true),null,'空搜索不显示清除按钮');
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('[data-testid=mysql-table-item]').length",true),2,'清空恢复全部已加载表');
    assert.equal(databaseCalls.length,beforeClearSearch,'清除搜索不重新请求数据库');
    await click(win,testId('mysql-tables-load-more'));
    await textContains(win,'mysql-table-list','archived_orders');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-list-tables',payload:{...scope(PRIMARY_ID),limit:100,cursor:'100'}});
    const viewCalls = databaseCalls.length;
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-table-item')}[data-table-name="order_summary"]').click()`,true);
    await wait(100);
    assert.equal(databaseCalls.length,viewCalls,'不可查询的 View 不得发起表读取。');
    await click(win,`${testId('mysql-table-item')}[data-table-name="orders"]`);
    await textContains(win,'mysql-preview-result','已完成订单');
    assert.equal(databaseCalls.filter(call => call.channel === 'v2:mysql-preview-table').length,1,'首次点击表自动读取一页');
    await click(win,testId('mysql-table-structure-tab'));
    await textContains(win,'mysql-table-structure','bigint');
    await screenshot(win,'structure');
    state.failDescribe = true;
    await click(win,`${testId('mysql-table-item')}[data-table-name="archived_orders"]`);
    await textContains(win,'mysql-structure-error','模拟表结构读取失败');
    state.failDescribe = false;
    await click(win,`${testId('mysql-table-item')}[data-table-name="orders"]`);
    await textContains(win,'mysql-table-structure','bigint');

    await click(win,testId('mysql-table-preview-tab'));
    assert.equal(databaseCalls.filter((call) => call.channel === 'v2:mysql-preview-table').length,1,'切回已打开表不得重复预览。');
    await click(win,testId('mysql-preview-run'));
    await textContains(win,'mysql-preview-result','已完成订单');
    await waitFor(win,`document.querySelector('${testId('mysql-preview-truncated')}') !== null`,'预览截断提示');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-preview-table',payload:{...scope(PRIMARY_ID),table:'orders',where:'',orderBy:[{column:'id',direction:'asc'}],limit:20,offset:0}});
    await assertTextOnly(win,'mysql-preview-result');
    await textContains(win,'mysql-preview-result','NULL');
    await textContains(win,'mysql-preview-result','（空字符串）');
    await textContains(win,'mysql-preview-summary','12 ms');
    const compactLayout = await win.webContents.executeJavaScript(`(() => {
      const toolbar=document.querySelector('.mysql-table-toolbar'),condition=document.querySelector('.mysql-table-filter-bar'),result=document.querySelector('[data-testid=mysql-preview-result]'),rail=result.querySelector('[data-testid=mysql-row-toolbar]'),footer=result.querySelector('.mysql-results-footer'),filter=document.querySelector('[data-testid=mysql-preview-filter]');
      return {top:toolbar.getBoundingClientRect().height+condition.getBoundingClientRect().height,footer:footer.getBoundingClientRect().height,rail:rail.getBoundingClientRect().width,vertical:getComputedStyle(rail).flexDirection,filterInTop:toolbar.contains(filter),extraHeader:Boolean(result.querySelector('.mysql-result-search-bar')),structureRefresh:Boolean(toolbar.querySelector('[aria-label="刷新表结构"]'))};
    })()`,true);
    assert.ok(compactLayout.top<=80,'顶部仅保留两行工具栏');assert.equal(compactLayout.footer,36,'底栏保持单行');assert.equal(compactLayout.rail,56,'竖栏固定宽度');assert.equal(compactLayout.vertical,'column');assert.equal(compactLayout.filterInTop,true);assert.equal(compactLayout.extraHeader,false);assert.equal(compactLayout.structureRefresh,false);
    await click(win,testId('mysql-query-options'));
    await textContains(win,'mysql-query-options-panel','LIMIT 20');
    const beforeSettings=databaseCalls.length;
    await click(win,'[aria-label="每批读取行数"]');
    await waitFor(win,'[...document.querySelectorAll("[role=option]")].some(e=>e.textContent.includes("50 行"))','读取数量选项');
    await win.webContents.executeJavaScript('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("50 行")).click()',true);
    assert.equal(databaseCalls.length,beforeSettings,'调整读取数量不立即请求数据库');
    await click(win,testId('mysql-query-options'));
    await click(win,testId('mysql-preview-run'));
    assert.equal(databaseCalls.at(-1).payload.limit,50,'执行后使用新的每批读取数量');
    await click(win,testId('mysql-query-options'));
    await click(win,'[aria-label="每批读取行数"]');
    await win.webContents.executeJavaScript('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("20 行")).click()',true);
    await click(win,testId('mysql-query-options'));
    await click(win,testId('mysql-preview-run'));

    await screenshot(win,'preview');
    state.failPreview = true;
    await click(win,testId('mysql-preview-run'));
    await textContains(win,'mysql-preview-error','模拟数据预览失败');
    state.failPreview = false;
    await click(win,testId('mysql-preview-run'));
    await textContains(win,'mysql-preview-result','已完成订单');

    await click(win,testId('mysql-sql-tab'));
    await textContains(win,'mysql-database-workspace','支持单条 SELECT');
    await fill(win,testId('mysql-sql-editor'),'');
    const emptySqlCalls = databaseCalls.length;
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-run')}').click()`,true);
    await wait(100);
    assert.equal(databaseCalls.length,emptySqlCalls,'空 SQL 不得发送 IPC。');
    const sql = `SELECT '${SQL_MARKER}', '${MARKUP}' FROM orders`;
    await fill(win,testId('mysql-sql-editor'),sql);
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-result','模拟订单 100');
    await assertTextOnly(win,'mysql-query-result');
    await waitFor(win,`document.querySelector('${testId('mysql-query-truncated')}') !== null`,'查询截断提示');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-query-readonly',payload:{...scope(PRIMARY_ID),sql}});
    await screenshot(win,'query');
    await click(win,testId('mysql-query-copy'));
    assert.equal(await win.webContents.executeJavaScript('window.__databaseClipboardWrites.at(-1)',true),sql,'复制 SQL 必须保留编辑器文本。');
    await assertResultDetails(win);
    await assertQueryDocuments(win,sql);
    const beforeReturnCalls=databaseCalls.length;
    await returnToDetails(win);
    await textContains(win,'plugin-workspace-open','继续工作区');
    await waitFor(win,`document.activeElement === document.querySelector('${testId('plugin-workspace-open')}')`,'返回焦点恢复到工作区入口');
    await assertBackgroundShortcutsRestored(win);
    await openDatabaseWorkspace(win);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value`,true),sql,'返回再打开必须保留当前连接的 SQL。');
    await textContains(win,'mysql-query-result','模拟订单 100');
    assert.equal(databaseCalls.length,beforeReturnCalls,'继续工作区不得自动重复查询。');
    await click(win,testId('mysql-query-next-page'));
    await textContains(win,'mysql-query-result','模拟订单 105');
    await assertNoPersistence(win);

    await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');
    win.webContents.focus();
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').focus()`,true);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers:[process.platform === 'darwin' ? 'meta' : 'control']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers:[process.platform === 'darwin' ? 'meta' : 'control']});
    await textContains(win,'mysql-query-result','查询成功，没有符合条件的数据');
    await textContains(win,'mysql-query-summary','0 行');
    await fill(win,testId('mysql-sql-editor'),'SELECT duplicate_columns FROM orders');
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-duplicate-columns','查询返回了重名列');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-result')} table') === null`,true),true,'重名列必须阻止误导性的结果表格。');
    await screenshot(win,'duplicate-columns');
    await fill(win,testId('mysql-sql-editor'),'SELECT audit_warning FROM orders');
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-audit-warning','操作记录写入失败');
    await textContains(win,'mysql-query-result','带审计提示的结果');
    await fill(win,testId('mysql-sql-editor'),'SELECT fixture_failure FROM orders');
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-error','模拟只读 SQL 查询失败');
    await screenshot(win,'query-error');

    const queryHold = {channel:'v2:mysql-query-readonly',pluginInstanceId:PRIMARY_ID,result:queryResult([{id:999,label:LATE_MARKER,optional:null}])};
    state.holdNext = queryHold;
    await fill(win,testId('mysql-sql-editor'),'SELECT delayed_scope_result FROM orders');
    await click(win,testId('mysql-query-run'));
    await waitUntil(() => Boolean(queryHold.release),'查询延迟响应挂起');
    await selectPlugin(win,OTHER_ID);
    await textContains(win,'mysql-table-list','reports');
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes('delayed_scope_result')`,true),false,'新插件不得继承其他插件的 SQL。');
    await fill(win,testId('mysql-sql-editor'),'SELECT * FROM reports');
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-result','仅属于报表范围');
    queryHold.release();
    await wait(150);
    await textContains(win,'mysql-query-result','仅属于报表范围');
    assert.equal(await win.webContents.executeJavaScript(`document.body.textContent.includes(${JSON.stringify(LATE_MARKER)})`,true),false,'旧插件迟到响应不得覆盖当前结果。');

    await selectPlugin(win,PRIMARY_ID);
    await textContains(win,'mysql-table-list','orders');
    state.failList = true;
    await click(win,testId('mysql-tables-refresh'));
    await textContains(win,'mysql-tables-error','模拟数据表列表读取失败');
    state.failList = false;
    await click(win,testId('mysql-tables-refresh'));
    await textContains(win,'mysql-table-list','orders');
    const listHold = {channel:'v2:mysql-list-tables',pluginInstanceId:PRIMARY_ID,result:{tables:[{name:'late_old_scope_table',type:'BASE TABLE',queryable:true}],nextCursor:null,truncated:false}};
    state.holdNext = listHold;
    await click(win,testId('mysql-tables-refresh'));
    await waitUntil(() => Boolean(listHold.release),'表列表延迟响应挂起');
    await selectPlugin(win,OTHER_ID);
    await textContains(win,'mysql-table-list','reports');
    listHold.release();
    await wait(150);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-table-list')}').textContent.includes('late_old_scope_table')`,true),false,'旧插件迟到表列表不得显示。');

    await click(win,testId('mysql-sql-tab'));
    await fill(win,testId('mysql-sql-editor'),`SELECT '${SQL_MARKER}' FROM reports`);
    const active = plugins.find((record) => record.pluginInstanceId === OTHER_ID);
    active.assessment = assessment('disconnected');
    state.sequence += 1;
    win.webContents.send('v2:environment-status-changed',runtime());
    await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}') === null`,'断连销毁数据库会话');
    await waitFor(win,`document.querySelector('${testId('plugin-workspace-open')}')?.disabled === true`,'断连入口禁用');
    const disconnectedCalls = databaseCalls.length;
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-run')}')?.click()`,true);
    await wait(100);
    assert.equal(databaseCalls.length,disconnectedCalls,'连接断开后不得继续查询。');
    active.assessment = assessment('connected');
    state.sequence += 1;
    win.webContents.send('v2:environment-status-changed',runtime());
    await waitFor(win,`document.querySelector('${testId('plugin-workspace-open')}')?.disabled === false`,'重连入口恢复');
    await openDatabaseWorkspace(win);
    await textContains(win,'mysql-table-list','reports');
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes(${JSON.stringify(SQL_MARKER)})`,true),false,'重连后必须清除旧 SQL。');
    await fill(win,testId('mysql-sql-editor'),`SELECT '${SQL_MARKER}' FROM reports`);
    await returnToDetails(win);
    await click(win,testId(`environment-trigger-${SECOND_ENVIRONMENT_ID}`));
    await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}') === null`,'切换环境销毁保留的数据库工作区');
    await click(win,testId(`environment-trigger-${ENVIRONMENT_ID}`));
    await selectPlugin(win,OTHER_ID);
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes(${JSON.stringify(SQL_MARKER)})`,true),false,'切换环境后不得恢复旧 SQL。');
    await fill(win,testId('mysql-sql-editor'),`SELECT '${SQL_MARKER}' FROM reports`);
    active.revision += 1;
    win.webContents.send('v2:workspace-changed',{...scope(OTHER_ID),type:'plugin-updated'});
    await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}') === null`,'配置版本变更销毁旧工作区');
    await openDatabaseWorkspace(win);
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes(${JSON.stringify(SQL_MARKER)})`,true),false,'配置修订后不得恢复旧 SQL。');
    await fill(win,testId('mysql-sql-editor'),`SELECT '${SQL_MARKER}' FROM reports`);
    active.assessment = assessment('disconnected');
    state.sequence += 1;
    win.webContents.send('v2:environment-status-changed',runtime());
    active.assessment = assessment('connected');
    state.sequence += 1;
    win.webContents.send('v2:environment-status-changed',runtime());
    await waitFor(win,`document.querySelector('${testId('mysql-full-window-workspace')}') === null`,'快速断连重连仍须销毁旧会话');
    await openDatabaseWorkspace(win);
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes(${JSON.stringify(SQL_MARKER)})`,true),false,'同批快速断重连不得恢复旧 SQL。');
    await selectPlugin(win,PRIMARY_ID);
    await click(win,testId('mysql-sql-tab'));
    await fill(win,testId('mysql-sql-editor'),SHOWCASE_SQL);
    await click(win,testId('mysql-query-run'));
    await textContains(win,'mysql-query-result','演示客户 24');
    await screenshot(win,'workspace');
    await assertSqlAssistanceAndBrowse({win,fill,click,waitFor,textContains,testId,screenshot,state,databaseCalls,PRIMARY_ID});
    await require('./database-tabs-ui.cjs')({win,fill,click,waitFor,textContains,testId,screenshot,state,databaseCalls,PRIMARY_ID,clipboard,openRowDetail});
    await assertNoPersistence(win);
    assert.deepEqual(forbiddenCalls,[],'只读数据库工作区不得调用配置变更通道。');
    assert.deepEqual(externalRequests,[],'数据库 UI 测试不得发起外部网络请求。');
    assert.deepEqual(rendererErrors,[],'Renderer 不应产生错误。');
    process.stdout.write(`数据库 UI smoke 通过（${databaseCalls.length} 次限定范围的模拟只读请求）。\n`);
  } catch (error) {
    await screenshot(win,'failure').catch(() => undefined);
    throw error;
  } finally {
    await editingFixture?.close();
    for (const release of releases) release();
    if (!win.isDestroyed()) win.destroy();
    await wait(100);
    for (const channel of registeredChannels) ipcMain.removeHandler(channel);
  }
}

run().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
