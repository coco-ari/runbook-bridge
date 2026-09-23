const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-bridge-redis-ui-'));
app.setPath('userData', dataRoot);
app.setPath('sessionData', path.join(dataRoot, 'session'));
const screenshotRoot = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR;
const projectId = 'redis-ui-project';
const environmentId = 'redis-ui-environment';
const scope = { projectId, environmentId, pluginInstanceId: 'redis-primary' };
const assessment = (phase) => ({ phase, primaryStatus: { kind: phase, label: phase === 'connected' ? '已连接' : '未连接', action: phase === 'connected' ? 'disconnect' : 'connect' } });
const plugin = { ...scope, pluginType: 'redis', displayName: '业务缓存', configState: 'ready', revision: 1,
  target: { host: 'redis.smoke.invalid', port: 6379, db: 3 }, auth: { username: 'readonly' }, transport: { kind: 'direct' }, tls: { mode: 'verifyIdentity' },
  limits: { maxKeys: 100, maxValueBytes: 65536, timeoutMs: 5000 }, assessment: assessment('connected'),
  patterns: [{ patternId: 'cache', pattern: 'cache:*', displayName: '业务缓存' }, { patternId: 'session', pattern: 'session:*', displayName: '会话' }] };
const plugins = [plugin, { ...plugin, pluginInstanceId: 'redis-offline', displayName: '离线缓存', assessment: assessment('disconnected') }];
let sequence = 1;
const runtime = () => ({ projectId, environmentId, sequence, phase: 'partial', desiredConnected: true, eligibleCount: 2,
  connectedCount: plugins.filter((entry) => entry.assessment.phase === 'connected').length, errorCount: 0, blockedCount: 0, draftCount: 0, pluginsPartial: false,
  plugins: Object.fromEntries(plugins.map((entry) => [entry.pluginInstanceId, { pluginInstanceId: entry.pluginInstanceId, phase: entry.assessment.phase, assessment: entry.assessment }])) });
const environment = () => ({ projectId, environmentId, name: '测试环境', revision: 1, pluginCount: 2, readyPluginCount: 2, draftCount: 0, resourcePreview: plugins, resourcePreviewTruncated: false, runtime: runtime() });
const workspace = () => [{ projectId, name: 'Redis 工作区验证', revision: 1, schemaVersion: 2, environmentCount: 1, pluginCount: 2, environments: [environment()] }];
const calls = [];
const forbidden = [];
const external = [];
const errors = [];
const channels = new Set();
const markup = '<img id="redis-injection" src="https://untrusted.invalid/pixel" onerror="window.injected=true">';
const longKey = 'cache:' + '很长的键名'.repeat(35);
const keys = ['cache:text', 'cache:hash', 'cache:list', 'cache:set', 'cache:zset', 'cache:binary', 'cache:empty', 'cache:stream', longKey,
  'cache:orders:pending:1001', 'cache:orders:pending:1002', 'cache:orders:completed:1000', 'cache:users:1001:profile', 'cache:users:1002:profile', 'cache:users', 'cache:settings:feature_flags', 'cache:platform:', 'cache:json-preview', 'cache:invalid-json', 'cache:large-json'];
const platformJson = '["example.Collection",[{"id":9007199254740993123,"name":"示例平台","enabled":true,"optional":null,"markup":' + JSON.stringify(markup) + ',"tags":["one","two"]},{"id":2,"name":"备用平台"}]]';
const partialJson = '{"rows":[{"id":1,"name":"首条记录"},{"id":2,"name":"未读取完  ';
const largeJson = JSON.stringify(Array.from({ length: 6000 }, (_, index) => ({ id: index, name: 'item-' + index, enabled: true })));
const stamp = () => new Date().toISOString();
const value = (text, truncated = false) => ({ text, hex: Buffer.from(text ?? [0, 255, 128]).toString('hex'), bytes: Buffer.byteLength(text ?? Buffer.from([0, 255, 128])), shownBytes: Buffer.byteLength(text ?? Buffer.from([0, 255, 128])), truncated });
const typeOf = (key) => ({ 'cache:hash': 'hash', 'cache:list': 'list', 'cache:set': 'set', 'cache:zset': 'zset', 'cache:stream': 'stream' }[key] ?? 'string');
const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const state = { hold: null, auditWarning: false, failScan: false, scanPages: [], releaseScan: null };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testId = (id) => '[data-testid="' + id + '"]';
const active = (id) => '.redis-tab-panel:not([hidden]) ' + testId(id);
function register(name, handler) { channels.add(name); ipcMain.handle(name, handler); }
function read(name, fn) { register(name, async (_event, payload) => ok(structuredClone(await fn(payload)))); }
function mocks(redisKeySearch) {
  read('v2:workspace-overview', workspace);
  read('v2:project-list', () => workspace());
  read('v2:environment-list', () => [environment()]);
  read('v2:environment-status', runtime);
  read('v2:plugin-list', () => plugins);
  read('v2:plugin-assess', () => plugin.assessment);
  read('v2:plugin-credential-status', () => ({ fields: { primary: false, proxy: false }, legacyAvailable: false }));
  read('v2:audit-list', () => ({ entries: [], nextCursor: null }));
  read('v2:confirmation-list', () => []);
  read('v2:runbook-read', () => ({ content: '', bytes: 0, hash: '0'.repeat(64), empty: true }));
  read('v2:quick-question-opening-get', () => ({ schemaVersion: 1, text: '只读排查', defaultText: '只读排查', revision: 1 }));
  read('v2:quick-question-list', () => ({ schemaVersion: 1, projectId, environmentId, revision: 1, items: [] }));
  for (const operation of ['scan', 'inspect', 'read', 'release']) register('v2:redis-workspace-' + operation, async (_event, payload) => {
    calls.push({ operation, payload });
    assert.deepEqual({ projectId: payload.projectId, environmentId: payload.environmentId, pluginInstanceId: payload.pluginInstanceId }, scope);
    if (operation === 'release') return ok({ released: true });
    assert.ok(['cache', 'session'].includes(payload.patternId));
    if (state.hold?.operation === operation) {
      const hold = state.hold; state.hold = null;
      return new Promise((resolve) => { hold.release = () => resolve(ok(hold.data)); });
    }
    if (operation === 'scan') {
      if (state.failScan) return fail('REDIS_READ_FAILED', '模拟扫描失败');
      if (state.scanPages.length) {
        const { hold, ...page } = state.scanPages.shift();
        const result = ok({ ...page, unsupportedKeys: 0, readAt: stamp() });
        if (hold) return new Promise((resolve) => { state.releaseScan = () => resolve(result); });
        return result;
      }
      const selected = payload.patternId === 'cache' ? keys : ['session:one'];
      return ok({ keys: selected.filter(redisKeySearch(payload.keyword)), nextCursor: null, complete: true, unsupportedKeys: 0, readAt: stamp(), auditWarning: state.auditWarning });
    }
    if (!payload.key.startsWith(payload.patternId + ':')) return fail('POLICY_DENIED', 'Redis Key 不在允许范围内。');
    if (operation === 'inspect') return ok({ key: payload.key, type: typeOf(payload.key), exists: payload.key !== 'cache:expired', ttlSeconds: payload.key === 'cache:expired' ? -2 : payload.key === 'cache:text' ? 1680 : -1,
      length: typeOf(payload.key) === 'string' ? payload.key === 'cache:platform:' ? Buffer.byteLength(platformJson) : payload.key === 'cache:json-preview' ? 100000 : payload.key === 'cache:large-json' ? Buffer.byteLength(largeJson) : payload.key === 'cache:empty' ? 0 : 25 : null, cardinality: typeOf(payload.key) === 'string' ? null : 2, readAt: stamp() });
    const base = { key: payload.key, type: typeOf(payload.key), exists: true, rows: [], nextCursor: null, complete: true, truncated: false, readAt: stamp() };
    if (payload.field !== undefined) return ok({ ...base, field: payload.field, fieldExists: payload.field !== 'missing', value: payload.field === 'missing' ? null : value('精确字段内容') });
    if (payload.key === 'cache:platform:') return ok({ ...base, value: value(platformJson) });
    if (payload.key === 'cache:json-preview') return ok({ ...base, value: { ...value(partialJson, true), bytes: 100000 } });
    if (payload.key === 'cache:large-json') return ok({ ...base, value: { ...value(largeJson.slice(0, 65536), true), bytes: Buffer.byteLength(largeJson) } });
    if (payload.key === 'cache:invalid-json') return ok({ ...base, value: value('{"broken":}') });
    if (base.type === 'string') return ok({ ...base, value: value(payload.key === 'cache:binary' ? null : payload.key === 'cache:empty' ? '' : '{"name":"示例","enabled":true}') });
    if (base.type === 'stream') return ok({ ...base, unsupported: true });
    return ok({ ...base, rows: [{ id: 'row-one', field: 'name', fieldLabel: 'name', index: 0, score: '1.5', value: value(markup) }, { id: 'row-two', field: 'enabled', fieldLabel: 'enabled', index: 1, score: '2', value: value('true') }] });
  });
  register('v2:connection-intent', async (event, payload) => {
    assert.equal(payload.intent, 'disconnect');
    plugin.assessment = assessment('disconnected'); sequence++;
    event.sender.send('v2:environment-status-changed', runtime());
    return ok({ snapshot: runtime() });
  });
  for (const [, channel] of fs.readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/gu)) {
    if (!channels.has(channel)) register(channel, async () => { forbidden.push(channel); return fail('FORBIDDEN', '测试禁止此操作'); });
  }
}
async function waitFor(win, expression, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await win.webContents.executeJavaScript(expression, true)) return; await wait(30); }
  throw new Error('等待超时：' + label);
}
async function takeScanHold() {
  const deadline = Date.now() + 5000;
  while (!state.releaseScan && Date.now() < deadline) await wait(20);
  assert.ok(state.releaseScan, '扫描请求应进入等待');
  const release = state.releaseScan;
  state.releaseScan = null;
  return release;
}
async function click(win, selector) {
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`, selector);
  await win.webContents.executeJavaScript(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(e.disabled) throw new Error('控件不可用'); e.click(); })()`, true);
  await wait(60);
}
async function fill(win, selector, text) {
  await win.webContents.executeJavaScript(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`, true);
  await wait(40);
}
async function openMenu(win, id) {
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(testId(id))}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`, true);
  await waitFor(win, 'Boolean(document.querySelector("[role=menu]"))', '菜单打开');
}
async function menuAction(win, trigger, item) {
  await openMenu(win, trigger);
  await click(win, testId(item));
  await waitFor(win, '!document.querySelector("[role=menu]")', '菜单关闭');
}
async function assertCompactSearch(win) {
  const layout = await win.webContents.executeJavaScript(`(() => {
    const header=document.querySelector('[data-testid=redis-browser-header]');
    const search=document.querySelector('[data-testid=redis-search-input]').getBoundingClientRect();
    const submit=document.querySelector('[data-testid=redis-search-submit]').getBoundingClientRect();
    const exact=document.querySelector('.redis-exact-toggle').getBoundingClientRect();
    const pane=document.querySelector('.redis-key-pane').getBoundingClientRect();
    return {headerHeight:header.getBoundingClientRect().height, selects:header.querySelectorAll('select').length,
      inputWidth:search.width, fits:search.right<=submit.left+1 && submit.right<=exact.left+1 && exact.right<=pane.right};
  })()`, true);
  assert.ok(layout.headerHeight <= 90, '树上方控件保持两行');
  assert.equal(layout.selects, 0, '不再堆叠选择框');
  assert.ok(layout.inputWidth >= 110 && layout.fits, '窄侧栏搜索框与精确匹配开关不重叠');
  return layout;
}
async function text(win, selector, expected) {
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(expected)})`, selector + ' 文本');
}
async function openKey(win, key, pin = false) {
  const selector = '[data-redis-key=' + JSON.stringify(key) + ']';
  await click(win, selector);
  if (pin) await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`, true);
  await waitFor(win, `document.querySelector('.redis-tab-panel:not([hidden]) [data-testid="redis-key-meta"]')?.textContent.includes('读取于')`, 'Key 元数据');
}
async function captureFrame(win) {
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
  await wait(100);
  return win.webContents.capturePage();
}
async function shot(win, name) {
  if (!screenshotRoot) return;
  const destination = path.resolve(screenshotRoot);
  const relative = path.relative(root, destination);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), '截图不得写入仓库。');
  fs.mkdirSync(destination, { recursive: true });
  // 隐藏窗口暂停颜色过渡并等待新帧，避免截图停留在上一个主题。
  await win.webContents.executeJavaScript("(() => {const style=document.createElement('style');style.id='redis-shot-motion';style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style)})()", true);
  const image = await captureFrame(win);
  fs.writeFileSync(path.join(destination, name + '.png'), image.toPNG());
  await win.webContents.executeJavaScript("document.getElementById('redis-shot-motion')?.remove()", true);
}
async function run() {
  await app.whenReady(); mocks((await import('../src/redis-key-search.mjs')).redisKeySearch);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = !details.url.startsWith('file:') && !details.url.startsWith('devtools:');
    if (blocked) external.push(details.url);
    callback(blocked ? { cancel: true } : {});
  });
  const win = new BrowserWindow({ show: false, useContentSize: true, enableLargerThanScreen: true, width: 1280, height: 820,
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const execute = win.webContents.executeJavaScript.bind(win.webContents);
  Object.defineProperty(win.webContents, 'executeJavaScript', { value: async (source, ...args) => {
    try { return await execute(source, ...args); }
    catch (error) { throw new Error('界面脚本执行失败：' + source.slice(0, 700), { cause: error }); }
  } });
  try {
    await win.loadFile(path.join(root, 'renderer-build', 'v2', 'index.html'));
    await waitFor(win, 'document.querySelector(\'[data-shell-ready="true"]\')', '主界面');
    await win.webContents.executeJavaScript(`(() => {
      window.__redisWrites=[]; window.__redisCopies=[];
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){window.__redisWrites.push([key,value]);return original.call(this,key,value);};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.__redisCopies.push(text);}}});
    })()`, true);
    await click(win, '[data-project-id="' + projectId + '"]');
    await click(win, testId('environment-trigger-' + environmentId));
    await click(win, testId('plugin-trigger-redis-offline'));
    await waitFor(win, 'document.querySelector(\'[data-testid="plugin-workspace-open"]\')?.disabled === true', '离线入口禁用');
    assert.equal(calls.length, 0);
    await click(win, testId('plugin-trigger-redis-primary'));
    await click(win, testId('plugin-workspace-open'));
    await waitFor(win, 'document.querySelector(\'[data-redis-key="cache:text"]\')?.getClientRects().length > 0', 'Key 已加载');
    assert.equal(calls.filter((entry) => entry.operation === 'inspect' || entry.operation === 'read').length, 0, '列表不逐项读取元数据');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=redis-browser-view-toggle]").dataset.view', true), 'tree');
    await assertCompactSearch(win);
    await require('./workspace-layout-ui.cjs')({evaluate:source=>win.webContents.executeJavaScript(source,true),until:(expression,label)=>waitFor(win,expression,label),win,root:'[data-testid=redis-workspace]'});
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:"] .redis-tree-count\').textContent', true), String(keys.length));
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(\'[data-redis-folder="cache:users:"]\') && document.querySelector(\'[data-redis-key="cache:users"]\'))', true), true, '同名 Key 与目录分别保留');
    await menuAction(win, 'redis-browser-menu', 'redis-tree-expand-all');
    await openKey(win, 'cache:platform:');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-key="cache:platform:"] .redis-tree-label\').textContent', true), 'cache:platform:', '尾部冒号显示完整 Key');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=redis-key-list]").textContent.includes("空名称")', true), false);
    await text(win, active('redis-value'), '9007199254740993123');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'.redis-tab-panel:not([hidden]) [data-testid=redis-view-json]\').getAttribute("aria-pressed")', true), 'true', '首次打开自动识别 JSON');
    await waitFor(win, 'document.querySelectorAll(".redis-tab-panel:not([hidden]) .redis-json-string").length > 0', 'JSON 语法高亮');
    const beforeValueTools = calls.length;
    await click(win, active('redis-json-collapse'));
    await waitFor(win, 'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-foldPlaceholder"))', '折叠 JSON');
    await click(win, active('redis-copy-content'));
    const foldedCopy = await win.webContents.executeJavaScript('window.__redisCopies.at(-1)', true);
    assert.ok(foldedCopy.includes('9007199254740993123') && foldedCopy.includes('备用平台'), '折叠后复制包含隐藏内容且大整数不失真');
    await click(win, active('redis-value-wrap'));
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-foldPlaceholder"))', true), true, '切换换行保留折叠状态');
    await click(win, active('redis-value-wrap'));
    await click(win, active('redis-json-expand'));
    await waitFor(win, '!document.querySelector(".redis-tab-panel:not([hidden]) .cm-foldPlaceholder")', '展开 JSON');
    const codeSelector = '.redis-tab-panel:not([hidden]) .cm-content';
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(codeSelector)}).focus()`, true);
    await win.webContents.insertText('readonly-probe');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(codeSelector)}).textContent.includes('readonly-probe')`, true), false, '内容查看器只读');
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(codeSelector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',keyCode:70,ctrlKey:true,bubbles:true,cancelable:true}))`, true);
    await waitFor(win, 'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-search"))', 'Ctrl+F 查找 Value 而非 Key');
    await fill(win, '.redis-tab-panel:not([hidden]) .cm-search input[name=search]', '备用平台');
    await win.webContents.executeJavaScript('document.querySelector(".redis-tab-panel:not([hidden]) .cm-search input[name=search]").dispatchEvent(new KeyboardEvent("keyup",{key:"a",bubbles:true}))', true);
    await waitFor(win, 'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-searchMatch"))', '内容搜索高亮');
    await click(win, '.redis-tab-panel:not([hidden]) .cm-search [name=close]');
    await click(win, active('redis-view-text'));
    await click(win, active('redis-copy-content'));
    assert.equal(await win.webContents.executeJavaScript('window.__redisCopies.at(-1)', true), platformJson, '原文视图复制保持原始字节对应的文本');
    await click(win, active('redis-view-json'));
    assert.equal(calls.length, beforeValueTools, '显示方式、折叠、查找和复制不增加远端读取');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("#redis-injection") || window.injected)', true), false, 'JSON 中的 HTML 只显示为文本');
    await shot(win, 'redis-json-dark');
    await openKey(win, 'cache:json-preview');
    await text(win, active('redis-value-truncation'), 'JSON 片段');
    await text(win, active('redis-value'), '未读取完');
    await click(win, active('redis-copy-content'));
    const fragment = await win.webContents.executeJavaScript('window.__redisCopies.at(-1)', true);
    assert.ok(fragment.endsWith('未读取完  '), '截断字符串不补齐，不丢弃尾部空白');
    assert.throws(() => JSON.parse(fragment));
    await shot(win, 'redis-json-partial');
    await openKey(win, 'cache:large-json');
    await text(win, active('redis-value-truncation'), 'JSON 片段');
    await waitFor(win, 'document.querySelectorAll(".redis-tab-panel:not([hidden]) .cm-line").length > 0', '大 JSON 渲染');
    assert.ok(await win.webContents.executeJavaScript('document.querySelectorAll(".redis-tab-panel:not([hidden]) .cm-line").length < 300', true), '大内容按视口渲染，避免创建全部行节点');
    await openKey(win, 'cache:invalid-json');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".redis-tab-panel:not([hidden]) [data-testid=redis-view-json]").disabled', true), true);
    await text(win, active('redis-value'), '{"broken":}');
    await win.webContents.executeJavaScript('window.__redisCopies=[]', true);
    const beforeTreeExpansion = calls.filter(entry => entry.operation === 'inspect' || entry.operation === 'read').length;
    await menuAction(win, 'redis-browser-menu', 'redis-tree-collapse-all');
    await click(win, '[data-redis-folder="cache:"]');
    await click(win, '[data-redis-folder="cache:orders:"]');
    await click(win, '[data-redis-folder="cache:orders:pending:"]');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-key="cache:orders:pending:1001"] .redis-tree-label\').textContent', true), 'cache:orders:pending:1001');
    assert.equal(calls.filter(entry => entry.operation === 'inspect' || entry.operation === 'read').length, beforeTreeExpansion, '展开目录只整理已有名称');
    await openKey(win, 'cache:orders:pending:1001');
    assert.ok(calls.some(entry => entry.operation === 'inspect' && entry.payload.key === 'cache:orders:pending:1001'), '叶子读取完整 Key');
    await openKey(win, 'cache:text', true);
    await click(win, active('redis-view-json'));
    await text(win, active('redis-value'), '"name": "示例"');
    await click(win, active('redis-copy-key'));
    await click(win, active('redis-copy-content'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.__redisCopies', true), ['cache:text', '{\n  "name": "示例",\n  "enabled": true\n}']);
    await menuAction(win, 'redis-browser-menu', 'redis-tree-collapse-all');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-redis-key]").length', true), 0);
    await click(win, testId('redis-browser-view-toggle'));
    await text(win, testId('redis-key-list'), 'cache:orders:pending:1001');
    await click(win, testId('redis-browser-view-toggle'));
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-redis-key]").length', true), 0, '切换浏览方式保留目录折叠状态');
    const beforeBack = calls.length;
    await openMenu(win, 'redis-browser-menu');
    await click(win, testId('redis-workspace-back'));
    await waitFor(win, '!document.querySelector("[role=menu]")', '隐藏工作区关闭工具菜单');
    await wait(120);
    assert.equal(calls.length, beforeBack, '隐藏工作区不增加读取');
    await text(win, testId('plugin-workspace-open'), '返回 Redis 工作区');
    await click(win, testId('plugin-workspace-open'));
    await text(win, active('redis-value'), '"name": "示例"');
    assert.equal(calls.length, beforeBack, '返回复用已有数据');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:"]\').getAttribute("aria-expanded")', true), 'false', '返回详情后保留目录状态');
    await menuAction(win, 'redis-browser-menu', 'redis-tree-locate');
    await waitFor(win, 'document.activeElement?.dataset.redisKey === "cache:text"', '定位当前 Key 并恢复焦点');
    assert.equal(calls.length, beforeBack, '定位只展开路径，不增加读取');
    await menuAction(win, 'redis-browser-menu', 'redis-tree-collapse-all');
    await win.webContents.executeJavaScript('(() => {const e=document.querySelector(\'[data-redis-folder="cache:"]\');e.focus();e.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));})()', true);
    await waitFor(win, 'Boolean(document.querySelector(\'[data-redis-folder="cache:orders:"]\'))', '右键展开目录');
    await win.webContents.executeJavaScript('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))', true);
    await waitFor(win, 'document.activeElement?.dataset.redisFolder === "cache:orders:"', '右键进入子目录');
    await win.webContents.executeJavaScript('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))', true);
    await waitFor(win, 'document.activeElement?.dataset.redisFolder === "cache:"', '左键返回父目录');
    await openKey(win, 'cache:hash', true);
    await text(win, active('redis-rows'), markup);
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("#redis-injection") || window.injected)', true), false);
    await fill(win, active('redis-field-input'), 'name');
    await click(win, active('redis-field-search'));
    await text(win, active('redis-value'), '精确字段内容');
    await fill(win, active('redis-field-input'), 'missing');
    await click(win, active('redis-field-search'));
    await text(win, '.redis-tab-panel:not([hidden])', '字段不存在');
    for (const key of ['cache:list', 'cache:set', 'cache:zset']) {
      await openKey(win, key, true);
      await text(win, active('redis-rows'), 'true');
    }
    await openKey(win, 'cache:binary');
    await text(win, active('redis-value'), '00ff80');
    await openKey(win, 'cache:empty');
    await text(win, active('redis-value'), '（空字符串）');
    await openKey(win, 'cache:stream');
    await text(win, '.redis-tab-panel:not([hidden])', '暂不支持');
    const beforeMatchMode = calls.length;
    await click(win, testId('redis-search-exact'));
    assert.equal(await win.webContents.executeJavaScript('(document.querySelector("[data-testid=redis-search-exact]").getAttribute("aria-checked") === "true")', true), true);
    assert.equal(calls.length, beforeMatchMode, '切换匹配方式不触发读取');
    await fill(win, testId('redis-search-input'), 'outside:key');
    const scans = calls.filter((entry) => entry.operation === 'scan').length;
    await click(win, testId('redis-search-submit'));
    await text(win, active('redis-key-error'), '不在允许范围');
    assert.equal(calls.filter((entry) => entry.operation === 'scan').length, scans, '精确定位不依赖扫描');
    await openKey(win, 'cache:binary', true);
    await openKey(win, 'cache:empty', true);
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-testid=redis-key-tab]").length', true), 8);
    const atTabLimit = calls.length;
    await click(win, '[data-redis-key=' + JSON.stringify(longKey) + ']');
    await text(win, testId('redis-notice'), '最多打开 8 个标签');
    assert.equal(calls.length, atTabLimit, '标签满时不增加读取');
    await win.webContents.executeJavaScript('document.querySelector(".redis-tabs [role=tab][aria-selected=true]").dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}))', true);
    await waitFor(win, 'document.querySelectorAll("[data-testid=redis-key-tab]").length === 7', 'Delete 关闭标签');
    await openKey(win, longKey, true);
    await click(win, '[role=tab][title="cache:text"]');
    await text(win, active('redis-value'), '"name": "示例"');
    await click(win, testId('redis-search-exact'));
    await fill(win, testId('redis-search-input'), 'hash');
    await click(win, testId('redis-search-submit'));
    await waitFor(win, 'document.querySelectorAll("[data-redis-key]").length === 1', '关键词筛选');
    const historyInput = 'document.querySelector("[data-testid=redis-search-input]")';
    const historyOptions = 'Array.from(document.querySelectorAll("[data-testid=redis-search-suggestion]"))';
    const historyQueries = historyOptions + '.map(e=>e.title)';
    const pressSearch = async (key, composing = false) => {
      await win.webContents.executeJavaScript(`${historyInput}.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,isComposing:${composing}}))`, true);
      await wait(60);
    };
    await win.webContents.executeJavaScript(historyInput + '.focus()', true);
    await fill(win, testId('redis-search-input'), '');
    await text(win, testId('redis-search-history'), 'hash');
    const beforeHistory = calls.length;
    await fill(win, testId('redis-search-input'), 'ha');
    assert.deepEqual(await win.webContents.executeJavaScript(historyQueries, true), ['hash']);
    await pressSearch('ArrowDown');
    await pressSearch('Enter', true);
    assert.equal(calls.length, beforeHistory, '输入、筛选历史和中文组词确认不访问 Redis');
    await pressSearch('Escape');
    await waitFor(win, '!document.querySelector("[data-testid=redis-search-history]")', 'Esc 关闭提示');
    await pressSearch('ArrowDown');
    await pressSearch('Enter');
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.keyword, 'hash', '方向键与 Enter 复用完整关键词');
    assert.equal(await win.webContents.executeJavaScript(historyInput + '.value', true), 'hash');
    await fill(win, testId('redis-search-input'), '');
    assert.equal((await win.webContents.executeJavaScript(historyQueries, true)).filter(query => query === 'hash').length, 1, '重复搜索历史去重');
    const beforeHideHistory = calls.length;
    await click(win, testId('redis-workspace-back'));
    await waitFor(win, '!document.querySelector("[data-testid=redis-search-history]")', '隐藏工作区关闭历史提示');
    await click(win, testId('plugin-workspace-open'));
    await win.webContents.executeJavaScript(historyInput + '.focus()', true);
    await fill(win, testId('redis-search-input'), '');
    await text(win, testId('redis-search-history'), 'hash');
    assert.equal(calls.length, beforeHideHistory, '返回保留历史，不自动读取');
    await click(win, testId('redis-search-submit'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    await click(win, testId('redis-search-exact'));
    await fill(win, testId('redis-search-input'), 'cache:text');
    await click(win, testId('redis-search-submit'));
    await text(win, active('redis-key-meta'), '读取于');
    await click(win, testId('redis-search-exact'));
    await fill(win, testId('redis-search-input'), 'cache:tex');
    const beforeExactHistory = calls.filter(entry => entry.operation === 'scan').length;
    await click(win, testId('redis-search-suggestion'));
    assert.equal(await win.webContents.executeJavaScript('(document.querySelector("[data-testid=redis-search-exact]").getAttribute("aria-checked") === "true")', true), true, '历史恢复精确匹配模式');
    assert.equal(calls.filter(entry => entry.operation === 'scan').length, beforeExactHistory, '精确历史直接读取 Key');
    assert.equal(await win.webContents.executeJavaScript(historyInput + '.value', true), 'cache:text');

    const folderSelector = '[data-redis-folder="cache:orders:"]';
    const beforeFolderMenu = calls.length;
    await win.webContents.executeJavaScript(`(() => {const e=document.querySelector(${JSON.stringify(folderSelector)});const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.x+20,clientY:r.y+10}));})()`, true);
    await text(win, testId('redis-folder-search'), '搜索此目录');
    assert.equal(calls.length, beforeFolderMenu, '打开目录菜单不读取 Redis');
    await click(win, testId('redis-folder-search'));
    await waitFor(win, '!document.querySelector("[role=menu]")', '目录菜单关闭');
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.keyword, 'cache:orders:*');
    assert.equal(calls.at(-1).payload.patternId, 'cache', '目录搜索保持已登记范围');
    assert.equal(calls.at(-1).payload.cursor, undefined, '目录搜索创建新查询');
    assert.equal(await win.webContents.executeJavaScript('(document.querySelector("[data-testid=redis-search-exact]").getAttribute("aria-checked") === "true")', true), false);
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-redis-key]").length', true), 3);
    await pressSearch('Escape');
    await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:orders:pending:"]\').focus()', true);
    await menuAction(win, 'redis-browser-menu', 'redis-tree-search-folder');
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.keyword, 'cache:orders:pending:*', '工具菜单也能按选中目录搜索');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-redis-key]").length', true), 2);
    await pressSearch('Escape');

    const beforeHiddenMenu = calls.length;
    await win.webContents.executeJavaScript(`(() => {const e=document.querySelector(${JSON.stringify(folderSelector)});const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.x+20,clientY:r.y+10}));})()`, true);
    await text(win, testId('redis-folder-search'), '搜索此目录');
    await click(win, testId('redis-workspace-back'));
    await waitFor(win, '!document.querySelector("[role=menu]")', '隐藏工作区关闭目录菜单');
    await click(win, testId('plugin-workspace-open'));
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[role=menu]"))', true), false, '返回不重开旧目录菜单');
    assert.equal(calls.length, beforeHiddenMenu);

    await menuAction(win, 'redis-pattern', 'redis-pattern-option-session');
    await text(win, testId('redis-scan-status'), '搜索完成');
    await win.webContents.executeJavaScript(historyInput + '.focus()', true);
    await fill(win, testId('redis-search-input'), '');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=redis-search-history]"))', true), false, '其他范围不显示缓存范围的历史');
    await fill(win, testId('redis-search-input'), 'one');
    await click(win, testId('redis-search-submit'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-cache');
    await text(win, testId('redis-scan-status'), '搜索完成');
    await win.webContents.executeJavaScript(historyInput + '.focus()', true);
    await fill(win, testId('redis-search-input'), '');
    await text(win, testId('redis-search-history'), 'cache:orders:*');
    assert.ok(!(await win.webContents.executeJavaScript(historyQueries, true)).includes('one'));
    await shot(win, 'redis-search-history');
    const beforeClearHistory = calls.length;
    await click(win, testId('redis-search-history-clear'));
    await pressSearch('ArrowDown');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=redis-search-history]"))', true), false);
    assert.equal(calls.length, beforeClearHistory, '清空历史不触发读取');
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-session');
    await text(win, testId('redis-scan-status'), '搜索完成');
    await win.webContents.executeJavaScript(historyInput + '.focus()', true);
    await fill(win, testId('redis-search-input'), '');
    await text(win, testId('redis-search-history'), 'one');
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-cache');
    await text(win, testId('redis-scan-status'), '搜索完成');
    await openKey(win, 'cache:text', true);

    const beforeAuto = calls.filter((entry) => entry.operation === 'scan').length;
    state.scanPages = [
      { keys: [], nextCursor: 'cursor-one', complete: false },
      { keys: [], nextCursor: 'cursor-two', complete: false },
      { keys: ['cache:scan:1', 'cache:scan:1'], nextCursor: 'cursor-three', complete: false },
      { keys: ['cache:scan:1', 'cache:scan:2'], nextCursor: null, complete: true },
    ];
    await fill(win, testId('redis-search-input'), '*scan*');
    await click(win, testId('redis-search-submit'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-redis-key]").length', true), 2, '一次提交自动跨越空批次，并跨批去重');
    const autoCalls = calls.filter((entry) => entry.operation === 'scan').slice(beforeAuto);
    assert.equal(autoCalls.length, 4);
    assert.ok(autoCalls.every((entry) => entry.payload.keyword === '*scan*'));
    assert.deepEqual(autoCalls.map((entry) => entry.payload.cursor), [undefined, 'cursor-one', 'cursor-two', 'cursor-three']);

    state.scanPages = Array.from({ length: 5 }, (_, page) => ({
      keys: Array.from({ length: 100 }, (_, index) => 'cache:scan:' + (page * 100 + index)),
      nextCursor: 'page-' + page, complete: false,
    }));
    state.scanPages.push({ keys: ['cache:scan:0', 'cache:scan:500'], nextCursor: null, complete: true });
    await click(win, testId('redis-refresh-keys'));
    await text(win, testId('redis-scan-status'), '已加载一页');
    assert.equal(state.scanPages.length, 1, '达到 500 个不同 Key 后暂停');
    await click(win, '[data-redis-folder="cache:scan:"]');
    await click(win, testId('redis-scan-more'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:scan:"] .redis-tree-count\').textContent', true), '501');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:scan:"]\').getAttribute("aria-expanded")', true), 'false', '继续搜索保留折叠状态');

    state.scanPages = [
      { keys: ['cache:scan:first'], nextCursor: 'stop-one', complete: false },
      { keys: ['cache:scan:second'], nextCursor: 'stop-two', complete: false, hold: true },
      { keys: ['cache:scan:last'], nextCursor: null, complete: true },
    ];
    await click(win, testId('redis-refresh-keys'));
    const releaseStopped = await takeScanHold();
    await waitFor(win, 'document.querySelector(\'[data-redis-folder="cache:scan:"] .redis-tree-count\')?.textContent === "1"', '搜索中逐步显示结果');
    await click(win, testId('redis-scan-stop'));
    const stoppedCalls = calls.length;
    releaseStopped();
    await text(win, testId('redis-scan-status'), '已停止');
    await wait(100);
    assert.equal(calls.length, stoppedCalls, '停止后不再发起下一批');
    assert.equal(state.scanPages.length, 1);
    const queuedHold = { operation: 'inspect', data: { key: 'cache:text', type: 'string', exists: true, ttlSeconds: -1, length: 1, cardinality: null, readAt: stamp() } };
    state.hold = queuedHold;
    await click(win, active('redis-refresh-key'));
    assert.ok(queuedHold.release);
    await click(win, testId('redis-scan-more'));
    await click(win, testId('redis-workspace-back'));
    const queuedCalls = calls.length;
    queuedHold.release(); await wait(100);
    assert.equal(calls.length, queuedCalls, '隐藏时尚在排队的续查不得访问 Redis');
    await click(win, testId('plugin-workspace-open'));
    await text(win, testId('redis-scan-status'), '已停止');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=redis-scan-error]"))', true), false);
    await click(win, testId('redis-scan-more'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.cursor, 'stop-two', '停止后使用在途回复的新游标续查');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:scan:"] .redis-tree-count\').textContent', true), '3');

    state.scanPages = [{ keys: ['cache:scan:old'], nextCursor: 'old-query', complete: false, hold: true }];
    await click(win, testId('redis-refresh-keys'));
    const releaseOldQuery = await takeScanHold();
    await fill(win, testId('redis-search-input'), 'hash');
    await click(win, testId('redis-search-submit'));
    releaseOldQuery();
    await text(win, testId('redis-scan-status'), '搜索完成');
    await waitFor(win, 'document.querySelectorAll("[data-redis-key]").length === 1 && Boolean(document.querySelector(\'[data-redis-key="cache:hash"]\'))', '新查询丢弃迟到结果');
    assert.equal(calls.at(-1).payload.cursor, undefined);
    assert.equal(calls.at(-1).payload.keyword, 'hash');

    state.scanPages = [
      { keys: ['cache:hash'], nextCursor: 'hidden-query', complete: false, hold: true },
      { keys: [], nextCursor: null, complete: true },
    ];
    await click(win, testId('redis-refresh-keys'));
    const releaseHidden = await takeScanHold();
    await click(win, testId('redis-workspace-back'));
    const hiddenCalls = calls.length;
    releaseHidden(); await wait(100);
    assert.equal(calls.length, hiddenCalls, '隐藏后不自动续扫');
    await click(win, testId('plugin-workspace-open'));
    await text(win, testId('redis-scan-status'), '已停止');
    assert.equal(calls.length, hiddenCalls, '返回工作区不擅自重启搜索');
    await click(win, testId('redis-scan-more'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.cursor, 'hidden-query');

    await win.webContents.executeJavaScript('window.__redisNow=performance.now.bind(performance);window.__redisClockOffset=0;performance.now=()=>window.__redisNow()+window.__redisClockOffset;void 0', true);
    state.scanPages = [
      { keys: [], nextCursor: 'budget-query', complete: false, hold: true },
      { keys: ['cache:hash'], nextCursor: null, complete: true },
    ];
    await click(win, testId('redis-refresh-keys'));
    const releaseBudget = await takeScanHold();
    await win.webContents.executeJavaScript('window.__redisClockOffset=31000', true);
    releaseBudget();
    await text(win, testId('redis-scan-status'), '搜索预算');
    assert.equal(state.scanPages.length, 1, '预算耗尽保留游标，不将空结果当成完成');
    await win.webContents.executeJavaScript('performance.now=window.__redisNow;void 0', true);
    await click(win, testId('redis-scan-more'));
    await text(win, testId('redis-scan-status'), '搜索完成');
    assert.equal(calls.at(-1).payload.cursor, 'budget-query');

    state.failScan = true;
    await click(win, testId('redis-refresh-keys'));
    await text(win, testId('redis-scan-error'), '模拟扫描失败');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=redis-key-list]").textContent.includes("没有匹配")', true), false);
    state.failScan = false;
    state.scanPages = [{ keys: ['cache:hash:old-scope'], nextCursor: 'old-scope', complete: false, hold: true }];
    await click(win, testId('redis-refresh-keys'));
    const releaseScope = await takeScanHold();
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-session');
    releaseScope();
    await text(win, testId('redis-pattern-current'), 'session:*');
    await waitFor(win, 'document.querySelector(\'[data-redis-key="session:one"]\')?.getClientRects().length > 0', '新范围 Key 已加载');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-testid=redis-key-tab]").length', true), 0);
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-cache');
    await menuAction(win, 'redis-browser-menu', 'redis-tree-expand-all');
    await openKey(win, 'cache:platform:', true);
    await click(win, active('redis-view-json'));
    for (const theme of ['dark', 'light']) {
      await click(win, '[data-testid="redis-workspace"] [data-testid="settings-open"]');
      await waitFor(win, 'Boolean(document.querySelector("[data-testid=theme-menu-trigger]"))', '进入配置页面');
      await win.webContents.executeJavaScript(`document.querySelector('[data-testid="theme-menu-trigger"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`, true);
      await click(win, testId('theme-option-' + theme));
      await waitFor(win, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, '主题切换');
      await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))', true);
      await waitFor(win, '!document.querySelector("[role=menu]")', '主题菜单关闭');
      await click(win, testId('settings-back'));
      await waitFor(win, '!document.querySelector("[data-testid=settings-page]")', '返回 Redis 工作区');
      await waitFor(win, 'document.querySelectorAll("[data-sonner-toast]").length === 0', '复制提示消退');
      await wait(250); await shot(win, 'redis-' + theme);
    }
    win.setContentSize(700, 620);
    await waitFor(win, 'innerWidth === 700 && innerHeight === 620', '窄窗口尺寸');
    await captureFrame(win);
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth', true), true);
    await assertCompactSearch(win);
    await require('./workspace-layout-ui.cjs')({evaluate:source=>win.webContents.executeJavaScript(source,true),until:(expression,label)=>waitFor(win,expression,label),win,root:'[data-testid=redis-workspace]'});
    assert.ok(await win.webContents.executeJavaScript('document.querySelector(".redis-key-pane").getBoundingClientRect().width >= 259', true), '展开后保持最小宽度');
    await assertCompactSearch(win);
    await shot(win, 'redis-narrow');
    win.setContentSize(1280, 820);
    await captureFrame(win);
    const hold = { operation: 'inspect', data: { key: 'cache:late', type: 'string', exists: true, ttlSeconds: -1, length: 1, cardinality: null, readAt: stamp() } };
    state.hold = hold;
    await click(win, active('redis-refresh-key'));
    await waitFor(win, 'document.querySelector(".redis-tab-panel:not([hidden])").textContent.includes("正在读取")', '挂起读取');
    await click(win, testId('redis-workspace-close'));
    await click(win, testId('redis-workspace-confirm-close'));
    const deadline = Date.now() + 5000;
    while (!hold.release && Date.now() < deadline) await wait(20);
    assert.ok(hold.release); hold.release(); await wait(100);
    await waitFor(win, '!document.querySelector("[data-testid=redis-workspace]")', '关闭清空页面');
    await click(win, testId('plugin-workspace-open'));
    await waitFor(win, 'document.querySelector(\'[data-redis-key="cache:text"]\')?.getClientRects().length > 0', 'Key 已加载');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-testid=redis-key-tab]").length', true), 0);
    await fill(win, testId('redis-search-input'), '');
    await pressSearch('ArrowDown');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=redis-search-history]"))', true), false, '关闭工作区后历史清除');
    plugin.patterns = [{ ...plugin.patterns[0], pattern: '*' }];
    plugin.revision++; win.webContents.send('v2:workspace-changed', { ...scope, type: 'plugin-updated' });
    await waitFor(win, '!document.querySelector("[data-testid=redis-workspace]")', '配置修订销毁旧会话');
    await click(win, testId('plugin-workspace-open'));
    await waitFor(win, 'document.querySelector(\'[data-redis-key="cache:text"]\')?.getClientRects().length > 0', 'Key 已加载');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=redis-pattern]"))', true), false, '单范围不显示切换菜单');
    await text(win, testId('redis-pattern-current'), '全部 Key（*）');
    await assertCompactSearch(win);
    await click(win, testId('redis-workspace-disconnect'));
    await waitFor(win, '!document.querySelector("[data-testid=redis-workspace]")', '断连销毁旧会话');
    const writes = await win.webContents.executeJavaScript('window.__redisWrites', true);
    assert.ok(!JSON.stringify(writes).includes('cache:text') && !JSON.stringify(writes).includes('精确字段内容'), '数据不得持久化');
    assert.ok(calls.some((entry) => entry.operation === 'release'));
    assert.deepEqual(forbidden, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    process.stdout.write('Redis 工作区 UI smoke 通过（' + calls.length + ' 次限定范围的模拟请求）。\n');
  } catch (error) { console.error('Redis 渲染错误', JSON.stringify(errors)); await shot(win, 'redis-failure').catch(() => {}); throw error; }
  finally { if (!win.isDestroyed()) win.destroy(); }
}
run().then(() => app.exit(0)).catch((error) => { process.stderr.write(String(error.stack ?? error) + '\n'); app.exit(1); });
