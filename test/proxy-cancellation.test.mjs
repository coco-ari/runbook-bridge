import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { getEventListeners, once } from 'node:events';
import { SocksClient } from 'socks';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnectionSocket, createProxySocket } from '../src/proxy.mjs';

async function proxyFixture(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { host: '127.0.0.1', port: server.address().port };
}

function socksHandshake(socket, banner, { authenticate = false, onAuthentication = () => {} } = {}) {
  let stage = 0, buffered = Buffer.alloc(0);
  socket.on('data', function receive(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    if (stage === 0) {
      if (buffered.length < 2 + buffered[1]) return;
      assert.equal(buffered[0], 5);
      if (authenticate) assert.ok(buffered.subarray(2, 2 + buffered[1]).includes(2));
      buffered = buffered.subarray(2 + buffered[1]);
      socket.write(Buffer.from([5, authenticate ? 2 : 0]));
      stage = authenticate ? 1 : 2;
    }
    if (stage === 1) {
      if (buffered.length < 2 || buffered.length < 3 + buffered[1]) return;
      const passwordOffset = 2 + buffered[1];
      if (buffered.length < passwordOffset + 1 + buffered[passwordOffset]) return;
      onAuthentication(buffered.subarray(2, passwordOffset).toString(), buffered.subarray(passwordOffset + 1, passwordOffset + 1 + buffered[passwordOffset]).toString());
      buffered = buffered.subarray(passwordOffset + 1 + buffered[passwordOffset]);
      socket.write(Buffer.from([1, 0]));
      stage = 2;
    }
    if (stage !== 2 || buffered.length < 10) return;
    assert.deepEqual([...buffered.subarray(0, 8)], [5, 1, 0, 1, 127, 0, 0, 1]);
    assert.equal(buffered.readUInt16BE(8), 22);
    socket.removeListener('data', receive);
    socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]), banner]));
  });
}

test('TCP 建连在底层地址解析未返回时可取消，迟到地址不会触发连接', async t => {
  let accepted = 0, lookupCallback, lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const target = await proxyFixture(t, () => { accepted += 1; });
  const controller = new AbortController();
  const connecting = createConnectionSocket({
    host: 'fixture.invalid', port: target.port,
    lookup: (_host, _options, callback) => { lookupCallback = callback; lookupStarted(); },
  }, 5000, { signal: controller.signal });
  const rejected = assert.rejects(connecting, { code: 'CONNECT_CANCELLED' });
  await started;
  controller.abort(new Error('fixture-private-reason'));
  await rejected;
  lookupCallback(null, [{ address: '127.0.0.1', family: 4 }]);
  await delay(30);
  assert.equal(accepted, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('HTTP 失败与提前关闭清理产品超时器和取消监听，不附带认证信息', async t => {
  for (const failure of ['rejected', 'closed', 'oversized', 'timeout']) {
    await t.test(failure, async child => {
      const timers = new Set();
      const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
      child.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
        const timer = realSet(callback, milliseconds, ...args);
        if (milliseconds === 5000 || milliseconds === 30) timers.add(timer);
        return timer;
      });
      child.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return realClear(timer); });
      const address = await proxyFixture(child, socket => socket.once('data', data => {
        assert.match(data.toString(), /Proxy-Authorization: Basic /u);
        if (failure === 'rejected') socket.write('HTTP/1.1 407 Denied\r\n\r\nfixture-private-upstream-output');
        else if (failure === 'closed') socket.end();
        else if (failure === 'oversized') socket.write(Buffer.alloc(65537, 65));
      }));
      const controller = new AbortController();
      await assert.rejects(createProxySocket({ type: 'http', ...address, username: 'fixture-user' }, { host: '127.0.0.1', port: 22 },
        { proxyPassword: 'fixture-private-password' }, failure === 'timeout' ? 30 : 5000, { signal: controller.signal }), error => {
        assert.equal(error.code, 'PROXY_CONNECTION_FAILED');
        assert.ok(!JSON.stringify(error).includes('fixture-private'));
        return true;
      });
      assert.equal(timers.size, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
});

for (const type of ['http', 'socks5']) {
  test(`${type} 暂停交接在消费端延迟绑定时保留完整 SSH 首包与代理认证`, async t => {
    const banner = Buffer.from('SSH-2.0-fixture-banner\r\n');
    let authenticated = false;
    const address = await proxyFixture(t, socket => {
      if (type === 'socks5') {
        socksHandshake(socket, banner, { authenticate: true, onAuthentication: (username, password) => {
          assert.equal(username, 'fixture-user'); assert.equal(password, 'fixture-password'); authenticated = true;
        } });
      } else socket.once('data', data => {
        assert.match(data.toString(), /^CONNECT 127\.0\.0\.1:22 HTTP\/1\.1/u);
        assert.ok(data.toString().includes(Buffer.from('fixture-user:fixture-password').toString('base64')));
        authenticated = true;
        socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), banner]));
      });
    });
    const controller = new AbortController();
    const socket = await createProxySocket({ type, ...address, username: 'fixture-user' }, { host: '127.0.0.1', port: 22 },
      { proxyPassword: 'fixture-password' }, 1500, { signal: controller.signal, pauseOnConnect: true });
    t.after(() => socket.destroy());
    await delay(30);
    assert.equal(authenticated, true);
    assert.equal(socket.readableFlowing, false);
    assert.equal(socket.readableLength, banner.length);
    const received = once(socket, 'data');
    socket.resume();
    assert.deepEqual((await received)[0], banner);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    assert.equal(socket.destroyed, false);
    const closed = once(socket, 'close');
    socket.destroy(new Error('fixture-handoff-reset'));
    await closed.catch(error => assert.equal(error.message, 'fixture-handoff-reset'));
    await delay(0);
    assert.equal(socket.listenerCount('error'), 0);
  });
}

test('SOCKS5 拒绝认证后返回稳定错误并关闭连接', async t => {
  let serverClosed;
  const closed = new Promise(resolve => { serverClosed = resolve; });
  const address = await proxyFixture(t, socket => {
    socket.once('close', serverClosed);
    socket.once('data', () => socket.write(Buffer.from([5, 255])));
  });
  const controller = new AbortController();
  await assert.rejects(createProxySocket({ type: 'socks5', ...address }, { host: '127.0.0.1', port: 22 }, {}, 1500, { signal: controller.signal }), { code: 'PROXY_CONNECTION_FAILED' });
  await closed;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('SOCKS5 交接回调期间取消或关闭释放 socket 与临时监听', async t => {
  for (const mode of ['cancel', 'close', 'reset']) {
    await t.test(mode, async child => {
      const address = await proxyFixture(child, socket => socksHandshake(socket, Buffer.from('SSH-2.0-fixture\r\n')));
      const controller = new AbortController();
      const original = SocksClient.createConnection;
      let socket;
      child.mock.method(SocksClient, 'createConnection', async options => {
        const result = await original.call(SocksClient, options);
        socket = result.socket;
        setImmediate(() => {
          if (mode === 'cancel') controller.abort(new Error('fixture-private-cancel'));
          else socket.destroy(mode === 'reset' ? new Error('fixture-private-reset') : undefined);
        });
        return result;
      });
      await assert.rejects(createProxySocket({ type: 'socks5', ...address }, { host: '127.0.0.1', port: 22 }, {}, 1500,
        { signal: controller.signal, pauseOnConnect: true }), error => {
        assert.equal(error.code, mode === 'cancel' ? 'CONNECT_CANCELLED' : 'PROXY_CONNECTION_FAILED');
        assert.ok(!JSON.stringify(error).includes('fixture-private'));
        return true;
      });
      await delay(0);
      assert.equal(socket.destroyed, true);
      assert.equal(socket.listenerCount('data'), 0);
      assert.equal(socket.listenerCount('error'), 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
});
