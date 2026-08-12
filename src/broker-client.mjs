import crypto from 'node:crypto';
import net from 'node:net';
import { AppError } from './errors.mjs';
import { brokerEndpoint } from './paths.mjs';
import { readBrokerToken } from './broker-auth.mjs';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export async function callBroker(dataRoot, method, params = {}, timeoutMs = 300_000) {
  let token;
  try {
    token = await readBrokerToken(dataRoot);
  } catch {
    throw new AppError('DESKTOP_UNAVAILABLE', '桌面工具未运行，请先启动 AI 运维工具。');
  }
  const endpoint = brokerEndpoint(dataRoot);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const id = crypto.randomUUID();
    let buffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => finish(new AppError('BROKER_TIMEOUT', '桌面工具响应超时。')),
      timeoutMs,
    );
    socket.once('error', () => finish(new AppError('DESKTOP_UNAVAILABLE', '无法连接桌面工具。')));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, auth: token, method, params })}\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(new AppError('BROKER_RESPONSE_TOO_LARGE', '桌面工具返回内容过大。'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id) throw new Error('response id mismatch');
        if (!response.ok) {
          finish(new AppError(response.error?.code ?? 'BROKER_ERROR', response.error?.message ?? '操作失败。', response.error?.details));
        } else {
          finish(null, response.result);
        }
      } catch {
        finish(new AppError('BROKER_PROTOCOL_ERROR', '桌面工具返回了无效响应。'));
      }
    });
  });
}
