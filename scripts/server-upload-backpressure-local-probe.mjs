import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { SshBroker } from '../src/ssh-broker.mjs';
import { abortable, writeUploadBlocks, UPLOAD_BLOCK_BYTES, UPLOAD_WINDOW_BLOCKS } from '../src/server-upload-transfer.mjs';

// 仅诊断回环背压，缩短的保活周期不代表生产十五秒配置。
const KEEPALIVE_INTERVAL_MS = 200, KEEPALIVE_COUNT_MAX = 3;
const fastFourMib = process.argv.includes('--fast-4m');
const fastOnly = fastFourMib || process.argv.includes('--fast');
const openSshProfile = process.argv.includes('--openssh-profile');
const RATE_BYTES = 128 * 1024, FILE_BYTES = (fastFourMib ? 4 : 1) * 1024 * 1024 + 32;
const DEADLINE_MS = 30000, QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;
const round = value => Math.round(value * 10) / 10;
const failure = code => Object.assign(new Error('本地背压夹具未按预期完成。'), {code});
const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, (error, value) => error ? reject(error) : resolve(value)));
async function bounded(promise, milliseconds = DEADLINE_MS) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('LOCAL_DEADLINE')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

class PacedSocket extends Duplex {
  constructor(socket) {
    super({allowHalfOpen:false, writableHighWaterMark:16 * 1024});
    this.socket = socket; this.connecting = false; this.rate = 0; this.nextAt = 0;
    this.timer = null; this.active = null; this.maxWritableLength = 0; this.backpressureWrites = 0; this.drains = 0;
    socket.setNoDelay(true);
    socket.on('data', chunk => { if (!this.push(chunk)) socket.pause(); });
    socket.on('end', () => this.push(null));
    socket.on('close', () => this.destroy());
    socket.on('error', error => this.destroy(error));
    this.on('drain', () => { this.drains += 1; });
    this.on('error', () => {});
  }
  get bytesRead() { return this.socket.bytesRead; }
  setNoDelay(value) { this.socket.setNoDelay(value); return this; }
  setKeepAlive(...args) { this.socket.setKeepAlive(...args); return this; }
  setTimeout(...args) { this.socket.setTimeout(...args); return this; }
  _read() { this.socket.resume(); }
  write(...args) {
    const accepted = super.write(...args);
    this.maxWritableLength = Math.max(this.maxWritableLength, this.writableLength);
    if (!accepted) this.backpressureWrites += 1;
    if (this.writableLength > QUEUE_LIMIT_BYTES) this.destroy(failure('LOCAL_QUEUE_LIMIT'));
    return accepted;
  }
  _write(chunk, encoding, callback) {
    let offset = 0, finished = false;
    const finish = error => { if (finished) return; finished = true; this.active = null; callback(error); };
    this.active = finish;
    const send = () => {
      this.timer = null;
      if (this.destroyed) { finish(failure('LOCAL_CLOSED')); return; }
      const end = this.rate ? Math.min(chunk.length, offset + 2048) : chunk.length;
      const part = chunk.subarray(offset, end);
      if (this.rate) this.nextAt = Math.max(this.nextAt, performance.now()) + part.length * 1000 / this.rate;
      this.socket.write(part, encoding, error => {
        if (finished) return;
        if (error) { finish(error); return; }
        offset = end;
        if (offset === chunk.length) finish();
        else schedule();
      });
    };
    const schedule = () => {
      const wait = this.rate ? Math.max(0, this.nextAt - performance.now()) : 0;
      if (wait > 0) this.timer = setTimeout(send, wait);
      else send();
    };
    schedule();
  }
  _final(callback) { this.socket.end(callback); }
  _destroy(error, callback) {
    clearTimeout(this.timer); this.timer = null;
    this.socket.destroy(); this.active?.(error ?? failure('LOCAL_CLOSED'));
    callback(error);
  }
  begin(rate) {
    this.rate = rate; this.nextAt = performance.now();
    this.maxWritableLength = 0; this.backpressureWrites = 0; this.drains = 0;
  }
}

const key = crypto.generateKeyPairSync('rsa', {modulusLength:2048, privateKeyEncoding:{type:'pkcs1', format:'pem'}, publicKeyEncoding:{type:'spki', format:'pem'}}).privateKey;
const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/u, '');
const payload = Buffer.alloc(FILE_BYTES);
for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

// 仅在本地实验保留原32块算法，用作同文件对照，不改变生产入口。
async function writeFixedBlocks({sftp, handle, localHandle, size, hash, signal, onAcknowledged}) {
  let position = 0, acknowledged = 0;
  while (position < size) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_BLOCK_BYTES * UPLOAD_WINDOW_BLOCKS, size - position));
    let filled = 0;
    while (filled < buffer.length) {
      const {bytesRead} = await localHandle.read(buffer, filled, buffer.length - filled, position + filled);
      if (!bytesRead) throw failure('LOCAL_READ_FAILED');
      filled += bytesRead; signal?.throwIfAborted();
    }
    hash.update(buffer);
    const writes = [];
    for (let offset = 0; offset < buffer.length; offset += UPLOAD_BLOCK_BYTES) {
      const bytes = Math.min(UPLOAD_BLOCK_BYTES, buffer.length - offset);
      writes.push(call(sftp, 'write', handle, buffer, offset, bytes, position + offset).then(() => {
        if (signal?.aborted) return;
        acknowledged += bytes; onAcknowledged?.(acknowledged);
      }));
    }
    await abortable(Promise.all(writes), signal); signal?.throwIfAborted(); position += buffer.length;
  }
  return {bytes:position, sha256:hash.digest('hex')};
}

async function scenario(kind, rate, algorithm, writeAckDelayMs = 0) {
  const peers = new Set(), peerClosures = [], clients = new Set(), ackTimers = new Set(), stop = new AbortController();
  const received = Buffer.alloc(FILE_BYTES), metrics = {keepaliveSent:0, globalReplies:0, serverWritePackets:0, serverWriteBytes:0, acknowledgedBytes:0, firstMibAckMs:null, successfulStatuses:0, maxQueueAtKeepalive:0};
  let socket, rawSocket, broker, writer, listening = false, started = null, lastAckAt = null, lastStatusAt = null;
  let closeCause = 'none', errorAt = null, fixtureErrors = 0, result, closed, closeObserved = false;
  const clientClosed = new Promise(resolve => { closed = resolve; });
  const safe = operation => (...args) => { try { operation(...args); } catch { fixtureErrors += 1; stop.abort(); for (const client of clients) client.destroy(); } };
  const server = new ssh2.Server({hostKeys:[key], ...(openSshProfile ? {ident:'OpenSSH_9.6'} : {})}, peer => {
    peers.add(peer); peerClosures.push(new Promise(resolve => peer.once('close', () => { peers.delete(peer); resolve(); }))); peer.on('error', () => {});
    peer.on('authentication', context => context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password' ? context.accept() : context.reject());
    // 不截留全局请求，也不修改保活回复；仅对真实加密出站流统一限速。
    peer.on('ready', () => peer.on('session', safe(accept => {
      const session = accept();
      session.on('sftp', safe(approve => {
        const sftp = approve(), handle = Buffer.from([1]); sftp.on('error', () => {});
        sftp.on('OPEN', safe((id, selected) => { assert.equal(selected, '/synthetic.bin'); sftp.handle(id, handle); }));
        sftp.on('WRITE', safe((id, selected, offset, data) => {
          assert.deepEqual(selected, handle); assert.ok(offset >= 0 && offset + data.length <= FILE_BYTES);
          assert.deepEqual(data, payload.subarray(offset, offset + data.length));
          data.copy(received, offset); metrics.serverWritePackets += 1; metrics.serverWriteBytes += data.length;
          if (writeAckDelayMs) {
            const timer = setTimeout(() => { ackTimers.delete(timer); if (!stop.signal.aborted) sftp.status(id, 0); }, writeAckDelayMs);
            ackTimers.add(timer);
          } else sftp.status(id, 0);
        }));
        sftp.on('CLOSE', safe((id, selected) => { assert.deepEqual(selected, handle); sftp.status(id, 0); }));
      }));
    })));
  });
  server.on('error', () => { fixtureErrors += 1; });
  try {
    await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { listening = true; server.removeListener('error', reject); resolve(); }); }), 5000);
    rawSocket = net.connect({host:'127.0.0.1', port:server.address().port});
    rawSocket.on('error', () => {});
    await bounded(new Promise((resolve, reject) => { rawSocket.once('connect', resolve); rawSocket.once('error', reject); }), 5000);
    socket = new PacedSocket(rawSocket);
    const config = {limits:{commandTimeoutSeconds:5}, ssh:{host:'127.0.0.1', port:server.address().port, username:'fixture', hostKeyFingerprint:fingerprint}, auth:{type:'password'}, proxy:{type:'direct'}};
    broker = new SshBroker({get:async () => config, appendAudit:async () => {}});
    const factory = broker.clientFactory;
    broker.clientFactory = function() {
      const client = factory.call(this), connect = client.connect; clients.add(client);
      client.on('close', () => { closeObserved = true; stop.abort(); closed(); });
      client.on('error', error => {
        if (started === null || closeCause !== 'none') return;
        errorAt = performance.now(); closeCause = error.level === 'client-timeout' && error.message === 'Keepalive timeout' ? 'keepalive-timeout' : 'other';
      });
      client.connect = function(settings) {
        return connect.call(this, {...settings, keepaliveInterval:KEEPALIVE_INTERVAL_MS, keepaliveCountMax:KEEPALIVE_COUNT_MAX, debug:raw => {
          // 仅计数固定类别，不保存或输出协议正文、路径或认证材料。
          if (started === null || typeof raw !== 'string') return;
          if (raw === 'Outbound: Sending ping (GLOBAL_REQUEST: keepalive@openssh.com)') { metrics.keepaliveSent += 1; metrics.maxQueueAtKeepalive = Math.max(metrics.maxQueueAtKeepalive, socket.writableLength); }
          else if (raw === 'Inbound: REQUEST_SUCCESS' || raw === 'Inbound: Received REQUEST_FAILURE') metrics.globalReplies += 1;
          else if (/^SFTP: Inbound: Received STATUS \(id:\d+, 0, /u.test(raw)) { metrics.successfulStatuses += 1; lastStatusAt = performance.now(); }
        }});
      };
      return client;
    };
    await bounded(broker.connect('fixture', {password:'fixture-password'}, {sock:socket}), 5000);
    const sftp = await bounded(call(broker.requireSession('fixture').client, 'sftp'), 5000); sftp.on('error', () => {});
    const handle = await bounded(call(sftp, 'open', '/synthetic.bin', 'w'), 5000);
    const localHandle = {read:async (target, offset, length, position) => ({bytesRead:payload.copy(target, offset, position, position + length)})};
    started = performance.now(); socket.begin(rate);
    const hash = crypto.createHash('sha256');
    const options = {sftp, handle, localHandle, hash, size:FILE_BYTES, writeScope:broker.requireSession('fixture').client, signal:stop.signal,
      onAcknowledged:bytes => { metrics.acknowledgedBytes = bytes; lastAckAt = performance.now(); if (metrics.firstMibAckMs === null && bytes >= 1024 * 1024) metrics.firstMibAckMs = round(lastAckAt - started); }};
    writer = (algorithm === 'fixed-32' ? writeFixedBlocks : writeUploadBlocks)(options);
    let transfer, transferError = 'none';
    try { transfer = await bounded(writer); }
    catch (error) { transferError = stop.signal.aborted ? 'aborted' : ['LOCAL_DEADLINE', 'LOCAL_QUEUE_LIMIT'].includes(error?.code) ? error.code : 'other'; }
    const transferMs = round(performance.now() - started);
    if (transfer) {
      assert.equal(transfer.bytes, FILE_BYTES); assert.equal(transfer.sha256, expectedHash);
      assert.deepEqual(received, payload); assert.equal(metrics.serverWriteBytes, FILE_BYTES);
      await bounded(call(sftp, 'close', handle));
      await delay(KEEPALIVE_INTERVAL_MS * 2 + 50);
      assert.equal(broker.status('fixture').connected, true);
    }
    assert.equal(fixtureErrors, 0);
    result = {feature:'local.upload-backpressure', scenario:kind, status:'observed', productionTiming:false, keepaliveIntervalMs:KEEPALIVE_INTERVAL_MS, keepaliveCountMax:KEEPALIVE_COUNT_MAX,
      inputBytes:FILE_BYTES, serverImplementation:'ssh2-fixture', serverProfile:openSshProfile ? 'openssh-ident-fixture' : 'ssh2-default', algorithm, maxWindowBlocks:UPLOAD_WINDOW_BLOCKS, writeAckDelayMs, rateBytesPerSecond:rate, transferMs, complete:Boolean(transfer), integrityVerified:Boolean(transfer), transferError, closeCause,
      lastAckBeforeErrorMs:errorAt !== null && lastAckAt !== null ? round(errorAt - lastAckAt) : null,
      lastStatusBeforeErrorMs:errorAt !== null && lastStatusAt !== null ? round(errorAt - lastStatusAt) : null,
      maxWritableLength:socket.maxWritableLength, backpressureWrites:socket.backpressureWrites, drains:socket.drains, ...metrics};
  } finally {
    stop.abort(); for (const timer of ackTimers) clearTimeout(timer); ackTimers.clear();
    for (const client of clients) client.destroy(); socket?.destroy(); rawSocket?.destroy();
    for (const peer of peers) peer.end();
    const cleanup = await Promise.allSettled([
      bounded(writer?.catch(() => {}) ?? Promise.resolve(), 5000), broker ? bounded(broker.closeAll(), 5000) : Promise.resolve(),
      listening ? bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000) : Promise.resolve(),
      clients.size ? bounded(clientClosed, 5000) : Promise.resolve(), bounded(Promise.all(peerClosures), 5000),
    ]);
    for (const item of cleanup) if (item.status === 'rejected') throw item.reason;
    assert.equal(peers.size, 0); assert.equal(server.address(), null); assert.equal(socket?.timer ?? null, null);
    if (result) Object.assign(result, {clientClosed:closeObserved, serverClosed:true, activeServerClients:peers.size, activePacingTimers:0, activeAckTimers:ackTimers.size, filesystemArtifacts:0});
  }
  return result;
}

const results = [];
try {
  const cases = fastOnly ? [
    ['ack80-fixed', 0, 'fixed-32', 80], ['ack80-adaptive', 0, 'adaptive', 80],
  ] : [
    ['unthrottled-fixed', 0, 'fixed-32', 0], ['unthrottled-adaptive', 0, 'adaptive', 0],
    ['ack80-fixed', 0, 'fixed-32', 80], ['ack80-adaptive', 0, 'adaptive', 80],
    ['throttled-fixed', RATE_BYTES, 'fixed-32', 0], ['throttled-adaptive', RATE_BYTES, 'adaptive', 0],
  ];
  for (const [kind, rate, algorithm, latency] of cases) {
    const result = await scenario(kind, rate, algorithm, latency); results.push(result); console.log(JSON.stringify(result));
  }
  for (const result of results) if (!result.scenario.startsWith('throttled-')) assert.equal(result.complete, true);
  const supported = !fastOnly && !results[4].complete && results[4].closeCause === 'keepalive-timeout' && results[4].successfulStatuses > 0 && results[5].complete;
  const fixed = results.find(result => result.scenario === 'ack80-fixed');
  const adaptive = results.find(result => result.scenario === 'ack80-adaptive');
  console.log(JSON.stringify({feature:'local.upload-backpressure.summary', status:'passed', scenarios:results.length, inputBytes:FILE_BYTES, backlogExplanation:fastOnly ? 'not-tested' : supported ? 'supported-locally' : 'not-supported-by-this-comparison',
    ...(!fastOnly ? {noDelayTimeRatio:round(results[1].transferMs / results[0].transferMs)} : {}), ack80TimeRatio:round(adaptive.transferMs / fixed.transferMs), ack80ExtraMs:round(adaptive.transferMs - fixed.transferMs), realTargetCausalityProven:false, externalRequests:0}));
} catch (error) {
  const code = ['ERR_ASSERTION', 'LOCAL_DEADLINE', 'LOCAL_QUEUE_LIMIT'].includes(error?.code) ? error.code : 'UNKNOWN_ERROR';
  const line = /server-upload-backpressure-local-probe\.mjs:(\d+):/u.exec(String(error?.stack ?? ''))?.[1];
  console.log(JSON.stringify({feature:'local.upload-backpressure.summary', status:'failed', scenarios:results.length, code, ...(line ? {line:Number(line)} : {})})); process.exitCode = 1;
}
