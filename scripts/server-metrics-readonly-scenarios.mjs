import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { metricsCommand } from '../src/server-metrics-reader.mjs';

// 只运行产品固定的系统与本地磁盘采样，采样正文和挂载点不输出或落盘。
export async function probeMetricsReadOnly({ runtime, manager, plugin, scope, owner, measure, reconnect }) {
  const client = runtime.broker.requireSession(runtime.key(plugin)).client;
  const originalExec = client.exec, originalRead = runtime.readWorkspaceMetrics;
  const counts = { system:0, disks:0 }, channels = new Map(), inFlight = new Set();
  const otherOwner = owner + '-other';
  let opening = 0;
  const waitFor = async predicate => {
    const deadline = performance.now() + 15000;
    while (!predicate() && performance.now() < deadline) await delay(10);
    if (!predicate()) throw Object.assign(new Error('监控后台测量超过观察时限。'), { code:'PROBE_DEADLINE' });
  };
  client.exec = function(command, options, callback) {
    const kind = ['system','disks'].find(value => command === metricsCommand(value));
    assert.ok(kind, '监控专项只执行固定采样命令');
    counts[kind] += 1; opening += 1;
    try {
      return originalExec.call(this, command, options, (error, stream) => {
        opening -= 1;
        if (stream) {
          const closed = () => channels.delete(stream);
          channels.set(stream, closed); stream.once('close', closed);
        }
        callback(error, stream);
      });
    } catch (error) { opening -= 1; throw error; }
  };
  // 迟到的未消费通道可能不发 close；必须同时确认双向协议关闭和连接登记已移除。
  const channelsReleased = () => {
    for (const [stream, closed] of channels) {
      if (stream.incoming.state === 'closed' && stream.outgoing.state === 'closed'
        && client._chanMgr.get(stream.incoming.id) === undefined) {
        stream.removeListener('close', closed); channels.delete(stream);
      }
    }
    return opening === 0 && channels.size === 0;
  };
  const read = (kind, selectedOwner = owner) => {
    const pending = manager.readMetrics(selectedOwner, { ...scope, kind });
    inFlight.add(pending);
    pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  };
  const current = () => {
    const record = [...manager.metrics.records.values()][0];
    assert.ok(record); return record;
  };
  const waitDue = async kind => {
    await delay(Math.max(0, current().nextAt[kind] - Date.now()) + 25);
  };
  const healthySystem = value => {
    assert.equal(value.error, null); assert.equal(value.unsupported, false);
    assert.ok(value.cpu && value.memory); assert.ok(value.memory.total > 0);
  };
  const healthyDisks = value => {
    assert.equal(value.diskError, null); assert.ok(value.disks.length > 0 && value.disks.length <= 64);
  };
  const timeoutSample = async kind => {
    // 仅本次诊断缩短客户端观察期限；远端命令、产品默认超时和服务器配置保持原样。
    runtime.readWorkspaceMetrics = (selected, selectedKind, options) => runtime.broker.readWorkspaceMetrics(runtime.key(selected), selectedKind, { ...options, timeoutMs:1 });
    try { return await read(kind); }
    finally { runtime.readWorkspaceMetrics = originalRead; }
  };
  try {
    let firstSystem, firstDisk;
    await measure('metrics.parallel-and-coalesced', async () => {
      const a = read('system'), b = read('system', otherOwner), c = read('disks'), d = read('disks', otherOwner);
      assert.equal(a, b); assert.equal(c, d);
      await Promise.all([
        a.then(async value => {
          healthySystem(value); assert.equal(value.cpu.percent, null); firstSystem = value;
          await measure('metrics.system.cache', async () => {
            const cached = await read('system'); assert.equal(cached.sampledAt, value.sampledAt); assert.equal(counts.system, 1);
          });
        }),
        c.then(async value => {
          healthyDisks(value); firstDisk = value;
          await measure('metrics.disks.cache', async () => {
            const cached = await read('disks'); assert.equal(cached.diskSampledAt, value.diskSampledAt); assert.equal(counts.disks, 1);
          });
        }),
      ]);
      assert.deepEqual(counts, { system:1, disks:1 });
    });
    await waitDue('system');
    const second = await measure('metrics.system.cpu-delta', async () => {
      const value = await read('system'); healthySystem(value);
      assert.equal(typeof value.cpu.percent, 'number'); assert.ok(value.cpu.percent >= 0 && value.cpu.percent <= 100);
      assert.ok(value.sampledAt > firstSystem.sampledAt); return value;
    });
    await waitDue('system');
    await measure('metrics.system.injected-timeout', async () => {
      const failed = await timeoutSample('system');
      assert.equal(failed.error, 'METRICS_TIMEOUT'); assert.equal(failed.sampledAt, second.sampledAt);
      assert.deepEqual(failed.memory, second.memory); assert.equal(runtime.status(plugin).connected, true);
    });
    await measure('metrics.system.timeout-channel-released', () => waitFor(channelsReleased));
    await waitDue('system');
    await measure('metrics.system.recover-baseline', async () => {
      const value = await read('system'); healthySystem(value);
      assert.equal(value.cpu.percent, null); assert.ok(value.retryAfterMs <= 1000);
    });
    await waitDue('system');
    await measure('metrics.system.recover-delta', async () => {
      const value = await read('system'); healthySystem(value); assert.equal(typeof value.cpu.percent, 'number');
    });
    await waitDue('disks');
    await measure('metrics.disks.injected-timeout', async () => {
      const failed = await timeoutSample('disks');
      assert.equal(failed.diskError, 'METRICS_TIMEOUT'); assert.equal(failed.diskSampledAt, firstDisk.diskSampledAt);
      assert.deepEqual(failed.disks, firstDisk.disks); assert.equal(runtime.status(plugin).connected, true);
    });
    await measure('metrics.disks.timeout-channel-released', () => waitFor(channelsReleased));
    await waitDue('disks');
    const recoveredDisk = await measure('metrics.disks.recover', async () => {
      const value = await read('disks'); healthyDisks(value);
      assert.ok(value.diskSampledAt > firstDisk.diskSampledAt); return value;
    });
    await measure('metrics.stop.one-owner', async () => {
      const reads = counts.disks; manager.stopMetrics(owner, scope);
      assert.equal(current().owners.size, 1); assert.equal(current().controller.signal.aborted, false);
      const cached = await read('disks', otherOwner);
      assert.equal(cached.diskSampledAt, recoveredDisk.diskSampledAt); assert.equal(counts.disks, reads);
    });
    await measure('metrics.stop.last-owner', () => {
      manager.stopMetrics(otherOwner, scope); assert.equal(manager.metrics.records.size, 0);
    });
    await measure('metrics.cancel.opening-and-resume', async () => {
      const before = counts.system + counts.disks;
      const a = read('system'), b = read('disks');
      const rejected = Promise.all([assert.rejects(a, { code:'METRICS_CANCELLED' }), assert.rejects(b, { code:'METRICS_CANCELLED' })]);
      rejected.catch(() => undefined);
      await waitFor(() => counts.system + counts.disks === before + 2);
      await measure('metrics.cancel.feedback', async () => {
        manager.stopMetrics(owner, scope); await rejected;
        assert.equal(manager.metrics.records.size, 0); assert.equal(runtime.status(plugin).connected, true);
      });
      const value = await read('system'); healthySystem(value); assert.equal(value.cpu.percent, null);
      await waitFor(channelsReleased);
      assert.equal(manager.metrics.records.size, 1);
    });
    await measure('metrics.reconnect', async () => {
      const generation = runtime.status(plugin).generation;
      await runtime.disconnect(plugin); assert.equal(manager.metrics.records.size, 0);
      await reconnect(); assert.notEqual(runtime.status(plugin).generation, generation);
      const value = await read('system'); healthySystem(value);
      assert.equal(value.cpu.percent, null); assert.equal(value.diskSampledAt, null); assert.deepEqual(value.disks, []);
    });
    await measure('metrics.stop.final', () => {
      manager.stopMetrics(owner, scope); manager.stopMetrics(otherOwner, scope);
      assert.equal(manager.metrics.records.size, 0);
    });
  } finally {
    runtime.readWorkspaceMetrics = originalRead;
    manager.stopMetrics(owner, scope); manager.stopMetrics(otherOwner, scope);
    await Promise.allSettled([...inFlight]);
    try { await waitFor(channelsReleased); }
    finally { client.exec = originalExec; }
    assert.equal(manager.metrics.records.size, 0);
  }
}
