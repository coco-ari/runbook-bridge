const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {
  // 测试独立管理隐藏窗口和退出时机。
});

const root = path.resolve(__dirname,'..');
const pagePath = path.join(root,'renderer-build','v2','index.html');
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
const PRIMARY_ID = 'plugin-orders-smoke';
const OTHER_ID = 'plugin-reports-smoke';
const OFFLINE_ID = 'plugin-offline-smoke';
const MARKUP = '<img id="database-result-injection" src="https://untrusted.example.invalid/image" onerror="window.__databaseInjected=true">';
const SQL_MARKER = 'database-smoke-volatile-sql';
const LATE_MARKER = '迟到的订单范围结果';
const registeredChannels = new Set();
const databaseCalls = [];
const forbiddenCalls = [];
const externalRequests = [];
const rendererErrors = [];
const releases = new Set();
const state = { sequence:1, failList:false, failDescribe:false, failPreview:false, holdNext:null };
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

function environment() {
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
    environmentCount:1,pluginCount:plugins.length,environments:[environment()],
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
  registerRead('v2:environment-list',() => [environment()]);
  registerRead('v2:environment-status',runtime);
  registerRead('v2:plugin-list',() => plugins);
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
  registerDatabase('v2:mysql-preview-table',() => state.failPreview
    ? failed('模拟数据预览失败。')
    : ok(queryResult([{id:1,label:MARKUP,optional:null},{id:2,label:'已完成订单',optional:''}],{truncated:true,maxRows:100})));
  registerDatabase('v2:mysql-query-readonly',({pluginInstanceId,sql}) => {
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
  // 所有未列入只读测试范围的真实 preload 通道都明确禁止执行。
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

async function selectPlugin(win,pluginInstanceId) {
  await click(win,testId(`plugin-trigger-${pluginInstanceId}`));
  await waitFor(win,`document.querySelector(${JSON.stringify(testId(`plugin-trigger-${pluginInstanceId}`))})?.getAttribute('aria-current') === 'page'`,'插件范围切换');
  await activateDetailTab(win,'database');
  await waitFor(win,`document.querySelector(${JSON.stringify(testId('mysql-database-workspace'))}) !== null`,'数据库工作区');
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

async function screenshot(win,name) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true);
  await wait(100);
  const theme = await win.webContents.executeJavaScript('document.documentElement.dataset.theme',true);
  fs.writeFileSync(path.join(screenshotRoot,`database-${name}-${theme}.png`),(await win.webContents.capturePage()).toPNG());
  if (name === 'query' || name === 'preview') {
    await win.webContents.executeJavaScript(`document.querySelector('${testId(`mysql-${name}-result`)}')?.scrollIntoView({block:'start'})`,true);
    win.webContents.invalidate();
    await wait(120);
    fs.writeFileSync(path.join(screenshotRoot,`database-${name}-result-${theme}.png`),(await win.webContents.capturePage()).toPNG());
  }
}

async function run() {
  assert.ok(fs.existsSync(pagePath),'请先执行 build:renderer。');
  await app.whenReady();
  registerMockApi();
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    const blocked = !details.url.startsWith('file:') && !details.url.startsWith('devtools:');
    if (blocked) externalRequests.push(details.url);
    callback(blocked ? {cancel:true} : {});
  });
  const win = new BrowserWindow({
    show:false,useContentSize:true,width:1280,height:820,
    webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false},
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
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) {
        window.__databaseStorageWrites.push([String(key),String(value)]);
        return original.call(this,key,value);
      };
    })()`,true);
    await click(win,`[data-project-id="${PROJECT_ID}"]`);
    await click(win,testId(`environment-trigger-${ENVIRONMENT_ID}`));
    await selectPlugin(win,OFFLINE_ID);
    await textContains(win,'mysql-database-offline','连接');
    assert.equal(databaseCalls.length,0,'离线工作区不得发起数据库请求。');
    await screenshot(win,'offline');

    await selectPlugin(win,PRIMARY_ID);
    await textContains(win,'mysql-table-list','orders');
    assert.deepEqual(databaseCalls[0],{channel:'v2:mysql-list-tables',payload:{...scope(PRIMARY_ID),limit:100}});
    await fill(win,testId('mysql-table-search'),'orders');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('${testId('mysql-table-item')}').length`,true),1);
    await fill(win,testId('mysql-table-search'),'');
    await click(win,testId('mysql-tables-load-more'));
    await textContains(win,'mysql-table-list','archived_orders');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-list-tables',payload:{...scope(PRIMARY_ID),limit:100,cursor:'100'}});
    const viewCalls = databaseCalls.length;
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-table-item')}[data-table-name="order_summary"]').click()`,true);
    await wait(100);
    assert.equal(databaseCalls.length,viewCalls,'不可查询的 View 不得发起表读取。');
    await click(win,`${testId('mysql-table-item')}[data-table-name="orders"]`);
    await textContains(win,'mysql-table-structure','bigint');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-describe-table',payload:{...scope(PRIMARY_ID),table:'orders'}});
    await screenshot(win,'structure');
    state.failDescribe = true;
    await click(win,`${testId('mysql-table-item')}[data-table-name="archived_orders"]`);
    await textContains(win,'mysql-structure-error','模拟表结构读取失败');
    state.failDescribe = false;
    await click(win,`${testId('mysql-table-item')}[data-table-name="orders"]`);
    await textContains(win,'mysql-table-structure','bigint');

    await click(win,testId('mysql-table-preview-tab'));
    assert.equal(databaseCalls.filter((call) => call.channel === 'v2:mysql-preview-table').length,0,'切页签不得自动查询表数据。');
    await click(win,testId('mysql-preview-run'));
    await textContains(win,'mysql-preview-result','已完成订单');
    await waitFor(win,`document.querySelector('${testId('mysql-preview-truncated')}') !== null`,'预览截断提示');
    assert.deepEqual(databaseCalls.at(-1),{channel:'v2:mysql-preview-table',payload:{...scope(PRIMARY_ID),table:'orders'}});
    await assertTextOnly(win,'mysql-preview-result');
    await textContains(win,'mysql-preview-result','NULL');
    await textContains(win,'mysql-preview-result','（空字符串）');
    await textContains(win,'mysql-preview-summary','耗时 12 ms');
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
    await click(win,testId('mysql-query-next-page'));
    await textContains(win,'mysql-query-result','模拟订单 105');
    await assertNoPersistence(win);

    await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');
    win.webContents.focus();
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').focus()`,true);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers:['control']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers:['control']});
    await textContains(win,'mysql-query-result','查询成功，没有符合条件的数据');
    await textContains(win,'mysql-query-summary','返回 0 行');
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
    await textContains(win,'mysql-database-offline','连接');
    const disconnectedCalls = databaseCalls.length;
    await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-query-run')}')?.click()`,true);
    await wait(100);
    assert.equal(databaseCalls.length,disconnectedCalls,'连接断开后不得继续查询。');
    active.assessment = assessment('connected');
    state.sequence += 1;
    win.webContents.send('v2:environment-status-changed',runtime());
    await textContains(win,'mysql-table-list','reports');
    await click(win,testId('mysql-sql-tab'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${testId('mysql-sql-editor')}').value.includes(${JSON.stringify(SQL_MARKER)})`,true),false,'重连后必须清除旧 SQL。');
    await assertNoPersistence(win);
    assert.deepEqual(forbiddenCalls,[],'只读数据库工作区不得调用配置变更通道。');
    assert.deepEqual(externalRequests,[],'数据库 UI 测试不得发起外部网络请求。');
    assert.deepEqual(rendererErrors,[],'Renderer 不应产生错误。');
    process.stdout.write(`数据库 UI smoke 通过（${databaseCalls.length} 次限定范围的模拟只读请求）。\n`);
  } catch (error) {
    await screenshot(win,'failure').catch(() => undefined);
    throw error;
  } finally {
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
