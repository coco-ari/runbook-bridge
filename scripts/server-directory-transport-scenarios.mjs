import assert from 'node:assert/strict';
import net from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const round = value => Math.round(value * 10) / 10;

// 只观察本次 SSH 连接的收包长度和时序，绝不保留缓冲区、包内容或对端地址。
export function observeTransport(client, channels = []) {
  const socket = client._sock;
  assert.ok(socket instanceof net.Socket, '此诊断仅用于直接 TCP 连接');
  const originalSftp = client.sftp, originalWrite = socket.write, decorated = new WeakSet(), restorations = [];
  let active = null;
  const beforeData = chunk => {
    if (!active) return;
    const now = performance.now(), item = { atMs:round(now - active.started), bytes:chunk.length, gapMs:round(now - active.lastDataAt) };
    active.receivedBytes += chunk.length; active.receivedEvents += 1;
    active.longestGapMs = Math.max(active.longestGapMs, now - active.lastDataAt);
    active.lastDataAt = now; active.dispatchStarted = now;
    if (active.receive.length < 400) active.receive.push(item);
    active.currentReceive = item;
  };
  const afterData = () => {
    if (!active?.currentReceive) return;
    const duration = performance.now() - active.dispatchStarted;
    active.currentReceive.dispatchMs = round(duration);
    active.maxDispatchMs = Math.max(active.maxDispatchMs, duration);
    active.currentReceive = null;
  };
  socket.prependListener('data', beforeData); socket.on('data', afterData);
  const decorate = channel => {
    if (!channel || decorated.has(channel)) return;
    decorated.add(channel);
    const readDirectory = channel.readdir;
    channel.readdir = function(handle, done) {
      const target = active, started = performance.now();
      const item = target ? { startedMs:round(started - target.started),
        outgoingWindow:this.outgoing?.window ?? null, incomingWindow:this.incoming?.window ?? null } : null;
      if (target && target.reads.length < 100) target.reads.push(item);
      return readDirectory.call(this, handle, (failure, entries) => {
        if (item) Object.assign(item, { ms:round(performance.now() - started), entries:Array.isArray(entries) ? entries.length : 0,
          eof:Number(failure?.code) === 1, failed:Boolean(failure) && Number(failure.code) !== 1 });
        done(failure, entries);
      });
    };
    restorations.push(() => { channel.readdir = readDirectory; });
  };
  client.sftp = function(callback) {
    return originalSftp.call(this, (error, channel) => { decorate(channel); callback(error, channel); });
  };
  for (const channel of channels) decorate(channel);
  // 写入回调只代表本机数据排出，不当作远端确认；保留返回值及原回调语义。
  socket.write = function(...args) {
    const target = active;
    if (!target) return originalWrite.apply(this, args);
    const started = performance.now(), chunk = args[0];
    const item = {atMs:round(started - target.started), bytes:typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof args[1] === 'string' ? args[1] : undefined) : chunk.byteLength};
    target.sentEvents += 1;
    if (target.send.length < 400) target.send.push(item);
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    args.push(function(...results) {
      item.callbackMs = round(performance.now() - started);
      target.maxWriteCallbackMs = Math.max(target.maxWriteCallbackMs, item.callbackMs);
      if (results[0]) item.failed = true;
      callback?.apply(this, results);
    });
    const accepted = originalWrite.apply(this, args);
    item.backpressure = !accepted;
    item.queuedBytes = this.writableLength;
    target.backpressureEvents += Number(!accepted);
    target.maxQueuedBytes = Math.max(target.maxQueuedBytes, this.writableLength);
    return accepted;
  };
  return {
    async sample(feature, operation) {
      const histogram = monitorEventLoopDelay({ resolution:10 }); histogram.enable();
      await delay(25); histogram.reset();
      const started = performance.now(), cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization();
      active = { started, lastDataAt:started, receivedBytes:0, receivedEvents:0, longestGapMs:0, maxDispatchMs:0, sentEvents:0, maxWriteCallbackMs:0, maxQueuedBytes:0, backpressureEvents:0, send:[], receive:[], reads:[] };
      const target = active, writtenBefore = socket.bytesWritten;
      try { return await operation(); }
      finally {
        active = null; histogram.disable();
        const used = process.cpuUsage(cpu), elapsed = performance.eventLoopUtilization(utilization);
        console.log(JSON.stringify({ feature:feature + '.transport', status:'observed', ms:round(performance.now() - started),
          receivedBytes:target.receivedBytes, writtenBytes:socket.bytesWritten - writtenBefore, receivedEvents:target.receivedEvents,
          longestGapMs:round(target.longestGapMs), maxDataDispatchMs:round(target.maxDispatchMs),
          maxEventLoopDelayMs:round(histogram.max / 1e6), eventLoopUtilization:Number(elapsed.utilization.toFixed(4)),
          cpuMs:round((used.user + used.system) / 1000), sentEvents:target.sentEvents, maxWriteCallbackMs:target.maxWriteCallbackMs,
          maxQueuedBytes:target.maxQueuedBytes, backpressureEvents:target.backpressureEvents,
          send:target.send, sendTruncated:target.sentEvents > target.send.length, receive:target.receive, reads:target.reads,
          receiveTruncated:target.receivedEvents > target.receive.length }));
      }
    },
    dispose() { active = null; socket.removeListener('data', beforeData); socket.removeListener('data', afterData); socket.write = originalWrite; client.sftp = originalSftp; for (const restore of restorations.reverse()) restore(); },
  };
}

// 四次固定目录读取区分同通道、同 TCP 新通道和重连，不改变服务器或产品配置。
export async function probeDirectoryTransport({ runtime, files, plugin, scope, owner, measure, reconnect }) {
  let observation = observeTransport(runtime.broker.requireSession(runtime.key(plugin)).client), previousEntries = null;
  const read = label => measure(label, () => observation.sample(label, async () => {
    const page = await files.listDirectory(owner, { ...scope, path:'/usr/bin', deferLinks:true });
    assert.ok(page.entries.length > 0 && page.entries.length <= 200);
    if (previousEntries) assert.deepEqual(page.entries, previousEntries);
    previousEntries = page.entries;
  }));
  try {
    await read('transport.initial');
    await read('transport.reused-channel');
    const session = runtime.broker.requireSession(runtime.key(plugin));
    assert.ok(session.workspaceReads?.entries.size > 0);
    assert.ok([...session.workspaceReads.entries.values()].every(entry => entry.idle));
    session.workspaceReads.dispose(); delete session.workspaceReads;
    await read('transport.new-channel-same-connection');
    observation.dispose();
    await measure('transport.reconnect-pinned', async () => { await runtime.disconnect(plugin); await reconnect(); });
    observation = observeTransport(runtime.broker.requireSession(runtime.key(plugin)).client);
    await read('transport.new-connection');
  } finally { observation.dispose(); }
}

// 仅本次只读诊断交错协商认证后压缩；保留全部认证、指纹和加密算法设置。
export async function probeDirectoryCompression({ runtime, files, plugin, scope, owner, measure, reconnect, verifyIntegrity = false }) {
  const factory = runtime.broker.clientFactory, negotiated = new WeakMap();
  let enableCompression = false, observation = null, previousEntries = null, previousBinary = null;
  runtime.broker.clientFactory = function() {
    const client = factory.call(this), connect = client.connect;
    client.connect = function(config) {
      return connect.call(this, { ...config, algorithms:{ ...config.algorithms,
        compress:enableCompression ? ['zlib@openssh.com','none'] : ['none'] } });
    };
    client.once('handshake', result => {
      const names = [result.cs.compress, result.sc.compress];
      negotiated.set(client, names);
    });
    return client;
  };
  try {
    for (const [index, enabled] of (verifyIntegrity ? [false,true] : [false,true,true,false]).entries()) {
      observation?.dispose(); observation = null;
      enableCompression = enabled;
      const label = 'compression.' + (enabled ? 'enabled.' : 'disabled.') + index;
      await measure(label + '.connect', async () => { await runtime.disconnect(plugin); await reconnect(); });
      const client = runtime.broker.requireSession(runtime.key(plugin)).client;
      const names = negotiated.get(client); assert.ok(names);
      assert.ok(names.every(name => ['none','zlib@openssh.com'].includes(name)));
      const compressed = names.every(name => name === 'zlib@openssh.com');
      if (!enabled) assert.ok(names.every(name => name === 'none'));
      console.log(JSON.stringify({ feature:label + '.negotiated', status:'observed', requested:enabled, compressed }));
      observation = observeTransport(client);
      for (const kind of ['first','repeat']) {
        await measure(label + '.' + kind, () => observation.sample(label + '.' + kind, async () => {
          const page = await files.listDirectory(owner, { ...scope, path:'/usr/bin', deferLinks:true });
          assert.ok(page.entries.length > 0 && page.entries.length <= 200);
          if (previousEntries) assert.deepEqual(page.entries, previousEntries);
          previousEntries = page.entries;
        }));
      }
      if (verifyIntegrity) {
        if (enabled) assert.equal(compressed, true, '完整性专项必须实际协商认证后压缩');
        const { probeDirectoryPages } = await import('./server-directory-readonly-scenarios.mjs');
        await probeDirectoryPages({ runtime, files, plugin, scope, owner, measure:(feature, operation, options) => measure(label + '.' + feature, operation, options) });
        await measure(label + '.binary-integrity', async () => {
          const value = await runtime.withWorkspaceReadSession(plugin, reader => reader.readBuffer('/usr/bin/ls', 0, 1024 * 1024));
          assert.equal(value.truncated, false); assert.equal(value.content.length, value.size); assert.ok(value.size > 0);
          if (previousBinary) assert.deepEqual(value.content, previousBinary);
          previousBinary = value.content;
          console.log(JSON.stringify({ feature:label + '.binary-bytes', status:'observed', bytes:value.size }));
        });
        if (enabled) {
          const session = runtime.broker.requireSession(runtime.key(plugin)), generation = runtime.status(plugin).generation;
          assert.ok([...session.workspaceReads.entries.values()].every(entry => entry.idle));
          session.workspaceReads.dispose(); delete session.workspaceReads;
          const open = client.sftp, controller = new AbortController();
          let issued = 0, cancelledAt = 0;
          client.sftp = function(callback) {
            return open.call(this, (error, channel) => {
              if (channel) {
                const readdir = channel.readdir;
                channel.readdir = function(...args) {
                  issued += 1; const result = readdir.apply(this, args);
                  if (issued === 1) setImmediate(() => { cancelledAt = performance.now(); controller.abort(); });
                  return result;
                };
              }
              callback(error, channel);
            });
          };
          try {
            await measure(label + '.cancel-active-directory', async () => {
              await assert.rejects(runtime.withWorkspaceReadSession(plugin, reader => reader.listDirectoryEntries('/usr/bin'), {signal:controller.signal}), {code:'TRANSFER_CANCELLED'});
              assert.ok(issued >= 1 && cancelledAt > 0); assert.equal(runtime.status(plugin).connected, true);
              console.log(JSON.stringify({ feature:label + '.cancel-feedback', status:'observed', ms:round(performance.now() - cancelledAt), issued }));
            });
          } finally { controller.abort(); client.sftp = open; }
          await measure(label + '.directory-after-cancel', async () => {
            const page = await files.listDirectory(owner, {...scope, path:'/usr/bin', deferLinks:true});
            assert.deepEqual(page.entries, previousEntries); assert.equal(runtime.status(plugin).generation, generation);
          });
        }
      }
    }
  } finally { observation?.dispose(); runtime.broker.clientFactory = factory; }
}

// 同一 SSH 连接交错测量固定路径，两种会话都在取得通道后计时，不输出远端内容。
export async function probeDirectoryPathPipeline({ runtime, plugin, measure }) {
  let previous = null;
  const samples = [];
  for (const [group, pipeline] of [false,true,true,false].entries()) {
    const withSession = pipeline ? runtime.withWorkspaceReadSession : runtime.withRemoteReadSession;
    await withSession.call(runtime, plugin, async reader => {
      for (let index = 0; index < 4; index += 1) {
        const feature = 'directory.path-pipeline.' + (pipeline ? 'enabled' : 'serial') + '.' + group + '.' + index;
        await measure(feature, async () => {
          const started = performance.now();
          const snapshot = await reader.statPath('/usr/bin');
          const ms = round(performance.now() - started);
          assert.equal(snapshot.type, 'directory'); assert.equal(snapshot.canonicalPath, '/usr/bin');
          if (previous) assert.deepEqual(snapshot, previous);
          previous = snapshot;
          samples.push({pipeline, group, ms});
        });
      }
    });
  }
  console.log(JSON.stringify({feature:'directory.path-pipeline.summary', status:'observed', samples}));
}

// 只在诊断连接公告较小的 SSH 通道包上限；不修改网卡 MTU、TCP 参数或生产默认值。
export async function probeDirectoryPacketSize({ runtime, files, plugin, scope, owner, measure }) {
  const session = runtime.broker.requireSession(runtime.key(plugin));
  const protocol = session.client._protocol, openSession = protocol.session;
  let packetSize = 32768, announcements = 0, previous = null;
  protocol.session = function(channel, initialWindow, maximumPacket) {
    announcements += 1;
    return openSession.call(this, channel, initialWindow, Math.min(maximumPacket, packetSize));
  };
  const observation = observeTransport(session.client);
  try {
    for (const [index, size] of [32768,1024,1024,32768].entries()) {
      if (session.workspaceReads) {
        assert.ok([...session.workspaceReads.entries.values()].every(entry => entry.idle));
        session.workspaceReads.dispose(); delete session.workspaceReads;
      }
      packetSize = size;
      const announcedBefore = announcements, feature = 'directory.packet-size.' + size + '.' + index;
      await measure(feature, () => observation.sample(feature, async () => {
        const page = await files.listDirectory(owner, {...scope,path:'/usr/bin',deferLinks:true});
        assert.equal(announcements, announcedBefore + 1);
        assert.equal(runtime.broker.requireSession(runtime.key(plugin)), session);
        const snapshot = files.directoryCache.snapshots.get(page.snapshotId);
        assert.ok(snapshot?.entries.length > 0 && snapshot.entries.length <= 10000);
        const actual = {entries:snapshot.entries,truncated:snapshot.truncated,canonicalPath:page.canonicalPath};
        if (previous) assert.deepEqual(actual, previous);
        previous = actual;
        console.log(JSON.stringify({feature:feature + '.content',status:'observed',entries:snapshot.entries.length,truncated:snapshot.truncated,advertisedPacketSize:size}));
      }));
    }
  } finally { observation.dispose(); protocol.session = openSession; }
}
