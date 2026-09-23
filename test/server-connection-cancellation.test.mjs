import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';

function fixture(uplink, resolver) {
  const plugin = {
    projectId: 'connection-probe', environmentId: 'local', pluginInstanceId: 'server',
    pluginType: 'server', configState: 'ready', revision: 1,
    target: { host: '127.0.0.1', port: 22, hostKeyFingerprint: 'fixture-pinned-key' },
    auth: { type: 'password', username: 'fixture' }, uplink, limits: { timeoutMs: 1500 },
  };
  const runtime = new ServerPluginRuntime({}, { load: async () => null }, {
    resolver: resolver ?? { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
  });
  let sshCalls = 0;
  runtime.broker.connect = async () => { sshCalls += 1; return { connected: true }; };
  return { plugin, runtime, sshCalls: () => sshCalls };
}

async function settledWithin(promise, milliseconds = 400) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => ({ error: { code: 'PROBE_DEADLINE' } })),
    ]);
  } finally { controller.abort(); }
}

async function localProxy(t, onRequest = () => {}) {
  const sockets = new Set();
  let received;
  const requested = new Promise(resolve => { received = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', chunk => { received(socket); onRequest(socket, chunk); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requested, sockets };
}

test('连接在地址解析等待中取消后及时结束，迟到解析不能继续连接', async () => {
  let resolveAddresses, started;
  const resolving = new Promise(resolve => { started = resolve; });
  const addresses = new Promise(resolve => { resolveAddresses = resolve; });
  const h = fixture({ type: 'direct' }, { resolve: () => { started(); return addresses; } });
  const controller = new AbortController();
  const connecting = h.runtime.connect(h.plugin, { password: 'fixture-password' }, { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  await resolving;
  try {
    controller.abort(new Error('fixture-private-cancel-reason'));
    const result = await settledWithin(connecting);
    assert.equal(result.error?.code, 'CONNECT_CANCELLED');
    assert.ok(!result.error.message.includes('fixture-private-cancel-reason'));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(h.runtime.connectAttempts.size, 0);
  } finally { resolveAddresses([]); await connecting; }
  assert.equal(h.sshCalls(), 0);
});

for (const type of ['http', 'socks5']) {
  test(`${type} 代理握手等待中取消及时结束并释放连接`, async t => {
    const proxy = await localProxy(t);
    const h = fixture({ type, host: '127.0.0.1', port: proxy.port });
    const controller = new AbortController();
    const connecting = h.runtime.connect(h.plugin, { password: 'fixture-password' }, { signal: controller.signal })
      .then(value => ({ value }), error => ({ error }));
    const socket = await proxy.requested;
    const closed = new Promise(resolve => socket.once('close', () => resolve({ closed: true })));
    controller.abort(new Error('fixture-private-cancel-reason'));
    const result = await settledWithin(connecting);
    assert.equal(result.error?.code, 'CONNECT_CANCELLED');
    assert.ok(!result.error.message.includes('fixture-private-cancel-reason'));
    assert.equal((await settledWithin(closed)).closed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(h.runtime.connectAttempts.size, 0);
    assert.equal(h.sshCalls(), 0);
  });
}

test('新的连接尝试中止旧代理握手，旧取消和强制清理不影响新连接', async t => {
  let requests = 0, newSocket;
  const proxy = await localProxy(t, socket => {
    requests += 1;
    if (requests === 2) socket.write('HTTP/1.1 200 OK\r\n\r\n');
  });
  const h = fixture({ type: 'http', host: '127.0.0.1', port: proxy.port });
  let brokerCancels = 0;
  h.runtime.broker.cancelPendingConnection = () => { brokerCancels += 1; };
  h.runtime.broker.connect = async (_resource, _secrets, options) => { newSocket = options.sock; return { connected: true }; };
  const oldController = new AbortController();
  const old = h.runtime.connect(h.plugin, { password: 'fixture-password' }, { signal: oldController.signal, attemptToken: 'old' })
    .then(value => ({ value }), error => ({ error }));
  const oldSocket = await proxy.requested;
  const oldClosed = new Promise(resolve => oldSocket.once('close', () => resolve({ closed: true })));
  const fresh = await h.runtime.connect(h.plugin, { password: 'fixture-password' }, { attemptToken: 'new' });
  assert.equal(fresh.connected, true);
  assert.equal((await settledWithin(old)).error?.code, 'CONNECT_CANCELLED');
  assert.equal((await settledWithin(oldClosed)).closed, true);
  assert.equal(h.runtime.connectAttempts.get(h.runtime.key(h.plugin)), 'new');
  assert.equal(h.runtime.connectionControllers.size, 0);
  const cancelledBefore = brokerCancels;
  oldController.abort();
  assert.equal(brokerCancels, cancelledBefore);
  assert.equal(newSocket.destroyed, false);
  const stale = await h.runtime.forceDisconnect(h.plugin, 'stale-cleanup', { attemptToken: 'old' });
  assert.equal(stale.stale, true);
  assert.equal(newSocket.destroyed, false);
  assert.equal(getEventListeners(oldController.signal, 'abort').length, 0);
});

test('取消后迟到的非空地址结果不会建立 TCP 或 SSH', async t => {
  const proxy = await localProxy(t);
  let release, announce;
  const started = new Promise(resolve => { announce = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = fixture({ type: 'direct' }, { resolve: () => { announce(); return pending; } });
  h.plugin.target.port = proxy.port;
  const controller = new AbortController();
  const rejected = assert.rejects(h.runtime.connect(h.plugin, { password: 'fixture-password' }, { signal: controller.signal }), { code: 'CONNECT_CANCELLED' });
  await started;
  controller.abort();
  await rejected;
  release([{ address: '127.0.0.1', family: 4 }]);
  await delay(30);
  assert.equal(proxy.sockets.size, 0);
  assert.equal(h.sshCalls(), 0);
});

test('诊断连接在指纹覆盖更新后取消仍清理自身配置与 socket', async () => {
  const h = fixture({ type: 'direct' });
  h.plugin.pluginInstanceId = 'diagnostic-server';
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  h.runtime.createUplinkSocket = async () => socket;
  const controller = new AbortController();
  h.runtime.broker.connect = async resource => {
    await h.runtime.adapter.update(resource, { ssh: { hostKeyFingerprint: 'fixture-updated-key' } });
    controller.abort();
    return { connected: true };
  };
  await assert.rejects(h.runtime.connect(h.plugin, { password: 'fixture-password' }, { signal: controller.signal }), { code: 'CONNECT_CANCELLED' });
  assert.equal(socket.destroyed, true);
  assert.equal(h.runtime.adapter.overrides.size, 0);
  assert.equal(h.runtime.adapter.overrideOwners.size, 0);
  assert.equal(h.runtime.connectionControllers.size, 0);
});

test('旧诊断断开等待不清除使用同一配置对象的新连接及新指纹覆盖', async () => {
  const h = fixture({ type: 'direct' });
  h.plugin.pluginInstanceId = 'diagnostic-server';
  h.runtime.createUplinkSocket = async () => ({ destroy() {} });
  await h.runtime.connect(h.plugin, { password: 'fixture-password' }, { attemptToken: 'old' });
  let releaseDisconnect;
  h.runtime.broker.disconnect = () => new Promise(resolve => { releaseDisconnect = resolve; });
  const disconnecting = h.runtime.disconnect(h.plugin);
  await h.runtime.connect(h.plugin, { password: 'fixture-password' }, { attemptToken: 'new' });
  const resource = h.runtime.key(h.plugin);
  await h.runtime.adapter.update(resource, { ssh: { hostKeyFingerprint: 'fixture-new-key' } });
  releaseDisconnect({ connected: false });
  await disconnecting;
  assert.equal(h.runtime.connectAttempts.get(resource), 'new');
  assert.equal(h.runtime.adapter.overrides.get(resource).target.hostKeyFingerprint, 'fixture-new-key');
  assert.equal(h.runtime.adapter.overrideOwners.size, 1);
  h.runtime.broker.disconnect = async () => ({ connected: false });
  await h.runtime.disconnect(h.plugin);
  assert.equal(h.runtime.adapter.overrides.size, 0);
  assert.equal(h.runtime.adapter.overrideOwners.size, 0);
});

test('预先取消不加载凭据或发起地址解析', async () => {
  const h = fixture({ type: 'direct' }, { resolve: () => assert.fail('取消后不得解析目标') });
  h.runtime.credentialVault.load = () => assert.fail('取消后不得读取凭据');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.runtime.connect(h.plugin, {}, { signal: controller.signal }), { code: 'CONNECT_CANCELLED' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(h.runtime.connectionControllers.size, 0);
  assert.equal(h.runtime.connectAttempts.size, 0);
});


test('整体关闭取消仍在地址解析的诊断连接，迟到解析不能发布 SSH', async () => {
  let release, announce;
  const started = new Promise(resolve => { announce = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = fixture({ type: 'direct' }, { resolve: () => { announce(); return pending; } });
  h.plugin.pluginInstanceId = 'diagnostic-server';
  const connecting = h.runtime.connect(h.plugin, { password: 'fixture-password' }).then(value => ({ value }), error => ({ error }));
  await started;
  try {
    await h.runtime.closeAll();
    assert.equal((await settledWithin(connecting)).error?.code, 'CONNECT_CANCELLED');
    assert.equal(h.runtime.connectionControllers.size, 0);
    assert.equal(h.runtime.connectAttempts.size, 0);
    assert.equal(h.runtime.adapter.overrides.size, 0);
    assert.equal(h.runtime.adapter.overrideOwners.size, 0);
  } finally { release([]); await connecting; }
  assert.equal(h.sshCalls(), 0);
});


test('整体关闭的迟到收尾保留后来显式建立的新连接与诊断覆盖', async () => {
  const h = fixture({ type: 'direct' });
  h.plugin.pluginInstanceId = 'diagnostic-server';
  h.runtime.createUplinkSocket = async () => ({ destroy() {} });
  await h.runtime.connect(h.plugin, { password: 'fixture-password' }, { attemptToken: 'old' });
  let releaseClose;
  h.runtime.broker.closeAll = () => new Promise(resolve => { releaseClose = resolve; });
  const closing = h.runtime.closeAll();
  await h.runtime.connect(h.plugin, { password: 'fixture-password' }, { attemptToken: 'new' });
  releaseClose();
  await closing;
  const resource = h.runtime.key(h.plugin);
  assert.equal(h.runtime.connectAttempts.get(resource), 'new');
  assert.equal(h.runtime.adapter.overrides.size, 1);
  assert.equal(h.runtime.adapter.overrideOwners.size, 1);
  h.runtime.broker.closeAll = async () => {};
  await h.runtime.closeAll();
  assert.equal(h.runtime.connectAttempts.size, 0);
  assert.equal(h.runtime.adapter.overrides.size, 0);
  assert.equal(h.runtime.adapter.overrideOwners.size, 0);
});
