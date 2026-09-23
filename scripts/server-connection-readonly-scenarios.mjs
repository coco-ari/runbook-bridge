import assert from 'node:assert/strict';

// 仅取消本探针自己的 SSH 连接；不试错密码、不访问其他目标、不改变服务器配置。
export async function probeConnectionCancellation({ runtime, files, plugin, scope, owner, measure, reconnect }) {
  const broker = runtime.broker, resource = runtime.key(plugin), originalFactory = broker.clientFactory;
  let timer, controller, clients = 0, handshakeReached = false, handshakeAbortStarted = 0, cancellationAfterHandshakeMs = null, stopped = false;
  const active = () => { if (stopped) throw Object.assign(new Error('连接取消采样已停止'), { code:'CONNECTION_CANCEL_PROBE_TIMEOUT' }); };
  const measureCurrent = (feature, operation) => measure(feature, async () => { active(); const value = await operation(); active(); return value; });
  try {
    const run = async () => {
      await measureCurrent('connection-cancel.disconnect-initial', () => runtime.disconnect(plugin));
      await measureCurrent('connection-cancel.before-start', async () => {
        const before = clients, aborted = new AbortController(); aborted.abort();
        broker.clientFactory = function(...args) { clients += 1; return originalFactory.apply(this, args); };
        await assert.rejects(reconnect({ signal:aborted.signal }), error => ['CONNECT_CANCELLED', 'SSH_CONNECTION_CANCELLED'].includes(error.code));
        assert.equal(clients, before); assert.equal(runtime.status(plugin).connected, false);
      });
      await measureCurrent('connection-cancel.at-handshake', async () => {
        controller = new AbortController();
        broker.clientFactory = function(...args) {
          clients += 1;
          const client = originalFactory.apply(this, args);
          // 在已固定指纹连接的实际 SSH 握手阶段取消，不记录任何协商或服务器身份数据。
          client.once('handshake', () => { handshakeReached = true; handshakeAbortStarted = performance.now(); controller.abort(); });
          return client;
        };
        await assert.rejects(reconnect({ signal:controller.signal }), error => ['CONNECT_CANCELLED', 'SSH_CONNECTION_CANCELLED'].includes(error.code));
        assert.equal(handshakeReached, true); assert.equal(clients, 1);
        cancellationAfterHandshakeMs = Math.round((performance.now() - handshakeAbortStarted) * 10) / 10;
        assert.equal(runtime.status(plugin).connected, false);
        assert.equal(broker.pendingConnections.has(resource), false);
      });
      broker.clientFactory = originalFactory;
      await measureCurrent('connection-cancel.reconnect-pinned', () => reconnect());
      await measureCurrent('connection-cancel.read-after-recovery', async () => {
        const info = await files.fileInfo(owner, { ...scope, path:'/etc/hostname' });
        assert.equal(info.type, 'file'); assert.equal(runtime.status(plugin).connected, true);
        assert.equal(files.readCounts.get(owner) ?? 0, 0);
      });
      await measureCurrent('connection-cancel.final-disconnect', async () => {
        await runtime.disconnect(plugin);
        assert.equal(runtime.status(plugin).connected, false);
        assert.equal(broker.pendingConnections.has(resource), false);
      });
      console.log(JSON.stringify({ feature:'connection-cancel.summary', status:'observed', handshakeReached, cancellationAfterHandshakeMs, cancelledClients:clients, recovered:true }));
    };
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { stopped = true; controller?.abort(); reject(Object.assign(new Error('连接取消采样超过时限'), { code:'CONNECTION_CANCEL_PROBE_TIMEOUT' })); }, 90_000); });
    await Promise.race([run(), deadline]);
  } finally { stopped = true; clearTimeout(timer); controller?.abort(); broker.clientFactory = originalFactory; }
}
