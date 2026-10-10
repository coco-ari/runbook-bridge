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
      // 本地单独修改不属于云端更新；本机上传成功后也不会重复提醒。
      if (current.downloaded && mapping?.remoteDigest === project.digest) continue;
      const kind = current.downloaded ? current.syncStatus === 'modified' ? 'conflict' : 'changed' : 'added';
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
  if (!state?.source || !state.availableVersion || !['available','downloading','downloaded','installing'].includes(state.phase)) return [];
  const ready = ['downloaded','installing'].includes(state.phase);
  return [{id:identity(['software',state.source.repositoryId,state.source.origin,platform,arch,state.availableVersion,ready]),
    type:'software',kind:ready ? 'downloaded' : 'available',repositoryId:state.source.repositoryId,repositoryName:label(state.source.name),
    title:ready ? `新版本 ${state.availableVersion} 已下载` : `发现新版本 ${state.availableVersion}`,
    description:ready ? '准备好后可重启并更新。' : '查看版本说明，选择何时下载和安装。'}];
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
    // 发送前重新确认状态，忽略合并等待期间已读、延后或已移除的项目。
    const items = state.items.filter(item => this.pending.has(item.id) && item.unread && !item.snoozedUntil);
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
      if (![1,2].includes(saved.schemaVersion) || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)
        || Object.keys(saved.records).length > 8192 || Object.entries(saved.records).some(([id,r]) => !/^[a-f0-9]{64}$/.test(id) || !r || typeof r.read !== 'boolean' || typeof r.notified !== 'boolean'
          || ['firstSeenAt','snoozedUntil'].some(key => r[key] != null && (!Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 8.64e15)))
        || saved.schemaVersion === 2 && !['app','background','always'].includes(saved.notificationMode)) throw new Error();
      this.records = saved.records;
      this.notificationMode = saved.notificationMode ?? 'background';
    } catch (error) { if (error.code !== 'ENOENT') this.error = '无法读取本机提醒记录，原文件已保留。'; }
  }
  snapshot() { return {items:this.items.map(item => ({...item,unread:!this.records[item.id]?.read,
    firstSeenAt:this.records[item.id]?.firstSeenAt,snoozedUntil:this.records[item.id]?.snoozedUntil ?? null})),notificationMode:this.notificationMode,error:this.error}; }
  enqueue(run) { const next = this.queue.catch(() => undefined).then(run); this.queue = next; return next; }
  async persist(records,notificationMode = this.notificationMode) {
    await this.workspace.writeSealed(this.file,{schemaVersion:2,records,notificationMode});
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
        const due = record?.snoozedUntil != null && record.snoozedUntil <= now;
        if (!record?.notified || due) fresh.push(item);
        records[item.id] = {read:due ? false : record?.read ?? false,notified:true,
          firstSeenAt:record?.firstSeenAt ?? now,snoozedUntil:due ? null : record?.snoozedUntil ?? null};
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
      this.scheduleReminder();
      if (before !== JSON.stringify(this.snapshot())) this.onChanged();
      if (saved && fresh.length) this.onNotify(fresh);
    });
  }
  read(ids) {
    return this.enqueue(async () => {
      if (this.error) throw new Error('提醒记录不可用。');
      const records = {...this.records};
      for (const item of this.items) if (ids.includes(item.id) && records[item.id]) records[item.id] = {...records[item.id],read:true};
      await this.persist(records);
      this.onChanged();
      return this.snapshot();
    });
  }
  snooze(ids,duration) {
    return this.enqueue(async () => {
      if (this.error) throw new Error('提醒记录不可用。');
      const tomorrow = new Date(this.now());
      tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(9,0,0,0);
      const until = duration === 'hour' ? this.now()+3_600_000 : duration === 'tomorrow' ? tomorrow.getTime() : null;
      const records = {...this.records};
      for (const item of this.items) if (ids.includes(item.id) && records[item.id]) {
        records[item.id] = {...records[item.id],read:duration !== 'cancel',snoozedUntil:until};
      }
      await this.persist(records);
      this.scheduleReminder(); this.onChanged();
      return this.snapshot();
    });
  }
  preferences(notificationMode) {
    return this.enqueue(async () => {
      if (this.error) throw new Error('提醒记录不可用。');
      await this.persist(this.records,notificationMode); this.onChanged();
      return this.snapshot();
    });
  }
  scheduleReminder() {
    clearTimeout(this.reminder);
    if (this.disposed || this.error) return;
    const due = this.items.map(item => this.records[item.id]?.snoozedUntil).filter(value => value != null);
    if (!due.length) return;
    this.reminder = setTimeout(() => {
      const items = this.items;
      // 仅重新提醒仍待处理的当前项目；解绑或完成更新后不再唤起旧提醒。
      void this.reconcile(items,() => this.items === items);
    },Math.max(1,Math.min(2_147_483_647,Math.min(...due)-this.now())));
    this.reminder.unref?.();
  }
  clear() { this.items = []; clearTimeout(this.reminder); }
  dispose() { this.disposed = true; this.clear(); }
}
