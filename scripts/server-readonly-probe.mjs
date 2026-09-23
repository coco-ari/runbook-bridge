import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';

// 独立的只读入口：不创建测试资源、不打开人工终端、不调用任何文件变更或任意 Shell 入口。
const host = process.env.RUNBOOK_LIVE_HOST;
const username = process.env.RUNBOOK_LIVE_USER;
const password = process.env.RUNBOOK_LIVE_PASSWORD;
delete process.env.RUNBOOK_LIVE_PASSWORD;
if (net.isIP(host ?? '') !== 4 || !username || !password) throw new Error('只读探针需要显式 IPv4 目标和进程内凭据。');
const scope = { projectId: 'readonly-probe', environmentId: 'isolated', pluginInstanceId: 'probe-server' };
const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '只读测速',
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
// 基线模式仅在本次探针中还原旧的客户端合包与每次新建通道，便于同条件对比。
if (process.argv.includes('--baseline')) {
  runtime.withWorkspaceReadSession = (selected, operation, options) => runtime.broker.withRemoteReadSession(runtime.key(selected), operation, options);
  const connect = runtime.connect.bind(runtime);
  runtime.connect = async (...args) => {
    const result = await connect(...args);
    runtime.broker.requireSession(runtime.key(plugin)).client.setNoDelay(false);
    return result;
  };
}
const operations = new ServerOperations(runtime, store);
const services = { workspaceStore: store, serverRuntime: runtime, serverOperations: operations };
const files = new ServerWorkspaceFiles(services);
const manager = new ServerWorkspaceManager(services);
const owner = 'renderer:readonly-probe';
const results = [];
let stoppedCode = null;
let phases = [];
let serialDirectoryFinalize = false;
const round = value => Math.round(value * 10) / 10;

// 只保留步骤名称与时间，不输出路径、文件名、命令结果或任何凭据。
const withSession = runtime.withWorkspaceReadSession.bind(runtime);
runtime.withWorkspaceReadSession = (selected, operation, options) => {
  const opening = performance.now();
  return withSession(selected, reader => {
    phases.push({ step: 'sftp-open', ms: round(performance.now() - opening) });
    const wrapped = { ...reader };
    for (const key of ['statPath', 'listDirectoryEntries']) wrapped[key] = async (...args) => {
      const start = performance.now();
      try {
        // 对照只移除内部收尾回调，目录缓存仍执行原有串行路径复核。
        return await reader[key](...(key === 'listDirectoryEntries' && serialDirectoryFinalize ? [args[0]] : args));
      }
      finally { phases.push({ step: key, ms: round(performance.now() - start) }); }
    };
    return operation(wrapped);
  }, options);
};
let directoryProtocol = [], directoryProtocolStarted = 0;
if (process.argv.includes('--directory-protocol')) {
  const createClient = runtime.broker.clientFactory.bind(runtime.broker);
  const instrumented = new WeakSet();
  runtime.broker.clientFactory = () => {
    const client = createClient(), open = client.sftp.bind(client);
    client.sftp = callback => open((error, channel) => {
      if (channel && !instrumented.has(channel)) {
        instrumented.add(channel);
        let pendingReads = 0;
        // 只记录操作类别、时间和条目数量，不保留参数、目录内容或错误正文。
        for (const operation of ['opendir', 'readdir', 'close', 'lstat', 'realpath']) {
          const invoke = channel[operation].bind(channel);
          channel[operation] = (...args) => {
            const callback = args.pop(), target = directoryProtocol, started = performance.now();
            if (typeof callback !== 'function') throw new Error('目录采样仅支持回调式请求');
            if (operation === 'readdir') pendingReads += 1;
            const record = { operation, startedMs: round(started - directoryProtocolStarted), ...(operation === 'readdir' ? { pendingReads } : {}) };
            if (target.length < 300) target.push(record);
            return invoke(...args, (error, value) => {
              record.ms = round(performance.now() - started);
              if (operation === 'readdir') {
                pendingReads -= 1;
                record.entries = Array.isArray(value) ? value.length : 0;
                record.eof = Number(error?.code) === 1;
              }
              record.failed = Boolean(error) && !(operation === 'readdir' && record.eof);
              callback(error, value);
            });
          };
        }
      }
      callback(error, channel);
    });
    return client;
  };
}
let protocolEvents = [];
let protocolStarted = 0;
if (process.argv.includes('--cold-directory') || process.argv.includes('--channel-startup')) {
  const createClient = runtime.broker.clientFactory.bind(runtime.broker);
  runtime.broker.clientFactory = () => {
    const client = createClient();
    const open = client.sftp.bind(client);
    client.sftp = callback => {
      if (protocolEvents.length < 40) protocolEvents.push({ direction:'Local', type:'SFTP_REQUESTED', ms:round(performance.now()-protocolStarted) });
      return open((error, channel) => {
        if (protocolEvents.length < 40) protocolEvents.push({ direction:'Local', type:error ? 'SFTP_FAILED' : 'SFTP_READY', ms:round(performance.now()-protocolStarted) });
        callback(error, channel);
      });
    };
    const connect = client.connect.bind(client);
    client.connect = config => {
      protocolEvents = [];
      protocolStarted = performance.now();
      return connect({ ...config, debug: message => {
        // 仅把白名单协议事件映射为类别和耗时；不保留调试原文、地址或认证参数。
        const event = /^(Inbound|Outbound):.*?\b(USERAUTH_SUCCESS|CHANNEL_OPEN_CONFIRMATION|CHANNEL_OPEN|CHANNEL_SUCCESS|CHANNEL_REQUEST|GLOBAL_REQUEST)\b/u.exec(message);
        if (event && protocolEvents.length < 40) protocolEvents.push({ direction:event[1], type:event[2], ms:round(performance.now()-protocolStarted) });
        // 仅保存固定阶段名，不保存服务端扩展清单、请求编号或调试原文。
        if (protocolEvents.length < 40 && message.startsWith('SFTP: Inbound: Received VERSION (')) protocolEvents.push({ direction:'Inbound', type:'SFTP_VERSION', ms:round(performance.now()-protocolStarted) });
        if (protocolEvents.length < 40 && /^SFTP: Outbound: (Sent|Buffered) limits@openssh\.com$/u.test(message)) protocolEvents.push({ direction:'Outbound', type:'SFTP_LIMITS', ms:round(performance.now()-protocolStarted) });
      } });
    };
    return client;
  };
}

async function measure(feature, operation, { optional = false } = {}) {
  const start = performance.now();
  phases = []; directoryProtocol = []; directoryProtocolStarted = start;
  try {
    const value = await operation();
    const result = { feature, status: 'passed', ms: round(performance.now() - start), ...(phases.length ? { phases } : {}), ...(directoryProtocol.length ? { protocol: directoryProtocol } : {}) };
    results.push(result); console.log(JSON.stringify(result));
    return value;
  } catch (error) {
    const result = { feature, status: 'failed', code: error.code ?? error.name, ms: round(performance.now() - start) };
    results.push(result); console.log(JSON.stringify(result));
    if (!optional) throw error;
  }
}
try {
  await measure('connection.host-key-check', async () => {
    await assert.rejects(runtime.connect(plugin, { password }), error => {
      if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
      plugin.target.hostKeyFingerprint = error.details.fingerprint;
      return true;
    });
  });
  await measure('connection.pinned-login', () => runtime.connect(plugin, { password }));
  if (process.argv.includes('--cold-directory') || process.argv.includes('--channel-startup')) {
    const settlements = process.argv.includes('--channel-startup') ? [0,0,0] : [0,350,0,350,100,0];
    for (const [index, settleMs] of settlements.entries()) {
      if (index) {
        await runtime.disconnect(plugin);
        await measure('cold.reconnect.'+index, () => runtime.connect(plugin, {password}));
      }
      if (settleMs) await delay(settleMs);
      const before = protocolEvents.length;
      await measure('cold.directory.'+index, async () => {
        const page = await files.listDirectory(owner, {...scope,path:'/',deferLinks:true});
        assert.ok(Array.isArray(page.entries) && page.entries.length <= 200);
      });
      console.log(JSON.stringify({feature:'cold.protocol.'+index,settleMs,events:protocolEvents.slice(before)}));
      await measure('cold.repeated-directory.'+index, () => files.listDirectory(owner,{...scope,path:'/',deferLinks:true}));
    }
  } else if (process.argv.includes('--directory-idle')) {
    const { SftpReadPool } = await import('../src/sftp-read-pool.mjs');
    const session = runtime.broker.requireSession(runtime.key(plugin)), client = session.client, open = client.sftp;
    let opened = 0;
    client.sftp = function(...args) { opened += 1; return open.apply(this, args); };
    try {
      // 交错比较空闲回收期限；只读取固定目录，不发保活包或修改服务器配置。
      for (const [index, configuredIdleMs] of [5000,null,null,5000].entries()) {
        session.workspaceReads?.dispose(); session.workspaceReads = new SftpReadPool(client, configuredIdleMs === null ? {} : { idleMs:configuredIdleMs });
        const idleMs = session.workspaceReads.idleMs;
        if (configuredIdleMs === null) assert.equal(idleMs, 30000);
        const label = 'idle.' + idleMs + '.' + index;
        await measure(label + '.prime', () => files.listDirectory(owner, { ...scope, path:'/', deferLinks:true }));
        const before = opened, start = performance.now();
        await delay(8000);
        const idleBefore = [...session.workspaceReads.entries.values()].filter(entry => entry.idle).length;
        await measure(label + '.resume', async () => {
          const page = await files.listDirectory(owner, { ...scope, path:'/', deferLinks:true });
          assert.equal(page.canonicalPath, '/'); assert.ok(page.entries.length <= 200);
          assert.equal(opened - before, idleMs === 5000 ? 1 : 0);
          assert.equal(idleBefore, idleMs === 5000 ? 0 : 1);
        });
        console.log(JSON.stringify({ feature:label + '.channels', idleMs, pauseAtLeastMs:8000, pauseAndReadMs:round(performance.now()-start), idleBefore, newChannels:opened-before }));
      }
      const read = runtime.withWorkspaceReadSession;
      let sessions = 0;
      runtime.withWorkspaceReadSession = function(...args) { sessions += 1; return read.apply(this, args); };
      try {
        await measure('directory.coalesced-first-read', async () => {
          const pages = await Promise.all([1,2].map(() => files.listDirectory(owner, { ...scope, path:'/', deferLinks:true })));
          assert.equal(pages[0].snapshotId, pages[1].snapshotId); assert.deepEqual(pages[0].entries, pages[1].entries);
          assert.equal(sessions, 1, '并发首次读取共享同一完整校验会话');
        });
        console.log(JSON.stringify({ feature:'directory.coalesced-sessions', sessions }));
      } finally { runtime.withWorkspaceReadSession = read; }
    } finally { client.sftp = open; session.workspaceReads?.dispose(); delete session.workspaceReads; }
  } else if (process.argv.includes('--directory-compression') || process.argv.includes('--compression-integrity')) {
    const { probeDirectoryCompression } = await import('./server-directory-transport-scenarios.mjs');
    await probeDirectoryCompression({ runtime, files, plugin, scope, owner, measure, reconnect:() => runtime.connect(plugin, { password }), verifyIntegrity:process.argv.includes('--compression-integrity') });
  } else if (process.argv.includes('--preview-phases') || process.argv.includes('--preview-path-pipeline') || process.argv.includes('--preview-channel-reuse') || process.argv.includes('--preview-validation-pipeline')) {
    const { probePreviewPhases } = await import('./server-preview-readonly-scenarios.mjs');
    await probePreviewPhases({ runtime, files, plugin, scope, owner, measure, compare:process.argv.includes('--preview-path-pipeline'), reuseCompare:process.argv.includes('--preview-channel-reuse'), validationCompare:process.argv.includes('--preview-validation-pipeline') });
  } else if ((process.argv.includes('--directory-queue') || process.argv.includes('--mixed-file-reads'))) {
    const { probeDirectoryQueue } = await import('./server-directory-readonly-scenarios.mjs');
    await probeDirectoryQueue({ files, scope, owner, measure, mixed:process.argv.includes('--mixed-file-reads') });
  } else if (process.argv.includes('--connection-cancel')) {
    const { probeConnectionCancellation } = await import('./server-connection-readonly-scenarios.mjs');
    await probeConnectionCancellation({ runtime, files, plugin, scope, owner, measure, reconnect:options => runtime.connect(plugin, { password }, options) });
  } else if (process.argv.includes('--overlay-peer')) {
    const { probeOverlayPeer } = await import('./server-overlay-readonly-scenarios.mjs');
    await probeOverlayPeer({ runtime, files, plugin, scope, owner, measure });
  } else if (process.argv.includes('--directory-packet-size')) {
    const { probeDirectoryPacketSize } = await import('./server-directory-transport-scenarios.mjs');
    await probeDirectoryPacketSize({ runtime, files, plugin, scope, owner, measure });
  } else if (process.argv.includes('--directory-path-pipeline')) {
    const { probeDirectoryPathPipeline } = await import('./server-directory-transport-scenarios.mjs');
    await probeDirectoryPathPipeline({ runtime, plugin, measure });
  } else if (process.argv.includes('--directory-transport')) {
    const { probeDirectoryTransport } = await import('./server-directory-transport-scenarios.mjs');
    await probeDirectoryTransport({ runtime, files, plugin, scope, owner, measure, reconnect:() => runtime.connect(plugin, { password }) });
  } else if (process.argv.includes('--directory-pages')) {
    const { probeDirectoryPages } = await import('./server-directory-readonly-scenarios.mjs');
    await probeDirectoryPages({ runtime, files, plugin, scope, owner, measure });
  } else if (process.argv.includes('--metrics-lifecycle')) {
    const { probeMetricsReadOnly } = await import('./server-metrics-readonly-scenarios.mjs');
    await probeMetricsReadOnly({ runtime, manager, plugin, scope, owner, measure, reconnect:() => runtime.connect(plugin, { password }) });
  } else if (process.argv.includes('--docker-lifecycle')) {
    const { probeDockerReadOnly } = await import('./server-docker-readonly-scenarios.mjs');
    await probeDockerReadOnly({ runtime, operations, plugin, scope, owner, measure });
  } else if (process.argv.includes('--compare-finalize')) {
    // 在同一连接内交错比较，只读取固定目录，不改变产品配置或发布前校验。
    const remotePath = process.argv.includes('--large-directory') ? '/usr/bin' : '/';
    await measure('finalize.warmup', () => files.listDirectory(owner, { ...scope, path: remotePath, deferLinks: true }));
    for (const [index, serial] of [true, false, false, true, true, false].entries()) {
      serialDirectoryFinalize = serial;
      const page = await measure('finalize.' + (serial ? 'serial.' : 'parallel.') + index, async () => {
        const result = await files.listDirectory(owner, { ...scope, path: remotePath, deferLinks: true });
        assert.ok(Array.isArray(result.entries) && result.entries.length <= 200);
        return result;
      });
      await measure('finalize.snapshot.' + index, async () => {
        const result = await files.listDirectory(owner, { ...scope, path: remotePath, snapshotId: page.snapshotId, cursor: '0', deferLinks: true });
        assert.equal(result.snapshotId, page.snapshotId); assert.deepEqual(result.entries, page.entries);
      });
    }
    serialDirectoryFinalize = false;
  } else if (process.argv.includes('--directory-cancel')) {
    const { probeDirectoryCancellation } = await import('./server-directory-cancellation-scenarios.mjs');
    await probeDirectoryCancellation({runtime,files,plugin,scope,owner,measure});
  } else if (process.argv.includes('--directory-latency')) {
    // 组网专项只读取固定目录，分别记录完整读取和快照复用，不打开桌面或终端。
    const paths = process.argv.includes('--large-directory') ? ['/usr/bin', '/usr/bin', '/usr/bin'] : ['/', '/', '/', '/usr/bin'];
    for (const [index, remotePath] of paths.entries()) {
      const page = await measure('latency.directory.' + index, async () => {
        const result = await files.listDirectory(owner, { ...scope, path: remotePath, deferLinks: true });
        assert.ok(Array.isArray(result.entries) && result.entries.length <= 200);
        return result;
      });
      await measure('latency.snapshot.' + index, async () => {
        const result = await files.listDirectory(owner, { ...scope, path: remotePath, snapshotId: page.snapshotId, cursor: '0', deferLinks: true });
        assert.equal(result.snapshotId, page.snapshotId);
        assert.deepEqual(result.entries, page.entries);
      });
    }
  } else {
  for (let index = 0; index < 5; index += 1) {
    for (const [label, remotePath] of [['root', '/'], ['system-bin', '/usr/bin']]) {
      const page = await measure('directory.' + label + '.fresh.' + index, async () => {
        const value = await files.listDirectory(owner, { ...scope, path: remotePath, deferLinks: true });
        assert.ok(Array.isArray(value.entries)); assert.ok(value.entries.length <= 200); return value;
      });
      await measure('directory.' + label + '.snapshot.' + index, async () => {
        const value = await files.listDirectory(owner, { ...scope, path: remotePath, snapshotId: page.snapshotId,
          cursor: page.nextCursor ?? '0', deferLinks: true });
        assert.ok(value.entries.length <= 200);
      });
      if (index === 0 && page.metadataPending) await measure('directory.' + label + '.links', async () => {
        const value = await files.listDirectory(owner, { ...scope, path: remotePath, snapshotId: page.snapshotId,
          cursor: '0', deferLinks: true, resolveLinks: true });
        assert.equal(value.metadataPending, false);
      });
    }
  }
  await measure('files.directory-properties', async () => {
    const value = await files.fileInfo(owner, { ...scope, path: '/usr' });
    assert.equal(value.type, 'directory');
  });
  await measure('files.preview-os-release', async () => {
    const value = await files.readFile(owner, { ...scope, path: '/etc/os-release' });
    assert.equal(typeof value.content, 'string'); assert.ok(value.content.length); assert.equal(value.truncated, false);
  });
  await measure('files.bounded-read-and-cursor', async () => {
    const first = await operations.readFile(plugin, { path: '/etc/os-release', maxBytes: 32 });
    assert.ok(first.nextCursor); assert.equal(first.endByte, 32);
    const next = await operations.readFile(plugin, { path: '/etc/os-release', cursor: first.nextCursor, maxBytes: 32 });
    assert.equal(next.startByte, first.endByte);
  });
  await measure('files.tail', async () => {
    const value = await operations.readFile(plugin, { path: '/etc/os-release', maxBytes: 32, tail: true });
    assert.equal(value.endByte, value.size); assert.ok(value.endByte - value.startByte <= 32);
  });
  await measure('files.find-depth-zero', async () => {
    const value = await operations.findFiles(plugin, { path: '/etc', pattern: '*.conf', maxDepth: 0, maxResults: 20 });
    assert.ok(value.files.length > 0); assert.ok(value.files.length <= 20);
  }, { optional: true });
  const baseline = await measure('metrics.system.initial', async () => {
    const value = await manager.readMetrics(owner, { ...scope, kind: 'system' });
    assert.equal(value.error, null); assert.ok(value.cpu); assert.ok(value.memory); return value;
  });
  await measure('metrics.system.cached', async () => {
    const value = await manager.readMetrics(owner, { ...scope, kind: 'system' });
    assert.equal(value.sampledAt, baseline.sampledAt);
  });
  await measure('metrics.disks', async () => {
    const value = await manager.readMetrics(owner, { ...scope, kind: 'disks' });
    assert.equal(value.diskError, null); assert.ok(value.disks.length);
  });
  await delay(Math.min(1100, baseline.retryAfterMs + 25));
  await measure('metrics.system.cpu-delta', async () => {
    const value = await manager.readMetrics(owner, { ...scope, kind: 'system' });
    assert.equal(value.error, null); assert.equal(typeof value.cpu?.percent, 'number');
  });
  await measure('metrics.stop', () => manager.stopMetrics(owner, scope));
  await measure('operations.system-summary', async () => {
    const value = await operations.runAction(plugin, 'system.summary', {});
    assert.equal(value.exitCode, 0);
  }, { optional: true });
  await measure('operations.service-show', async () => {
    const value = await operations.inspectService(plugin, { unit: 'ssh.service', view: 'show' });
    assert.equal(value.exitCode, 0);
  }, { optional: true });
  await measure('operations.journal-bounded', async () => {
    const value = await operations.queryJournal(plugin, { unit: 'ssh.service', lines: 10, since: '10 minutes ago' });
    assert.equal(value.exitCode, 0);
  }, { optional: true });
  const containers = await measure('docker.list', async () => {
    const value = await operations.docker.read(owner, { ...scope, kind: 'list', limit: 20 });
    assert.ok(Array.isArray(value.items)); return value;
  }, { optional: true });
  const containerId = containers?.items.find(item => item.state === 'running')?.id;
  if (containerId) {
    for (const kind of ['inspect', 'stats', 'logs']) await measure('docker.' + kind, async () => {
      const value = await operations.docker.read(owner, { ...scope, kind, containerId, ...(kind === 'logs' ? { lines: 10, maxBytes: 1024 } : {}) });
      assert.ok(value && typeof value === 'object');
    }, { optional: true });
  } else console.log(JSON.stringify({ feature: 'docker.details', status: 'not-covered', reason: 'no-running-container' }));
  if (process.argv.includes('--preview-concurrency')) await measure('files.concurrent-previews', async () => {
    let timer;
    try {
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('并发预览测量超时'), { code: 'PROBE_DEADLINE' })), 3000);
      });
      const previews = Promise.all([1, 2].map(() => files.readFile(owner, { ...scope, path: '/etc/os-release' })));
      const values = await Promise.race([previews, deadline]);
      assert.ok(values.every(value => typeof value.content === 'string' && value.content.length > 0));
    } finally { clearTimeout(timer); }
  });
  await measure('connection.disconnect', () => runtime.disconnect(plugin));
  await measure('connection.reconnect-pinned', () => runtime.connect(plugin, { password }));
  await measure('directory.after-reconnect', async () => {
    const value = await files.listDirectory(owner, { ...scope, path: '/', deferLinks: true });
    assert.ok(Array.isArray(value.entries));
  });
  }
} catch (error) {
  stoppedCode = error.code ?? error.name;
  console.log(JSON.stringify({ status: 'stopped', code: stoppedCode }));
  process.exitCode = 1;
} finally {
  files.dispose(); manager.dispose(); operations.docker.dispose();
  await runtime.closeAll();
  const failed = results.filter(item => item.status === 'failed').length;
  if (failed) process.exitCode = 1;
  console.log(JSON.stringify({ status: stoppedCode || failed ? 'failed' : 'finished', ...(stoppedCode ? { fatalCode:stoppedCode } : {}), mode: process.argv.includes('--directory-cancel') ? 'directory-cancel' : process.argv.includes('--channel-startup') ? 'channel-startup' : process.argv.includes('--connection-cancel') ? 'connection-cancel' : process.argv.includes('--preview-validation-pipeline') ? 'preview-validation-pipeline' : process.argv.includes('--preview-channel-reuse') ? 'preview-channel-reuse' : process.argv.includes('--preview-path-pipeline') ? 'preview-path-pipeline' : process.argv.includes('--preview-phases') ? 'preview-phases' : process.argv.includes('--mixed-file-reads') ? 'mixed-file-reads' : process.argv.includes('--directory-queue') ? 'directory-queue' : process.argv.includes('--overlay-peer') ? 'overlay-peer' : process.argv.includes('--directory-packet-size') ? 'directory-packet-size' : process.argv.includes('--directory-path-pipeline') ? 'directory-path-pipeline' : process.argv.includes('--compression-integrity') ? 'compression-integrity' : process.argv.includes('--directory-compression') ? 'directory-compression' : process.argv.includes('--directory-transport') ? 'directory-transport' : process.argv.includes('--directory-pages') ? 'directory-pages' : process.argv.includes('--directory-idle') ? 'directory-idle' : process.argv.includes('--metrics-lifecycle') ? 'metrics-lifecycle' : process.argv.includes('--docker-lifecycle') ? 'docker-lifecycle' : process.argv.includes('--directory-latency') ? 'directory-latency' : process.argv.includes('--cold-directory') ? 'cold-directory' : process.argv.includes('--baseline') ? 'read-only-baseline' : 'read-only', passed: results.length - failed, failed, auditEvents }));
}
