import net from 'node:net';
import dns from 'node:dns/promises';
import { SocksClient } from 'socks';
import { AppError } from './errors.mjs';

function httpAuthority(host, port) {
  const value = String(host);
  const formattedHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `${formattedHost}:${port}`;
}

export async function createProxySocket(proxy, target, secrets = {}, timeoutMs = 15_000) {
  if (!proxy || proxy.type === 'direct') return undefined;
  if (!proxy.host || !proxy.port) {
    throw new AppError('PROXY_CONFIG_INVALID', '代理地址和端口不能为空。');
  }
  if (proxy.type === 'socks5') {
    try {
      const destinationHost = proxy.remoteDns === false
        ? (await dns.lookup(target.host)).address
        : target.host;
      const result = await SocksClient.createConnection({
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
        timeout: timeoutMs,
      });
      return result.socket;
    } catch {
      throw new AppError('PROXY_CONNECTION_FAILED', 'SOCKS5 代理连接失败。');
    }
  }
  if (proxy.type === 'http') {
    return createHttpConnectSocket(proxy, target, secrets, timeoutMs);
  }
  throw new AppError('PROXY_CONFIG_INVALID', '不支持的代理类型。');
}

function createHttpConnectSocket(proxy, target, secrets, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: Number(proxy.port) });
    let settled = false;
    let response = Buffer.alloc(0);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error instanceof AppError ? error : new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理连接失败。'));
    };
    const timer = setTimeout(() => fail(new AppError('PROXY_CONNECTION_FAILED', 'HTTP 代理连接超时。')), timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => {
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
    });
    socket.on('data', (chunk) => {
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
      clearTimeout(timer);
      // Keep the error listener installed after CONNECT succeeds so a reset in
      // the short hand-off window to ssh2 cannot become an uncaught exception.
      socket.removeAllListeners('data');
      const remainder = response.subarray(headerEnd + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve(socket);
    });
  });
}
