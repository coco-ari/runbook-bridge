import net from 'node:net';
import dns from 'node:dns/promises';
import { SocksClient } from 'socks';
import { AppError } from './errors.mjs';

function httpAuthority(host, port) {
  const value = String(host);
  const formattedHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `${formattedHost}:${port}`;
}

function connectionCancelled() {
  return new AppError('CONNECT_CANCELLED', '连接已取消。');
}

export function waitForConnection(operation, signal, onAbort = () => {}) {
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { onAbort(); finish(connectionCancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (signal.aborted) throw connectionCancelled();
      return operation();
    }).then(value => finish(null, value), error => finish(error));
  });
}

export function createConnectionSocket(options, timeoutMs, { signal = null } = {}) {
  if (signal?.aborted) return Promise.reject(connectionCancelled());
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options);
    // 交接给代理协议或 SSH 之前也可能复位；错误监听不捕获凭据，关闭时回收。
    const ignoreError = () => {};
    socket.on('error', ignoreError);
    socket.once('close', () => socket.removeListener('error', ignoreError));
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.removeListener('connect', connected);
      socket.removeListener('error', fail);
      socket.removeListener('close', closed);
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const connected = () => finish();
    const fail = error => finish(error);
    const closed = () => finish(Object.assign(new Error('连接已关闭。'), { code: 'ECONNRESET' }));
    const abort = () => finish(connectionCancelled());
    const timer = setTimeout(() => finish(Object.assign(new Error('连接超时。'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.once('connect', connected);
    socket.once('error', fail);
    socket.once('close', closed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function pauseSocksHandoff(socket, signal) {
  const chunks = [];
  const capture = chunk => { chunks.push(chunk); socket.pause(); };
  let immediate;
  socket.pause();
  socket.on('data', capture);
  try {
    // socks 会在下一轮重放握手后的数据并恢复流动；先接住这些字节，再交给 SSH 主动恢复。
    await waitForConnection(() => new Promise(resolve => { immediate = setImmediate(resolve); }), signal, () => {
      clearImmediate(immediate);
      socket.destroy();
    });
  } finally {
    socket.pause();
    socket.removeListener('data', capture);
  }
  if (socket.destroyed || socket.readableEnded) throw new AppError('PROXY_CONNECTION_FAILED', 'SOCKS5 代理在连接交接前关闭。');
  if (chunks.length) socket.unshift(Buffer.concat(chunks));
}

export async function createProxySocket(proxy, target, secrets = {}, timeoutMs = 15_000, { signal = null, pauseOnConnect = false } = {}) {
  if (signal?.aborted) throw connectionCancelled();
  if (!proxy || proxy.type === 'direct') return undefined;
  if (!proxy.host || !proxy.port) {
    throw new AppError('PROXY_CONFIG_INVALID', '代理地址和端口不能为空。');
  }
  if (proxy.type === 'socks5') {
    let socket;
    try {
      const destinationHost = proxy.remoteDns === false
        ? (await waitForConnection(() => dns.lookup(target.host), signal)).address
        : target.host;
      const deadline = Date.now() + timeoutMs;
      socket = await createConnectionSocket({ host: proxy.host, port: Number(proxy.port) }, timeoutMs, { signal });
      const result = await waitForConnection(() => SocksClient.createConnection({
        proxy: {
          host: proxy.host,
          port: Number(proxy.port),
          type: 5,
          ...(proxy.username
            ? { userId: proxy.username, password: String(secrets.proxyPassword ?? '') }
            : {}),
        },
        command: 'connect',
        destination: { host: destinationHost, port: target.port },
        timeout: Math.max(1, deadline - Date.now()),
        existing_socket: socket,
      }), signal, () => socket.destroy());
      if (signal?.aborted) throw connectionCancelled();
      if (pauseOnConnect) await pauseSocksHandoff(result.socket, signal);
      return result.socket;
    } catch (error) {
      socket?.destroy();
      if (signal?.aborted || error?.code === 'CONNECT_CANCELLED') throw connectionCancelled();
      throw new AppError('PROXY_CONNECTION_FAILED', 'SOCKS5 代理连接失败。');
    }
  }
  if (proxy.type === 'http') {
    return createHttpConnectSocket(proxy, target, secrets, timeoutMs, signal, pauseOnConnect);
  }
  throw new AppError('PROXY_CONFIG_INVALID', '不支持的代理类型。');
}

function createHttpConnectSocket(proxy, target, secrets, timeoutMs, signal, pauseOnConnect) {
  if (signal?.aborted) return Promise.reject(connectionCancelled());
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: Number(proxy.port) });
    // 交接期的连接复位仍需处理；独立监听不保留代理凭据，关闭时回收。
    const ignoreError = () => {};
    socket.on('error', ignoreError);
    socket.once('close', () => socket.removeListener('error', ignoreError));
    let settled = false;
    let response = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.removeListener('error', fail);
      socket.removeListener('connect', onConnect);
      socket.removeListener('close', closed);
      socket.removeListener('end', closed);
      socket.removeListener('data', onData);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof AppError ? error : new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理连接失败。'));
    };
    const timer = setTimeout(() => fail(new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理连接超时。')), timeoutMs);
    const abort = () => fail(connectionCancelled());
    const closed = () => fail(new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理在握手完成前关闭连接。'));
    const onConnect = () => {
      const authority = httpAuthority(target.host, target.port);
      const headers = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        'Proxy-Connection: Keep-Alive',
      ];
      if (proxy.username) {
        const auth = Buffer.from(`${proxy.username}:${String(secrets.proxyPassword ?? '')}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${auth}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    };
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 64 * 1024) {
        fail(new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理响应过大。'));
        return;
      }
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = response.subarray(0, headerEnd).toString('latin1');
      const match = /^HTTP\/\d\.\d\s+(\d{3})/i.exec(header);
      if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) {
        fail(new AppError('PROXY_CONNECTION_FAILED', `HTTP 代理拒绝连接（${match?.[1] ?? '未知状态'}）。`));
        return;
      }
      settled = true;
      cleanup();
      if (pauseOnConnect) socket.pause();
      const remainder = response.subarray(headerEnd + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve(socket);
    };
    socket.once('error', fail);
    socket.once('connect', onConnect);
    socket.once('close', closed);
    socket.once('end', closed);
    socket.on('data', onData);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
