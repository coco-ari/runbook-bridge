import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const identity = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160);

export function cloudUpdateNotices(state,status) {
  const notices = [];
  for (const repo of state.repositories) {
    const available = status.repositories.find(item => item.repositoryId === repo.repositoryId);
    if (!available?.unlocked || available.error) continue;
    const prefix = {type:'cloud',repositoryId:repo.repositoryId,repositoryName:label(repo.name)};
    for (const project of repo.catalog ?? []) {
      const current = status.cloudProjects.find(item => item.repositoryId === repo.repositoryId && item.projectId === project.projectId);
      if (!current || (!current.visible && !current.downloaded) || ['synced','error','locked','unknown'].includes(current.syncStatus)) continue;
      const mapping = state.mappings.find(item => item.repositoryId === repo.repositoryId && item.remoteId === project.projectId);
      const initialDigest = repo.notificationBaseline && Object.hasOwn(repo.notificationBaseline,project.projectId) ? repo.notificationBaseline[project.projectId] : undefined;
      // 首次目录只是本机看到的已有内容；不能把通知去重当成初始化，否则消息和角标仍会出现。
      if (!current.downloaded && (repo.notificationBaseline === null || initialDigest === project.digest)) continue;
      // 本地单独修改不属于云端更新；本机上传成功后也不会重复提醒。
      if (current.downloaded && mapping?.remoteDigest === project.digest) continue;
      const kind = current.downloaded ? current.syncStatus === 'modified' ? 'conflict' : 'changed' : initialDigest ? 'changed' : 'added';
      notices.push({...prefix,id:identity(['cloud',repo.repositoryId,project.projectId,project.digest]),projectId:project.projectId,localProjectId:mapping?.localId,
        title:label(project.name),kind,description:kind === 'conflict' ? '本地与云端都有修改，请查看差异后处理。' : kind === 'added' ? '云端新增项目，可查看并下载配置。' : '云端配置有更新，可查看差异后更新。'});
    }
    for (const project of repo.deletedProjects ?? []) {
      if (!status.deletedCloudProjects.some(item => item.repositoryId === repo.repositoryId && item.projectId === project.projectId)) continue;
      const mapping = state.mappings.find(item => item.repositoryId === repo.repositoryId && item.remoteId === project.projectId);
      if (!mapping || !status.projects.some(item => item.projectId === mapping.localId)) continue;
      notices.push({...prefix,id:identity(['deleted',repo.repositoryId,project.projectId,project.deletedAt]),projectId:project.projectId,localProjectId:mapping.localId,
        title:label(project.name),kind:'deleted',description:'云端已删除，本地配置仍保留。'});
    }
  }
  return notices;
}

export function softwareUpdateNotices(state,platform,arch) {
  if (!state?.source || !state.availableVersion || !['available','downloading','downloaded','installing','error'].includes(state.phase)) return [];
  const ready = ['downloaded','installing'].includes(state.phase);
  return [{id:identity(['software',state.source.repositoryId,state.source.origin,platform,arch,state.availableVersion,ready]),
    type:'software',version:state.availableVersion,kind:ready ? 'downloaded' : 'available',repositoryId:state.source.repositoryId,repositoryName:label(state.source.name),
    title:ready ? `新版本 ${state.availableVersion} 已下载` : `发现新版本 ${state.availableVersion}`,
    description:ready ? '新版本已就绪，立即更新将重启应用。' : '下载新版本，完成后即可更新。'}];
}

export function notificationChannel(mode,focused) {
  return mode === 'always' ? 'system' : focused ? 'app' : mode === 'background' ? 'system' : null;
}

export class UpdateNotificationDelivery {
  constructor({current,send,delayMs = 5_000}) {
    Object.assign(this,{current,send,delayMs});
    this.pending = new Set();
  }
  enqueue(items) {
    for (const item of items) this.pending.add(item.id);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(),this.delayMs);
    this.timer.unref?.();
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    const state = this.current();
    // 仅发送仍未完成的消息；相同内容的系统通知由 notified 记录去重。
    const items = state.items.filter(item => this.pending.has(item.id));
    this.pending.clear();
    if (items.length) this.send(items,state.notificationMode);
  }
  dispose() { clearTimeout(this.timer); this.timer = null; this.pending.clear(); }
}

export class UpdateNotifications {
  constructor({workspace,onChanged = () => {},onNotify = () => {},now = Date.now}) {
    Object.assign(this,{workspace,onChanged,onNotify,now});
    this.file = path.join(workspace.directory,'update-notifications.enc.json');
    this.records = {};
    this.items = [];
    this.error = null;
    this.queue = Promise.resolve();
    this.notificationMode = 'background';
    this.disposed = false;
  }
  async init() {
    try {
      const saved = await this.workspace.unseal(await fs.readFile(this.file,'utf8'));
      if (![1,2,3].includes(saved.schemaVersion) || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)
        || Object.keys(saved.records).length > 8192 || Object.entries(saved.records).some(([id,r]) => !/^[a-f0-9]{64}$/.test(id) || !r || saved.schemaVersion < 3 && typeof r.read !== 'boolean' || typeof r.notified !== 'boolean'
          || ['firstSeenAt','snoozedUntil'].some(key => r[key] != null && (!Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 8.64e15)))
        || saved.schemaVersion >= 2 && !['app','background','always'].includes(saved.notificationMode)) throw new Error();
      this.records = Object.fromEntries(Object.entries(saved.records).map(([id,r]) => [id,{notified:r.notified,...(r.firstSeenAt != null ? {firstSeenAt:r.firstSeenAt} : {})}]));
      this.notificationMode = saved.notificationMode ?? 'background';
      if (saved.schemaVersion < 3) await this.persist(this.records);
    } catch (error) { if (error.code !== 'ENOENT') this.error = '无法读取本机提醒记录，原文件已保留。'; }
  }
  snapshot() { return {items:this.items.map(item => ({...item,firstSeenAt:this.records[item.id]?.firstSeenAt})),notificationMode:this.notificationMode,error:this.error}; }
  enqueue(run) { const next = this.queue.catch(() => undefined).then(run); this.queue = next; return next; }
  async persist(records,notificationMode = this.notificationMode) {
    await this.workspace.writeSealed(this.file,{schemaVersion:3,records,notificationMode});
    this.records = records;
    this.notificationMode = notificationMode;
  }
  reconcile(items,isCurrent = () => true) {
    return this.enqueue(async () => {
      if (this.disposed || !isCurrent()) return;
      const before = JSON.stringify(this.snapshot());
      const records = {...this.records};
      const fresh = [];
      const now = this.now();
      for (const item of items) {
        const record = records[item.id];
        if (!record?.notified) fresh.push(item);
        records[item.id] = {notified:true,firstSeenAt:record?.firstSeenAt ?? now};
      }
      const activeIds = new Set(items.map(item => item.id));
      for (const id of Object.keys(records)) {
        if (Object.keys(records).length <= 8192) break;
        if (!activeIds.has(id)) delete records[id];
      }
      let saved = false;
      if (!this.error && JSON.stringify(records) !== JSON.stringify(this.records)) {
        try { await this.persist(records); saved = true; }
        catch { this.error = '无法保存本机提醒记录，暂不发送重复提示。'; }
      }
      if (this.disposed || !isCurrent()) return;
      this.items = items;
      if (before !== JSON.stringify(this.snapshot())) this.onChanged();
      if (saved && fresh.length) this.onNotify(fresh);
    });
  }
  preferences(notificationMode) {
    return this.enqueue(async () => {
      if (this.error) throw new Error('提醒记录不可用。');
      await this.persist(this.records,notificationMode); this.onChanged();
      return this.snapshot();
    });
  }
  clear() { this.items = []; }
  dispose() { this.disposed = true; this.clear(); }
}
