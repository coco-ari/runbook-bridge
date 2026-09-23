import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';
import { dockerRequest, parseDockerResult } from './server-docker-reader.mjs';

const scopeOf = value => ({ projectId:value.projectId, environmentId:value.environmentId, pluginInstanceId:value.pluginInstanceId });
const matches = (value, scope) => Object.entries(scopeOf(scope)).every(([key, expected]) => expected === undefined || value[key] === expected);
const cancelled = () => new AppError('DOCKER_CANCELLED', 'Docker 目标或工作区已变化，请重新读取。');

export class ServerDockerManager {
  constructor({ workspaceStore, serverRuntime }) {
    Object.assign(this, { workspaceStore, serverRuntime });
    this.pending = new Map();
    this.snapshots = new Map();
    this.disposed = false;
    this.lifecycle = event => this.closeScope(event);
    serverRuntime.on?.('lifecycle', this.lifecycle);
  }

  async plugin(scope) {
    const plugin = await this.workspaceStore.getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId);
    if (plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', 'Docker 功能只支持 Server 插件。');
    if (!this.serverRuntime.status(plugin)?.connected) throw new AppError('SSH_NOT_CONNECTED', '请先连接服务器。');
    return plugin;
  }

  async verify(record) {
    if (this.disposed || record.controller.signal.aborted) throw cancelled();
    const plugin = await this.plugin(record.scope);
    if (record.controller.signal.aborted || this.serverRuntime.status(plugin).generation !== record.generation || pluginConnectionFingerprint(plugin) !== record.fingerprint) throw cancelled();
    return plugin;
  }

  async read(owner, payload, parentAuditOperationId = null) {
    const { kind, requestId = crypto.randomUUID(), projectId, environmentId, pluginInstanceId, ...input } = payload;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(requestId)) throw new AppError('INVALID_ARGUMENT', 'Docker 请求标识无效。');
    const request = dockerRequest(kind, input);
    const scope = { projectId, environmentId, pluginInstanceId };
    const key = JSON.stringify([owner, scope, requestId]);
    if (this.disposed) throw cancelled();
    if (this.pending.size >= 64 || this.pending.has(key)) throw new AppError('DOCKER_BUSY', 'Docker 读取正在进行，请稍后重试。');
    const operationId = parentAuditOperationId ?? crypto.randomUUID();
    const actor = String(owner).startsWith('renderer:') ? 'user' : 'agent';
    const record = { key, owner, scope, controller:new AbortController() };
    let pluginNameSnapshot;
    this.pending.set(key, record);
    try {
      const plugin = await this.plugin(scope);
      pluginNameSnapshot = plugin.displayName;
      record.generation = this.serverRuntime.status(plugin).generation;
      record.fingerprint = pluginConnectionFingerprint(plugin);
      await this.verify(record);
      await this.workspaceStore.appendAudit(projectId, { ...scope, pluginType:'server', type:'docker-read', auditNested:Boolean(parentAuditOperationId), auditTarget:request.containerId ?? '', operationId, actor, pluginNameSnapshot, origin:String(owner).startsWith('renderer:') ? 'desktop-human' : 'agent', operation:kind, containerId:request.containerId, result:'started' });
      await this.verify(record);
      let result;
      if (request.cursor) {
        const [id, offsetText] = request.cursor.split(':');
        const snapshot = this.snapshots.get(id);
        if (!snapshot || snapshot.owner !== owner || !matches(snapshot.scope, scope) || snapshot.expiresAt < Date.now() || snapshot.fingerprint !== record.fingerprint || snapshot.generation !== record.generation) throw new AppError('DOCKER_CURSOR_EXPIRED', '容器列表快照已过期，请重新刷新。');
        result = this.page(snapshot, Number(offsetText), request.limit);
      } else {
        const raw = await this.serverRuntime.readDocker(plugin, request, { signal:record.controller.signal });
        await this.verify(record);
        result = parseDockerResult(request, raw);
        if (kind === 'list') {
          for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt < Date.now()) this.snapshots.delete(id);
          const owned = [...this.snapshots.values()].filter(item => item.owner === owner);
          for (const old of owned.slice(0, Math.max(0, owned.length - 3))) this.snapshots.delete(old.id);
          while (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value);
          const snapshot = { ...record, controller:undefined, ...result, id:crypto.randomUUID(), expiresAt:Date.now() + 60000 };
          this.snapshots.set(snapshot.id, snapshot);
          result = this.page(snapshot, 0, request.limit);
        }
      }
      await this.workspaceStore.appendAudit(projectId, { ...scope, pluginType:'server', type:'docker-read', auditNested:Boolean(parentAuditOperationId), auditTarget:request.containerId ?? '', operationId, actor, pluginNameSnapshot, operation:kind, result:'success' });
      await this.verify(record);
      return result;
    } catch (error) {
      await this.workspaceStore.appendAudit(projectId, { ...scope, pluginType:'server', type:'docker-read', auditNested:Boolean(parentAuditOperationId), auditTarget:request.containerId ?? '', operationId, actor, pluginNameSnapshot, operation:kind, result:'error', errorCode:error instanceof AppError ? error.code : 'INTERNAL_ERROR' }).catch(() => {});
      throw error;
    } finally { this.pending.delete(key); }
  }

  page(snapshot, offset, limit) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.items.length) throw new AppError('INVALID_ARGUMENT', '容器列表分页位置无效。');
    const items = snapshot.items.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, sampledAt:snapshot.sampledAt, truncated:snapshot.truncated, total:snapshot.items.length, nextCursor:next < snapshot.items.length ? `${snapshot.id}:${next}` : null };
  }

  cancel(owner, payload) {
    for (const record of this.pending.values()) if (record.owner === owner && matches(record.scope, payload) && (!payload.requestId || record.key === JSON.stringify([owner, scopeOf(payload), payload.requestId]))) record.controller.abort();
    return { stopped:true };
  }

  closeOwner(owner) {
    for (const record of this.pending.values()) if (record.owner === owner) record.controller.abort();
    for (const [id, snapshot] of this.snapshots) if (snapshot.owner === owner) this.snapshots.delete(id);
  }

  closeScope(scope) {
    for (const record of this.pending.values()) if (matches(record.scope, scope)) record.controller.abort();
    for (const [id, snapshot] of this.snapshots) if (matches(snapshot.scope, scope)) this.snapshots.delete(id);
  }

  dispose() {
    this.disposed = true;
    this.closeScope({});
    this.serverRuntime.removeListener?.('lifecycle', this.lifecycle);
  }
}
