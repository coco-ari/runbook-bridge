const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, clipboard } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-server-workspace-ui-'));
app.setPath('userData', temporaryRoot);
nativeTheme.themeSource = 'dark';
const scope = { projectId: 'project-workspace-smoke', environmentId: 'env-workspace-smoke', pluginInstanceId: 'server-workspace-smoke' };
const plugin = { ...scope, pluginType: 'server', displayName: '工作区验证服务器', revision: 1, configState: 'ready', target: { host: 'server.example.invalid', port: 22 }, auth: { username: 'operator', type: 'agent' }, uplink: { type: 'direct' }, sources: [], assessment: { phase: 'connected', primaryStatus: { kind: 'connected', label: '已连接' } } };
const mysqlScope = { ...scope, pluginInstanceId: 'mysql-workspace-coexistence' };
const mysqlPlugin = { ...mysqlScope, pluginType: 'mysql', displayName: '并存验证数据库', revision: 1, configState: 'ready', target: { host: 'database.example.invalid', port: 3306, database: 'workspace_fixture' }, auth: { username: 'readonly' }, transport: { kind: 'direct' }, tls: { mode: 'required' }, limits: { maxRows: 100, maxBytes: 65536, timeoutMs: 2500 }, assessment: plugin.assessment };
const redisPlugin = { ...mysqlPlugin, pluginInstanceId: 'redis-workspace-coexistence', pluginType: 'redis', displayName: '并存验证缓存', target: { host: 'cache.example.invalid', port: 6379, db: 0 }, keyPatterns: ['fixture:*'] };
const plugins = [plugin, mysqlPlugin, redisPlugin];
const mysqlCalls = [];
let sequence = 1;
let connected = true;
let recoveryPhase = null;
let terminalOpenDelay = 0;
let recoveryOpenFailures = 0;
const openRequests = [];
const connectionRequests = [];
let win;
const terminalSessions = new Map();
const writes = [];
const resizes = [];
const directoryReads = [];
const previewReads = [];
const metricsState = { reads:0, stops:0, round:0, mode:"normal", delay:0, diskDelay:0, inFlight:0, byKind:{system:0,disks:0}, maxByKind:{system:0,disks:0} };
const removedPaths = new Set();
let previewFailure = null;
let previewDelay = 0;
const opened = [];
const defaultColorOptions = [];
const closed = [];
const errors = [];
const externalRequests = [];
let uploads = [];
let uploadConfirmCalls = 0;
let pausedResumeRequests = 0;
const uploadedPaths = new Set();
let uploadReadFailure = false;
let downloadFailure = false;
let preparationPath;
let uploadSelection = ['release.tar'];
let uploadPreparation;
let revisionFailure = false;
let reviewHeld = false;
let reviewReadDelay = 0;
const cancelledReviews = [];
const uploadRevisions = [];
let preparationRuns = 0;
const makePreparation = (target, names, failure = false) => {
  preparationRuns += 1;
  preparationPath = canonicalFixturePath(target);
  uploadPreparation = {
    reviewId: require('node:crypto').randomUUID(), status:'checking', preparationId:null, expiresAt:null,
    path:preparationPath, sourcePath:target, readyAt:Date.now()+500, failure,
    progress:{phase:'hashing',completedFiles:0,totalFiles:names.length,hashedBytes:0,totalBytes:1000000*names.length},
    files:names.map(name=>({name,localPath:path.win32.join('D:/发布文件/待上传',name),bytes:1000000,remotePath:path.posix.join(preparationPath,name),exists:null})),
  };
  return reviewResult(uploadPreparation);
};
function reviewResult(item) {
  if (!reviewHeld && Date.now()>=item.readyAt && item.status==='checking') {
    item.status=item.failure?'error':'ready';
    item.error=item.failure?{code:'PERMISSION_DENIED',message:'目标目录暂时不可写，请重新检查。'}:undefined;
    item.preparationId=item.failure?null:require('node:crypto').randomUUID();
    item.expiresAt=item.failure?null:Date.now()+60000;
    item.progress={...item.progress,phase:item.failure?'hashing':'ready',completedFiles:item.files.length,hashedBytes:item.progress.totalBytes};
    item.files=item.files.map(file=>({...file,exists:file.name==='release.tar'}));
  }
  const {readyAt,failure,...result}=item;
  return structuredClone(result);
}
let savedClipboard;
let clipboardDelay = 0;
let clipboardReads = 0;
let completed = false;
let workspaceFiles;
let stagedRoot;
let releaseRootMetadata;
const rootMetadataReady = new Promise(resolve => { releaseRootMetadata = resolve; });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (data) => ({ ok: true, data });
const runtime = () => ({
  projectId:scope.projectId,environmentId:scope.environmentId,phase:connected?'connected':'partial',sequence,
  desiredConnected:connected || Boolean(recoveryPhase),
  manualDisconnected:!connected && !recoveryPhase ? {[scope.pluginInstanceId]:true} : {},
  reconnect:recoveryPhase ? {phase:recoveryPhase,attempt:2,maxAttempts:5,nextRetryAt:recoveryPhase==='waiting'?Date.now()+5000:null,pluginInstanceIds:[scope.pluginInstanceId]} : null,
  eligibleCount:plugins.length,connectedCount:connected?plugins.length:plugins.length-1,errorCount:recoveryPhase?1:0,blockedCount:0,pluginsPartial:false,
  plugins:Object.fromEntries(plugins.map(item=>{
    const phase=item.pluginType!=='server'||connected?'connected':recoveryPhase?'error':'disconnected';
    return [item.pluginInstanceId,{pluginInstanceId:item.pluginInstanceId,phase,retryable:Boolean(recoveryPhase),
      reason:phase==='disconnected'?'USER_DISCONNECTED':recoveryPhase?'ROUTE_UNAVAILABLE':null,assessment:{phase}}];
  })),
});
function publishRecovery(isConnected, phase=null) {
  connected=isConnected; recoveryPhase=phase; sequence++;
  win.webContents.send('v2:environment-status-changed',runtime());
}
function interruptTerminals(reason='connection-lost') {
  for(const item of terminalSessions.values()) if(item.status==='open') {
    item.status='closed';item.closeReason=reason;item.recoverable=true;
  }
}
const project = () => ({ schemaVersion: 2, projectId: scope.projectId, name: '服务器工作区演示', revision: 1, environmentCount: 1, pluginCount: plugins.length, environments: [{ projectId: scope.projectId, environmentId: scope.environmentId, name: '测试环境', revision: 1, pluginCount: plugins.length, readyPluginCount: plugins.length, resourcePreview: plugins, resourcePreviewTruncated: false, runtime: runtime() }] });
function handle(channel, handler) { ipcMain.handle('v2:' + channel, async (_event, input) => { try { return ok(await handler(input)); } catch (error) { return { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } }; } }); }
function scoped(input) { assert.equal(input.projectId, scope.projectId); assert.equal(input.environmentId, scope.environmentId); assert.equal(input.pluginInstanceId, scope.pluginInstanceId); }
function canonicalFixturePath(value) {
  if (value === '/bin' || value.startsWith('/bin/')) value = '/usr/bin' + value.slice(4);
  if (value === '/usr/bin/X11') return '/usr/bin';
  if (value === '/lib') return '/usr/lib';
  if (value === '/current.conf' || value === '/default.conf') return '/srv/example.conf';
  return value;
}
function fixtureStat(value) {
  if ([...removedPaths].some(item => value === item || value.startsWith(item + '/'))) throw Object.assign(new Error('服务器路径不存在。'), { code: 'SOURCE_NOT_FOUND' });
  if (value === '/missing-link') return { type: 'symlink', canonicalPath: null };
  const canonicalPath = canonicalFixturePath(value);
  const isLink = ['/bin', '/lib', '/current.conf', '/default.conf', '/usr/bin/X11', '/bin/X11'].includes(value);
  return { type: isLink ? 'symlink' : /\.(conf|txt|log)$/u.test(canonicalPath) || canonicalPath === '/usr/bin/apt' ? 'file' : 'directory', canonicalPath };
}
function register() {
  handle('workspace-overview', () => [project()]);
  handle('project-list', () => [project()]);
  handle('environment-list', () => project().environments);
  handle('environment-status', () => runtime());
  handle('plugin-list', () => plugins);
  handle('mysql-list-tables', input => { assert.deepEqual(input, { ...mysqlScope, limit: 100 }); mysqlCalls.push(input); return { tables: [{ name: 'records', type: 'BASE TABLE', queryable: true }], nextCursor: null, truncated: false }; });
  handle('mysql-query-readonly', input => { assert.equal(input.projectId, mysqlScope.projectId); assert.equal(input.environmentId, mysqlScope.environmentId); assert.equal(input.pluginInstanceId, mysqlScope.pluginInstanceId); assert.equal(input.sql, 'SELECT 1 AS integration_probe'); mysqlCalls.push(input); return { rows: [{ integration_probe: 1 }], rowCount: 1, bytes: 25, truncated: false, columns: [{ name: 'integration_probe', table: null, type: 3 }], durationMs: 1, fingerprint: 'integration-fixture', limitsApplied: mysqlPlugin.limits }; });
  handle('confirmation-list', () => []);
  handle('audit-list', () => ({ entries: [], nextCursor: null }));
  handle('plugin-assess', () => plugin.assessment);
  handle('quick-question-opening-get', () => ({ text: '', defaultText: '', revision: 1 }));
  handle('quick-question-list', () => ({ ...scope, schemaVersion: 1, revision: 1, items: [] }));
  handle('runbook-read', () => ({ content: '', bytes: 0, hash: '0'.repeat(64), empty: true }));
  handle('plugin-credential-status', () => ({ fields: { primary: false, proxy: false }, legacyAvailable: false }));
  handle('connection-intent', async (input) => {
    scoped(input);
    connectionRequests.push(input);
    if (!connected && input.intent !== 'disconnect') {
      // 模拟连接计划已启动、插件还停留在断开状态的中间快照。
      const connectingSnapshot = runtime();
      connectingSnapshot.sequence = ++sequence;
      connectingSnapshot.phase = 'reconnecting';
      connectingSnapshot.desiredConnected = true;
      connectingSnapshot.manualDisconnected = {};
      connectingSnapshot.plugins[scope.pluginInstanceId].reason = null;
      win.webContents.send('v2:environment-status-changed', connectingSnapshot);
      await wait(100);
    }
    recoveryPhase = null;
    connected = input.intent !== 'disconnect';
    sequence += 1;
    if (!connected) for (const value of terminalSessions.values()) if (value.status === 'open' || value.recoverable) { value.status = 'closed'; value.closeReason = 'user-disconnected'; value.recoverable = true; }
    win.webContents.send('v2:environment-status-changed', runtime());
    return { outcome: 'completed', snapshot: runtime(), actions: [] };
  });
  handle('server-terminal-open', async (input) => {
    scoped(input); assert.ok(connected);
    openRequests.push(input);
    if (terminalOpenDelay) await wait(terminalOpenDelay);
    if (input.recoveryOf) {
      const previous = terminalSessions.get(input.recoveryOf);
      if (!previous?.recoverable || previous.tabId !== input.tabId) throw Object.assign(new Error('恢复已停止'), { code:'TERMINAL_RECOVERY_STOPPED' });
      if (recoveryOpenFailures-- > 0) throw Object.assign(new Error('模拟通道打开失败'), { code:'TERMINAL_OPEN_FAILED' });
    }
    const sessionId = 'terminal-' + (opened.length + 1);
    opened.push(sessionId);
    defaultColorOptions.push(input.defaultColors);
    terminalSessions.set(sessionId, { status: 'open', tabId:input.tabId, recoverable:false, closeReason:null, chunks: [Buffer.from('\x1b[32m已连接到示例服务器\x1b[0m\r\noperator@demo:~$ ')] });
    return { sessionId, status: 'open', cols: input.cols, rows: input.rows };
  });
  handle('server-terminal-read', async (input) => {
    scoped(input);
    const item = terminalSessions.get(input.sessionId);
    if (!item.chunks.length) await wait(100);
    return { data: new Uint8Array(item.chunks.shift() ?? []), status: item.status, closeReason:item.closeReason, recoverable:item.recoverable, exitCode:item.exitCode };
  });
  handle('server-terminal-write', (input) => {
    scoped(input);
    assert.ok(Buffer.byteLength(input.data, input.encoding === 'binary' ? 'latin1' : 'utf8') <= 65536);
    writes.push(input);
    terminalSessions.get(input.sessionId).chunks.push(Buffer.from(input.data === '\r' ? '\r\noperator@demo:~$ ' : input.data === '\x03' ? '^C\r\noperator@demo:~$ ' : input.data));
    return {};
  });
  handle('server-terminal-clipboard', async (input) => {
    scoped(input);
    assert.ok(terminalSessions.has(input.sessionId));
    if (input.action === 'copy') { clipboard.writeText(input.text); return {}; }
    clipboardReads += 1;
    const text = clipboard.readText();
    if (clipboardDelay) await wait(clipboardDelay);
    if (Buffer.byteLength(text) > 65536) throw Object.assign(new Error('粘贴内容超过 64 KB，请分批操作。'), { code: 'CLIPBOARD_TOO_LARGE' });
    return { text };
  });
  handle('server-workspace-metrics', async input => {
    scoped(input);
    const kind=input.kind ?? 'system';
    assert.ok(['system','disks'].includes(kind));
    metricsState.reads++;
    if(kind==='system') metricsState.round++;
    metricsState.inFlight++;metricsState.byKind[kind]++;
    metricsState.maxByKind[kind]=Math.max(metricsState.maxByKind[kind],metricsState.byKind[kind]);
    const round=metricsState.round, mode=metricsState.mode, delay=kind==='disks'?metricsState.diskDelay:metricsState.delay;
    try {
      if(delay) await wait(delay);
      if(mode==='failure' && kind==='system') throw new Error('模拟系统采样超时');
      return {cpu:kind==='system'?{percent:round===1?null:mode==='late'?99:18,cores:4}:null,
        memory:kind==='system'?{percent:43,used:3.4*1024**3,total:8*1024**3,available:4.6*1024**3}:null,
        disks:kind==='disks'?[{mount:'/',percent:62,used:31*1024**3,total:50*1024**3,available:19*1024**3},{mount:'/data with space',percent:92,used:92*1024**3,total:100*1024**3,available:8*1024**3}]:[],
        sampledAt:kind==='system'?Date.now():null,diskSampledAt:kind==='disks'?Date.now():null,error:null,diskError:null,unsupported:mode==='unsupported',disksTruncated:false,
        retryAfterMs:kind==='disks'?30000:round===1?1000:5000};
    } finally {metricsState.inFlight--;metricsState.byKind[kind]--;}
  });
  handle('server-workspace-stop-metrics', input => {scoped(input);metricsState.stops++;metricsState.round=0;return{stopped:true};});
  handle('server-terminal-resize', (input) => { scoped(input); assert.ok(input.cols > 1 && input.rows > 1); resizes.push(input); return {}; });
  handle('server-terminal-close', (input) => { scoped(input); closed.push(input.sessionId); Object.assign(terminalSessions.get(input.sessionId), {status:'closed',closeReason:'user-closed',recoverable:false}); return {}; });
  const listDirectory = (input) => {
    scoped(input); directoryReads.push(input);
    const entry = (name, type = 'file') => ({ name, path: (input.path === '/' ? '' : input.path) + '/' + name, type, size: 256, mtime: 1, mode: 0o644 });
    const roots = [entry('.env.example'), entry('app', 'directory'), { ...entry('bin', 'symlink'), path: '/usr/bin' }, entry('boot', 'directory'), { ...entry('current.conf', 'symlink'), path: '/srv/example.conf' }, { ...entry('default.conf', 'symlink'), path: '/srv/example.conf' }, entry('dev', 'directory'), entry('etc', 'directory'), entry('home', 'directory'), { ...entry('lib', 'symlink'), path: '/usr/lib' }, ...['media', 'mnt', 'opt', 'proc', 'root', 'run', 'srv', 'sys', 'tmp', 'usr', 'var'].map(name => entry(name, 'directory')), entry('welcome.txt'), entry('missing-link', 'symlink')];
    const entries = input.path === '/' ? [...roots, ...Array.from({ length: 2300 - roots.length }, (_, index) => entry('file-' + String(index).padStart(3, '0') + '.txt'))] : input.path === '/usr/bin' ? [{ ...entry('X11', 'symlink'), path: '/usr/bin' }, entry('apt'), entry('tool.conf')] : [entry('config', 'directory'), entry('example.conf'), entry('example.log'), entry('loading')];
    if (input.path === '/srv') entries.push(entry('带空格目录 ', 'directory'), entry("带 空格'$(echo literal).conf"));
    for (const job of uploads) if (job.direction !== 'download' && job.status === 'completed') uploadedPaths.add(job.path);
    entries.push(...[...uploadedPaths].filter(target => path.posix.dirname(target) === input.path).map(target => entry(path.posix.basename(target))));
    const offset = Number(input.cursor ?? 0);
    return { path: input.path, entries: entries.filter(item => !removedPaths.has(item.path)).slice(offset, offset + 200), nextCursor: entries.length > offset + 200 ? String(offset + 200) : null, truncated: entries.length > offset + 200 };
  };
  workspaceFiles.serverOperations.listDirectory = async (_plugin, input) => { if (input.path !== '/') await wait(120); return listDirectory({ ...scope, ...input }); };
  handle('server-workspace-list-directory', async (input) => {
    if (input.resolveLinks && input.snapshotId === stagedRoot?.snapshotId) { await rootMetadataReady; return stagedRoot; }
    const page = await workspaceFiles.listDirectory('renderer:1', input);
    if (input.path === '/' && input.deferLinks && !input.cursor && !stagedRoot) {
      stagedRoot = { ...page, snapshotId: require('node:crypto').randomUUID(), metadataPending: false };
      return { ...stagedRoot, metadataPending: true, entries: page.entries.map(entry => { const { linkTarget, linkTargetType, ...basic } = entry; return basic; }) };
    }
    return page;
  });
  workspaceFiles.serverOperations.readFile = async (_plugin, input) => { previewReads.push(input.path); if (previewDelay) await wait(previewDelay); return { path: input.path, content: '# 示例配置\nsource = ' + input.path + '\nserver_name = demo\nport = 8080\n' + (input.path.endsWith('.log') ? '日志示例\n'.repeat(200) : ''), size: 52, startByte: 0, endByte: 52, mtime: 1, truncated: false, nextCursor: null }; };
  handle('server-workspace-read-file', (input) => { scoped(input); if (previewFailure) throw Object.assign(new Error('没有文件读取权限。'), { code: previewFailure }); return workspaceFiles.readFile('renderer:1', input); });
  handle('server-workspace-prepare-upload-resume', async input => {
    scoped(input);
    const job=uploads.find(item=>item.jobId===input.jobId);
    assert.ok(['interrupted','paused'].includes(job.status));
    if (job.status === 'paused') { pausedResumeRequests += 1; await wait(250); }
    uploadPreparation={
      reviewId:require('node:crypto').randomUUID(),preparationId:require('node:crypto').randomUUID(),status:'ready',expiresAt:Date.now()+60000,
      path:'/srv',sourcePath:'/srv',resume:{jobId:job.jobId,bytes:job.resumeBytes},
      files:[{name:job.name,localPath:path.win32.join('D:/发布文件/待上传',job.name),remotePath:job.path,bytes:job.bytes,exists:true}],
      progress:{phase:'ready',completedFiles:1,totalFiles:1,hashedBytes:job.bytes,totalBytes:job.bytes}
    };
    return reviewResult(uploadPreparation);
  });
  handle('server-workspace-pick-upload', input => { scoped(input); return makePreparation(input.path, uploadSelection); });
  handle('server-workspace-read-upload-review', async input => {
    scoped(input);
    const item=uploadPreparation;
    assert.equal(input.reviewId,item.reviewId);
    if(reviewReadDelay) await wait(reviewReadDelay);
    return reviewResult(item);
  });
  handle('server-workspace-cancel-upload-review', input => {
    scoped(input); cancelledReviews.push(input.reviewId);
    if(uploadPreparation?.reviewId===input.reviewId) uploadPreparation=null;
    return {};
  });
  handle('server-workspace-revise-upload', async input => {
    scoped(input); assert.equal(input.reviewId,uploadPreparation.reviewId);
    assert.ok(input.fileNames.every(name=>uploadPreparation.files.some(file=>file.name===name)));
    assert.equal(input.path,undefined,'修订不能指定目标目录');
    uploadRevisions.push(input);
    if (uploadPreparation.status === 'ready' && uploadPreparation.expiresAt > Date.now() && input.fileNames.length > 0 && input.fileNames.length < uploadPreparation.files.length) {
      const files = uploadPreparation.files.filter(file => input.fileNames.includes(file.name));
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      uploadPreparation = { ...uploadPreparation, reviewId:require('node:crypto').randomUUID(), preparationId:require('node:crypto').randomUUID(), files,
        progress:{phase:'ready',completedFiles:files.length,totalFiles:files.length,hashedBytes:bytes,totalBytes:bytes} };
      return reviewResult(uploadPreparation);
    }
    return input.fileNames.length?makePreparation(uploadPreparation.sourcePath,input.fileNames,revisionFailure):null;
  });
  handle('server-workspace-confirm-upload', input => { scoped(input); uploadConfirmCalls += 1; assert.equal(input.preparationId, uploadPreparation.preparationId); assert.equal(input.overwrite, true); uploads = uploadPreparation.files.map((file, index) => ({ jobId: 'upload-job-' + index, name: file.name, path: file.remotePath, bytes: file.bytes, transferred: 0, status: 'running', canPause:true, phase:'uploading', bytesPerSecond:80000, etaSeconds:12 })); return { jobs: uploads }; });
  handle('server-workspace-uploads', (input) => { scoped(input); if (uploadReadFailure) throw new Error('已有上传任务状态暂时无法读取。'); uploads = uploads.map((job) => { if (job.status !== 'running') return job; const transferred = Math.min(job.bytes, job.transferred + 80000); return { ...job, transferred, status: transferred === job.bytes ? 'completed' : 'running' }; }); return { jobs: uploads.map(job=>({...job,canPause:job.direction!=='download'&&job.status==='running',canRemove:['completed','cancelled','error'].includes(job.status)})) }; });
  handle('server-workspace-pause-upload', input => {
    scoped(input);const job=uploads.find(item=>item.jobId===input.jobId);
    assert.equal(job.status,'running');
    Object.assign(job,{status:'paused',canPause:false,canResume:true,resumeBytes:job.transferred,message:'上传已暂停，可在 30 分钟内继续；退出客户端后失效。'});
    return job;
  });
  handle('server-workspace-clear-transfers', input => {
    scoped(input);
    const removedIds=uploads.filter(job=>(!input.jobId||job.jobId===input.jobId)&&['completed','cancelled','error'].includes(job.status)).map(job=>job.jobId);
    uploads=uploads.filter(job=>!removedIds.includes(job.jobId));
    return {removedIds};
  });
  handle('server-workspace-download', input => {
    scoped(input);assert.equal(input.path,'/srv/release.tar');
    if (downloadFailure) throw Object.assign(new Error('本地保存位置空间不足，请选择其他磁盘。'), {code:'DOWNLOAD_DISK_FULL'});
    const job={jobId:'download-job',name:'release.tar',path:input.path,localPath:'D:/下载/release.tar',direction:'download',bytes:400000,transferred:0,status:'running'};
    uploads.push(job);return job;
  });
  handle('server-workspace-cancel-upload', (input) => { scoped(input); uploads = uploads.map((job) => ({ ...job, status: 'cancelled' })); return uploads[0]; });
}
async function evaluate(source) { try { return await win.webContents.executeJavaScript(source, true); } catch (error) { throw new Error("界面脚本执行失败：" + source.slice(0, 700), { cause: error }); } }
async function until(source, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await evaluate(source)) return; await wait(40); }
  throw Error('等待超时：' + label);
}
async function click(selector) { assert.ok(await evaluate(`(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.getClientRects().length); if (!element || element.disabled) return false; element.click(); return true })()`), selector); await wait(70); }
async function doubleClick(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block:'nearest' });
    const rect = element.getBoundingClientRect();
    return { x:Math.round(rect.left + 65), y:Math.round(rect.top + rect.height / 2) };
  })()`);
  assert.ok(point, selector);
  win.webContents.focus();
  for (const clickCount of [1, 2]) {
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount,...point});
  }
  await wait(100);
}
async function clickText(text) { assert.ok(await evaluate(`(() => { const element = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)} && item.getClientRects().length && !item.disabled); if (!element) return false; element.click(); return true })()`), text); await wait(70); }
async function key(key, keyCode, ctrlKey = false) { await evaluate(`document.querySelector('.server-workspace:not([hidden]) .server-terminal-tab-panel:not([hidden]) .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key:${JSON.stringify(key)}, code:${JSON.stringify(key === 'Enter' ? 'Enter' : 'Key' + key.toUpperCase())}, keyCode:${keyCode}, which:${keyCode}, ctrlKey:${ctrlKey}, bubbles:true, cancelable:true }))`); await wait(80); }
async function paste(text) { await evaluate(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)}); document.querySelector('.server-workspace:not([hidden]) .server-terminal-tab-panel:not([hidden]) .xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true })) })()`); await wait(80); }
async function nativePaste(text, shortcut = false) {
  clipboard.writeText(text);
  await evaluate("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-helper-textarea').focus()");
  if (shortcut) {
    const modifiers = process.platform === 'darwin' ? ['meta'] : ['control', 'shift'];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers });
  } else win.webContents.paste();
  await wait(100);
}
async function setViewport(width, height) {
  win.setContentSize(width, height);
  await until(`innerWidth === ${width} && innerHeight === ${height}`, '固定内容区尺寸');
  await wait(250);
}
async function assertTransferActionLayout(label) {
  const layout = await evaluate(`(() => {
    const row = document.querySelector('.server-upload-row');
    if (!row) return null;
    const progress = row.querySelector('.server-upload-progress').getBoundingClientRect();
    const action = row.querySelector('.server-upload-task-action').getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const buttons = [...row.querySelectorAll('.server-upload-task-action button')].map(button => {
      const rect = button.getBoundingClientRect();
      return {left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom};
    });
    return {progressRight:progress.right, actionLeft:action.left, actionRight:action.right, rowRight:bounds.right, buttons};
  })()`);
  assert.ok(layout && layout.buttons.length >= 2, label + '：包含主操作和移除按钮');
  assert.ok(layout.actionLeft - layout.progressRight >= 8, label + '：进度与操作区有间距');
  for (const button of layout.buttons) {
    assert.ok(button.left >= layout.actionLeft - 1 && button.right <= layout.actionRight + 1, label + '：按钮完整位于操作区');
    assert.ok(button.right <= layout.rowRight, label + '：按钮不越出任务行');
  }
  assert.ok(layout.buttons[1].left >= layout.buttons[0].right + 4, label + '：按钮之间不重叠');
}
async function assertPasteAppearance(theme) {
  const appearance = await evaluate(`(() => {
    const rows = document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows');
    const cell = [...rows.querySelectorAll('span')].find(item => item.textContent.includes('paste-highlight'));
    if (!cell) return null;
    const style = getComputedStyle(cell);
    const rgb = value => value.match(/\\d+/g).slice(0, 3).map(Number);
    const luminance = value => rgb(value).map(c => { const v=c/255; return v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4 }).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);
    const fg=luminance(style.color), bg=luminance(style.backgroundColor);
    return { foreground: style.color, background: style.backgroundColor, contrast:(Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05), font:style.fontFamily, size:style.fontSize };
  })()`);
  assert.ok(appearance, '粘贴高亮已呈现');
  assert.equal(appearance.background, 'rgb(0, 95, 95)', '高亮不再使用白色背景');
  assert.ok(appearance.contrast >= 7, '粘贴高亮文本对比度达到 7:1');
  assert.ok(appearance.font.includes('Microsoft YaHei UI'), '为中文提供清晰的无衬线字体回退');
  assert.equal(appearance.size, '14px');
  await snapshot('terminal-paste-highlight-' + theme + '.png');
}

async function snapshot(name) {
  const folder = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR;
  if (!folder) return;
  const absolute = path.resolve(folder);
  const relative = path.relative(root, absolute);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), '截图必须位于仓库之外');
  fs.mkdirSync(absolute, { recursive: true });
  await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  win.webContents.invalidate();
  await wait(180);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const frame = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  // 页面缩放改变 CSS 视口，截图仍使用窗口内容区的像素尺寸。
  const [width, height] = win.getContentSize();
  assert.deepEqual(frame.getSize(),{width,height},'截图与内容区尺寸一致');
  fs.writeFileSync(path.join(absolute, name), frame.toPNG());
}

async function exerciseUploadReview() {
  const buttonDisabled = "document.querySelector('[data-testid=upload-confirm-submit]').disabled";
  const readsBefore = directoryReads.length;
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=upload-file-row]').length"), 2);
  assert.equal(await evaluate("document.querySelector('[data-testid=upload-source-path]').textContent"), uploadPreparation.files[0].localPath);
  assert.equal(await evaluate("document.querySelector('[data-testid=upload-destination-path]').textContent"), '/srv');
  assert.equal(await evaluate("document.querySelectorAll('.server-upload-directory-picker').length"), 0);
  assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog] button')].some(item=>item.textContent.includes('更换目录'))"), false);
  assert.ok(await evaluate("document.querySelector('.server-upload-file-meta strong').textContent.includes('KB')"));
  assert.ok(await evaluate(buttonDisabled), '检查期间禁止上传');
  assert.ok(await evaluate("document.querySelector('[data-testid=upload-review-progress]')?.textContent.includes('校验文件')"), '检查进度可见');
  await snapshot('upload-review-checking.png');
  for (const [label, expected] of [
    ['复制 release.tar 的本地路径', uploadPreparation.files[0].localPath],
    ['复制 release.tar 的目标目录', '/srv'],
  ]) {
    clipboard.writeText('fixture-before-path-copy');
    await click('[aria-label="' + label + '"]');
    assert.equal(clipboard.readText(), expected, '复制完整路径到系统剪贴板');
  }
  reviewHeld=false;
  await until("!document.querySelector('[data-testid=upload-review-progress]') && !document.querySelector('[role=dialog] input[type=checkbox]').disabled", '检查完成后允许确认覆盖');
  await snapshot('upload-confirm-dark.png');
  await click('[role=dialog] input[type=checkbox]');
  const checksBeforeRemoval = preparationRuns;
  const expiresBeforeRemoval = uploadPreparation.expiresAt;
  const tokenBeforeRemoval = uploadPreparation.preparationId;
  await click('[aria-label="移除 deployment-report.xlsx"]');
  await until("document.querySelectorAll('[data-testid=upload-file-row]').length === 1 && !document.querySelector('[data-testid=upload-review-progress]')", '移除直接更新清单');
  assert.equal(preparationRuns, checksBeforeRemoval, '移除不启动整批检查');
  assert.equal(uploadPreparation.expiresAt, expiresBeforeRemoval, '移除不延长原确认有效期');
  assert.notEqual(uploadPreparation.preparationId, tokenBeforeRemoval, '移除替换旧凭证');
  assert.ok(await evaluate("document.querySelector('.server-upload-total').textContent.includes('1 个文件') && document.querySelector('.server-upload-total').textContent.includes('976.6 KB')"), '数量和大小立即更新');
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').checked"), false, '移除后重新确认剩余同名覆盖');
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').disabled"), false, '移除后可以直接确认覆盖');
  await snapshot('upload-after-remove.png');
  uploadPreparation.status = 'error'; uploadPreparation.preparationId = null;
  uploadPreparation.error = {code:'UPLOAD_CONFIRMATION_EXPIRED',message:'上传确认已过期，请重新检查文件。'};
  await until("document.querySelector('.server-upload-review-error')?.textContent.includes('已过期')", '移除后继续轮询到期状态');
  revisionFailure = true;
  await clickText('重新检查');
  await until("document.querySelector('.server-upload-review-error')?.textContent.includes('暂时不可写')", '文件重新检查失败可恢复');
  assert.ok(await evaluate(buttonDisabled), '失败后禁止旧凭证上传');
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').checked"), false, '重新检查清除覆盖选择');
  revisionFailure = false;
  await clickText('重新检查');
  await until("!document.querySelector('[data-testid=upload-review-progress]') && !document.querySelector('.server-upload-review-error') && document.querySelector('[role=dialog] input[type=checkbox]')?.disabled === false", '原目录重新检查完成');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=upload-file-row]').length"), 1, '后台重试保留移除后的文件清单');
  assert.ok(await evaluate(buttonDisabled), '重新检查后再次确认覆盖');
  assert.equal(await evaluate("document.querySelector('[data-testid=upload-destination-path]').textContent"), '/srv');
  assert.equal(uploadRevisions.length, 3);
  assert.ok(uploadRevisions.every(input => !Object.hasOwn(input, 'path')), '修订不接受目标目录');
  assert.equal(directoryReads.length, readsBefore, '确认页不额外浏览远端目录');
  await snapshot('upload-confirm-single.png');
}

async function assertWorkspaceCoexistence() {
  const terminalId = opened[0];
  const closedBefore = closed.length;
  const writesBefore = writes.length;
  const railWidth = await evaluate('document.querySelector("[data-testid=project-rail]").getBoundingClientRect().width');
  await click('[data-testid="plugin-trigger-mysql-workspace-coexistence"]');
  await until('document.querySelector("[data-testid=plugin-workspace-open]")?.disabled === false', '数据库详情入口');
  assert.equal(mysqlCalls.length, 0, '切换到数据库详情不读取数据库');
  assert.equal(await evaluate('document.querySelector("[data-testid=plugin-open-workspace]") === null'), true, '数据库详情不显示服务器入口');
  await click('[data-testid="plugin-workspace-open"]');
  await until('document.querySelector("[data-testid=mysql-table-item]")?.textContent.includes("records")', '数据库表列表');
  assert.ok(await evaluate('document.querySelector("[data-testid=server-workspace]").hidden'), '数据库前台保留隐藏的服务器工作区');
  await evaluate("(() => { const editor = document.querySelector('[data-testid=mysql-sql-editor]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'SELECT 1 AS integration_probe'); editor.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await click('[data-testid="mysql-query-run"]');
  await until('document.querySelector("[data-testid=mysql-query-result]")?.textContent.includes("integration_probe")', '数据库结果');
  await evaluate("(() => { document.activeElement?.blur(); for (const key of ['k', 'n', 'b']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })); })()");
  assert.equal(await evaluate('document.querySelector("[role=dialog]") === null'), true, '数据库工作区不触发后台命令或创建弹窗');
  assert.equal(await evaluate('document.querySelector("[data-testid=project-rail]").getBoundingClientRect().width'), railWidth, '数据库快捷键不改变主工作台分栏');
  assert.equal(writes.length, writesBefore, 'SQL 输入和查询不会发送给隐藏终端');
  assert.equal(closed.length, closedBefore, '数据库查询不会关闭服务器会话');
  assert.equal(terminalSessions.get(terminalId).status, 'open');
  await click('[data-testid="mysql-workspace-back"]');
  await until('document.activeElement?.dataset.testid === "plugin-workspace-open"', '数据库返回焦点');
  await click('[data-testid="plugin-workspace-open"]');
  assert.equal(mysqlCalls.length, 2, '继续数据库工作区不重复查询');
  assert.ok(await evaluate('document.querySelector("[data-testid=mysql-query-result]")?.textContent.includes("integration_probe")'), '继续时保留数据库结果');
  await click('[data-testid="mysql-workspace-back"]');
  await click('[data-testid="plugin-trigger-redis-workspace-coexistence"]');
  await until('document.querySelector("[data-testid=detail-workspace] h1")?.textContent.includes("并存验证缓存")', 'Redis 详情');
  assert.ok(await evaluate('document.querySelector("[data-testid=plugin-open-workspace], [data-testid=plugin-workspace-open]") === null'), 'Redis 详情没有无效工作区入口');
  assert.ok(await evaluate('document.querySelector("[data-testid=mysql-full-window-workspace]") === null'), '切换插件清除数据库旧结果');
  await click('[data-testid="plugin-trigger-server-workspace-smoke"]');
  await until('document.querySelector("[data-testid=plugin-open-workspace]")?.textContent.includes("继续工作区")', '继续服务器工作区');
}

async function run() {
  await app.whenReady();
  const { createTransferExitGuard } = await import('../src/desktop-transfer-exit-guard.mjs');
  savedClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  const { ServerWorkspaceFiles } = await import('../src/server-workspace-files.mjs');
  workspaceFiles = new ServerWorkspaceFiles({ workspaceStore: { getPlugin: async () => plugin }, serverRuntime: { status: () => ({ connected, generation: 1 }), statRemotePath: async (_plugin, target) => fixtureStat(target) }, serverOperations: {} });
  register();
  win = new BrowserWindow({ enableLargerThanScreen:true, useContentSize:true, width: 1440, height: 920, show: process.platform === 'darwin', webPreferences: { preload: path.join(root, 'src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  let exitAnswer, exitPrompts=0, requestedQuits=0;
  const exitGuard=createTransferExitGuard({
    summary:() => ({active:1,resumable:1}),
    confirm:() => { exitPrompts++; return new Promise(resolve => {exitAnswer=resolve;}); },
    quit:() => {requestedQuits++;},
  });
  const guardedClose=event => exitGuard.allow(event);
  win.on('close',guardedClose);
  win.close(); win.close();
  await wait(50);
  assert.equal(win.isDestroyed(),false,'确认前保留原生窗口');
  assert.equal(exitPrompts,1,'重复关闭只显示一次确认');
  exitAnswer(false); await wait(30);
  assert.equal(requestedQuits,0,'取消退出不终止应用');
  win.close(); await wait(30);
  exitAnswer(true); await wait(30);
  assert.equal(requestedQuits,1,'批准后交给应用退出流程');
  win.removeListener('close',guardedClose);
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/u.test(details.url)) { externalRequests.push(details.url); callback({ cancel: true }); } else callback({}); });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await win.loadFile(path.join(root, 'renderer-build/v2/index.html'));
  await setViewport(1440, 920);
  await until(`document.querySelector('[data-project-id="${scope.projectId}"]')`, '项目');
  await click(`[data-project-id="${scope.projectId}"]`);
  await until(`document.querySelector('[data-testid="environment-trigger-${scope.environmentId}"]')`, '环境');
  await click(`[data-testid="environment-trigger-${scope.environmentId}"]`);
  await until(`document.querySelector('[data-testid="plugin-trigger-${scope.pluginInstanceId}"]')`, '服务器');
  await click(`[data-testid="plugin-trigger-${scope.pluginInstanceId}"]`);
  await until(`document.querySelector('[data-testid="plugin-open-workspace"]')?.disabled === false`, '工作区入口');
  assert.equal(opened.length, 0, '打开详情不会建立终端');
  await snapshot('server-workspace-detail-dark.png');
  await click('[data-testid="plugin-open-workspace"]');
  await until(`document.querySelector('.xterm-rows')?.textContent.includes('operator@demo')`, '真实 xterm 收到输出');
  assert.equal(opened.length, 1, '首次点击只创建一个会话');
  if (process.env.RUNBOOK_BRIDGE_METRICS_SMOKE === '1') {
    releaseRootMetadata();
    await require('./workspace-metrics-ui.cjs')({evaluate,click,clickText,until,wait,win,setViewport,snapshot,metricsState,writes,errors});
    completed=true;
    process.stdout.write(JSON.stringify({ok:true,metrics:true,reads:metricsState.reads})+'\n');
    return;
  }
  if (process.env.RUNBOOK_BRIDGE_FILE_INTERACTION_SMOKE === '1') {
    releaseRootMetadata();
    await require('./workspace-file-interactions-ui.cjs')({evaluate,click,doubleClick,clickText,until,wait,win,previewReads,writes,opened,terminalSessions,errors});
    completed = true;
    process.stdout.write(JSON.stringify({ok:true,fileInteractions:true,writes:writes.length})+'\n');
    return;
  }
  if (process.env.RUNBOOK_BRIDGE_CONVENIENCE_SMOKE === '1') {
    releaseRootMetadata();
    await testWorkspaceConveniences();
    completed = true;
    process.stdout.write(JSON.stringify({ok:true,searchAndBookmarks:true,terminalSessions:opened.length})+'\n');
    return;
  }
  if (process.env.RUNBOOK_BRIDGE_RECOVERY_SMOKE === '1') {
    releaseRootMetadata();
    await testTerminalRecovery();
    assert.deepEqual(errors, [], '自动恢复没有渲染错误');
    completed = true;
    process.stdout.write(JSON.stringify({ok:true,recovery:true,terminalSessions:opened.length})+'\n');
    return;
  }

  await require('./workspace-controls-ui.cjs')({evaluate,click,until,win,root:'[data-testid=server-workspace]'});
  assert.equal(opened.length,1,'工作区主题切换不得重建终端');
  assert.ok(await evaluate(`document.querySelector('[aria-label="三栏工作台"]').closest('[inert]') !== null`), '工作区禁用背景导航');
  await until(`document.querySelector('[role="treeitem"][title="/srv"]')`, '文件目录');
  assert.ok(await evaluate(`document.querySelectorAll('.server-workspace [role="treeitem"]').length < 60`), '200条目录采用虚拟列表');
  assert.ok(await evaluate("document.querySelector('[role=treeitem][title^=\"/bin\"]')?.textContent.includes('读取中')"), '链接信息延迟时先展示基本列表，不误报断链');
  const beforeMetadata = await evaluate("[...document.querySelectorAll('[role=treeitem]')].map(row => ({ path:row.title.split('（')[0], top:row.getBoundingClientRect().top }))");
  await click('[role="treeitem"][title^="/bin"]');
  releaseRootMetadata();
  await until("document.querySelector('[role=treeitem][title^=\"/bin →\"] .server-icon-folder')", '后台补齐目录链接类型');
  await until("document.querySelector('[role=treeitem][title=\"/bin/apt\"]')", '等待中的链接点击在解析后自动展开');
  await click('[role="treeitem"][title^="/bin →"]');
  const afterMetadata = await evaluate("[...document.querySelectorAll('[role=treeitem]')].map(row => ({ path:row.title.split(' →')[0].split('（')[0], top:row.getBoundingClientRect().top }))");
  assert.deepEqual(afterMetadata, beforeMetadata, '补齐元数据不重排条目或改变行高');
  assert.ok(await evaluate(`[...document.querySelectorAll('.server-tree-link')].some(row => row.textContent.includes('bin') && row.textContent.includes('→ /usr/bin'))`), '软链接展示真实目标且名称清晰可读');
  await snapshot('server-files-reference.png');
  assert.ok(await evaluate(`document.querySelector('[role="treeitem"][title^="/bin →"] .server-icon-folder') !== null`), '目录链接显示文件夹图标');
  await click('[role="treeitem"][title^="/bin →"]');
  await until(`document.querySelector('[role="treeitem"][title="/bin/apt"]')`, '目录链接直接展开');
  const beforeLocate = directoryReads.length;
  await evaluate("(() => { const tree=document.querySelector('.server-tree-scroll'); tree.scrollTop=2000; tree.dispatchEvent(new Event('scroll')); })()");
  await wait(100);
  assert.equal(await evaluate("document.querySelector('[role=treeitem][title^=" + JSON.stringify('/bin →') + " ]') !== null"), false, '定位前目录位于虚拟列表视口之外');
  await click('[title="定位到 /bin"]');
  await until("document.querySelector('[role=treeitem][aria-selected=true]')?.textContent.includes('bin')", '面包屑定位并高亮目录本身');
  await until("document.activeElement?.getAttribute('role') === 'treeitem'", '定位后目录获得键盘焦点');
  assert.ok(await evaluate("document.querySelector('[role=treeitem][title=" + JSON.stringify('/app') + " ]') !== null"), '定位保留父级中的同级目录');
  assert.ok(await evaluate("document.querySelector('[role=treeitem][title=" + JSON.stringify('/bin/tool.conf') + " ]') !== null"), '定位保留已展开的子目录');
  assert.equal(directoryReads.length, beforeLocate, '定位已缓存目录不重新请求');
  await snapshot('server-breadcrumb-locate.png');
  const beforeCycle = directoryReads.length;
  assert.ok(await evaluate(`document.querySelector('[role="treeitem"][title^="/bin/X11 →"]')?.getAttribute('aria-disabled') === 'true'`), '祖先循环链接不可重复展开');
  await click('[role="treeitem"][title^="/bin/X11 →"]');
  assert.equal(directoryReads.length, beforeCycle, '循环链接不会触发额外读取');
  await doubleClick('[role="treeitem"][title="/bin/tool.conf"]');
  await until(`document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('server_name')`, '链接目录中的文件可预览');
  assert.equal(previewReads.at(-1), '/usr/bin/tool.conf');
  await snapshot('server-symlink-expanded.png');
  await clickText('上传文件');
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('/usr/bin')`, '链接上传显示实际目录');
  assert.ok(await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('目录链接 /bin → 上方实际目录')`), '上传确认解释链接路径');
  await clickText('取消');
  await doubleClick('[role="treeitem"][title^="/current.conf →"]');
  await until(`document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('server_name')`, '普通文件链接可预览');
  assert.equal(previewReads.at(-1), '/srv/example.conf');
  assert.ok(await evaluate(`document.querySelector('[role="treeitem"][title^="/current.conf →"] .server-icon-code') !== null`), '文件链接使用文件图标');
  await click('[aria-label="关闭文件预览"]');
  await click('[role="treeitem"][title^="/bin →"]');

  await click('[aria-label="显示隐藏文件"]');
  await until(`document.querySelector('[role="treeitem"][title="/.env.example"]')`, '工具栏显示隐藏文件');
  await click('[aria-label="显示隐藏文件"]');
  await until(`!document.querySelector('[role="treeitem"][title="/.env.example"]')`, '工具栏隐藏点文件');
  await click('[aria-label="编辑目录路径"]');
  await evaluate(`(() => { const input=document.querySelector('[aria-label="目录路径"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/srv'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await clickText('转到');
  await until(`document.querySelector('[role="treeitem"][title="/srv/example.conf"]')`, '输入路径导航');
  assert.ok(await evaluate(`document.querySelector('[aria-label="当前目录"] [aria-current="location"]')?.textContent === 'srv'`), '面包屑同步当前路径');
  const treeHas = (value) => 'document.querySelector(' + JSON.stringify('[role="treeitem"][title="' + value + '"]') + ')';
  await click('[role="treeitem"][title="/srv/config"]');
  await until(treeHas('/srv/config/example.conf'), '缓存多层子目录');
  const cachedReads = directoryReads.length;
  await click('[aria-label="当前目录"] [aria-current="location"]');
  await until(treeHas('/srv/config/example.conf'), '面包屑定位已读取目录');
  await evaluate("[...document.querySelectorAll('[aria-label=当前目录] button')].find(item => item.textContent === 'srv').click()");
  await until(treeHas('/srv/config/example.conf'), '返回父目录保留子目录展开');
  assert.ok(await evaluate(treeHas('/srv') + "?.getAttribute('aria-selected') === 'true'"), '点击父路径选中父目录节点');
  assert.ok(await evaluate(treeHas('/srv/config')), '高亮父目录时子目录仍在树中');
  await wait(250);
  assert.equal(directoryReads.length, cachedReads, '缓存导航不重新请求目录');
  await doubleClick('[role="treeitem"][title="/srv/config/example.conf"]');
  await until("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')", '缓存目录中的文件仍实时预览');
  assert.equal(directoryReads.length, cachedReads, '正常文件预览不刷新目录');
  removedPaths.add('/srv/config/example.conf');
  await doubleClick('[role="treeitem"][title="/srv/config/example.conf"]');
  await until('!' + treeHas('/srv/config/example.conf'), '失效文件触发父目录刷新');
  assert.equal(directoryReads.at(-1).path, '/srv/config', '仅刷新失效文件所在目录');
  const beforePermission = directoryReads.length;
  previewFailure = 'SOURCE_PERMISSION_DENIED';
  await doubleClick('[role="treeitem"][title="/srv/config/example.log"]');
  await until("document.querySelector('.server-preview-tab-panel:not([hidden]) [role=alert]')?.textContent.includes('没有文件读取权限')", '权限失败保留明确提示');
  await wait(200);
  assert.equal(directoryReads.length, beforePermission, '权限失败不丢弃或刷新目录缓存');
  previewFailure = null;
  removedPaths.add('/srv/config');
  await doubleClick('[role="treeitem"][title="/srv/config/example.log"]');
  await until('!' + treeHas('/srv/config'), '父文件夹失效时更新上一级目录');
  removedPaths.clear();
  await click('[aria-label="关闭文件预览"]');
  await click('[aria-label="刷新目录"]');
  await until(treeHas('/srv/config') + " && !document.querySelector('.server-tree-scroll').textContent.includes('读取中')", '手动刷新发现新增目录');
  await click('[aria-label="收起所有目录"]');
  await click('[aria-label="根目录"]');
  await until(`document.querySelector('[role="treeitem"][title="/srv"]')`, '面包屑返回根目录');

  for (let page = 1; page < 10; page += 1) {
    await evaluate("(() => { const tree = document.querySelector('.server-tree-scroll'); tree.scrollTop = tree.scrollHeight; tree.dispatchEvent(new Event('scroll')); })()");
    await wait(80); await clickText("加载更多");
  }
  await evaluate("(() => { const tree = document.querySelector('.server-tree-scroll'); tree.scrollTop = tree.scrollHeight; tree.dispatchEvent(new Event('scroll')); })()");
  await wait(80); await clickText("查看下一批");
  assert.ok(directoryReads.some((input) => input.cursor === "2000"), "第2001项之后仍可浏览");
  await wait(100); await clickText("查看上一批");
  await evaluate("(() => { const tree = document.querySelector('.server-tree-scroll'); tree.scrollTop = 0; tree.dispatchEvent(new Event('scroll')); })()");
  await wait(100);
  // 虚拟列表只挂载可视区附近的条目，先滚动到明确的失效链接再验证禁用行为。
  const unavailableLink = '[role="treeitem"][title^="/missing-link"][aria-disabled="true"]';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await evaluate('Boolean(document.querySelector(' + JSON.stringify(unavailableLink) + '))')) break;
    await evaluate("(() => { const tree = document.querySelector('.server-tree-scroll'); tree.scrollTop += Math.max(80, tree.clientHeight / 2); tree.dispatchEvent(new Event('scroll')); })()");
    await wait(80);
  }
  const beforeLink = directoryReads.length;
  await click(unavailableLink);
  assert.equal(directoryReads.length, beforeLink, "不遍历符号链接");
  await click('[role="treeitem"][title="/srv"]');
  await until(`document.querySelector('[role="treeitem"][title="/srv/example.conf"]')`, '懒加载子目录');
  const assertTreeGeometry = async (label) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const result = await evaluate(`(() => { const tree=document.querySelector('.server-tree-scroll'); const rows=[...tree.querySelectorAll('[role=treeitem]')]; const indices=rows.map(row=>Number(row.dataset.treeIndex)); const titles=rows.map(row=>row.title); const boxes=rows.map(row=>row.getBoundingClientRect()); return { uniqueIndices:new Set(indices).size===indices.length, uniquePaths:new Set(titles).size===titles.length, noOverlap:boxes.every((box,index)=>index===0||box.top>=boxes[index-1].bottom-0.5), bounded:rows.length<60, links:rows.filter(row=>row.getAttribute('aria-disabled')==='true').map(row=>row.title) }; })()`);
    assert.ok(result.uniqueIndices && result.uniquePaths && result.noOverlap && result.bounded, label + ': ' + JSON.stringify(result));
  };
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await click('[role="treeitem"][title="/srv/config"]');
    await until(`document.querySelector('[role="treeitem"][title="/srv/config/example.conf"]')`, '多层目录展开');
    await assertTreeGeometry('多层展开无重叠');
    await click('[role="treeitem"][title="/srv"]');
    await assertTreeGeometry('收起父目录无残留行');
    await click('[role="treeitem"][title="/srv"]');
    await assertTreeGeometry('展开父目录无残留行');
    await click('[role="treeitem"][title="/srv/config"]');
    await evaluate("(() => { const tree=document.querySelector('.server-tree-scroll'); tree.scrollTop=290; tree.dispatchEvent(new Event('scroll')); })()");
    await assertTreeGeometry('滚动后行位置唯一');
    await evaluate("(() => { const tree=document.querySelector('.server-tree-scroll'); tree.scrollTop=0; tree.dispatchEvent(new Event('scroll')); })()");
  }
  await click('[role="treeitem"][title="/srv"]');
  await click('[role="treeitem"][title="/srv"]');
  await click('[aria-label="刷新目录"]');
  await assertTreeGeometry('刷新加载提示与同名文件无冲突');
  await until("!document.querySelector('.server-tree-scroll').textContent.includes('读取中')", '刷新目录完成');
  await assertTreeGeometry('回到顶部无重影');
  await snapshot('server-tree-no-overlap.png');
  await click('[role="treeitem"][title="/srv/config"]');
  await until(treeHas('/srv/config/example.conf'), '展开待刷新分支');
  // 选择父目录后，子目录仍展开；删除其他分支中的文件应被全局刷新发现。
  await click('[role="treeitem"][title="/srv"]');
  await click('[role="treeitem"][title="/srv"]');
  removedPaths.add('/srv/config/example.conf');
  await click('[aria-label="刷新目录"]');
  await until('!' + treeHas('/srv/config/example.conf') + ' && ' + treeHas('/srv/config/example.log'), '刷新覆盖非当前的展开子目录');
  await until("!document.querySelector('[aria-label=刷新目录]').disabled", '展开分支刷新完成');
  removedPaths.delete('/srv/config/example.conf');
  const beforeStaleRefresh = directoryReads.length;
  await evaluate("window.reviewOriginalNow = Date.now; Date.now = () => window.reviewOriginalNow() + 31000; undefined;");
  await click('[role="treeitem"][title="/srv/config"]');
  await click('[role="treeitem"][title="/srv/config"]');
  await until(treeHas('/srv/config/example.conf'), '再次展开过期缓存会重新读取');
  assert.ok(directoryReads.slice(beforeStaleRefresh).some(item => item.path === '/srv/config'), '过期分支发送新的目录请求');
  await evaluate("Date.now = window.reviewOriginalNow; delete window.reviewOriginalNow;");
  await click('[role="treeitem"][title="/srv/config"]');
  await click('[role="treeitem"][title="/srv"]');
  await click('[role="treeitem"][title="/srv"]');

  assert.ok(!writes.length, '文件树导航不会改变终端目录');
  await doubleClick('[role="treeitem"][title="/srv/example.conf"]');
  await until(`document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('server_name')`, '只读预览');
  const beforeSecondFile = previewReads.length;
  await doubleClick('[role="treeitem"][title="/srv/example.log"]');
  await until("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('/srv/example.log')", '第二个文件独立预览');
  await evaluate("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content').scrollTop = 120");
  await click('[role="tab"][title="/srv/example.conf"]');
  await until("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('/srv/example.conf')", '文件标签切回独立内容');
  assert.equal(previewReads.length, beforeSecondFile + 1, '切换文件标签复用预览，不重新读取');
  await click('[role="tab"][title="/srv/example.log"]');
  assert.equal(await evaluate("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content').scrollTop"), 120, '文件标签保留滚动位置');
  await click('[aria-label="关闭/srv/example.log"]');
  await until("document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('/srv/example.conf')", '关闭当前文件切回相邻预览');
  previewDelay = 350;
  await doubleClick('[role="treeitem"][title="/srv/example.log"]');
  await click('[aria-label="关闭/srv/example.log"]');
  await wait(400);
  assert.equal(await evaluate("document.querySelector('[role=tab][title=\"/srv/example.log\"]') !== null"), false, '关闭加载中的文件不会被迟到响应重新打开');
  previewDelay = 0;
  await key('c', 67, true);
  assert.ok(writes.some((item) => item.data === '\x03'), 'Ctrl+C送到交互会话');
  const pasted = 'cat <<EOF\r\n  第一行\r\n\r\n第二行\r\nEOF';
  const beforePaste = writes.length;
  await nativePaste(pasted);
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('确认粘贴')`, '系统剪贴板多行预览');
  assert.equal(writes.length, beforePaste, '预览前不发送任何一行');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[role=dialog] pre')).fontSize"), '14px', '多行预览使用可读字号');
  await snapshot('terminal-paste-preview.png');
  await clickText('确认粘贴整段');
  assert.equal(writes.at(-1).data, pasted.replace(/\r?\n/gu, '\r'), '整段保留中文、缩进与空行');
  await until('document.querySelector("[role=dialog]") === null', '确认后关闭预览');
  const sessionId = opened[0];
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\x1b[?2004h'));
  await wait(250);
  const readsBefore = clipboardReads;
  await nativePaste('echo shortcut\necho second', true);
  await until('document.querySelector("[role=dialog]")?.textContent.includes("echo shortcut")', '真实快捷键读取剪贴板');
  assert.equal(clipboardReads, readsBefore + 1, '快捷键只读取一次');
  await clickText('确认粘贴整段');
  assert.equal(writes.at(-1).data, '\x1b[200~echo shortcut\recho second\x1b[201~', '遵循远端括号粘贴模式且不额外回车');
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\x1b[?2004l'));
  await wait(250);
  await nativePaste('echo cancelled\necho never');
  const beforeCancel = writes.length;
  await clickText('取消');
  assert.equal(writes.length, beforeCancel, '取消粘贴不发送');
  await until('document.querySelector("[role=dialog]") === null', '取消后关闭预览');
  await wait(200);
  const box = await evaluate("(() => { const e=document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-screen'); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width} })()");
  win.webContents.sendInputEvent({type:'mouseMove', x:Math.round(box.x+2), y:Math.round(box.y+8)});
  await wait(50);
  win.webContents.sendInputEvent({type:'mouseDown', x:Math.round(box.x+2), y:Math.round(box.y+8), button:'left', clickCount:1});
  await wait(50);
  win.webContents.sendInputEvent({type:'mouseMove', x:Math.round(box.x+box.w-5), y:Math.round(box.y+35), button:'left', modifiers:['leftButtonDown']});
  await wait(70);
  win.webContents.sendInputEvent({type:'mouseUp', x:Math.round(box.x+box.w-5), y:Math.round(box.y+35), button:'left', clickCount:1});
  await wait(100);
  await clickText('复制');
  assert.ok(clipboard.readText().includes('\n'), '终端多行选中内容复制到系统剪贴板');
  const copiedText = clipboard.readText();
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\x1b]52;c;dGVzdA==\x07'));
  await wait(200);
  assert.equal(clipboard.readText(), copiedText, '远端 OSC 52 不能改写剪贴板');
  await snapshot('terminal-multiline-paste.png');
  const beforeLargePaste = writes.length;
  await paste('中'.repeat(30000));
  assert.equal(writes.length, beforeLargePaste, 'UTF8超过64KB在发送前拒绝');
  assert.equal(closed.length, 0, '大粘贴不结束会话');
  await until(`document.querySelector('.server-terminal-pane [role="alert"]')?.textContent.includes('64 KB')`, '中文超限提示');
  await click('[aria-label="收起终端提示"]');
  await click('[data-testid="server-workspace-back"]');
  await assertWorkspaceCoexistence();
  await click('[data-testid="plugin-open-workspace"]');
  assert.equal(opened.length, 1, '返回重开保留同一终端');
  assert.ok(await evaluate(`document.querySelector('.server-preview-tab-panel:not([hidden]) .server-preview-content')?.textContent.includes('server_name')`), '返回保留预览');
  uploadSelection = ['cancelled-large.bin'];
  reviewHeld = true; reviewReadDelay = 700;
  await clickText('上传文件');
  await until("document.querySelector('[data-testid=upload-review-progress]')", '慢检查先显示清单');
  const cancelledReviewId = uploadPreparation.reviewId;
  await wait(100);
  await clickText('取消');
  assert.ok(cancelledReviews.includes(cancelledReviewId), '取消终止对应预处理任务');
  reviewReadDelay = 0;
  uploadSelection = ['release.tar', 'deployment-report.xlsx'];
  await clickText('上传文件');
  await wait(800);
  assert.ok(await evaluate("document.querySelector('[role=dialog]').textContent.includes('release.tar') && !document.querySelector('[role=dialog]').textContent.includes('cancelled-large.bin')"), '迟到结果不能覆盖新选择');

  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('release.tar')`, '上传文件确认');
  await exerciseUploadReview();
  assert.ok(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(item => item.textContent.includes('开始上传')).disabled`), '覆盖必须明确选择');
  await click('[role="dialog"] input[type="checkbox"]');
  await clickText('开始上传 1 个文件');
  assert.equal(uploads[0].path, '/srv/release.tar', '确认锁定目录');
  await until("document.querySelector('[data-testid=upload-speed]')?.textContent.includes('/s')", '显示上传速度');
  assert.ok(await evaluate("document.querySelector('[data-testid=upload-speed]').textContent.includes('剩余约 12 秒')"), '显示剩余时间');
  await snapshot('upload-speed-estimate.png');
  uploadSelection = ['next-batch.bin']; reviewHeld = true; uploadReadFailure = true;
  await clickText('上传文件');
  await until("document.querySelector('[data-testid=upload-review-progress]') && document.querySelector('[data-testid=upload-poll-error]')", '检查与已有传输提示并存');
  assert.equal(await evaluate("document.querySelector('.server-upload-review-error')"), null, '已有任务的查询错误不会进入新文件检查窗口');
  assert.equal(uploads[0].status, 'running', '预处理不会停止已有上传');
  uploadReadFailure = false;
  const transferredBeforeReview = uploads[0].transferred;
  await until("!document.querySelector('[data-testid=upload-poll-error]')", '状态查询恢复后清除传输提示');
  assert.ok(uploads[0].transferred > transferredBeforeReview, '后台检查期间已有上传继续推进');
  await clickText('取消'); reviewHeld = false;
  assert.equal(uploads[0].status, 'running', '取消新检查不取消已有上传');
  const progressBefore = uploads[0].transferred;
  await click('[data-testid="server-workspace-back"]');
  // 工作区隐藏时空闲轮询最长为 4 秒，等待实际进度避免依赖固定时序。
  const transferDeadline = Date.now() + 8000;
  while (uploads[0].transferred <= progressBefore && Date.now() < transferDeadline) await wait(50);
  assert.ok(uploads[0].transferred > progressBefore, '返回详情后任务继续');
  await click('[data-testid="plugin-open-workspace"]');
  assert.equal(await evaluate("document.querySelector('.server-workspace-density')"),null,'服务器工作区固定紧凑布局，不提供密度切换');
  await snapshot('server-workspace-dark.png');
  uploads = uploads.map(job => ({...job, transferred:job.bytes, status:'completed'}));
  await until("document.querySelector('[aria-label=\"定位到 release.tar\"]')", '上传完成可定位');
  await click('[aria-label="定位到 release.tar"]');
  await until("document.querySelector('[role=treeitem][aria-selected=true]')?.getAttribute('title')==='/srv/release.tar'", '定位上传文件并高亮');
  assert.ok(await evaluate("document.querySelector('.server-upload-task-target code').textContent==='/srv/release.tar'"), '任务持续展示固定目标');
  await assertTransferActionLayout('常规窗口');
  await snapshot('upload-task-completed.png');
  await setViewport(1000, 750);
  win.webContents.setZoomFactor(1.25);
  await wait(250);
  await assertTransferActionLayout('窄窗口及 125% 缩放');
  await snapshot('upload-task-completed-zoom.png');
  win.webContents.setZoomFactor(1);
  await setViewport(1440, 920);
  uploads=uploads.map(job=>({...job,status:'interrupted',canResume:true,resumeBytes:400000,transferred:400000,message:'上传已中断，连接恢复后可继续。'}));
  await until(`[...document.querySelectorAll('.server-upload-task-action button')].some(button=>button.textContent==='继续上传')`,'中断任务显示继续上传');
  await clickText('继续上传');
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('继续前会校验')`,'续传确认说明校验和已传大小');
  assert.ok(await evaluate(`document.querySelector('[aria-label="移除 release.tar"]').disabled`),'续传不能替换文件');
  assert.ok(await evaluate(`document.querySelector('[data-testid=upload-confirm-submit]').disabled`),'续传覆盖仍需明确确认');
  await snapshot('upload-resume-confirm.png');
  await click('[role="dialog"] input[type="checkbox"]');
  await clickText('确认继续上传');
  await until(`!document.querySelector('[role="dialog"]')`,'续传确认关闭');
  assert.equal(uploads.length,1,'续传复用原任务');
  await until("document.querySelector('[aria-label=\"暂停上传 release.tar\"]')", '运行任务可暂停');
  await click('[aria-label="暂停上传 release.tar"]');
  await until("document.querySelector('.server-upload-row')?.textContent.includes('已暂停')", '暂停状态可识别');
  assert.equal(uploads[0].status,'paused');
  const pausedBytes=uploads[0].transferred;
  await wait(800);assert.equal(uploads[0].transferred,pausedBytes,'暂停期间不推进');
  const beforeDirectResume = uploadConfirmCalls;
  await assertTransferActionLayout('暂停状态');
  await evaluate(`(() => {
    window.resumeDialogObserved = false;
    window.resumeDialogObserver = new MutationObserver(() => { if (document.querySelector('[role=dialog]')) window.resumeDialogObserved = true; });
    window.resumeDialogObserver.observe(document.body, {childList:true, subtree:true});
    const button = [...document.querySelectorAll('.server-upload-task-action button')].find(item => item.textContent === '继续上传');
    button.click(); button.click();
  })()`);
  await until("document.querySelector('.server-upload-task-action')?.textContent.includes('正在继续')", '直接继续时显示等待状态');
  await until(`document.querySelector('[aria-label="暂停上传 release.tar"]')`, '暂停后一键恢复');
  assert.equal(uploadConfirmCalls, beforeDirectResume + 1, '恢复只消费一次新确认');
  assert.equal(pausedResumeRequests, 1, '重复点击不会重复准备恢复');
  assert.equal(uploads.length, 1, '直接继续保留原任务');
  assert.equal(await evaluate("window.resumeDialogObserver.disconnect(); window.resumeDialogObserved"), false, '暂停后继续全程不弹确认窗口');
  assert.equal(uploadPreparation, null, '自动恢复后释放检查记录');
  await until("document.querySelector('[aria-label=\"暂停上传 release.tar\"]')",'继续后恢复传输');
  uploads=uploads.map(job=>({...job,status:'completed',transferred:job.bytes}));
  await until("document.querySelector('[aria-label=\"移除记录 release.tar\"]')",'已结束记录可移除');
  await click('[aria-label="移除记录 release.tar"]');
  await until("document.querySelectorAll('.server-upload-row').length===0",'移除单条记录');
  await wait(1600);
  assert.equal(await evaluate("document.querySelectorAll('.server-upload-row').length"),0,'轮询不会恢复已移除记录');
  downloadFailure = true;
  await click('[aria-label="下载 release.tar"]');
  await until("document.querySelector('[data-testid=upload-job-error]')?.textContent.includes('空间不足')", '操作失败显示明确提示');
  await wait(3200);
  assert.ok(await evaluate("document.querySelector('[data-testid=upload-job-error]')?.textContent.includes('空间不足')"), '正常轮询不能清除操作失败提示');
  downloadFailure = false;
  await click('[aria-label="下载 release.tar"]');
  await until("!document.querySelector('[data-testid=upload-job-error]')", '重新操作后清除旧错误');
  await until("document.querySelector('.server-upload-task-target')?.textContent.includes('D:/下载/release.tar')",'目录树下载显示本地保存路径');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"暂停上传 release.tar\"]')"),null,'下载不显示上传暂停');
  await snapshot('download-task-running.png');
  await until("document.querySelector('.server-upload-row')?.textContent.includes('已完成')",'下载完成');
  await clickText('清除已结束');
  await until("document.querySelectorAll('.server-upload-row').length===0",'批量清除结束记录');

  await click('[aria-label="最大化终端"]');
  await wait(150);
  assert.ok(await evaluate(`document.querySelector('.server-terminal-container').getBoundingClientRect().width > window.innerWidth - 60`), '最大化终端获得完整宽度');
  await click('[aria-label="恢复分栏"]');
  await setViewport(1000, 750);
  assert.ok(await evaluate(`(() => { const rect = document.querySelector('.server-terminal-container').getBoundingClientRect(); return rect.height > 160 && rect.width > 350 && document.documentElement.scrollWidth <= window.innerWidth; })()`), '窄窗口终端仍可操作');
  await snapshot('server-workspace-narrow.png');
  clipboardDelay = 500;
  const beforeLatePaste = writes.length;
  await nativePaste('late-paste-must-not-arrive', true);
  const firstTerminal = opened[0];
  await click('[aria-label="新增终端"]');
  await until("document.querySelectorAll('[aria-label=终端标签] [role=tab]').length === 2", '新增终端标签');
  await wait(200);
  const secondTerminal = opened.at(-1);
  await wait(500);
  clipboardDelay = 0;
  assert.equal(writes.length, beforeLatePaste, '切换标签后丢弃迟到的剪贴板读取');
  assert.notEqual(firstTerminal, secondTerminal, '新标签使用独立会话');
  await paste('second-tab-input');
  assert.equal(writes.at(-1).sessionId, secondTerminal, '输入只发送给当前标签');
  terminalSessions.get(firstTerminal).chunks.push(Buffer.from('\r\nbackground-first-tab\r\n'));
  await wait(200);
  await click('[role="tab"][title="终端 1"]');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('background-first-tab')", '后台终端继续接收输出');
  await paste('first-tab-input');
  assert.equal(writes.at(-1).sessionId, firstTerminal, '切回原终端保持独立输入');
  const beforeColors = writes.length;
  await clickText('目录配色');
  await until("document.querySelector('[role=dialog]')?.textContent.includes('LS_COLORS')", '提供会话内标准配色设置');
  assert.equal(writes.length, beforeColors, '查看配色设置不发送命令');
  assert.ok(defaultColorOptions.every(value => value === true), '首次与新增终端默认自动配色');
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').checked"), true);
  const beforePreference = opened.length;
  await click('[role=dialog] input[type=checkbox]');
  assert.equal(await evaluate("localStorage.getItem('runbook-bridge:terminal-default-colors:v1')"), 'false');
  assert.equal(opened.length, beforePreference, '更改开关不会重建现有终端');
  await clickText('填入配色命令');
  assert.equal(writes.at(-1).sessionId, firstTerminal);
  assert.ok(writes.at(-1).data.includes("alias ll="), '配色命令补充 ll 别名');
  const { TERMINAL_PASTE_COLORS } = await import('../src/server-terminal-startup.mjs');
  assert.ok(writes.at(-1).data.endsWith(TERMINAL_PASTE_COLORS), '手动应用与新建会话使用同一粘贴配色');
  assert.ok(!/[\r\n]/u.test(writes.at(-1).data), '配色命令不自动回车执行');
  terminalSessions.get(firstTerminal).chunks.push(Buffer.from('\r\n\x1b[34mcolor-directory\x1b[0m \x1b[36mcolor-link\x1b[0m \x1b[32mcolor-executable\x1b[0m\r\n'));
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('color-executable')", '渲染文件类型 ANSI 颜色');
  const palette = await evaluate("(() => { const rows=document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows'); return ['color-directory','color-link','color-executable'].map(text => getComputedStyle([...rows.querySelectorAll('span')].find(item => item.textContent.includes(text))).color) })()");
  assert.equal(new Set(palette).size, 3, '目录、链接、可执行文件颜色不同');
  await snapshot('server-multiple-tabs.png');
  terminalSessions.get(firstTerminal).chunks.push(Buffer.from('\r\n\x1b[27;48;5;23;38;5;195mpaste-highlight 中文多行\x1b[0m\r\n\x1b[27;48;5;23;38;5;195m    保留缩进和空行\x1b[0m\r\n'));
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('paste-highlight')", '模拟 Readline 原生粘贴高亮');
  await assertPasteAppearance('dark');
  await click('[aria-label="关闭终端 2"]');
  await wait(100);
  assert.ok(closed.includes(secondTerminal), '关闭标签释放它的终端');
  assert.ok(!closed.includes(firstTerminal), '关闭其他标签不结束当前终端');
  const retainedTerminalCount = opened.length;
  nativeTheme.themeSource = 'light';
  await evaluate(`localStorage.setItem('runbook-bridge:theme-preference:v1', 'light'); window.dispatchEvent(new StorageEvent('storage', { key:'runbook-bridge:theme-preference:v1' }))`);
  await wait(150);
  const lightColors = await evaluate("(() => { const probe = document.createElement('span'); probe.style.cssText='color:var(--foreground);transition:none;position:fixed;visibility:hidden'; document.body.appendChild(probe); const expected=getComputedStyle(probe).color; const actual=getComputedStyle(document.querySelector('.server-workspace h1')).color; const tree=getComputedStyle(document.querySelector('.server-tree-row:not([aria-selected=true])')).color; probe.remove(); return {expected,actual,tree}; })()");
  assert.equal(lightColors.actual, lightColors.expected, '浅色标题使用当前前景色');
  assert.equal(lightColors.tree, lightColors.expected, '浅色树使用当前前景色');
  await snapshot('server-workspace-light.png');
  await assertPasteAppearance('light');
  uploadSelection = ['release.tar', ...Array.from({length:19}, (_, index) => 'deployment-report-with-long-name-' + index + '.xlsx')];
  await clickText('上传文件');
  await until("document.querySelectorAll('[data-testid=upload-file-row]').length===20", '多文件滚动列表');
  assert.ok(await evaluate("(() => {const el=document.querySelector('.server-upload-confirm-files'); return el.scrollHeight>el.clientHeight && document.documentElement.scrollWidth<=window.innerWidth;})()"), '文件列表有界滚动且页面不溢出');
  assert.ok(await evaluate("(() => {const r=document.querySelector('.server-upload-confirm-footer').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()"), '多文件时操作栏始终可见');
  await snapshot('upload-confirm-light-many.png');
  await setViewport(650, 750);
  assert.ok(await evaluate("(() => {const el=document.querySelector('[role=dialog]');const rect=el.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.height<=innerHeight && el.scrollWidth<=el.clientWidth+1;})()"), '窄窗口长文件名不溢出弹窗');
  assert.ok(await evaluate("(() => {const r=document.querySelector('.server-upload-confirm-footer').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()"), '窄窗口操作栏始终可见');
  await snapshot('upload-confirm-narrow.png');
  await setViewport(420, 750);
  assert.ok(await evaluate("(() => {const el=document.querySelector('[role=dialog]'); return el.scrollWidth<=el.clientWidth+1 && el.getBoundingClientRect().bottom<=innerHeight;})()"), '更窄窗口路径换行且不溢出');
  await snapshot('upload-confirm-compact.png');
  await clickText('取消');
  await setViewport(1000, 750);
  await clickText('结束会话');
  assert.ok(closed.length > 0, '结束终端关闭对应会话');
  assert.equal(connected, true, '结束终端保持服务器连接');
  await click('[data-testid="server-workspace-back"]');
  await click('[data-testid="plugin-open-workspace"]');
  assert.equal(opened.length, retainedTerminalCount, '已结束的终端不会自动重开');
  await clickText('打开终端');
  await wait(200);
  assert.equal(opened.length, retainedTerminalCount + 1, '显式打开新的终端');
  assert.equal(defaultColorOptions.at(-1), false, '重开终端读取最新配色偏好');
  await clickText('断开连接');
  await until(`document.querySelector('.server-workspace-connection-notice')`, '断线反馈');
  assert.equal(connected, false);
  await click('[data-testid="server-workspace-back"]');
  await until(`document.querySelector('[data-testid="plugin-open-workspace"]')?.disabled === true`, '未连接不能打开工作区');
  assert.ok(resizes.length > 0 && resizes.every((item) => item.cols > 1 && item.rows > 1), '布局变化只传有效尺寸');
  assert.deepEqual(externalRequests, [], '不连接真实服务');
  assert.deepEqual(errors, [], '没有渲染错误');
  win.webContents.send('v2:workspace-changed', { type: 'plugin-deleted', ...scope });
  await until("document.querySelector('[data-testid=server-workspace]') === null", '删除插件释放工作区');
  connected = true; sequence += 1;
  await win.loadFile(path.join(root, "renderer-build/v2/index.html"));
  await until("document.querySelector('[data-project-id=" + scope.projectId + "]')", "浅色冷启动项目");
  await click("[data-project-id=" + scope.projectId + "]");
  await until("document.querySelector('[data-testid=environment-trigger-" + scope.environmentId + "]')", "浅色冷启动环境");
  await click("[data-testid=environment-trigger-" + scope.environmentId + "]");
  await until("document.querySelector('[data-testid=plugin-trigger-" + scope.pluginInstanceId + "]')", "浅色冷启动服务器");
  await click("[data-testid=plugin-trigger-" + scope.pluginInstanceId + "]");
  await until("document.querySelector('[data-testid=plugin-open-workspace]')?.disabled === false", "浅色冷启动入口");
  await click("[data-testid=plugin-open-workspace]");
  await until("document.querySelector('.xterm-rows')?.textContent.includes('operator@demo')", "浅色冷启动终端");
  const coldColors = await evaluate("(() => { const probe = document.createElement('span'); probe.style.cssText='color:var(--foreground);transition:none;position:fixed;visibility:hidden'; document.body.appendChild(probe); const expected=getComputedStyle(probe).color; const actual=getComputedStyle(document.querySelector('.server-workspace h1')).color; const tree=getComputedStyle(document.querySelector('.server-tree-row:not([aria-selected=true])')).color; probe.remove(); return {expected,actual,tree}; })()");
  assert.equal(coldColors.actual, coldColors.expected, "浅色冷启动标题对比度");
  assert.equal(coldColors.tree, coldColors.expected, "浅色冷启动目录对比度");
  await snapshot("server-workspace-light-cold.png");
  assert.deepEqual(errors, [], "冷启动也没有渲染错误");
  assert.equal(defaultColorOptions.at(-1), false, '冷启动保留自动配色偏好');
  await testTerminalRecovery();
  assert.deepEqual(errors, [], '自动恢复没有渲染错误');
  await testWorkspaceConveniences();
  await require('./workspace-metrics-ui.cjs')({evaluate,click,clickText,until,wait,win,setViewport,snapshot,metricsState,writes,errors});
  await require('./workspace-file-interactions-ui.cjs')({evaluate,click,doubleClick,clickText,until,wait,win,previewReads,writes,opened,terminalSessions,errors});
  completed = true;
  process.stdout.write(JSON.stringify({ ok: true, terminalSessions: opened.length, writes: writes.length, directoryReads: directoryReads.length, resizes: resizes.length, screenshotRoot: process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR ?? null }) + '\n');
}

async function testTerminalRecovery() {
  await setViewport(1200,850);
  await click('[aria-label="新增终端"]');
  await until("document.querySelectorAll('.server-terminal-tab-panel').length===2", '恢复测试双终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('operator@demo')", '新终端就绪');
  const previous=opened.slice(-2);
  const active=previous[1];
  terminalSessions.get(active).chunks.push(Buffer.from('\r\nreconnect-history-marker\r\n\x1b[?1049hfull-screen-before-loss\x1b[?2004h\x1b[?1000h'));
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('full-screen-before-loss')",'断线前进入全屏模式');
  await paste('echo should-not-replay\npwd');
  await until("document.querySelector('[role=dialog]')?.textContent.includes('确认粘贴')",'断线前待确认粘贴');
  const before=opened.length;
  const previousWrites=writes.length;
  const connections=connectionRequests.length;
  const confirms=uploadConfirmCalls;
  const resumes=pausedResumeRequests;
  interruptTerminals();
  publishRecovery(false,'waiting');
  await until("document.querySelector('[data-testid=server-connection-notice]')?.textContent.includes('等待自动重连')",'真实等待状态');
  await until("!document.querySelector('[role=dialog]')",'断线关闭待确认粘贴');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden])')?.textContent.includes('停止恢复')",'终端等待恢复');
  await evaluate("document.querySelector('[data-testid=server-workspace-back]').focus()");
  await snapshot('terminal-reconnect-waiting.png');
  publishRecovery(true);
  await until("document.querySelectorAll('.server-terminal-pane [role=status]').length===2 && [...document.querySelectorAll('.server-terminal-pane [role=status]')].every(el=>el.textContent.includes('已重新连接'))",'双终端自动恢复');
  assert.equal(opened.length,before+2);
  assert.deepEqual(openRequests.slice(-2).map(item=>item.recoveryOf),[previous[1],previous[0]],'优先恢复当前可见标签');
  assert.equal(writes.length,previousWrites,'断线前待确认粘贴不会发送');
  assert.equal(connectionRequests.length,connections,'终端恢复复用连接，不创建新的 SSH 重试');
  assert.equal(uploadConfirmCalls,confirms,'终端恢复不重新开始上传');
  assert.equal(pausedResumeRequests,resumes,'终端恢复不改变暂停上传');
  assert.equal(await evaluate("document.activeElement?.dataset.testid"),'server-workspace-back','恢复不抢焦点');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('reconnect-history-marker')",'全屏程序退出后保留普通缓冲区历史');
  await paste('after-reconnect');
  assert.equal(writes.at(-1).data,'after-reconnect','新会话没有沿用旧括号粘贴模式');
  await snapshot('terminal-reconnect-restored.png');

  const afterFirstRecovery=opened.length;
  interruptTerminals();
  publishRecovery(false,'waiting');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden])')?.textContent.includes('停止恢复')",'可以停止单个标签恢复');
  await clickText('停止恢复');
  publishRecovery(true);
  await until("document.querySelector('.server-terminal-tab-panel[hidden] [role=status]')?.textContent.includes('已重新连接')",'其他标签正常恢复');
  assert.equal(opened.length,afterFirstRecovery+1,'已停止的标签不会重新打开');
  assert.equal(connectionRequests.length,connections,'停止单个终端不会断开共享连接');

  await clickText('终端 1');
  const current=opened.at(-1);
  const item=terminalSessions.get(current);
  item.status='closed';item.closeReason='remote-exit';item.recoverable=false;item.exitCode=0;
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('会话已结束')",'正常退出不重开');
  publishRecovery(false,'waiting');
  publishRecovery(true);
  await wait(250);
  assert.equal(opened.length,afterFirstRecovery+1,'正常退出和停止的标签不随连接恢复');

  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'显式打开新会话');
  const beforeFailures=opened.length;
  recoveryOpenFailures=2;
  interruptTerminals('channel-error');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('已重新连接')",'通道恢复失败后有界重试成功');
  assert.equal(opened.length,beforeFailures+1);
  assert.equal(connectionRequests.length,connections,'通道故障不重连整个 SSH');

  await clickText('结束会话');
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'重置人工打开意图');
  terminalOpenDelay=600;
  const beforeStopped=opened.length;
  interruptTerminals('channel-error');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('正在恢复终端')",'模拟恢复请求在途');
  await clickText('停止恢复');
  await wait(750);
  terminalOpenDelay=0;
  assert.equal(opened.length,beforeStopped,'停止恢复使迟到的打开请求失效');
  assert.ok(await evaluate("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('会话已结束')"));

  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'耗尽测试终端');
  interruptTerminals();
  publishRecovery(false,'exhausted');
  await until("document.querySelector('[data-testid=server-connection-notice]')?.textContent.includes('自动重连未成功')",'重试耗尽停止动画');
  await clickText('重新连接');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('已重新连接')",'直接在工作区重连并恢复终端');
  assert.equal(connectionRequests.length,connections+1,'人工重试只有一个连接动作');

  await clickText('结束会话');
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'事件乱序测试终端');
  const uncertain=terminalSessions.get(opened.at(-1));
  uncertain.status='closed';uncertain.closeReason='channel-closed';uncertain.recoverable=false;
  const beforeUncertain=opened.length;
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('会话已结束')",'未知关闭不立即重开');
  await wait(150);
  assert.equal(opened.length,beforeUncertain);
  uncertain.closeReason='connection-lost';uncertain.recoverable=true;
  publishRecovery(false,'waiting');
  publishRecovery(true);
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('已重新连接')",'迟到断线通知仍能恢复');
  assert.equal(opened.length,beforeUncertain+1);

  await clickText('结束会话');
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'连续失败测试终端');
  const beforeExhaustion=openRequests.length;
  recoveryOpenFailures=10;
  interruptTerminals('channel-error');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden])')?.textContent.includes('终端连续恢复失败')",'终端重试耗尽后停止');
  assert.equal(openRequests.length,beforeExhaustion+3);
  await wait(300);
  assert.equal(openRequests.length,beforeExhaustion+3,'连续失败不无限循环');
  recoveryOpenFailures=0;
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'关闭标签测试终端');
  // 主动断开保持等待，只有用户重新连接才恢复；停止过的其他标签始终保持结束。
  const beforeManualWrites=writes.length;
  for (let cycle=0;cycle<4;cycle++) {
    const beforeManual=opened.length;
    const requestsBefore=connectionRequests.length;
    const source=opened.at(-1);
    await clickText('断开连接');
    await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('等待服务器连接')",'主动断开后终端等待连接');
    await wait(150);
    assert.equal(opened.length,beforeManual,'断开期间不创建终端');
    assert.equal(connectionRequests.length,requestsBefore+1,'断开期间不自动重连服务器');
    await clickText('重新连接');
    await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('已重新连接')",'重新连接后恢复原终端');
    assert.equal(opened.length,beforeManual+1,'仅恢复活动标签，多次手动重连不会耗尽恢复次数');
    assert.equal(openRequests.at(-1).recoveryOf,source);
    assert.equal(connectionRequests.length,requestsBefore+2,'重新连接仅触发用户指定的一个连接动作');
    assert.ok(await evaluate("document.querySelector('.server-terminal-tab-panel[hidden] [role=status]')?.textContent.includes('会话已结束')"),'停止过的标签不会复活');
  }
  assert.equal(writes.length,beforeManualWrites,'主动重连不重放历史输入');
  await clickText('断开连接');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden])')?.textContent.includes('停止恢复')",'断开期间可以停止恢复');
  await clickText('停止恢复');
  const beforeManualStop=opened.length;
  await clickText('重新连接');
  await until("!document.querySelector('[data-testid=server-connection-notice]')",'停止恢复后服务器仍可连接');
  await wait(200);
  assert.equal(opened.length,beforeManualStop,'断开期间停止恢复后不再打开终端');
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'手动打开后允许再次恢复');
  await clickText('结束会话');
  const beforeEnded=opened.length;
  await clickText('断开连接');
  await until("document.querySelector('[data-testid=server-connection-notice]')?.textContent.includes('服务器已断开')",'结束后断开服务器');
  await clickText('重新连接');
  await until("!document.querySelector('[data-testid=server-connection-notice]')",'结束后重新连接服务器');
  await wait(200);
  assert.equal(opened.length,beforeEnded,'单独结束的终端不会因手动重连而复活');
  await clickText('打开终端');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent==='人工会话'",'恢复关闭标签测试终端');
  terminalOpenDelay=600;
  const beforeClosed=opened.length;
  interruptTerminals('channel-error');
  await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) [role=status]')?.textContent.includes('正在恢复终端')",'关闭恢复中的标签');
  await click('[aria-label="关闭终端 1"]');
  await wait(750);
  terminalOpenDelay=0;
  assert.equal(opened.length,beforeClosed,'关闭标签后迟到恢复不会创建新会话');
  assert.equal(await evaluate("document.querySelectorAll('.server-terminal-tab-panel').length"),1);

}

async function testWorkspaceConveniences() {
  const panel=".server-terminal-tab-panel:not([hidden])";
  const searchInput=panel+" [aria-label='搜索终端内容']";
  const searchCount=panel+" .server-terminal-search-count";
  const setInput=async (selector,value) => {
    await evaluate("(() => { const input=document.querySelector("+JSON.stringify(selector)+"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+JSON.stringify(value)+"); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  };
  const expectCount=async count=>until("document.querySelector("+JSON.stringify(searchCount)+")?.textContent.endsWith("+JSON.stringify(' / '+count)+")",'搜索匹配数量 '+count);
  const openSearch=async (selector=panel+" .xterm-helper-textarea") => {
    await evaluate("document.querySelector("+JSON.stringify(selector)+").focus()");
    win.webContents.focus();
    const modifiers=process.platform==='darwin'?['meta']:['control'];
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'F',modifiers});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'F',modifiers});
    await until("document.activeElement?.getAttribute('aria-label')==='搜索终端内容' && document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length",'标准快捷键聚焦搜索并选中关键词');
  };
  const activeText=panel+" [role=status]";
  if(await evaluate("document.querySelector("+JSON.stringify(activeText)+")?.textContent.includes('会话已结束')")) {
    await clickText('打开终端');
    await until("document.querySelector("+JSON.stringify(activeText)+")?.textContent==='人工会话'",'搜索测试终端就绪');
  }
  const initialOpens=opened.length;
  const sessionId=opened.at(-1);
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\r\nsearch-example Alpha alpha\r\n中文查找 中文查找\r\n'+'wrapped'+('x'.repeat(160))+'end\r\n'));
  await until("document.querySelector("+JSON.stringify(panel+" .xterm-rows")+")?.textContent.includes('中文查找')",'搜索中文输出');
  assert.equal(await evaluate("document.querySelector('[aria-label=搜索终端]')"),null,'工具栏不再显示搜索入口');
  const beforeSearchWrites=writes.length;
  await openSearch();
  await setInput(searchInput,'Alpha');
  await expectCount(2);
  await openSearch(searchInput);
  assert.deepEqual(await evaluate("(() => { const input=document.querySelector("+JSON.stringify(searchInput)+"); return {value:input.value,start:input.selectionStart,end:input.selectionEnd}; })()"),{value:'Alpha',start:0,end:5},'重复快捷键选中已有关键词且不修改内容');
  await openSearch(panel+" [aria-label='下一个匹配']");
  assert.equal(await evaluate("document.querySelector("+JSON.stringify(searchInput)+").value"),'Alpha','搜索按钮聚焦时也能返回关键词输入');
  await click('[aria-label="区分大小写"]');
  await expectCount(1);
  await click('[aria-label="区分大小写"]');
  await setInput(searchInput,'中文查找');
  await expectCount(2);
  const firstCount=await evaluate("document.querySelector("+JSON.stringify(searchCount)+").textContent");
  await click('[aria-label="下一个匹配"]');
  assert.notEqual(await evaluate("document.querySelector("+JSON.stringify(searchCount)+").textContent"),firstCount);
  await click('[aria-label="上一个匹配"]');
  assert.equal(await evaluate("document.querySelector("+JSON.stringify(searchCount)+").textContent"),firstCount);
  await until("document.querySelectorAll("+JSON.stringify(panel+" .xterm-find-result-decoration")+").length>0",'中文匹配高亮');
  await snapshot('workspace-terminal-search-dark.png');
  await setInput(searchInput,'wrapped'+('x'.repeat(160))+'end');
  await expectCount(1);
  await setInput(searchInput,'not-present-fixture');
  await until("document.querySelector("+JSON.stringify(searchCount)+")?.textContent==='无匹配'",'无结果提示');
  await setInput(searchInput,'中文查找');
  await expectCount(2);
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\r\n中文查找\r\n'));
  await expectCount(3);
  terminalSessions.get(sessionId).chunks.push(Buffer.from('\r\n'+('cap-probe '.repeat(1100))+'\r\n'));
  await setInput(searchInput,'cap-probe');
  await until("document.querySelector("+JSON.stringify(searchCount)+")?.textContent.includes('1000+')",'大量匹配明确显示计数上限');
  await setInput(searchInput,'中文查找');
  await expectCount(3);
  assert.equal(writes.length,beforeSearchWrites,'搜索操作不发送远端命令');
  assert.equal(opened.length,initialOpens,'搜索不重建终端');

  await click('[aria-label="新增终端"]');
  await until("document.querySelector("+JSON.stringify(activeText)+")?.textContent==='人工会话'",'搜索隔离测试新标签');
  assert.equal(await evaluate("document.querySelector("+JSON.stringify(searchInput)+")"),null,'新标签没有继承搜索界面');
  await openSearch();
  await setInput(searchInput,'中文查找');
  await until("document.querySelector("+JSON.stringify(searchCount)+")?.textContent==='无匹配'",'搜索仅限当前标签');
  const latestClose=await evaluate("document.querySelector('.server-tab-item[data-active=true] .server-tab-close').getAttribute('aria-label')");
  await click('[aria-label="'+latestClose+'"]');
  await expectCount(3);
  await evaluate("document.querySelector("+JSON.stringify(searchInput)+").dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await until("!document.querySelector("+JSON.stringify(searchInput)+")",'Esc 关闭搜索');
  assert.ok(await evaluate("document.activeElement?.classList.contains('xterm-helper-textarea')"),'退出搜索返回终端输入');
  if(process.platform==='darwin') {
    const beforeControlF=writes.length;
    await key('f',70,true);
    assert.equal(writes.length,beforeControlF+1,'Mac 保留 Control+F 行编辑');
    assert.equal(writes.at(-1).data,'\u0006');
  }
  const beforeReopenWrites=writes.length;
  await openSearch();
  assert.equal(writes.length,beforeReopenWrites,'重新打开搜索不发送 Shell 控制字符');
  await click('[aria-label="关闭终端搜索"]');

  await click('[aria-label="编辑目录路径"]');
  await setInput('[aria-label="目录路径"]','/srv');
  await clickText('转到');
  await until("document.querySelector('.server-file-current-path')?.textContent==='/srv'",'收藏当前目录');
  await click('[aria-label="常用目录"]');
  await clickText('收藏当前目录');
  await until("document.querySelector('[aria-label=\"打开收藏目录 /srv\"]')",'收藏保存到列表');
  const bookmarkKey='runbook-bridge:directory-bookmarks:v1:'+JSON.stringify([scope.projectId,scope.environmentId,scope.pluginInstanceId]);
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(bookmarkKey)+'))'),['/srv']);
  await snapshot('workspace-directory-bookmarks-dark.png');
  await click('[aria-label="常用目录"]');
  await click('[aria-label="根目录"]');
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 /srv"]');
  await until("document.querySelector('.server-file-current-path')?.textContent==='/srv'",'点击收藏更新当前目录');
  await until("document.querySelector('[role=treeitem][title=\"/srv\"][aria-selected=true][aria-expanded=true]')",'收藏展开并高亮目录节点');
  await until("document.querySelector('[role=treeitem][title=\"/srv/config\"]')",'收藏目录显示子项');
  assert.equal(await evaluate("document.querySelector('[role=treeitem][title=\"/srv\"]').getAttribute('aria-level')"),'1','收藏仍位于根目录层级');
  assert.ok(await evaluate("document.querySelector('[role=treeitem][title=\"/usr\"]') !== null"),'收藏保留同级目录');
  const otherKey='runbook-bridge:directory-bookmarks:v1:'+JSON.stringify([scope.projectId,'other-environment',scope.pluginInstanceId]);
  await evaluate('localStorage.setItem('+JSON.stringify(otherKey)+',JSON.stringify(["/other-environment-only"])); window.dispatchEvent(new StorageEvent("storage",{key:'+JSON.stringify(otherKey)+'}))');
  await click('[aria-label="常用目录"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"打开收藏目录 /other-environment-only\"]')"),null,'其他环境收藏不可见');

  const spacedPath='/srv/带空格目录 ';
  await evaluate('localStorage.setItem('+JSON.stringify(bookmarkKey)+',JSON.stringify(["/srv",'+JSON.stringify(spacedPath)+'])); window.dispatchEvent(new StorageEvent("storage",{key:'+JSON.stringify(bookmarkKey)+'}))');
  await click('[aria-label="打开收藏目录 '+spacedPath+'"]');
  await until("document.querySelector('.server-file-current-path')?.textContent==="+JSON.stringify(spacedPath),'收藏跳转保留目录名末尾空格');
  await until("document.querySelector('[role=treeitem][aria-selected=true]')?.getAttribute('title')==="+JSON.stringify(spacedPath),"带空格收藏仍能定位到真实节点");
  await until("document.querySelector('[role=treeitem][title="+JSON.stringify(spacedPath+"/config")+"]')","带空格收藏展开内容");
  await click('[aria-label="常用目录"]');
  await click('[aria-label="移除收藏 '+spacedPath+'"]');
  await click('[aria-label="打开收藏目录 /srv"]');
  await click('[aria-label="常用目录"]');

  await click('[aria-label="常用目录"]');
  const nestedBookmark="/srv/config/config";
  const missingBookmark="/srv/已移除的目录";
  const saveBookmarks=async paths => evaluate("localStorage.setItem("+JSON.stringify(bookmarkKey)+","+JSON.stringify(JSON.stringify(paths))+"); window.dispatchEvent(new StorageEvent('storage',{key:"+JSON.stringify(bookmarkKey)+"}))");
  await saveBookmarks(["/srv",nestedBookmark,missingBookmark,"/bin/X11"]);
  await click('[role=treeitem][title="/home"]');
  await until("document.querySelector('[role=treeitem][title=\"/home/config\"]')",'收藏跳转前展开另一分支');
  await click('[aria-label="编辑目录路径"]');
  await setInput('[aria-label="目录路径"]',"/etc");
  await clickText('转到');
  await until("document.querySelector('[role=treeitem][title=\"/etc/config\"]')",'切换到另一个浏览起点');
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 '+nestedBookmark+'"]');
  await until("document.querySelector('[role=treeitem][title=\"/srv/config/config/config\"]')",'跨浏览起点展开深层收藏');
  for(const [target,level] of [["/srv","1"],["/srv/config","2"],[nestedBookmark,"3"]]) {
    assert.deepEqual(await evaluate("(() => { const row=document.querySelector('[role=treeitem][title="+JSON.stringify(target)+"]'); return row && {level:row.getAttribute('aria-level'),expanded:row.getAttribute('aria-expanded')}; })()"),{level,expanded:"true"},'保留收藏完整祖先链 '+target);
  }
  await until("document.activeElement?.getAttribute('title')==="+JSON.stringify(nestedBookmark),'收藏定位后获得键盘焦点');
  await snapshot('workspace-bookmark-ancestors.png');
  const formattedBookmark="/srv//config/../config/config/";
  await saveBookmarks(["/srv",nestedBookmark,missingBookmark,"/bin/X11",formattedBookmark]);
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 '+formattedBookmark+'"]');
  await until("document.activeElement?.getAttribute('title')==="+JSON.stringify(nestedBookmark),'带分隔符和相对段的收藏定位到规范路径');
  const beforeBookmarkRepeat=directoryReads.length;
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 '+nestedBookmark+'"]');
  await until("document.activeElement?.getAttribute('title')==="+JSON.stringify(nestedBookmark),'重复收藏定位完成');
  assert.equal(directoryReads.length,beforeBookmarkRepeat,'重复收藏定位复用缓存');
  await evaluate("document.querySelector('.server-tree-scroll').scrollTop=0; document.querySelector('.server-tree-scroll').dispatchEvent(new Event('scroll'))");
  await until("document.querySelector('[role=treeitem][title=\"/home/config\"]')",'收藏跳转保留原有展开分支');
  const beforeMissingBookmark=directoryReads.length;
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 '+missingBookmark+'"]');
  await until("document.querySelector('.server-file-tree').textContent.includes('未找到该项')",'失效收藏显示提示');
  assert.ok(!directoryReads.slice(beforeMissingBookmark).some(item=>item.path===missingBookmark),'失效收藏不读取不存在的目标');
  const beforeCycleBookmark=directoryReads.length;
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 /bin/X11"]');
  await until("document.querySelector('.server-file-tree').textContent.includes('循环链接，无法打开收藏目录')",'收藏循环链接停止展开');
  assert.ok(!directoryReads.slice(beforeCycleBookmark).some(item=>["/bin/X11","/usr/bin/X11"].includes(item.path)),'收藏循环链接不发起目录读取');
  await saveBookmarks(["/srv"]);
  await click('[aria-label="常用目录"]');
  await click('[aria-label="打开收藏目录 /srv"]');
  await until("document.querySelector('[role=treeitem][title=\"/srv\"][aria-selected=true]')",'错误后可再次定位有效收藏');
  await click('[aria-label="常用目录"]');

  for(const theme of ['light','dark']) {
    nativeTheme.themeSource=theme;
    await evaluate("localStorage.setItem('runbook-bridge:theme-preference:v1',"+JSON.stringify(theme)+"); window.dispatchEvent(new StorageEvent('storage',{key:'runbook-bridge:theme-preference:v1'}))");
    await setViewport(860,620);
    const fits=await evaluate("(() => { const pop=document.querySelector('.server-directory-bookmarks').getBoundingClientRect(); const toolbar=document.querySelector('.server-file-toolbar'); return pop.left>=0 && pop.right<=innerWidth && toolbar.scrollWidth<=toolbar.clientWidth; })()");
    assert.ok(fits,'窄窗口收藏面板和工具栏没有越界 '+theme);
    const contrast=await evaluate("(() => { const pop=document.querySelector('.server-directory-bookmarks'); const item=pop.querySelector('.server-bookmark-link'); const canvas=document.createElement('canvas'); canvas.width=1; canvas.height=1; const context=canvas.getContext('2d'); const lum=color=>{ context.fillStyle=color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].slice(0,3).map(n=>{n/=255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;}).reduce((s,n,i)=>s+n*[0.2126,0.7152,0.0722][i],0); }; const a=lum(getComputedStyle(item).color),b=lum(getComputedStyle(pop).backgroundColor); return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05); })()");
    assert.ok(contrast>=4.5,'收藏路径文字对比度满足可读性要求 '+theme+' '+contrast);

    await snapshot('workspace-bookmarks-compact-'+theme+'.png');
  }
  await click('[aria-label="常用目录"]');
  await openSearch();
  await setInput(searchInput,'中文查找');
  await expectCount(3);
  assert.ok(await evaluate("(() => { const bar=document.querySelector("+JSON.stringify(panel+" .server-terminal-search")+"); return bar.scrollWidth<=bar.clientWidth; })()"),'窄窗口搜索栏不溢出');
  await snapshot('workspace-search-compact.png');
  await click('[aria-label="关闭终端搜索"]');

  // 断线时保留历史搜索和目录收藏，但收藏不会主动发起连接。
  await clickText('断开连接');
  await until("document.querySelector('[data-testid=server-connection-notice]')",'断线保留收藏');
  await click('[aria-label="常用目录"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"打开收藏目录 /srv\"]').disabled"),true);
  await click('[aria-label="常用目录"]');
  await openSearch();
  await setInput(searchInput,'中文查找');
  await expectCount(3);
  await click('[aria-label="关闭终端搜索"]');
  await clickText('重新连接');
  await until("document.querySelector("+JSON.stringify(activeText)+")?.textContent.includes('已重新连接')",'重连兼容搜索扩展');
  await openSearch();
  await setInput(searchInput,'中文查找');
  await expectCount(3);
  await click('[aria-label="关闭终端搜索"]');

  // 重新加载整个 Renderer，验证收藏持久化并且搜索内容没有落盘。
  await win.loadFile(path.join(root,'renderer-build/v2/index.html'));
  await until("document.querySelector('[data-project-id="+scope.projectId+"]')",'收藏重载项目');
  await click('[data-project-id="'+scope.projectId+'"]');
  await click('[data-testid="environment-trigger-'+scope.environmentId+'"]');
  await click('[data-testid="plugin-trigger-'+scope.pluginInstanceId+'"]');
  await click('[data-testid="plugin-open-workspace"]');
  await until("document.querySelector('.xterm-rows')?.textContent.includes('operator@demo')",'收藏重载终端');
  await click('[aria-label="常用目录"]');
  await until("document.querySelector('[aria-label=\"打开收藏目录 /srv\"]')",'重载保留收藏');
  await click('[aria-label="移除收藏 /srv"]');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(bookmarkKey)+'))'),[]);
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(otherKey)+'))'),['/other-environment-only']);
  await click('[aria-label="常用目录"]');
  await openSearch();
  assert.equal(await evaluate("document.querySelector("+JSON.stringify(searchInput)+").value"),'','搜索关键词不持久化');
  await evaluate("document.querySelector("+JSON.stringify(panel+" [aria-label='关闭终端搜索']")+").focus()");
  win.webContents.focus();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until("!document.querySelector("+JSON.stringify(searchInput)+")",'关闭搜索支持键盘 Enter 操作');
  assert.deepEqual(errors,[],'搜索和收藏没有 Renderer 错误');
  assert.deepEqual(externalRequests,[],'搜索和收藏不连接外部服务');
}

run().catch((error) => { process.stderr.write(error.stack + '\n'); }).finally(() => { if (savedClipboard) clipboard.write(savedClipboard); workspaceFiles?.dispose(); win?.destroy(); app.exit(completed ? 0 : 1); });
