import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// 固定系统文件仅在内存比对；协议记录不包含路径、正文、参数或错误原文。
export async function probePreviewPhases({ runtime, files, plugin, scope, owner, measure, compare = false, reuseCompare = false, validationCompare = false }) {
  const client = runtime.broker.requireSession(runtime.key(plugin)).client;
  const originalSftp = client.sftp, originalSession = runtime.withRemoteReadSession;
  const round = value => Math.round(value * 10) / 10;
  const restores = [], decorated = new WeakSet(), baseline = new Map();
  let current = null, pipelineMetadata = false, reuseWorkspace = false, pipelineReadValidation = false, stopped = false, timer;
  const decorate = channel => {
    if (!channel || decorated.has(channel)) return;
    decorated.add(channel);
    for (const method of ['lstat', 'realpath', 'stat', 'open', 'read', 'close']) {
      const original = channel[method];
      channel[method] = function(...args) {
        const callback = args.pop(), sample = current;
        if (!sample || typeof callback !== 'function') return original.apply(this, [...args, callback]);
        if (method === 'open') sample.phase = 'content-data';
        const metadata = ['lstat', 'realpath', 'stat'].includes(method);
        const started = performance.now();
        const record = { method, phase:sample.phase, startMs:round(started - sample.started) };
        sample.requests.push(record);
        const validation = metadata && record.phase === 'content-after';
        if (validation) { sample.pendingValidation += 1; sample.peakValidation = Math.max(sample.peakValidation, sample.pendingValidation); }
        if (metadata) { sample.pendingMetadata += 1; sample.peakMetadata = Math.max(sample.peakMetadata, sample.pendingMetadata); }
        return original.call(this, ...args, (...values) => {
          record.ms = round(performance.now() - started); record.failed = Boolean(values[0]);
          if (metadata) sample.pendingMetadata -= 1;
          if (validation) sample.pendingValidation -= 1;
          if (method === 'close' && sample.phase === 'content-data') sample.phase = 'content-after';
          callback(...values);
        });
      };
      restores.push(() => { channel[method] = original; });
    }
  };
  client.sftp = function(callback) {
    const sample = current, started = performance.now();
    return originalSftp.call(this, (error, channel) => {
      if (sample) { sample.sftpOpenMs = round(performance.now() - started); sample.newChannels += 1; }
      decorate(channel); callback(error, channel);
    });
  };
  for (const channel of runtime.broker.requireSession(runtime.key(plugin)).workspaceReads?.entries.keys() ?? []) decorate(channel);
  runtime.withRemoteReadSession = function(selected, operation, options = {}) {
    // 仅当前诊断显式选择查询时序和通道复用；两种对照始终保留生产限流及全部校验。
    const sample = current;
    const acquireStarted = performance.now();
    return originalSession.call(this, selected, reader => {
      sample.sessions += 1; sample.acquireMs = round(performance.now() - acquireStarted);
      return operation({ ...reader,
        readRange:async (...args) => {
          const sample = current; sample.phase = 'content-before';
          try { return await reader.readRange(...args); }
          finally { sample.phase = 'path-after'; }
        },
      });
    }, { ...options, pipelineMetadata, reuseWorkspace, pipelineReadValidation });
  };
  try {
    const run = async () => {
      // 同一连接按基线、候选、候选、基线交错采样，避免单向顺序混入网络变化。
      for (const [iteration, enabled] of ((compare || reuseCompare || validationCompare) ? [false, true, true, false] : [false]).entries()) {
        pipelineMetadata = reuseCompare || validationCompare || enabled;
        reuseWorkspace = validationCompare || (reuseCompare && enabled);
        pipelineReadValidation = validationCompare && enabled;
        if (reuseCompare || validationCompare) {
          if (stopped) return;
          // 每组先展开同一目录，分别验证保留空闲通道与每次新建的后续查看路径。
          await measure((validationCompare ? 'preview-validation' : 'preview-reuse') + '.prime.' + iteration, async () => {
            const page = await files.listDirectory(owner, { ...scope, path:'/etc', deferLinks:true });
            assert.ok(Array.isArray(page.entries) && page.entries.length <= 200);
            assert.equal([...runtime.broker.requireSession(runtime.key(plugin)).workspaceReads.entries.values()].filter(entry => entry.idle).length, 1);
          });
        }
        for (const [file, remotePath] of ['/etc/hostname', '/etc/os-release'].entries()) {
          for (const kind of (validationCompare ? ['preview'] : ['preview', 'info'])) {
            if (stopped) return;
            const sample = { started:performance.now(), phase:kind === 'preview' ? 'path-before' : 'info', requests:[], pendingMetadata:0, peakMetadata:0, pendingValidation:0, peakValidation:0, sessions:0, newChannels:0, sftpOpenMs:0 };
            current = sample;
            const label = (validationCompare ? 'preview-validation.' + (enabled ? 'parallel' : 'serial') : reuseCompare ? 'preview-reuse.' + (enabled ? 'reuse' : 'fresh') : 'preview-phases.' + (enabled ? 'parallel' : 'serial')) + '.' + iteration + '.' + file + '.' + kind;
            await measure(label, async () => {
              const value = kind === 'preview' ? await files.readFile(owner, { ...scope, path:remotePath }) : await files.fileInfo(owner, { ...scope, path:remotePath });
              if (kind === 'preview') {
                assert.ok(typeof value.content === 'string' && value.content.length > 0);
                assert.equal(value.truncated, false);
                if (baseline.has(file)) assert.equal(value.content === baseline.get(file), true, '多轮预览正文必须相同');
                else baseline.set(file, value.content);
              } else assert.ok(['file', 'symlink'].includes(value.type));
              assert.equal(sample.sessions, 1); assert.equal(sample.pendingMetadata, 0);
              assert.equal(sample.peakMetadata, pipelineMetadata ? 2 : 1);
              assert.equal(sample.peakValidation, kind === 'preview' ? pipelineReadValidation ? 2 : 1 : 0);
              assert.equal(sample.pendingValidation, 0);
              assert.equal(sample.newChannels, reuseWorkspace ? 0 : 1);
              if (reuseWorkspace) {
                const entries = [...runtime.broker.requireSession(runtime.key(plugin)).workspaceReads.entries.values()];
                assert.equal(entries.length, 1); assert.equal(entries[0].idle, true);
              }
              assert.equal(files.readCounts.get(owner) ?? 0, 0);
              const metadataRequests = sample.requests.filter(item => ['lstat', 'realpath', 'stat'].includes(item.method)).length;
              assert.ok(kind === 'preview' ? [8, 12].includes(metadataRequests) : [2, 6].includes(metadataRequests));
              console.log(JSON.stringify({ feature:label + '.protocol', status:'observed', ms:round(performance.now() - sample.started),
                sftpOpenMs:sample.sftpOpenMs, acquireMs:sample.acquireMs, newChannels:sample.newChannels, sessions:sample.sessions, peakMetadata:sample.peakMetadata, peakValidation:sample.peakValidation, metadataRequests,
                aliased:value.canonicalPath !== remotePath, requests:sample.requests }));
            });
            current = null;
          }
        }
      }
    };
    // 独立探针需要有引用的总时限，不能因产品内部计时器取消引用而提前退出。
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('预览阶段采样超过时限'), { code:'PREVIEW_PHASE_PROBE_TIMEOUT' })), (compare || reuseCompare || validationCompare) ? 600_000 : 180_000); });
    await Promise.race([run(), deadline]);
  } finally {
    stopped = true; clearTimeout(timer); runtime.withRemoteReadSession = originalSession; client.sftp = originalSftp;
    for (const restore of restores.reverse()) restore();
    baseline.clear();
  }
}
