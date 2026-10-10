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
      notices.push({...prefix,id:identity(['cloud',repo.repositoryId,project.projectId,project.digest]),projectId:project.projectId,
        title:label(project.name),kind,description:kind === 'conflict' ? '本地与云端都有修改，请查看差异后处理。' : kind === 'added' ? '云端新增项目，可查看并下载配置。' : '云端配置有更新，可查看差异后更新。'});
    }
    for (const project of repo.deletedProjects ?? []) {
      if (!status.deletedCloudProjects.some(item => item.repositoryId === repo.repositoryId && item.projectId === project.projectId)) continue;
      const mapping = state.mappings.find(item => item.repositoryId === repo.repositoryId && item.remoteId === project.projectId);
      if (!mapping || !status.projects.some(item => item.projectId === mapping.localId)) continue;
      notices.push({...prefix,id:identity(['deleted',repo.repositoryId,project.projectId,project.deletedAt]),projectId:project.projectId,
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

export class UpdateNotifications {
  constructor({workspace,onChanged = () => {},onNotify = () => {}}) {
    Object.assign(this,{workspace,onChanged,onNotify});
    this.file = path.join(workspace.directory,'update-notifications.enc.json');
    this.records = {};
    this.items = [];
    this.error = null;
    this.queue = Promise.resolve();
  }
  async init() {
    try {
      const saved = await this.workspace.unseal(await fs.readFile(this.file,'utf8'));
      if (saved.schemaVersion !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)
        || Object.keys(saved.records).length > 8192 || Object.entries(saved.records).some(([id,r]) => !/^[a-f0-9]{64}$/.test(id) || !r || typeof r.read !== 'boolean' || typeof r.notified !== 'boolean')) throw new Error();
      this.records = saved.records;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '无法读取本机提醒记录，原文件已保留。'; }
  }
  snapshot() { return {items:this.items.map(item => ({...item,unread:!this.records[item.id]?.read})),error:this.error}; }
  enqueue(run) { const next = this.queue.catch(() => undefined).then(run); this.queue = next; return next; }
  async persist(records) {
    await this.workspace.writeSealed(this.file,{schemaVersion:1,records});
    this.records = records;
  }
  reconcile(items,isCurrent = () => true) {
    return this.enqueue(async () => {
      if (!isCurrent()) return;
      const before = JSON.stringify(this.snapshot());
      const records = {...this.records};
      const fresh = [];
      for (const item of items) {
        const record = records[item.id];
        if (!record?.notified) fresh.push(item);
        records[item.id] = {read:record?.read ?? false,notified:true};
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
      if (!isCurrent()) return;
      this.items = items;
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
}
