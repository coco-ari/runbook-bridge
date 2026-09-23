import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';

// 只读远端文件与临时 PTY：不调用上传、文件变更或服务控制，不接受自由命令参数。
const host = process.env.RUNBOOK_LIVE_HOST;
const username = process.env.RUNBOOK_LIVE_USER;
const password = process.env.RUNBOOK_LIVE_PASSWORD;
delete process.env.RUNBOOK_LIVE_PASSWORD;
if (net.isIP(host ?? '') !== 4 || !username || !password) throw new Error('交互探针需要显式 IPv4 目标和进程内凭据。');
const scope = { projectId: 'interaction-probe', environmentId: 'isolated', pluginInstanceId: 'probe-server' };
const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '交互测速',
  target: { host, port: 22 }, auth: { type: 'password', username }, uplink: { type: 'direct' },
  limits: { timeoutMs: 10_000, maxBytes: 65536 }, sources: [], actions: [] };
let auditEvents = 0;
const store = {
  getPlugin: async (...keys) => { assert.deepEqual(keys, Object.values(scope)); return plugin; },
  updatePlugin: async (_project, _environment, _id, patch) => { Object.assign(plugin, patch); return plugin; },
  appendAudit: async () => { auditEvents += 1; },
  readRunbook: async () => ({ content: '', hash: '0'.repeat(64) }),
};
const runtime = new ServerPluginRuntime(store, { load: async () => null }, {
  resolver: { resolve: async value => { assert.equal(value, host); return [{ address: host, family: 4 }]; } },
});
const operations = new ServerOperations(runtime, store);
const services = { workspaceStore: store, serverRuntime: runtime, serverOperations: operations };
const files = new ServerWorkspaceFiles(services);
const manager = new ServerWorkspaceManager(services);
const owner = 'renderer:interaction-probe';
const results = [];
let terminalPhases = [];
const round = value => Math.round(value * 10) / 10;
const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-interaction-probe-'));
const localNames = new Set();
async function measure(feature, operation) {
  const start = performance.now();
  terminalPhases = [];
  try {
    const value = await operation();
    results.push({ feature, status: 'passed', ms: round(performance.now() - start), ...(terminalPhases.length ? { phases: terminalPhases } : {}) });
    console.log(JSON.stringify(results.at(-1)));
    return value;
  } catch (error) {
    results.push({ feature, status: 'failed', code: error.code ?? error.name, ms: round(performance.now() - start) });
    console.log(JSON.stringify(results.at(-1)));
    throw error;
  }
}
function localFile(name) {
  assert.match(name, /^[a-z0-9-]+\.(?:bin|txt)$/u);
  localNames.add(name);
  return path.join(localRoot, name);
}
async function waitFor(check, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  do { if (await check()) return; await delay(5); } while (performance.now() < deadline);
  throw Object.assign(new Error('探针等待超时'), { code: 'PROBE_DEADLINE' });
}
function payload(session) { return { ...scope, sessionId: session.sessionId }; }
async function readUntil(session, matches, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  let content = '';
  const decoder = new TextDecoder('utf8');
  do {
    const result = await manager.readTerminal(owner, payload(session));
    content += decoder.decode(result.data, { stream: true });
    assert.ok(content.length <= 256 * 1024, '终端探针输出必须有界');
    if (matches(content, result)) return { content, ...result };
    if (result.status === 'closed') throw Object.assign(new Error('探针终端提前退出'), { code: 'PROBE_TERMINAL_CLOSED' });
  } while (performance.now() < deadline);
  throw Object.assign(new Error('探针终端等待超时'), { code: 'PROBE_DEADLINE' });
}
async function drainTerminal(session) {
  return readUntil(session, (_content, result) => !result.data.length);
}
async function marker(session) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const token = 'probe-' + suffix;
  await manager.writeTerminal(owner, { ...payload(session), data: "printf '%s%s\\n' 'probe-' '" + suffix + "'\r" });
  await readUntil(session, content => content.includes(token));
  return token;
}
function isolatedShell() {
  const client = runtime.broker.requireSession(runtime.key(plugin)).client;
  const originalExec = client.exec.bind(client);
  client.exec = (command, options, callback) => {
    const start = performance.now();
    const phases = terminalPhases;
    const label = command.startsWith('env HISTFILE=') ? 'pty' : command.startsWith('command readlink') ? 'working-directory' : 'shell-probe';
    return originalExec(command, options, (error, channel) => {
      phases.push({ step: label + '.opened', ms: round(performance.now() - start) });
      channel?.once('data', () => phases.push({ step: label + '.first-data', ms: round(performance.now() - start) }));
      callback(error, channel);
    });
  };
  // 仅探针替换新 PTY 的启动方式，不加载交互配置、不读写已有历史；生产终端入口保持原样。
  client.shell = (window, callback) => client.exec('env HISTFILE= HISTSIZE=0 HISTFILESIZE=0 /bin/bash --noprofile --norc -i', { pty: window }, callback);
}
async function waitJob(job, expectedStatus = 'completed') {
  await waitFor(() => !files.jobs.get(job.jobId)?.inFlight && ['completed', 'cancelled', 'error'].includes(files.jobs.get(job.jobId)?.status), 10_000);
  assert.equal(files.jobs.get(job.jobId).status, expectedStatus);
}
async function startDownload(prepared, name) {
  return files.downloads.start(owner, scope, prepared, localFile(name));
}
try {
  await measure('connection.host-key-check', () => assert.rejects(runtime.connect(plugin, { password }), error => {
    if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
    plugin.target.hostKeyFingerprint = error.details.fingerprint;
    return true;
  }));
  await measure('connection.pinned-login', () => runtime.connect(plugin, { password }));
  isolatedShell();
  let terminal = await measure('terminal.isolated-open', () => manager.openTerminal(owner, { ...scope, tabId: 'first', cols: 100, rows: 30 }));
  await drainTerminal(terminal);
  for (let index = 0; index < 5; index += 1) {
    await measure('terminal.input-echo.' + index, async () => {
      const text = 'echo' + crypto.randomBytes(4).toString('hex');
      await manager.writeTerminal(owner, { ...payload(terminal), data: text });
      await readUntil(terminal, content => content.includes(text));
    });
    await manager.writeTerminal(owner, { ...payload(terminal), data: '\x15' });
    await drainTerminal(terminal);
    await measure('terminal.command-roundtrip.' + index, () => marker(terminal));
  }
  await measure('terminal.resize', async () => {
    await manager.resizeTerminal(owner, { ...payload(terminal), rows: 41, cols: 101 });
    await manager.writeTerminal(owner, { ...payload(terminal), data: 'stty size\r' });
    await readUntil(terminal, content => content.includes('41 101'));
  });
  await measure('terminal.working-directory', async () => {
    await manager.writeTerminal(owner, { ...payload(terminal), data: 'cd /usr/bin\r' });
    await marker(terminal);
    assert.equal((await manager.terminalWorkingDirectory(owner, payload(terminal))).path, '/usr/bin');
  });
  await measure('terminal.utf8-bracketed-paste', async () => {
    const suffix = crypto.randomBytes(8).toString('hex');
    const token = '中文探针-' + suffix;
    const command = "printf '%s%s\\n' '中文探针-' '" + suffix + "'";
    await manager.writeTerminal(owner, { ...payload(terminal), data: '\x1b[200~' + command + '\x1b[201~\r' });
    await readUntil(terminal, content => content.includes(token));
  });
  await measure('terminal.directory-with-pending-input', async () => {
    await manager.writeTerminal(owner, { ...payload(terminal), data: 'not-executed-probe' });
    await readUntil(terminal, content => content.includes('not-executed-probe'));
    assert.equal((await manager.terminalWorkingDirectory(owner, payload(terminal))).path, '/usr/bin');
    await manager.writeTerminal(owner, { ...payload(terminal), data: '\x15' });
    await drainTerminal(terminal);
  });
  const second = await measure('terminal.second-tab', () => manager.openTerminal(owner, { ...scope, tabId: 'second' }));
  await drainTerminal(second);
  await measure('terminal.tab-isolation', async () => {
    const secondToken = await marker(second);
    assert.equal((await drainTerminal(terminal)).content.includes(secondToken), false);
    const firstToken = await marker(terminal);
    assert.equal((await drainTerminal(second)).content.includes(firstToken), false);
  });
  await measure('terminal.remote-exit', async () => {
    await manager.writeTerminal(owner, { ...payload(second), data: 'exit 0\r' });
    const end = await readUntil(second, (_content, result) => result.status === 'closed');
    assert.equal(end.exitCode, 0); assert.equal(end.recoverable, false);
    await marker(terminal);
  });
  const smallPath = (await files.resolvePath(plugin, '/etc/os-release', 'file')).canonicalPath;
  assert.ok(['/etc/os-release', '/usr/lib/os-release'].includes(smallPath));
  const small = await measure('download.prepare-small', () => files.downloads.prepare(owner, { ...scope, path: smallPath }));
  await measure('download.small-integrity', async () => {
    const expected = (await operations.readFile(plugin, { path: smallPath })).content;
    const job = await startDownload(small, 'small.txt');
    await waitJob(job);
    assert.equal(await fs.readFile(localFile('small.txt'), 'utf8'), expected);
  });
  const binary = await measure('download.prepare-system-binary', () => files.downloads.prepare(owner, { ...scope, path: '/usr/bin/bash' }));
  assert.ok(binary.expected.size > 512 * 1024 && binary.expected.size < 8 * 1024 * 1024);
  await measure('download.binary-integrity', async () => {
    const job = await startDownload(binary, 'binary.bin');
    await waitJob(job);
    const localHash = crypto.createHash('sha256').update(await fs.readFile(localFile('binary.bin'))).digest('hex');
    await manager.writeTerminal(owner, { ...payload(terminal), data: 'sha256sum -- /usr/bin/bash\r' });
    await readUntil(terminal, content => content.includes(localHash));
  });
  await measure('download.concurrent-and-terminal', async () => {
    const jobs = await Promise.all(['parallel-one.bin', 'parallel-two.bin'].map(name => startDownload(binary, name)));
    await measure('terminal.during-download', () => marker(terminal));
    await measure('directory.during-download', () => files.listDirectory(owner, { ...scope, path: '/usr', deferLinks: true }));
    await Promise.all(jobs.map(job => waitJob(job)));
    assert.deepEqual(await fs.readFile(localFile('parallel-one.bin')), await fs.readFile(localFile('binary.bin')));
    assert.deepEqual(await fs.readFile(localFile('parallel-two.bin')), await fs.readFile(localFile('binary.bin')));
  });
  await measure('download.cancel-active', async () => {
    const job = await startDownload(binary, 'cancelled.bin');
    const state = files.jobs.get(job.jobId);
    assert.equal(state.inFlight, true);
    assert.equal(files.cancelUpload(owner, { ...scope, jobId: job.jobId }).status, 'cancelled');
    await waitJob(job, 'cancelled');
    await assert.rejects(fs.stat(localFile('cancelled.bin')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(localRoot)).some(name => name.endsWith('.part')), false);
  });
  await measure('download.cancel-after-data', async () => {
    const original = runtime.downloadWorkspaceFile.bind(runtime);
    let selectedJob, cancelStarted = 0, received = 0;
    runtime.downloadWorkspaceFile = (selected, remote, destination, expected, options) => original(selected, remote, destination, expected, {
      ...options, onProgress: value => {
        options.onProgress(value);
        if (value.transferredBytes > 0 && !cancelStarted) {
          received = value.transferredBytes; cancelStarted = performance.now();
          files.cancelUpload(owner, { ...scope, jobId: selectedJob.jobId });
        }
      },
    });
    try {
      selectedJob = await startDownload(binary, 'cancel-after-data.bin');
      await waitJob(selectedJob, 'cancelled');
      assert.ok(received > 0 && received < binary.expected.size);
      await assert.rejects(fs.stat(localFile('cancel-after-data.bin')), { code: 'ENOENT' });
      assert.equal((await fs.readdir(localRoot)).some(name => name.endsWith('.part')), false);
      console.log(JSON.stringify({ feature: 'download.cancel-cleanup-latency', status: 'passed', ms: round(performance.now() - cancelStarted) }));
    } finally { runtime.downloadWorkspaceFile = original; }
  });
  await measure('download.cancel-queued', async () => {
    const jobs = await Promise.all(['queue-one.bin', 'queue-two.bin', 'queue-cancelled.bin'].map(name => startDownload(binary, name)));
    const queued = jobs[2];
    assert.equal(files.jobs.get(queued.jobId).status, 'queued');
    files.cancelUpload(owner, { ...scope, jobId: queued.jobId });
    await Promise.all(jobs.map((job, index) => waitJob(job, index === 2 ? 'cancelled' : 'completed')));
    await assert.rejects(fs.stat(localFile('queue-cancelled.bin')), { code: 'ENOENT' });
  });
  await measure('download.changed-local-target', async () => {
    const original = runtime.downloadWorkspaceFile.bind(runtime);
    const destination = localFile('local-change.bin');
    runtime.downloadWorkspaceFile = (selected, remote, selectedDestination, expected, options) => original(selected, remote, selectedDestination, expected, {
      ...options, beforeCommit: async () => {
        await fs.writeFile(destination, 'probe-created-local-content', { flag: 'wx' });
        await options.beforeCommit();
      },
    });
    try {
      const job = await files.downloads.start(owner, scope, binary, destination);
      await waitJob(job, 'error');
      assert.equal(await fs.readFile(destination, 'utf8'), 'probe-created-local-content');
      assert.equal((await fs.readdir(localRoot)).some(name => name.endsWith('.part')), false);
    } finally { runtime.downloadWorkspaceFile = original; }
  });
  await measure('download.clear-records', async () => {
    const count = files.uploads(owner, scope).jobs.length;
    assert.equal(files.clearTransfers(owner, scope).removedIds.length, count);
    assert.equal(files.uploads(owner, scope).jobs.length, 0);
    assert.ok((await fs.stat(localFile('binary.bin'))).size > 0);
  });
  await measure('download.disconnect-after-data', async () => {
    const original = runtime.downloadWorkspaceFile.bind(runtime);
    let disconnecting, received = 0;
    runtime.downloadWorkspaceFile = (selected, remote, destination, expected, options) => original(selected, remote, destination, expected, {
      ...options, onProgress: value => {
        options.onProgress(value);
        if (value.transferredBytes > 0 && !disconnecting) {
          received = value.transferredBytes;
          disconnecting = runtime.disconnect(plugin, 'user-plugin-disconnect');
        }
      },
    });
    try {
      const job = await startDownload(binary, 'disconnected.bin');
      await waitJob(job, 'error'); await disconnecting;
      assert.ok(received > 0 && received < binary.expected.size);
      await assert.rejects(fs.stat(localFile('disconnected.bin')), { code: 'ENOENT' });
      assert.equal((await fs.readdir(localRoot)).some(name => name.endsWith('.part')), false);
    } finally { runtime.downloadWorkspaceFile = original; }
  });
  await measure('connection.reconnect', () => runtime.connect(plugin, { password }));
  isolatedShell();
  terminal = await measure('terminal.recover-session', () => manager.openTerminal(owner, { ...scope, tabId: 'first', recoveryOf: terminal.sessionId }));
  await measure('terminal.after-recovery', () => marker(terminal));
  await measure('terminal.close', async () => {
    await manager.closeTerminal(owner, payload(terminal));
    await readUntil(terminal, (_content, result) => result.status === 'closed');
  });
} catch (error) {
  console.log(JSON.stringify({ status: 'stopped', code: error.code ?? error.name }));
  process.exitCode = 1;
} finally {
  for (const job of files.jobs.values()) if (job.inFlight) files.cancelUpload(owner, { ...scope, jobId: job.jobId });
  try { await waitFor(() => files.running === 0, 5000); }
  catch { process.exitCode = 1; }
  manager.dispose(); files.dispose(); operations.docker.dispose();
  await runtime.broker.closeAll();
  // 本机仅删除已核对目录内本次创建的下载文件，禁止递归清理或跟随目录链接。
  try {
    const actual = await fs.realpath(localRoot);
    const temporaryParent = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual), temporaryParent);
    assert.match(path.basename(actual), /^runbook-interaction-probe-[a-zA-Z0-9]+$/u);
    for (const name of await fs.readdir(actual)) {
      assert.ok(localNames.has(name) || /^\.runbook-download-[a-f0-9]{24}\.part$/u.test(name));
      const selected = path.join(actual, name);
      assert.equal((await fs.lstat(selected)).isFile(), true);
      await fs.unlink(selected);
    }
    await fs.rmdir(actual);
    console.log(JSON.stringify({ feature: 'local.cleanup', status: 'passed' }));
  } catch {
    console.log(JSON.stringify({ feature: 'local.cleanup', status: 'failed' }));
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ status: 'finished', mode: 'isolated-terminal-and-readonly-download',
    passed: results.filter(item => item.status === 'passed').length, failed: results.filter(item => item.status === 'failed').length, auditEvents }));
}
