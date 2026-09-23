import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CLIENTS = 16;
const MAX_EVENTS = 16;
const TERMINAL_EVENTS = new Set(['client.close', 'socket.close', 'observer.dispose']);
const COUNTER_LIMIT = 1_000_000_000;
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'ENOTCONN', 'EADDRNOTAVAIL', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE']);
const ERROR_LEVELS = new Set(['client-socket', 'client-timeout', 'client-dns', 'client-authentication', 'agent', 'handshake', 'protocol', 'sftp-protocol']);
const CATEGORIES = ['sftpWrite', 'sftpWriteSent', 'sftpWriteBuffered', 'sftpStatus', 'sftpStatusSuccess', 'sftpStatusEof', 'sftpStatusFailure', 'keepaliveOutbound', 'keepaliveInbound', 'requestSuccess', 'requestFailure', 'channelSuccess', 'channelFailure', 'windowInbound', 'windowOutbound', 'channelDataInbound', 'channelDataOutbound', 'disconnectInbound', 'disconnectOutbound'];
const rounded = value => Math.round(Math.max(0, value) * 10) / 10;
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const reasonCode = value => Number.isInteger(value) && value >= 1 && value <= 15 ? value : null;
const safe = operation => { try { return operation(); } catch { return undefined; } };
const byteCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function publicError(error) {
  const code = ERROR_CODES.has(error?.code) ? error.code : 'other';
  const level = ERROR_LEVELS.has(error?.level) ? error.level : 'other';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 512) : '';
  const messageCategory = /keepalive/iu.test(message) ? 'keepalive'
    : code === 'ETIMEDOUT' || /timeout|timed out/iu.test(message) ? 'timeout'
      : code === 'ECONNRESET' || /connection reset|socket hang up/iu.test(message) ? 'reset'
        : ['protocol', 'sftp-protocol', 'handshake'].includes(level) ? 'protocol' : 'other';
  return { errorCode:code, errorLevel:level, messageCategory, sshDisconnectReason:level === 'sftp-protocol' ? null : reasonCode(error?.code) };
}

// 规则只匹配本地 ssh2 的固定调试前缀；STATUS 和 DISCONNECT 后的远端正文绝不保存或输出。
function classifyDebug(state, raw) {
  if (typeof raw !== 'string') return;
  const text = raw.slice(0, 256);
  const hit = category => {
    const item = state.protocol[category], elapsedMs = state.elapsed();
    item.count = Math.min(COUNTER_LIMIT, item.count + 1);
    item.firstMs ??= elapsedMs; item.lastMs = elapsedMs;
  };
  let match;
  if ((match = /^SFTP: Outbound: (Sent|Buffered) WRITE \(id:(\d{1,10})\)$/u.exec(text)) && uint32(Number(match[2]))) {
    hit('sftpWrite'); hit(match[1] === 'Sent' ? 'sftpWriteSent' : 'sftpWriteBuffered');
  } else if ((match = /^SFTP: Inbound: Received STATUS \(id:(\d{1,10}), (\d{1,10}), /u.exec(text)) && uint32(Number(match[1])) && uint32(Number(match[2]))) {
    const code = Number(match[2]);
    hit('sftpStatus'); hit(code === 0 ? 'sftpStatusSuccess' : code === 1 ? 'sftpStatusEof' : 'sftpStatusFailure');
  } else if (text === 'Outbound: Sending ping (GLOBAL_REQUEST: keepalive@openssh.com)') hit('keepaliveOutbound');
  else if (text === 'Inbound: GLOBAL_REQUEST (keepalive@openssh.com)') hit('keepaliveInbound');
  else if (text === 'Inbound: REQUEST_SUCCESS') hit('requestSuccess');
  else if (text === 'Inbound: Received REQUEST_FAILURE') hit('requestFailure');
  else if ((match = /^Inbound: CHANNEL_(SUCCESS|FAILURE) \(r:(\d{1,10})\)$/u.exec(text)) && uint32(Number(match[2]))) hit(match[1] === 'SUCCESS' ? 'channelSuccess' : 'channelFailure');
  else if ((match = /^(Inbound: |Outbound: Sending )CHANNEL_(WINDOW_ADJUST|DATA) \(r:(\d{1,10}), (\d{1,10})\)$/u.exec(text)) && uint32(Number(match[3])) && uint32(Number(match[4]))) {
    hit((match[2] === 'WINDOW_ADJUST' ? 'window' : 'channelData') + (match[1] === 'Inbound: ' ? 'Inbound' : 'Outbound'));
  } else if ((match = /^Inbound: Received DISCONNECT \((\d{1,2}), /u.exec(text)) && reasonCode(Number(match[1])) !== null) {
    state.sshDisconnectReason = Number(match[1]); hit('disconnectInbound');
  } else if ((match = /^Outbound: Sending DISCONNECT \((\d{1,2})\)$/u.exec(text)) && reasonCode(Number(match[1])) !== null) {
    hit('disconnectOutbound');
  } else state.unclassified = Math.min(COUNTER_LIMIT, state.unclassified + 1);
}

function restoreProperty(target, name, wrapper, descriptor) {
  if (target[name] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else delete target[name];
}

// 仅显式 enabled:true 启用；最多观察十六个客户端，每个客户端最多十六条生命周期快照。
export function installProbeConnectionObserver(runtime, { enabled = false, emit = record => console.log(JSON.stringify(record)) } = {}) {
  if (enabled !== true) return () => {};
  const broker = safe(() => runtime.broker), originalFactory = safe(() => broker.clientFactory);
  if (typeof originalFactory !== 'function') return () => {};
  const factoryDescriptor = Object.getOwnPropertyDescriptor(broker, 'clientFactory');
  const active = new Set(), seen = new WeakSet();
  let disposed = false, sequence = 0, capacityReported = false;
  const send = record => safe(() => emit(record));
  const attach = client => {
    if (!client || typeof client.connect !== 'function' || typeof client.on !== 'function' || seen.has(client)) return;
    seen.add(client);
    if (sequence >= MAX_CLIENTS) {
      if (!capacityReported) { capacityReported = true; send({feature:'probe.connection', event:'capacity', clientsObserved:sequence}); }
      return;
    }
    const started = performance.now(), connect = client.connect, descriptor = Object.getOwnPropertyDescriptor(client, 'connect');
    const state = { client, id:++sequence, open:true, events:0, droppedEvents:0, errors:0, unclassified:0, socket:null, terminalEvents:new Set(),
      protocol:Object.fromEntries(CATEGORIES.map(key => [key, {count:0, firstMs:null, lastMs:null}])),
      elapsed:() => rounded(performance.now() - started), listeners:[], debug:null, previousDebug:undefined, sshDisconnectReason:null };
    active.add(state);
    const listen = (target, event, handler) => {
      const guarded = (...args) => safe(() => { if (state.open && !disposed) handler(...args); });
      target.on(event, guarded); state.listeners.push([target, event, guarded]);
    };
    const snapshot = (event, extra = {}) => {
      const terminal = TERMINAL_EVENTS.has(event);
      if (terminal && state.terminalEvents.has(event)) return;
      // 为关闭和卸载预留三条快照，重复普通事件不能挤掉最终状态。
      if (state.events >= (terminal ? MAX_EVENTS : MAX_EVENTS - TERMINAL_EVENTS.size)) { state.droppedEvents = Math.min(COUNTER_LIMIT, state.droppedEvents + 1); return; }
      if (terminal) state.terminalEvents.add(event);
      state.events += 1;
      const socket = state.socket ?? client._sock;
      send({ feature:'probe.connection', client:state.id, event, elapsedMs:state.elapsed(),
        bytesRead:byteCount(socket?.bytesRead), bytesWritten:byteCount(socket?.bytesWritten),
        unclassifiedDebug:state.unclassified, droppedEvents:state.droppedEvents, sshDisconnectReason:state.sshDisconnectReason,
        protocol:Object.fromEntries(CATEGORIES.filter(key => state.protocol[key].count > 0).map(key => [key, {...state.protocol[key]}])), ...extra });
    };
    const release = () => {
      if (!state.open) return;
      state.open = false; active.delete(state);
      for (const [target, event, handler] of state.listeners.splice(0)) safe(() => target.removeListener(event, handler));
      safe(() => restoreProperty(client, 'connect', wrappedConnect, descriptor));
      safe(() => { if (state.debug && client.config?.debug === state.debug) client.config.debug = state.previousDebug; });
    };
    state.release = release;
    state.snapshot = snapshot;
    const attachSocket = () => {
      const socket = client._sock;
      if (state.socket || !socket || typeof socket.on !== 'function') return;
      state.socket = socket;
      listen(socket, 'timeout', () => snapshot('socket.timeout'));
      listen(socket, 'end', () => snapshot('socket.end'));
      listen(socket, 'close', hadError => { snapshot('socket.close', {hadError:typeof hadError === 'boolean' ? hadError : null}); release(); });
    };
    function wrappedConnect(config, ...args) {
      if (!state.open || disposed) return connect.call(this, config, ...args);
      let observedConfig = config;
      safe(() => {
        state.previousDebug = config?.debug;
        state.debug = raw => safe(() => { if (state.open && !disposed) classifyDebug(state, raw); });
        // 诊断期间只消费白名单分类，不转发原始 debug；结束后恢复原回调和方法。
        observedConfig = {...config, debug:state.debug};
        snapshot('connect.start');
      });
      try {
        const result = connect.call(this, observedConfig, ...args);
        safe(attachSocket);
        return result;
      } catch (error) {
        safe(() => snapshot('connect.throw', publicError(error)));
        safe(release);
        throw error;
      }
    }
    try {
      client.connect = wrappedConnect;
      listen(client, 'connect', () => { attachSocket(); snapshot('client.connect'); });
      listen(client, 'ready', () => { attachSocket(); snapshot('client.ready'); });
      listen(client, 'error', error => {
        if (state.errors >= 4) { state.droppedEvents = Math.min(COUNTER_LIMIT, state.droppedEvents + 1); return; }
        state.errors += 1; snapshot('client.error', publicError(error));
      });
      listen(client, 'timeout', () => snapshot('client.timeout'));
      listen(client, 'end', () => snapshot('client.end'));
      listen(client, 'close', hadError => {
        attachSocket(); snapshot('client.close', {hadError:typeof hadError === 'boolean' ? hadError : null});
        if (!state.socket) release();
      });
    } catch { safe(release); }
  };
  function factory(...args) {
    const client = originalFactory.apply(this, args);
    if (!disposed) safe(() => attach(client));
    return client;
  }
  if (!safe(() => { broker.clientFactory = factory; return broker.clientFactory === factory; })) {
    disposed = true;
    return () => {};
  }
  return () => {
    if (disposed) return;
    for (const state of [...active]) { safe(() => state.snapshot('observer.dispose')); safe(state.release); }
    disposed = true;
    safe(() => restoreProperty(broker, 'clientFactory', factory, factoryDescriptor));
  };
}

async function selfTest() {
  const {default:assert} = await import('node:assert/strict');
  const {EventEmitter} = await import('node:events');
  const canary = 'SYNTHETIC_PRIVATE_CANARY';
  class Client extends EventEmitter {
    connect(config) {
      this.config = config; this._sock = new EventEmitter(); this._sock.bytesRead = 1024; this._sock.bytesWritten = 2048;
      this.emit('connect'); return this;
    }
  }
  const clients = [], runtime = {broker:{clientFactory:() => { const client = new Client(); client.on('error', () => {}); clients.push(client); return client; }}};
  const originalFactory = runtime.broker.clientFactory, originalConnect = Client.prototype.connect, output = [];
  const disabled = installProbeConnectionObserver(runtime);
  assert.equal(runtime.broker.clientFactory, originalFactory); disabled();
  const dispose = installProbeConnectionObserver(runtime, {enabled:true, emit:record => output.push(JSON.stringify(record))});
  const client = runtime.broker.clientFactory(), priorDebug = () => { throw new Error(canary); };
  const config = {host:canary, username:canary, password:canary, readyTimeout:20000, keepaliveInterval:15000, keepaliveCountMax:3, debug:priorDebug};
  assert.equal(client.connect(config), client);
  assert.equal(config.debug, priorDebug);
  assert.deepEqual({...client.config, debug:priorDebug}, config);
  const debug = client.config.debug;
  for (let index = 0; index < 1000; index += 1) {
    debug('SFTP: Outbound: Sent WRITE (id:' + index + ')');
    debug('SFTP: Inbound: Received STATUS (id:' + index + ', 0, "' + canary + '")');
  }
  debug('SFTP: Outbound: Buffered WRITE (id:1000)');
  debug('SFTP: Inbound: Received STATUS (id:1000, 3, "' + canary + '")');
  debug('SFTP: Inbound: Received STATUS (id:1001, 1, "' + canary + '")');
  debug('Outbound: Sending ping (GLOBAL_REQUEST: keepalive@openssh.com)');
  debug('Inbound: Received REQUEST_FAILURE');
  debug('Inbound: CHANNEL_WINDOW_ADJUST (r:0, 1024)');
  debug('Inbound: Received DISCONNECT (11, "' + canary + '")');
  debug('Remote ident: ' + canary);
  client.emit('ready');
  client.emit('error', Object.assign(new Error(canary + ' connection reset'), {code:'ECONNRESET', level:'client-socket'}));
  client.emit('error', Object.assign(new Error(canary), {code:11, level:canary}));
  client.emit('error', Object.assign(new Error(canary), {code:canary, level:canary}));
  client.emit('timeout'); client._sock.emit('timeout'); client.emit('end'); client._sock.emit('end');
  client.emit('close'); client._sock.emit('close', true);
  const records = output.map(value => JSON.parse(value)), last = records.at(-1);
  assert.equal(output.some(value => value.includes(canary)), false);
  assert.equal(last.event, 'socket.close'); assert.equal(last.hadError, true);
  assert.equal(last.bytesRead, 1024); assert.equal(last.bytesWritten, 2048);
  assert.equal(last.protocol.sftpWrite.count, 1001);
  assert.equal(last.protocol.sftpStatusSuccess.count, 1000); assert.equal(last.protocol.sftpStatusFailure.count, 1); assert.equal(last.protocol.sftpStatusEof.count, 1);
  assert.ok(last.protocol.sftpWrite.firstMs <= last.protocol.sftpWrite.lastMs);
  assert.ok(last.protocol.sftpStatus.firstMs <= last.protocol.sftpStatus.lastMs);
  assert.equal(last.sshDisconnectReason, 11);
  assert.ok(records.some(value => value.errorCode === 'ECONNRESET' && value.errorLevel === 'client-socket' && value.messageCategory === 'reset'));
  assert.ok(records.some(value => value.errorCode === 'other' && value.errorLevel === 'other'));
  assert.equal(client.connect, originalConnect); assert.equal(Object.hasOwn(client, 'connect'), false);
  assert.equal(client.config.debug, priorDebug);
  assert.equal(client.listenerCount('error'), 1); assert.equal(client._sock.listenerCount('close'), 0);
  const before = output.length; debug(canary); assert.equal(output.length, before);
  const second = runtime.broker.clientFactory(); second.connect(config);
  for (let index = 0; index < 100; index += 1) second.emit('timeout');
  assert.ok(output.length - before <= MAX_EVENTS);
  const late = second.config.debug;
  second.emit('close'); second._sock.emit('close', false);
  assert.equal(JSON.parse(output.at(-1)).event, 'socket.close');
  assert.equal(JSON.parse(output.at(-1)).hadError, false);
  assert.ok(output.length - before <= MAX_EVENTS);
  dispose(); dispose();
  assert.equal(runtime.broker.clientFactory, originalFactory); assert.equal(second.connect, originalConnect); assert.equal(second.config.debug, priorDebug);
  const after = output.length; late(canary); assert.equal(output.length, after);
  const throwingDispose = installProbeConnectionObserver(runtime, {enabled:true, emit:() => { throw new Error(canary); }});
  const third = runtime.broker.clientFactory();
  assert.doesNotThrow(() => third.connect(config)); assert.doesNotThrow(() => third.emit('error', new Error(canary))); assert.doesNotThrow(throwingDispose);
  assert.equal(runtime.broker.clientFactory, originalFactory);
  const capOutput = [], capDispose = installProbeConnectionObserver(runtime, {enabled:true, emit:record => capOutput.push(record)});
  const many = Array.from({length:MAX_CLIENTS + 3}, () => runtime.broker.clientFactory());
  assert.equal(many.at(-1).connect, originalConnect);
  assert.equal(capOutput.filter(record => record.event === 'capacity').length, 1);
  capDispose();
  assert.ok(capOutput.length <= MAX_CLIENTS * MAX_EVENTS + 1);
  console.log(JSON.stringify({feature:'probe.connection.self-test', status:'passed', classifiedWrites:last.protocol.sftpWrite.count, classifiedStatuses:last.protocol.sftpStatus.count, observedClients:MAX_CLIENTS, maxEventsPerClient:MAX_EVENTS, rawCanaryLeaks:0, externalRequests:0}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.includes('--self-test')) {
  selfTest().catch(() => { console.error(JSON.stringify({feature:'probe.connection.self-test', status:'failed'})); process.exitCode = 1; });
}
