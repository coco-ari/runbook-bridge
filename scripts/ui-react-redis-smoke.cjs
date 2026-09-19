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
  'cache:orders:pending:1001', 'cache:orders:pending:1002', 'cache:orders:completed:1000', 'cache:users:1001:profile', 'cache:users:1002:profile', 'cache:users', 'cache:settings:feature_flags'];
const stamp = () => new Date().toISOString();
const value = (text, truncated = false) => ({ text, hex: Buffer.from(text ?? [0, 255, 128]).toString('hex'), bytes: Buffer.byteLength(text ?? Buffer.from([0, 255, 128])), shownBytes: Buffer.byteLength(text ?? Buffer.from([0, 255, 128])), truncated });
const typeOf = (key) => ({ 'cache:hash': 'hash', 'cache:list': 'list', 'cache:set': 'set', 'cache:zset': 'zset', 'cache:stream': 'stream' }[key] ?? 'string');
const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const state = { hold: null, auditWarning: false, failScan: false, scanPages: [] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testId = (id) => '[data-testid="' + id + '"]';
const active = (id) => '.redis-tab-panel:not([hidden]) ' + testId(id);
function register(name, handler) { channels.add(name); ipcMain.handle(name, handler); }
function read(name, fn) { register(name, async (_event, payload) => ok(structuredClone(await fn(payload)))); }
function mocks() {
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
      if (state.scanPages.length) return ok({ ...state.scanPages.shift(), unsupportedKeys: 0, readAt: stamp() });
      const selected = payload.patternId === 'cache' ? keys : ['session:one'];
      return ok({ keys: selected.filter((key) => key.includes(payload.keyword ?? '')), nextCursor: null, complete: true, unsupportedKeys: 0, readAt: stamp(), auditWarning: state.auditWarning });
    }
    if (!payload.key.startsWith(payload.patternId + ':')) return fail('POLICY_DENIED', 'Redis Key 不在允许范围内。');
    if (operation === 'inspect') return ok({ key: payload.key, type: typeOf(payload.key), exists: payload.key !== 'cache:expired', ttlSeconds: payload.key === 'cache:expired' ? -2 : payload.key === 'cache:text' ? 1680 : -1,
      length: typeOf(payload.key) === 'string' ? 25 : null, cardinality: typeOf(payload.key) === 'string' ? null : 2, readAt: stamp() });
    const base = { key: payload.key, type: typeOf(payload.key), exists: true, rows: [], nextCursor: null, complete: true, truncated: false, readAt: stamp() };
    if (payload.field !== undefined) return ok({ ...base, field: payload.field, fieldExists: payload.field !== 'missing', value: payload.field === 'missing' ? null : value('精确字段内容') });
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
  await app.whenReady(); mocks();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = !details.url.startsWith('file:') && !details.url.startsWith('devtools:');
    if (blocked) external.push(details.url);
    callback(blocked ? { cancel: true } : {});
  });
  const win = new BrowserWindow({ show: false, useContentSize: true, enableLargerThanScreen: true, width: 1280, height: 820,
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message); });
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
    await click(win, '[data-redis-folder="cache:orders:"]');
    await click(win, '[data-redis-folder="cache:orders:pending:"]');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-key="cache:orders:pending:1001"] .redis-tree-label\').textContent', true), '1001');
    assert.equal(calls.filter(entry => entry.operation === 'inspect' || entry.operation === 'read').length, 0, '展开目录只整理已有名称');
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
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=redis-search-exact]").checked', true), true);
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
    state.scanPages = [
      { keys: [], nextCursor: 'cursor-one', complete: false },
      { keys: ['cache:scan:1', 'cache:scan:1'], nextCursor: 'cursor-two', complete: false },
      { keys: ['cache:scan:1', 'cache:scan:2'], nextCursor: null, complete: true },
    ];
    await click(win, testId('redis-refresh-keys'));
    await text(win, testId('redis-key-list'), '本批未找到');
    await click(win, testId('redis-scan-more'));
    await waitFor(win, 'document.querySelectorAll("[data-redis-key]").length === 1', '批内去重');
    await click(win, '[data-redis-folder="cache:scan:"]');
    await click(win, testId('redis-scan-more'));
    await waitFor(win, 'document.querySelector(\'[data-redis-folder="cache:scan:"] .redis-tree-count\')?.textContent === "2"', '续页合并目录并去重');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[data-redis-folder="cache:scan:"]\').getAttribute("aria-expanded")', true), 'false', '继续扫描保留折叠状态');
    await click(win, '[data-redis-folder="cache:scan:"]');
    await waitFor(win, 'document.querySelectorAll("[data-redis-key]").length === 2', '跨批去重');
    state.failScan = true;
    await click(win, testId('redis-refresh-keys'));
    await text(win, testId('redis-scan-error'), '模拟扫描失败');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=redis-key-list]").textContent.includes("没有匹配")', true), false);
    state.failScan = false;
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-session');
    await text(win, testId('redis-pattern-current'), 'session:*');
    await waitFor(win, 'document.querySelector(\'[data-redis-key="session:one"]\')?.getClientRects().length > 0', '新范围 Key 已加载');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-testid=redis-key-tab]").length', true), 0);
    await menuAction(win, 'redis-pattern', 'redis-pattern-option-cache');
    await openKey(win, 'cache:text', true);
    await menuAction(win, 'redis-browser-menu', 'redis-tree-expand-all');
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
  } catch (error) { await shot(win, 'redis-failure').catch(() => {}); throw error; }
  finally { if (!win.isDestroyed()) win.destroy(); }
}
run().then(() => app.exit(0)).catch((error) => { process.stderr.write(String(error.stack ?? error) + '\n'); app.exit(1); });
