import fs from 'node:fs/promises';
import net from 'node:net';
import { brokerEndpoint } from './paths.mjs';
import { toPublicError, AppError } from './errors.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;

export class BrokerServer {
  constructor({ dataRoot, token, v2Service = null, appVersion = 'unknown' }) {
    this.endpoint = brokerEndpoint(dataRoot);
    this.token = token;
    this.v2Service = v2Service;
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
    if (method.startsWith('v2.')) return this.dispatchV2(method.slice(3), params);
    switch (method) {
      case 'info':
        return { version: this.appVersion, protocolVersion: 2 };
      default:
        throw new AppError('METHOD_NOT_FOUND', '旧版 Broker 操作已停用，请重新加载 Agent 运维工作台 MCP。');
    }
  }

  dispatchV2(method, params) {
    if (!this.v2Service) throw new AppError('METHOD_NOT_FOUND', '新版 Broker 尚未启用。');
    switch (method) {
      case 'listProjects': return this.v2Service.listProjects(params);
      case 'listEnvironments': return this.v2Service.listEnvironments(params);
      case 'openEnvironment': return this.v2Service.openEnvironment(params);
      case 'addPlugin': return this.v2Service.addPlugin(params);
      case 'listEnvironmentPlugins': return this.v2Service.listEnvironmentPlugins(params);
      case 'readRunbook': return this.v2Service.readRunbook(params);
      case 'serverListActions': return this.v2Service.serverDescriptors(params, 'actions');
      case 'serverListSources': return this.v2Service.serverDescriptors(params, 'sources');
      case 'serverRunAction': return this.v2Service.invoke(params, ['system.summary', 'process.summary', 'network.listen'].includes(params.actionId) ? 'status' : 'diagnostics', { actionId: params.actionId, parameters: params.parameters ?? {} });
      case 'serverListFiles': return this.v2Service.invoke(params, 'logs', { operation: 'list', sourceId: params.sourceId, cursor: params.cursor, limit: params.limit });
      case 'serverReadLog': return this.v2Service.invoke(params, 'logs', { operation: 'read', fileId: params.fileId, cursor: params.cursor, maxBytes: params.maxBytes, tail: params.tail });
      case 'serverSearchLogs': return this.v2Service.invoke(params, 'logs', { operation: 'search', fileIds: params.fileIds, contains: params.contains, maxLines: params.maxLines, maxScanBytes: params.maxScanBytes });
      case 'serverReadConfig': return this.v2Service.invoke(params, 'config', { fileId: params.fileId, cursor: params.cursor, maxBytes: params.maxBytes });
      case 'serverDownloadFile': return this.v2Service.invoke(params, 'download', { fileId: params.fileId });
      case 'mysqlListTables': return this.v2Service.invoke(params, 'describe', { cursor: params.cursor, limit: params.limit });
      case 'mysqlDescribeTable': return this.v2Service.invoke(params, 'describe', { table: params.table });
      case 'mysqlQueryReadonly': return this.v2Service.invoke(params, 'select', { sql: params.sql, params: params.params });
      case 'mysqlExplain': return this.v2Service.invoke(params, 'explain', { sql: params.sql, params: params.params });
      case 'redisScan': return this.v2Service.invoke(params, 'scan', { patternId: params.patternId, cursor: params.cursor, limit: params.limit });
      case 'redisRead': return this.v2Service.invoke(params, 'read', { patternId: params.patternId, key: params.key, field: params.field });
      case 'redisTtl': return this.v2Service.invoke(params, 'ttl', { patternId: params.patternId, key: params.key });
      default: throw new AppError('METHOD_NOT_FOUND', '不支持的新版 Broker 操作。');
    }
  }
}
