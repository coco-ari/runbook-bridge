import { loadProbeRuntime } from './server-probe-runtime.mjs';
import { installProbeConnectionObserver } from './server-probe-connection-observer.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
const { ServerPluginRuntime } = await loadProbeRuntime('server-plugin-runtime.mjs');
const { ServerOperations } = await loadProbeRuntime('server-operations.mjs');
const { ServerWorkspaceFiles } = await loadProbeRuntime('server-workspace-files.mjs');

// 变更严格限于本次创建的随机目录；文件变更经过产品预检与一次性确认，不使用 Shell 变更或递归删除。
const host = process.env.RUNBOOK_LIVE_HOST;
const username = process.env.RUNBOOK_LIVE_USER;
const password = process.env.RUNBOOK_LIVE_PASSWORD;
delete process.env.RUNBOOK_LIVE_PASSWORD;
if (net.isIP(host ?? '') !== 4 || !username || !password || process.env.RUNBOOK_LIVE_MUTATIONS !== 'new-resources-only') {
  throw new Error('实测需要显式 IPv4、进程凭据和 new-resources-only 授权。');
}
const scope = { projectId: 'owned-file-probe', environmentId: 'isolated', pluginInstanceId: 'probe-server' };
const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '新建资源实测',
  target: { host, port: 22 }, auth: { type: 'password', username }, uplink: { type: 'direct' },
  limits: { timeoutMs: 10_000, maxBytes: 65536 }, sources: [], actions: [] };
const audits = [];
const store = {
  getPlugin: async (...keys) => { assert.deepEqual(keys, Object.values(scope)); return plugin; },
  updatePlugin: async (_project, _environment, _id, patch) => { Object.assign(plugin, patch); return plugin; },
  appendAudit: async (_project, event) => { audits.push(event); },
  readRunbook: async () => ({ content: '', hash: '0'.repeat(64) }),
};
const runtime = new ServerPluginRuntime(store, { load: async () => null }, {
  resolver: { resolve: async value => { assert.equal(value, host); return [{ address: host, family: 4 }]; } },
});
const stopConnectionObservation = installProbeConnectionObserver(runtime, { enabled:process.argv.includes('--connection-observation') });
const operations = new ServerOperations(runtime, store);
let clockOffset = 0;
const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: operations, now: () => Date.now() + clockOffset });
const owner = 'renderer:owned-file-probe';
const rootName = 'runbookbridge-probe-' + crypto.randomUUID();
const root = '/tmp/' + rootName;
const owned = new Set();
const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-owned-file-probe-'));
const localNames = new Set();
const results = [];
let stoppedCode = null;
const round = value => Math.round(value * 10) / 10;
async function measure(feature, operation) {
  const start = performance.now();
  try {
    const value = await operation();
    results.push({ feature, status: 'passed', ms: round(performance.now() - start) });
    console.log(JSON.stringify(results.at(-1))); return value;
  } catch (error) {
    results.push({ feature, status: 'failed', code: error.code ?? error.name, ms: round(performance.now() - start) });
    console.log(JSON.stringify(results.at(-1))); throw error;
  }
}
function inside(selected) { return selected === root || selected.startsWith(root + '/'); }
function guarded(kind, selected, name) {
  assert.ok(kind === 'mkdir' && selected === '/tmp' && name === rootName || owned.has(selected) && inside(selected));
  if (name !== undefined) assert.ok(typeof name === 'string' && !/[\\/\0\r\n]/u.test(name) && !['.', '..'].includes(name));
  const destination = kind === 'mkdir' ? path.posix.join(selected, name) : kind === 'rename' ? path.posix.join(path.posix.dirname(selected), name) : null;
  if (destination) assert.ok(inside(destination));
  return { ...scope, kind, path: selected, ...(name === undefined ? {} : { name }) };
}
async function action(kind, selected, name) {
  const request = guarded(kind, selected, name);
  const prepared = await files.prepareFileAction(owner, request);
  if (kind !== 'delete') assert.equal(prepared.canonicalDestination, kind === 'mkdir' ? path.posix.join(selected, name) : path.posix.join(path.posix.dirname(selected), name));
  const result = await files.confirmFileAction(owner, { ...scope, operationId: prepared.operationId });
  if (kind === 'delete' || kind === 'rename') owned.delete(selected);
  if (kind === 'mkdir' || kind === 'rename') owned.add(result.destinationPath);
  return { result, operationId: prepared.operationId };
}
async function waitFor(check, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  do { if (await check()) return; await delay(10); } while (performance.now() < deadline);
  throw Object.assign(new Error('实测等待超时'), { code: 'PROBE_DEADLINE' });
}
async function createLocal(name, content) {
  assert.match(name, /^[a-z0-9-]+\.(?:txt|log|conf)$/u);
  localNames.add(name);
  const selected = path.join(localRoot, name);
  await fs.writeFile(selected, content, { flag: 'wx', mode: 0o600 });
  return selected;
}
try {
  await measure('connection.host-key-check', () => assert.rejects(runtime.connect(plugin, { password }), error => {
    if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
    plugin.target.hostKeyFingerprint = error.details.fingerprint; return true;
  }));
  await measure('connection.pinned-login', () => runtime.connect(plugin, { password }));
  const created = await measure('files.create-owned-root', () => action('mkdir', '/tmp', rootName));
  await measure('confirmation.single-use', () => assert.rejects(files.confirmFileAction(owner, { ...scope, operationId: created.operationId }), { code: 'WORKSPACE_ACTION_EXPIRED' }));
  await measure('directory.new-root-empty', async () => {
    const page = await files.listDirectory(owner, { ...scope, path: root, deferLinks: true });
    assert.equal(page.canonicalPath, root); assert.equal(page.entries.length, 0);
  });
  if (process.argv.includes('--search-bounds') || process.argv.includes('--search-log-bounds')) {
    const { runSearchBoundsScenarios } = await import('./server-search-bounds-live-scenarios.mjs');
    await runSearchBoundsScenarios({ runtime, plugin, files, operations, scope, owner, root, owned, localRoot, localNames, action, measure, waitFor, includeTextBoundary:!process.argv.includes('--search-log-bounds') });
  } else if (process.argv.includes('--upload-phases')) {
    const { runUploadPhaseScenarios } = await import('./server-upload-phase-scenarios.mjs');
    await runUploadPhaseScenarios({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames, measure, waitFor });
  } else if (process.argv.includes('--file-state') || process.argv.includes('--file-parents')) {
    const { runFileStateScenarios } = await import('./server-file-state-live-scenarios.mjs');
    await runFileStateScenarios({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames, action, measure, waitFor, parentsOnly:process.argv.includes('--file-parents'), reconnect: () => runtime.connect(plugin, { password }) });
  } else {
  await measure('confirmation.cancel', async () => {
    const pending = await files.prepareFileAction(owner, guarded('mkdir', root, 'cancelled-directory'));
    files.cancelFileAction(owner, { ...scope, operationId: pending.operationId });
    await assert.rejects(files.confirmFileAction(owner, { ...scope, operationId: pending.operationId }), { code: 'WORKSPACE_ACTION_EXPIRED' });
    await assert.rejects(runtime.statRemotePath(plugin, root + '/cancelled-directory'), { code: 'SOURCE_NOT_FOUND' });
  });
  await measure('confirmation.expired', async () => {
    const pending = await files.prepareFileAction(owner, guarded('mkdir', root, 'expired-directory'));
    try {
      clockOffset = 6 * 60 * 1000;
      await assert.rejects(files.confirmFileAction(owner, { ...scope, operationId: pending.operationId }), { code: 'WORKSPACE_ACTION_EXPIRED' });
    } finally { clockOffset = 0; }
    await assert.rejects(runtime.statRemotePath(plugin, root + '/expired-directory'), { code: 'SOURCE_NOT_FOUND' });
  });
  await measure('files.create-owned-child', () => action('mkdir', root, 'empty'));
  const sample = 'runbook probe 中文\n'.repeat(64);
  const selected = await Promise.all([createLocal('preview.txt', sample), createLocal('events.log', 'INFO probe-ready\nWARN probe-delay\nERROR probe-failed\n'), createLocal('settings.conf', 'probe_enabled=true\nprobe_mode=synthetic\n')]);
  const review = await measure('upload.begin-async-review', () => files.beginUploadReview(owner, { ...scope, path: root }, selected));
  let checked;
  await measure('upload.review-ready', async () => {
    await waitFor(async () => {
      checked = await files.readUploadReview(owner, { ...scope, reviewId: review.reviewId });
      if (checked.status === 'error') throw Object.assign(new Error('上传预检失败'), { code: checked.error.code });
      return checked.status === 'ready';
    });
    assert.equal(checked.files.length, selected.length);
    for (const file of checked.files) {
      assert.equal(file.exists, false);
      assert.equal(file.remotePath, path.posix.join(root, file.name));
    }
  });
  let jobs;
  await measure('upload.confirm-and-complete', async () => {
    // 每个目标都已证明不存在且位于本次目录，之后仅这些确切路径进入清理名单。
    for (const file of checked.files) owned.add(file.remotePath);
    jobs = (await files.confirmUpload(owner, { ...scope, preparationId: checked.preparationId, overwrite: false })).jobs;
    await waitFor(() => jobs.every(job => { const state = files.jobs.get(job.jobId); return !state.inFlight && ['completed', 'error', 'cancelled'].includes(state.status); }));
    assert.ok(jobs.every(job => files.jobs.get(job.jobId).status === 'completed'));
  });
  await measure('upload.single-use-confirmation', () => assert.rejects(files.confirmUpload(owner, { ...scope, preparationId: checked.preparationId, overwrite: false }), { code: 'UPLOAD_CONFIRMATION_INVALID' }));
  await measure('files.preview-owned-upload', async () => {
    assert.equal((await files.readFile(owner, { ...scope, path: root + '/preview.txt' })).content, sample);
  });
  await measure('directory.uploaded-entries', async () => {
    const page = await files.listDirectory(owner, { ...scope, path: root, deferLinks: true });
    assert.equal(page.entries.length, 4);
    assert.equal(page.entries.filter(item => item.type === 'directory').length, 1);
  });
  await measure('files.rename-owned-file', () => action('rename', root + '/preview.txt', 'renamed.txt'));
  await measure('files.renamed-content', async () => {
    assert.equal((await files.readFile(owner, { ...scope, path: root + '/renamed.txt' })).content, sample);
    await assert.rejects(files.readFile(owner, { ...scope, path: root + '/preview.txt' }), { code: 'SOURCE_NOT_FOUND' });
  });
  await measure('files.rename-owned-directory', () => action('rename', root + '/empty', 'renamed-empty'));
  await measure('files.reject-nonempty-delete', () => assert.rejects(action('delete', root), { code: 'DIRECTORY_NOT_EMPTY' }));
  await measure('files.delete-owned-file', () => action('delete', root + '/renamed.txt'));
  await measure('files.delete-owned-empty-directory', () => action('delete', root + '/renamed-empty'));
  if (process.argv.includes('--agent-mutations')) {
    const {runAgentMutationScenarios}=await import('./server-agent-mutation-live-scenarios.mjs');
    await runAgentMutationScenarios({runtime,plugin,operations,store,scope,root,owned,localRoot,localNames,action,measure});
  }
  if (process.argv.includes('--reads')) {
    // 只在本次内存配置中登记合成数据源，不读取业务日志或写入工作区配置。
    const previousSources = plugin.sources;
    plugin.sources = [
      { sourceId:'probe-log', displayName:'合成日志', kind:'log', root, patterns:['events.log'], maxFileBytes:1024*1024 },
      { sourceId:'probe-config', displayName:'合成配置', kind:'config', root, patterns:['settings.conf'], maxFileBytes:1024*1024 },
    ];
    try {
      let logFile, configFile;
      await measure('reads.source-lists', async () => {
        const logs = await operations.listFiles(plugin, { sourceId:'probe-log' });
        const configs = await operations.listFiles(plugin, { sourceId:'probe-config' });
        assert.equal(logs.files.length, 1); assert.equal(configs.files.length, 1);
        [logFile] = logs.files; [configFile] = configs.files;
        assert.equal(logFile.name, 'events.log'); assert.equal(configFile.name, 'settings.conf');
      });
      await measure('reads.config-pagination', async () => {
        let cursor, content = '', pages = 0;
        do {
          const page = await operations.readConfig(plugin, { fileId:configFile.fileId, maxBytes:16, ...(cursor ? {cursor} : {}) });
          content += page.content; cursor = page.nextCursor;
          assert.ok(++pages <= 8);
        } while (cursor);
        assert.equal(content, 'probe_enabled=true\nprobe_mode=synthetic\n');
      });
      await measure('reads.log-pagination', async () => {
        let cursor = null, content = '', pages = 0;
        do {
          const page = await operations.readLog(plugin, { fileId:logFile.fileId, maxBytes:18, cursor, tail:false });
          content += page.content; cursor = page.nextCursor;
          assert.ok(++pages <= 8);
        } while (cursor);
        assert.equal(content, 'INFO probe-ready\nWARN probe-delay\nERROR probe-failed\n');
      });
      await measure('reads.source-and-scope-rejection', async () => {
        await assert.rejects(operations.readConfig(plugin, { fileId:logFile.fileId }), { code:'SOURCE_NOT_ALLOWED' });
        await assert.rejects(operations.readLog(plugin, { fileId:configFile.fileId }), { code:'SOURCE_NOT_ALLOWED' });
        await assert.rejects(operations.readLog({ ...plugin, pluginInstanceId:'other-plugin' }, { fileId:logFile.fileId }), { code:'SOURCE_NOT_ALLOWED' });
      });
      await measure('reads.file-properties-and-discovery', async () => {
        const info = await files.fileInfo(owner, { ...scope, path:root+'/settings.conf' });
        assert.equal(info.type, 'file');
        const found = await operations.findFiles(plugin, { path:root, pattern:'*.conf', maxDepth:0, maxResults:5 });
        assert.deepEqual(found.files.map(file => file.path), [root+'/settings.conf']);
      });
      await measure('reads.config-content-search', async () => {
        const result = await operations.searchFiles(plugin, { path:root, pattern:'*.conf', contains:'probe_', maxDepth:0, maxFiles:5, maxMatches:5 });
        assert.equal(result.matchCount, 2); assert.equal(result.truncated, false);
        assert.ok(result.matches.every(match => match.path === root+'/settings.conf'));
      });
      const query = { path:root+'/events.log', queries:['probe-ready','probe-failed'], maxMatches:1, maxScanBytes:65536, maxExpandedBytes:65536 };
      await measure('logs.multiple-queries-and-cursor', async () => {
        const first = await operations.searchLogs(plugin, query);
        assert.equal(first.matchCount, 1); assert.ok(first.nextCursor);
        await assert.rejects(operations.searchLogs(plugin, { ...query, queries:['changed-query'], cursor:first.nextCursor }), { code:'LOG_CURSOR_MISMATCH' });
        const second = await operations.searchLogs(plugin, { ...query, cursor:first.nextCursor });
        assert.equal(second.matchCount, 1); assert.equal(second.nextCursor, null);
        assert.equal(second.status, 'complete');
        assert.deepEqual([...first.matches, ...second.matches].map(match => match.text).sort(), ['ERROR probe-failed','INFO probe-ready']);
      });
      await measure('logs.case-insensitive-all-match', async () => {
        const result = await operations.searchLogs(plugin, { path:root+'/events.log', queries:['error','PROBE-FAILED'], matchMode:'all', caseSensitive:false, maxScanBytes:65536, maxExpandedBytes:65536 });
        assert.equal(result.matchCount, 1); assert.equal(result.conclusion, 'matches');
      });
      await measure('logs.no-match-complete', async () => {
        const result = await operations.searchLogs(plugin, { path:root, pattern:'events.log', queries:['absent-probe-marker'], maxDepth:0, maxFiles:5, maxScanBytes:65536, maxExpandedBytes:65536 });
        assert.equal(result.matchCount, 0); assert.equal(result.conclusion, 'no_match'); assert.equal(result.status, 'complete');
      });
    } finally { plugin.sources = previousSources; }
  }
  if (process.argv.includes('--mcp') || process.argv.includes('--mcp-packaged')) {
    const { runMcpScenarios } = await import('./server-mcp-live-scenarios.mjs');
    await runMcpScenarios({ runtime, plugin, store, scope, root, owned, localRoot, localNames, measure, forbiddenValues: [password], packaged: process.argv.includes('--mcp-packaged') });
  }
  if (process.argv.includes('--archives')) {
    const { runArchiveScenarios } = await import('./server-archive-live-scenarios.mjs');
    await runArchiveScenarios({ plugin, files, operations, scope, owner, root, owned, localRoot, localNames, measure, waitFor });
  }
  if (process.argv.includes('--services')) {
    const { runServiceControlScenarios } = await import('./server-service-live-scenarios.mjs');
    await runServiceControlScenarios({ runtime, plugin, operations, store, scope, root, owned, measure, waitFor, reconnect: () => runtime.connect(plugin, { password }) });
  }
  if (process.argv.includes('--transfers')) {
    const { runUploadScenarios } = await import('./server-upload-live-scenarios.mjs');
    await runUploadScenarios({ runtime, plugin, files, operations, scope, owner, root, owned, localRoot, localNames, measure, waitFor, reconnect: () => runtime.connect(plugin, { password }) });
  }
  }
  await measure(process.argv.includes('--file-parents') ? 'audit.file-events' : 'audit.file-and-upload-events', async () => {
    assert.ok(audits.some(event => event.type === 'desktop-file-action' && event.result === 'completed'));
    if (!process.argv.includes('--file-parents')) assert.ok(audits.some(event => event.type === 'desktop-upload' && event.result === 'success'));
  });
} catch (error) {
  stoppedCode = error.code ?? error.name;
  console.log(JSON.stringify({ status: 'stopped', code: stoppedCode })); process.exitCode = 1;
} finally {
  clockOffset = 0;
  for (const job of files.jobs.values()) if (job.inFlight || job.status === 'queued') files.cancelUpload(owner, { ...scope, jobId: job.jobId });
  let uploadsSettled = false;
  const uploadsEnded = () => files.running === 0 && [...files.jobs.values()].every(job => !job.inFlight);
  try { await waitFor(uploadsEnded, 30_000); uploadsSettled = true; }
  catch {
    process.exitCode = 1;
    // 先终止本探针在途连接，确认上传真实收尾后才能清理，避免迟到提交重新创建文件。
    await runtime.closeAll();
    try { await waitFor(uploadsEnded, 30_000); uploadsSettled = true; } catch {}
  }
  if (owned.size && !uploadsSettled) console.log(JSON.stringify({ status:'cleanup-required', testDirectory:root, code:'UPLOAD_SETTLEMENT_TIMEOUT' }));
  if (owned.size && uploadsSettled) {
    try {
      if (!runtime.status(plugin).connected) await measure('cleanup.reconnect', () => runtime.connect(plugin, { password }));
      await measure('cleanup.exact-owned-paths', async () => {
        assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
        for (const selected of [...owned].sort((a, b) => b.length - a.length)) {
          assert.ok(inside(selected));
          try { await action('delete', selected); }
          catch (error) { if (error.code !== 'SOURCE_NOT_FOUND') throw error; owned.delete(selected); }
        }
        await assert.rejects(runtime.statRemotePath(plugin, root), { code: 'SOURCE_NOT_FOUND' });
      });
    } catch {
      console.log(JSON.stringify({ status: 'cleanup-required', testDirectory: root }));
      process.exitCode = 1;
    }
  }
  files.dispose(); operations.docker.dispose();
  try { await runtime.closeAll(); } finally { stopConnectionObservation(); }
  try {
    const actual = await fs.realpath(localRoot);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(actual), /^runbook-owned-file-probe-[a-zA-Z0-9]+$/u);
    for (const name of await fs.readdir(actual)) {
      assert.ok(localNames.has(name)); const selected = path.join(actual, name);
      assert.equal((await fs.lstat(selected)).isFile(), true); await fs.unlink(selected);
    }
    await fs.rmdir(actual);
  } catch { console.log(JSON.stringify({ status: 'local-cleanup-required' })); process.exitCode = 1; }
  console.log(JSON.stringify({ status: process.exitCode ? 'failed' : 'finished', ...(stoppedCode ? { fatalCode:stoppedCode } : {}), passed: results.filter(item => item.status === 'passed').length,
    failed: results.filter(item => item.status === 'failed').length, auditEvents: audits.length }));
}
