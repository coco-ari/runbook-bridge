import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { editPath, sameTextSnapshot, textBytes, textHash } from './server-text-edit.mjs';

const fields = ['projectId', 'environmentId', 'pluginInstanceId'];
const matches = (item, scope) => fields.every(key => !scope[key] || item.scope[key] === scope[key]);
const expired = () => new AppError('FILE_EDIT_EXPIRED', '文件编辑会话或保存确认已失效，请重新打开文件。');
const conflict = () => new AppError('FILE_EDIT_CONFLICT', '远端文件已被修改，草稿已保留。请重新读取后核对，不能直接覆盖。');
const keys = { open:['path'], prepare:['editId','content'], commit:['editId','planId'], verify:['editId'], restore:['editId'],
  dirty:['editId','dirty','sequence'], close:['editId'], cancel:['editId'] };

export class ServerWorkspaceEditor {
  constructor(files) { this.files = files; this.records = new Map(); this.writing = new Set(); }
  active(item) {
    if (this.records.get(item.editId) !== item || this.files.ownerEpoch(item.ownerId) !== item.epoch) throw expired();
    item.controller.signal.throwIfAborted();
  }
  public(item) {
    return { editId:item.editId, path:item.path, content:item.base.content, bytes:item.base.size, mtime:item.base.mtime,
      mode:item.base.mode, status:item.status, canRestore:Boolean(item.previous), ...(item.message ? {message:item.message} : {}) };
  }
  budget(extra = 0, excludingPlan = null) {
    const size = [...this.records.values()].reduce((sum, item) => sum + Buffer.byteLength(item.base?.content ?? '')
      + Buffer.byteLength(item.previous?.content ?? '') + Buffer.byteLength(item === excludingPlan ? '' : item.plan?.content ?? item.pending?.content ?? ''), extra);
    if (size > 48 * 1024 * 1024) throw new AppError('WORKSPACE_BUSY', '文件编辑缓存已满，请关闭不需要的编辑标签。');
  }
  invalidate(scope, { ownerId, remove = false } = {}) {
    for (const [id, item] of this.records) if ((!ownerId || item.ownerId === ownerId) && matches(item, scope)) {
      item.plan = null;
      item.controller.abort(new AppError('WORKSPACE_CHANGED', '服务器配置或连接已变化，草稿已保留。'));
      if (remove) this.records.delete(id);
    }
  }
  exitSummary() { return [...this.records.values()].filter(item => item.dirty || item.busy || item.status === 'unknown').length; }
  activeProject(projectId) { return [...this.records.values()].some(item => item.scope.projectId === projectId && (item.dirty || item.busy || item.status === 'unknown')); }
  async audit(item, result, errorCode) {
    await this.files.workspaceStore.appendAudit(item.scope.projectId, { ...item.scope, pluginType:'server', actor:'user', source:'desktop-human',
      type:'desktop-file-action', result, operationId:item.pending?.planId, pluginNameSnapshot:item.plugin.displayName,
      operation:{kind:'edit',path:item.path}, ...(errorCode ? {errorCode} : {}) });
  }
  async read(item) {
    const binding = await this.files.requirePlugin(item.ownerId, item.scope);
    if (binding.revision !== item.revision || binding.epoch !== item.epoch) throw expired();
    const snapshot = await this.files.serverRuntime.readWorkspaceText(binding.plugin, item.path, {signal:item.controller.signal});
    await this.files.requirePlugin(item.ownerId, item.scope, binding); this.active(item);
    return { binding, snapshot };
  }
  async open(ownerId, payload) {
    const selected = editPath(payload.path);
    const binding = await this.files.requirePlugin(ownerId, payload);
    if (this.records.size >= 32 || [...this.records.values()].filter(item => item.ownerId === ownerId).length >= 12) {
      throw new AppError('WORKSPACE_BUSY', '最多同时编辑 12 个文件，请先关闭不需要的编辑标签。');
    }
    this.budget(3 * 1024 * 1024);
    const item = {...binding, ownerId, editId:crypto.randomUUID(), path:selected, controller:new AbortController(),
      dirty:false, busy:true, sequence:0, status:'ready', plan:null, pending:null, previous:null};
    this.records.set(item.editId, item);
    try {
      const { snapshot } = await this.read(item);
      item.base = snapshot;
      return {edit:this.public(item)};
    } catch (error) { this.records.delete(item.editId); throw error; }
    finally { item.busy = false; }
  }
  async run(ownerId, payload) {
    const allowed = Object.hasOwn(keys, payload.operation) ? keys[payload.operation] : null;
    if (!allowed || Object.keys(payload).some(key => ![...fields, 'operation', ...allowed].includes(key))) throw new AppError('INVALID_ARGUMENT', '文件编辑请求参数无效。');
    this.files.ownerEpoch(ownerId);
    if (payload.operation === 'open') return this.open(ownerId, payload);
    const item = this.records.get(payload.editId);
    if (!item || item.ownerId !== ownerId || !fields.every(key => item.scope[key] === payload[key]) || item.epoch !== this.files.ownerEpoch(ownerId)) throw expired();
    if (payload.operation === 'dirty') {
      if (typeof payload.dirty !== 'boolean' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) throw new AppError('INVALID_ARGUMENT', '编辑状态无效。');
      if (payload.sequence > item.sequence) { item.sequence = payload.sequence; item.dirty = payload.dirty; if (item.plan) item.plan = null; }
      return {};
    }
    if (item.busy) throw new AppError('WORKSPACE_BUSY', '正在读取或保存文件，请稍候。');
    if (payload.operation === 'close') { this.records.delete(item.editId); item.controller.abort(); return {}; }
    if (payload.operation === 'cancel') { item.plan = null; return {}; }
    if (payload.operation === 'restore') {
      if (!item.previous || item.status === 'unknown') throw new AppError('FILE_EDIT_NO_BACKUP', '当前编辑会话没有可恢复版本，或保存结果尚待核实。');
      return {restoreContent:item.previous.content};
    }
    item.busy = true; item.controller = new AbortController();
    try {
      if (payload.operation === 'prepare') {
        if (item.status === 'unknown') throw new AppError('FILE_EDIT_UNKNOWN', '上次保存结果待核实，请先检查远端内容。');
        const bytes = textBytes(payload.content); this.budget(bytes.length, item);
        const { binding, snapshot } = await this.read(item);
        if (!sameTextSnapshot(snapshot, item.base)) throw conflict();
        if (snapshot.content === payload.content) throw new AppError('FILE_EDIT_UNCHANGED', '内容没有变化，无需保存。');
        Object.assign(item, binding);
        item.dirty = true;
        item.plan = {planId:crypto.randomUUID(),content:payload.content,before:item.base.content,expiresAt:this.files.now() + 120000};
        return {plan:{...item.plan}};
      }
      if (payload.operation === 'commit') return await this.commit(item, payload.planId);
      if (payload.operation === 'verify') {
        const { binding, snapshot } = await this.read(item);
        if (item.status === 'unknown' && item.pending) {
          if (snapshot.sha256 === textHash(item.pending.content)) await this.complete(item, snapshot);
          else if (sameTextSnapshot(snapshot, item.base)) {
            item.status = 'ready'; item.pending = null; item.message = '当前远端内容仍为保存前版本，草稿已保留；可重新检查并保存。';
          } else throw conflict();
        } else if (!sameTextSnapshot(snapshot, item.base)) throw conflict();
        Object.assign(item, binding);
        return {edit:this.public(item)};
      }
      throw new AppError('INVALID_ARGUMENT', '文件编辑操作无效。');
    } finally { item.busy = false; }
  }
  async complete(item, snapshot) {
    item.previous = {content:item.base.content}; item.base = snapshot; item.status = 'ready'; item.dirty = false;
    item.message = '已保存。当前编辑会话保留上一次保存前的版本。';
    this.files.directoryCache.clear(record => matches(item, record.binding.scope));
    try { await this.audit(item, 'completed'); }
    catch { item.message = '文件已保存，但完成记录写入失败。请核对操作记录。'; }
    item.pending = null;
  }
  async commit(item, planId) {
    const plan = item.plan; item.plan = null;
    if (!plan || plan.planId !== planId || plan.expiresAt <= this.files.now()) throw new AppError('FILE_EDIT_EXPIRED', '本次保存确认已失效，草稿已保留，请重新检查并确认。');
    const lock = JSON.stringify([item.scope, item.path]);
    if (this.writing.has(lock)) throw new AppError('WORKSPACE_BUSY', '这个文件正在保存，请稍后重新检查。');
    this.writing.add(lock); item.pending = plan;
    let committing = false;
    try {
      await this.files.requirePlugin(item.ownerId, item.scope, item); this.active(item);
      await this.audit(item, 'started'); this.active(item);
      await this.files.serverRuntime.writeWorkspaceText(item.plugin, {path:item.path,content:plan.content,expected:item.base}, {
        signal:item.controller.signal,
        beforeCommit:async () => { await this.files.requirePlugin(item.ownerId, item.scope, item); this.active(item); },
        onCommitting:() => { this.active(item); committing = true; },
      });
      const { snapshot } = await this.read(item);
      if (snapshot.sha256 !== textHash(plan.content)) throw conflict();
      await this.complete(item, snapshot);
      return {edit:this.public(item)};
    } catch (error) {
      if (committing && error.code !== 'FILE_EDIT_ATOMIC_UNAVAILABLE') {
        item.status = 'unknown'; item.dirty = true;
        item.message = '保存请求已发出，但最终内容尚未核实。请检查保存结果，暂时不要重复保存。';
        await this.audit(item, 'error', 'FILE_EDIT_UNKNOWN').catch(() => {});
        return {edit:this.public(item)};
      }
      await this.audit(item, 'error', error instanceof AppError ? error.code : 'INTERNAL_ERROR').catch(() => {});
      item.pending = null;
      throw error;
    } finally { this.writing.delete(lock); }
  }
}
