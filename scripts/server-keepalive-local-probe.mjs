import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { SshBroker } from '../src/ssh-broker.mjs';

// 仅在回环夹具缩短保活周期；这些参数不代表生产环境的十五秒配置。
const KEEPALIVE_INTERVAL_MS = 200;
const KEEPALIVE_COUNT_MAX = 3;
const ACTIVE_DURATION_MS = 1600;
const SCENARIO_DEADLINE_MS = 5000;
const WRITE_INTERVAL_MS = 20;
const CHUNK_BYTES = 256;
const round = value => Math.round(value * 10) / 10;
const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, (error, value) => error ? reject(error) : resolve(value)));
const failure = code => Object.assign(new Error('本地保活夹具未按预期完成。'), { code });

async function bounded(promise, milliseconds = SCENARIO_DEADLINE_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('LOCAL_DEADLINE')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

const key = crypto.generateKeyPairSync('rsa', {
  modulusLength:2048, privateKeyEncoding:{type:'pkcs1', format:'pem'}, publicKeyEncoding:{type:'spki', format:'pem'},
}).privateKey;
const publicKey = ssh2.utils.parseKey(key).getPublicSSH();
const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/u, '');

async function scenario(kind) {
  const serverClients = new Set(), localClients = new Set();
  const stop = new AbortController();
  const metrics = { keepaliveSent:0, globalSuccess:0, globalFailure:0, channelData:0, sftpSuccess:0, writesSent:0, writesConfirmed:0, serverWrites:0 };
  let started = null, lastWriteAt = null, errorAt = null, errorCategory = null, fixtureErrors = 0;
  let requestObserved, closed, broker, writer, result, globalRequestCount = 0, closeObserved = false, listening = false;
  const requestReady = new Promise(resolve => { requestObserved = resolve; });
  const clientClosed = new Promise(resolve => { closed = resolve; });
  const payload = Buffer.alloc(CHUNK_BYTES, 0x61);
  const safeHandler = operation => (...args) => {
    try { operation(...args); }
    catch { fixtureErrors += 1; for (const client of localClients) client.destroy(); }
  };
  const server = new ssh2.Server({ hostKeys:[key] }, peer => {
    serverClients.add(peer);
    peer.on('close', () => serverClients.delete(peer));
    peer.on('error', () => {});
    peer.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept();
      else context.reject();
    });
    peer.on('request', safeHandler((_accept, reject, name, details) => {
      assert.equal(name, 'tcpip-forward'); assert.equal(details.bindAddr, '127.0.0.1'); assert.equal(details.bindPort, 0);
      globalRequestCount += 1;
      // ssh2 服务端按全局请求顺序回复；只挂起此公开请求，不创建端口监听。
      // 后续 keepalive 的自动拒绝回复留在该队列后，SFTP 通道响应仍可继续。
      if (kind === 'normal-replies') reject();
      requestObserved();
    }));
    peer.on('ready', () => peer.on('session', safeHandler(accept => {
      const session = accept();
      session.on('sftp', safeHandler(approve => {
        const sftp = approve(), handle = Buffer.from([1]);
        sftp.on('error', () => {});
        sftp.on('OPEN', safeHandler((id, selected) => {
          assert.equal(selected, '/synthetic.bin'); sftp.handle(id, handle);
        }));
        sftp.on('WRITE', safeHandler((id, selected, offset, data) => {
          assert.deepEqual(selected, handle); assert.deepEqual(data, payload);
          assert.equal(offset, metrics.serverWrites * CHUNK_BYTES);
          assert.ok(metrics.serverWrites < 256);
          metrics.serverWrites += 1;
          sftp.status(id, 0);
        }));
        sftp.on('CLOSE', safeHandler((id, selected) => { assert.deepEqual(selected, handle); sftp.status(id, 0); }));
      }));
    })));
  });
  server.on('error', () => { fixtureErrors += 1; });
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { listening = true; server.removeListener('error', reject); resolve(); });
    }));
    const config = { limits:{commandTimeoutSeconds:5}, ssh:{host:'127.0.0.1', port:server.address().port, username:'fixture', hostKeyFingerprint:fingerprint}, auth:{type:'password'}, proxy:{type:'direct'} };
    broker = new SshBroker({get:async () => config, appendAudit:async () => {}});
    const originalFactory = broker.clientFactory;
    broker.clientFactory = function() {
      const client = originalFactory.call(this), connect = client.connect;
      localClients.add(client);
      client.on('close', () => { closeObserved = true; stop.abort(); closed(); });
      client.on('error', error => {
        if (started === null || errorCategory) return;
        errorAt = performance.now();
        errorCategory = error.level === 'client-timeout' && error.message === 'Keepalive timeout' ? 'keepalive-timeout' : 'other';
      });
      client.connect = function(settings) {
        return connect.call(this, { ...settings, keepaliveInterval:KEEPALIVE_INTERVAL_MS, keepaliveCountMax:KEEPALIVE_COUNT_MAX,
          // 调试正文仅匹配固定类别，既不保存也不输出。
          debug:raw => {
            if (started === null || typeof raw !== 'string') return;
            if (raw === 'Outbound: Sending ping (GLOBAL_REQUEST: keepalive@openssh.com)') metrics.keepaliveSent += 1;
            else if (raw === 'Inbound: REQUEST_SUCCESS') metrics.globalSuccess += 1;
            else if (raw === 'Inbound: Received REQUEST_FAILURE') metrics.globalFailure += 1;
            else if (/^Inbound: CHANNEL_DATA \(r:\d+, \d+\)$/u.test(raw)) metrics.channelData += 1;
            else if (/^SFTP: Inbound: Received STATUS \(id:\d+, 0, /u.test(raw)) metrics.sftpSuccess += 1;
          },
        });
      };
      return client;
    };
    await bounded(broker.connect('fixture', {password:'fixture-password'}));
    const client = broker.requireSession('fixture').client;
    const sftp = await bounded(call(client, 'sftp'));
    sftp.on('error', () => {});
    const handle = await bounded(call(sftp, 'open', '/synthetic.bin', 'w'));
    // 此转发请求只触发夹具的挂起回复，不会接受或建立任何新监听端口。
    client.forwardIn('127.0.0.1', 0, () => {});
    await bounded(requestReady);
    started = performance.now();
    // 只读套接字累计字节验证静默，不拦截协议、套接字方法或正文。
    const socket = client._sock, inboundStart = socket.bytesRead;
    if (kind !== 'silent-peer') {
      writer = (async () => {
        while (!stop.signal.aborted && performance.now() - started < ACTIVE_DURATION_MS) {
          const offset = metrics.writesSent * CHUNK_BYTES;
          metrics.writesSent += 1;
          await call(sftp, 'write', handle, payload, 0, payload.length, offset);
          metrics.writesConfirmed += 1; lastWriteAt = performance.now();
          await delay(WRITE_INTERVAL_MS, undefined, {signal:stop.signal});
        }
      })();
      // 断线时写回调会拒绝；预先观察，避免等待 close 期间产生未处理拒绝。
      writer.catch(() => {});
    }
    if (kind === 'normal-replies') {
      await bounded(writer);
      assert.equal(broker.status('fixture').connected, true);
      assert.equal(errorCategory, null); assert.ok(metrics.keepaliveSent >= 3);
      assert.ok(metrics.globalFailure >= 3); assert.ok(metrics.writesConfirmed >= 10);
      assert.equal(metrics.writesSent, metrics.writesConfirmed);
    } else {
      await bounded(clientClosed);
      await bounded(writer?.catch(() => {}) ?? Promise.resolve());
      assert.equal(errorCategory, 'keepalive-timeout'); assert.equal(broker.status('fixture').connected, false);
      assert.equal(metrics.globalSuccess, 0); assert.equal(metrics.globalFailure, 0);
      assert.equal(metrics.keepaliveSent, KEEPALIVE_COUNT_MAX);
      if (kind === 'delayed-replies-active-sftp') {
        assert.ok(metrics.writesConfirmed >= 5); assert.ok(metrics.sftpSuccess >= 5);
        assert.ok(errorAt - lastWriteAt < KEEPALIVE_INTERVAL_MS * 2);
        assert.ok(metrics.channelData > 0);
      } else {
        assert.equal(metrics.writesConfirmed, 0); assert.equal(metrics.channelData, 0); assert.equal(metrics.sftpSuccess, 0);
        assert.equal(socket.bytesRead - inboundStart, 0);
      }
    }
    assert.equal(fixtureErrors, 0); assert.equal(globalRequestCount, 1);
    result = {feature:'local.keepalive', scenario:kind, status:'passed', elapsedMs:round(performance.now() - started),
      closeCause:errorCategory ?? 'none', lastSuccessBeforeErrorMs:errorAt !== null && lastWriteAt !== null ? round(errorAt - lastWriteAt) : null,
      keepaliveIntervalMs:KEEPALIVE_INTERVAL_MS, keepaliveCountMax:KEEPALIVE_COUNT_MAX, productionTiming:false,
      inboundBytes:socket.bytesRead - inboundStart, successfulWriteBytes:metrics.writesConfirmed * CHUNK_BYTES, ...metrics};
  } finally {
    stop.abort();
    for (const client of localClients) client.destroy();
    for (const peer of serverClients) peer.end();
    // ssh2.Server 没有公开 listening 属性；显式记录成功监听并总是关闭已启动的服务。
    const cleanup = await Promise.allSettled([
      bounded(writer?.catch(() => {}) ?? Promise.resolve()),
      broker ? bounded(broker.closeAll()) : Promise.resolve(),
      listening ? bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))) : Promise.resolve(),
      localClients.size ? bounded(clientClosed) : Promise.resolve(),
    ]);
    for (const item of cleanup) if (item.status === 'rejected') throw item.reason;
    assert.equal(serverClients.size, 0);
    assert.equal(server.address(), null);
    if (result) Object.assign(result, {clientClosed:closeObserved, serverClosed:true, activeServerClients:serverClients.size, filesystemArtifacts:0});
  }
  return result;
}

let passed = 0;
try {
  for (const kind of ['normal-replies', 'delayed-replies-active-sftp', 'silent-peer']) {
    console.log(JSON.stringify(await scenario(kind))); passed += 1;
  }
  console.log(JSON.stringify({feature:'local.keepalive.summary', status:'passed', scenarios:passed, externalRequests:0, privateProtocolHooks:0}));
} catch (error) {
  const code = ['ERR_ASSERTION', 'LOCAL_DEADLINE', 'LOCAL_FIXTURE_FAILURE'].includes(error?.code) ? error.code : 'UNKNOWN_ERROR';
  const line = /server-keepalive-local-probe\.mjs:(\d+):/u.exec(String(error?.stack ?? ''))?.[1];
  console.log(JSON.stringify({feature:'local.keepalive.summary', status:'failed', scenarios:passed, code, ...(line ? {line:Number(line)} : {})})); process.exitCode = 1;
}
