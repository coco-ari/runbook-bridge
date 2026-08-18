import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ConfirmationManager extends EventEmitter {
  constructor({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.now = now;
    this.pending = new Map();
    this.approved = new Map();
  }

  pruneExpired(current = this.now()) {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= current) this.pending.delete(id);
    for (const [token, entry] of this.approved) if (entry.expiresAt <= current) this.approved.delete(token);
  }

  invalidateMatching(predicate) {
    this.pruneExpired();
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (!predicate(entry)) continue;
      this.pending.delete(id);
      changed = true;
    }
    for (const [token, entry] of this.approved) {
      if (!predicate(entry)) continue;
      this.approved.delete(token);
      changed = true;
    }
    if (changed) this.emit('changed', this.list());
    return changed;
  }

  invalidateProject(projectId) {
    return this.invalidateMatching((entry) => entry.projectId === projectId);
  }

  invalidateEnvironment(projectId, environmentId) {
    return this.invalidateMatching((entry) => entry.projectId === projectId && entry.environmentId === environmentId);
  }

  invalidatePlugin(projectId, environmentId, pluginInstanceId) {
    return this.invalidateMatching((entry) => entry.projectId === projectId
      && entry.environmentId === environmentId && entry.pluginInstanceId === pluginInstanceId);
  }

  request(scope, capability, args, summary = null, metadata = {}) {
    const operationHash = fingerprint({ scope, capability, args });
    const current = this.now();
    this.pruneExpired(current);
    for (const entry of this.pending.values()) {
      if (entry.expiresAt > current && entry.operationHash === operationHash) return { ...entry, deduplicated:true };
    }
    const requestId = crypto.randomUUID();
    const entry = { requestId, operationHash, ...scope, capability, summary, ...metadata, actor: 'Agent', createdAt: new Date().toISOString(), expiresAt: current + this.ttlMs };
    this.pending.set(requestId, entry);
    this.emit('changed', this.list());
    return { ...entry, deduplicated:false };
  }

  approve(requestId) {
    const current = this.now();
    this.pruneExpired(current);
    const entry = this.pending.get(requestId);
    if (!entry) throw new AppError('CONFIRMATION_EXPIRED', '确认请求已经过期。');
    this.pending.delete(requestId);
    const approvalToken = crypto.randomBytes(24).toString('base64url');
    this.approved.set(approvalToken, { ...entry, expiresAt: current + this.ttlMs });
    this.emit('changed', this.list());
    return { approvalToken, requestId, expiresAt: new Date(current + this.ttlMs).toISOString() };
  }

  reject(requestId) {
    this.pruneExpired();
    if (!this.pending.delete(requestId)) throw new AppError('CONFIRMATION_NOT_FOUND', '确认请求不存在。');
    this.emit('changed', this.list());
    return { requestId, rejected: true };
  }

  consume(token, scope, capability, args) {
    const current = this.now();
    this.pruneExpired(current);
    const entry = this.approved.get(String(token ?? ''));
    this.approved.delete(String(token ?? ''));
    if (!entry) throw new AppError('CONFIRMATION_REQUIRED', '该操作需要在桌面端确认。');
    const operationHash = fingerprint({ scope, capability, args });
    if (entry.operationHash !== operationHash) throw new AppError('CONFIRMATION_SCOPE_MISMATCH', '操作内容已变化，需要重新确认。');
    return entry;
  }

  consumeMatching(scope, capability, args) {
    this.pruneExpired();
    const operationHash = fingerprint({ scope, capability, args });
    for (const [token, entry] of this.approved) {
      if (entry.operationHash === operationHash) { this.approved.delete(token); return entry; }
    }
    return false;
  }

  list() {
    this.pruneExpired();
    return [...this.pending.values()].map((entry) => ({ ...entry, operationHash: undefined }));
  }
}
