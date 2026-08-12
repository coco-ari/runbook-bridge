import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createProxySocket } from '../src/proxy.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function roundTrip(socket, message) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('data', (data) => resolve(data.toString('utf8')));
    socket.write(message);
  });
}

async function echoTarget(t) {
  const server = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(server);
  t.after(() => closeServer(server));
  return port;
}

test('HTTP CONNECT proxy opens a transparent TCP tunnel', async (t) => {
  const targetPort = await echoTarget(t);
  const proxy = net.createServer((client) => {
    let buffer = '';
    client.on('data', function onData(chunk) {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.removeListener('data', onData);
      const match = /^CONNECT\s+([^:]+):(\d+)/i.exec(buffer);
      const upstream = net.createConnection({ host: match[1], port: Number(match[2]) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const socket = await createProxySocket(
    { type: 'http', host: '127.0.0.1', port: proxyPort },
    { host: '127.0.0.1', port: targetPort },
  );
  assert.equal(await roundTrip(socket, 'http-proxy-ok'), 'http-proxy-ok');
  socket.destroy();
});

test('SOCKS5 proxy opens a transparent TCP tunnel', async (t) => {
  const targetPort = await echoTarget(t);
  const proxy = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    client.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || buffer.length < 7) return;
      const atyp = buffer[3];
      let host;
      let offset;
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.');
        offset = 8;
      } else if (atyp === 3) {
        const length = buffer[4];
        if (buffer.length < 7 + length) return;
        host = buffer.subarray(5, 5 + length).toString('utf8');
        offset = 5 + length;
      } else return client.destroy();
      const port = buffer.readUInt16BE(offset);
      client.removeListener('data', onData);
      const upstream = net.createConnection({ host, port }, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const socket = await createProxySocket(
    { type: 'socks5', host: '127.0.0.1', port: proxyPort, remoteDns: true },
    { host: '127.0.0.1', port: targetPort },
  );
  assert.equal(await roundTrip(socket, 'socks-proxy-ok'), 'socks-proxy-ok');
  socket.destroy();
});
