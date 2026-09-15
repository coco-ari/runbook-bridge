import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { ConfirmationStatusStore } from './confirmation-status-store.mjs';

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
    this.statuses = new ConfirmationStatusStore({ now });
  }

  pruneExpired(current = this.now()) {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= current) { this.pending.delete(id); this.statuses.record(entry,'expired'); }
    for (const [token, entry] of this.approved) if (entry.expiresAt <= current) { this.approved.delete(token); this.statuses.record(entry,'expired'); }
  }

  invalidateMatching(predicate) {
    this.pruneExpired();
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (!predicate(entry)) continue;
      this.pending.delete(id);
      this.statuses.record(entry,'invalidated');
      changed = true;
    }
    for (const [token, entry] of this.approved) {
      if (!predicate(entry)) continue;
      this.approved.delete(token);
      this.statuses.record(entry,'invalidated');
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
    this.statuses.record(entry,'awaiting_user');
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
    this.statuses.record({ ...entry, expiresAt:current + this.ttlMs },'approved');
    this.emit('changed', this.list());
    return { approvalToken, requestId, expiresAt: new Date(current + this.ttlMs).toISOString() };
  }

  reject(requestId) {
    this.pruneExpired();
    const entry = this.pending.get(requestId);
    if (!entry) throw new AppError('CONFIRMATION_NOT_FOUND', '确认请求不存在。');
    this.pending.delete(requestId);
    this.statuses.record(entry,'rejected');
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
    if (entry.operationHash !== operationHash) {
      this.statuses.record(entry,'invalidated');
      throw new AppError('CONFIRMATION_SCOPE_MISMATCH', '操作内容已变化，需要重新确认。');
    }
    this.statuses.record(entry,'consumed');
    return entry;
  }

  consumeMatching(scope, capability, args) {
    this.pruneExpired();
    const operationHash = fingerprint({ scope, capability, args });
    for (const [token, entry] of this.approved) {
      if (entry.operationHash === operationHash) { this.approved.delete(token); this.statuses.record(entry,'consumed'); return entry; }
    }
    return false;
  }

  list() {
    this.pruneExpired();
    return [...this.pending.values()].map((entry) => ({ ...entry, operationHash: undefined }));
  }

  async status(scope, requestId, waitMs = 0) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new AppError('INVALID_ARGUMENT', 'waitMs 必须是 0 到 10000 之间的整数。');
    this.pruneExpired();
    await this.statuses.wait(scope, requestId, waitMs);
    this.pruneExpired();
    return this.statuses.get(scope, requestId);
  }

  executionStatus(requestId, status, errorCode) {
    this.statuses.update(requestId,status,errorCode);
  }
}
