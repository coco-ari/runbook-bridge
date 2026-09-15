import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';

const SCOPE_FIELDS = ['projectId','environmentId','pluginInstanceId','clientInstanceId'];

// 状态历史仅保存控制信息，不保存确认令牌、命令参数或执行输出。
export class ConfirmationStatusStore extends EventEmitter {
  constructor({ now = Date.now, ttlMs = 15 * 60 * 1000, maxEntries = 1024, maxWaiters = 32 } = {}) {
    super();
    Object.assign(this, { now, ttlMs, maxEntries, maxWaiters });
    this.entries = new Map();
    this.waiters = 0;
    this.setMaxListeners(maxWaiters + 1);
  }

  record(entry, status, errorCode) {
    const value = {
      ...Object.fromEntries(SCOPE_FIELDS.map(key => [key, entry[key]])),
      confirmationId:entry.requestId ?? entry.confirmationId,
      capability:entry.capability, status, updatedAt:new Date(this.now()).toISOString(),
      expiresAt:new Date(entry.expiresAt).toISOString(),
      ...(errorCode ? {errorCode} : {}),
    };
    this.entries.delete(value.confirmationId);
    for (const [id, item] of this.entries) if (item.retainUntil <= this.now()) this.entries.delete(id);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(value.confirmationId, { value, retainUntil:this.now() + this.ttlMs });
    this.emit('status', value.confirmationId);
  }

  update(id, status, errorCode) {
    const entry = this.entries.get(id)?.value;
    if (entry) this.record({ ...entry, expiresAt:Date.parse(entry.expiresAt) }, status, errorCode);
  }

  get(scope, id) {
    const item = this.entries.get(id);
    if (!item || item.retainUntil <= this.now() || SCOPE_FIELDS.some(key => String(item.value[key] ?? '') !== String(scope[key] ?? ''))) {
      throw new AppError('CONFIRMATION_NOT_FOUND', '当前会话中不存在此确认记录，或记录已经过期。');
    }
    const { status, confirmationId, capability, expiresAt, updatedAt, errorCode } = item.value;
    return { confirmationId, capability, status, expiresAt, updatedAt, ...(errorCode ? {errorCode} : {}) };
  }

  async wait(scope, id, waitMs = 0) {
    const initial = this.get(scope,id);
    if (waitMs === 0 || !['awaiting_user','consumed','running'].includes(initial.status)) return initial;
    if (this.waiters >= this.maxWaiters) throw new AppError('READ_BUSY', '确认状态等待数量已达到上限，请稍后重试。');
    this.waiters += 1;
    return new Promise((resolve,reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('status', changed);
        this.waiters -= 1;
        try { resolve(this.get(scope,id)); } catch (error) { reject(error); }
      };
      const changed = changedId => { if (changedId === id) finish(); };
      const duration = initial.status === 'awaiting_user' ? Math.min(waitMs, Math.max(0, Date.parse(initial.expiresAt) - this.now())) : waitMs;
      const timer = setTimeout(finish, duration);
      this.on('status',changed);
    });
  }
}
