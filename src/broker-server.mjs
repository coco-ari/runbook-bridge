import fs from 'node:fs/promises';
import net from 'node:net';
import { brokerEndpoint } from './paths.mjs';
import { toPublicError, AppError } from './errors.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;

export class BrokerServer {
  constructor({ dataRoot, token, broker, appVersion = 'unknown' }) {
    this.endpoint = brokerEndpoint(dataRoot);
    this.token = token;
    this.broker = broker;
    this.appVersion = appVersion;
    this.server = null;
    this.sockets = new Set();
    this.queues = new WeakMap();
  }

  async start() {
    if (this.server) return;
    if (process.platform !== 'win32') await fs.rm(this.endpoint, { force: true });
    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (process.platform !== 'win32') await fs.rm(this.endpoint, { force: true });
  }

  handleSocket(socket) {
    this.sockets.add(socket);
    this.queues.set(socket, Promise.resolve());
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.queues.delete(socket);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const queued = this.queues
          .get(socket)
          .then(() => this.handleLine(socket, line))
          .catch(() => undefined);
        this.queues.set(socket, queued);
      }
    });
  }

  async handleLine(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.auth !== this.token) throw new AppError('BROKER_UNAUTHORIZED', '本地 Broker 认证失败。');
      const result = await this.dispatch(request.method, request.params ?? {});
      this.safeWrite(socket, { id: request.id, ok: true, result });
    } catch (error) {
      this.safeWrite(socket, { id: request?.id ?? null, ok: false, error: toPublicError(error) });
    }
  }

  safeWrite(socket, payload) {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      socket.destroy();
    }
  }

  dispatch(method, params) {
    switch (method) {
      case 'info':
        return { version: this.appVersion };
      case 'status':
        return this.broker.status(params.projectId);
      case 'statuses':
        return this.broker.listStatuses();
      case 'openContext':
        return this.broker.openContext(
          params.projectId,
          params.expectedDocsHash,
          params.clientInstanceId,
          params.expectedSecurityConfigHash,
        );
      case 'execute':
        return this.broker.execute(
          params.projectId,
          params.contextToken,
          params.command,
          params.workingDirectory,
        );
      case 'upload':
        return this.broker.upload(params.projectId, params.contextToken, params.localPath, params.remotePath);
      case 'download':
        return this.broker.download(params.projectId, params.contextToken, params.remotePath);
      case 'searchLogs':
        return this.broker.searchLogs(params.projectId, params.contextToken, params);
      default:
        throw new AppError('METHOD_NOT_FOUND', '不支持的 Broker 操作。');
    }
  }
}
