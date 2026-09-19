import net from 'node:net';
import { BoundedRespDecoder } from '../../src/redis-workspace-reader.mjs';

export function resp(value) {
  if (value === null) return Buffer.from('$-1\r\n');
  if (Number.isInteger(value)) return Buffer.from(':' + value + '\r\n');
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('*' + value.length + '\r\n'), ...value.map(resp)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from('$' + bytes.length + '\r\n'), bytes, Buffer.from('\r\n')]);
}

export async function redisProtocolFixture(handler) {
  const sockets = new Set();
  const calls = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let decoder = new BoundedRespDecoder();
    socket.on('data', async (chunk) => {
      try {
        if (!decoder.push(chunk)) return;
        const args = decoder.value.map((value) => value.toString('utf8'));
        decoder = new BoundedRespDecoder();
        // 认证材料不进入调用记录；测试只检查是否使用正确的固定 DB。
        if (args[0] !== 'AUTH') calls.push(args);
        const result = args[0] === 'AUTH' || args[0] === 'SELECT' ? 'OK' : await handler(args, socket);
        if (!socket.destroyed && result !== undefined) socket.write(result?.raw ?? resp(result));
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, calls, sockets, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  } };
}
