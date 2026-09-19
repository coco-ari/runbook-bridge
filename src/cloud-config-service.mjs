import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CloudConfigClient } from './cloud-config-client.mjs';
import { cloudError, cloudHash, cloudId, deriveCloudKeys, newCloudMeta, encryptCloudSnapshot, decryptCloudSnapshot } from './cloud-config-crypto.mjs';
import { exportCloudProject, normalizeCloudSnapshot, snapshotDigest, cloudProjectWarnings, cloudProjectDiff, cloudBackupDiff } from './cloud-config-snapshot.mjs';

const emptyState = () => ({schemaVersion:1,repository:null,mappings:[]});
const publicFailure = error => ({code:error?.code?.startsWith('CLOUD_') ? error.code : 'CLOUD_IMPORT_FAILED',message:'项目未完成导入，请检查连接、配置及本机安全存储后重新预览。'});
async function deadline(promise,ms = 10_000) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject) => { timer = setTimeout(() => reject(cloudError('PROJECT_BUSY','项目仍有操作正在运行，请结束后重试。')),ms); })]); }
  finally { clearTimeout(timer); }
}

export class CloudConfigService {
  constructor({workspace,mutationCoordinator,connectionManager,pluginManager,v2Service,contextManager,confirmationManager,configTransactionJournal,pluginEditSessionManager,serverWorkspaceManager,serverWorkspaceFiles,serverDocker,broadcast,client = new CloudConfigClient()}) {
    Object.assign(this,{workspace,mutationCoordinator,connectionManager,pluginManager,v2Service,contextManager,confirmationManager,configTransactionJournal,pluginEditSessionManager,serverWorkspaceManager,serverWorkspaceFiles,serverDocker,broadcast,client});
    this.store = workspace.store;
    this.vault = workspace.vault;
    this.state = emptyState();
    this.stateFile = path.join(workspace.directory,'state.enc.json');
    this.sessions = new Map();
    this.epochs = new Map();
    this.plans = new Map();
    this.queue = Promise.resolve();
    this.stateError = false;
    mutationCoordinator.cloudRecoveryGuard = projectId => workspace.assertProjectAvailable(projectId);
    this.store.cloudMutationGuard = projectId => mutationCoordinator.assertCloudProjectAvailable(projectId);
  }
  async init() {
    try {
      this.state = await this.workspace.unseal(await fs.readFile(this.stateFile,'utf8'));
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.mappings)) throw new Error();
    } catch (error) { if (error.code !== 'ENOENT') this.stateError = true; }
  }
  async saveState(state) { await this.workspace.writeSealed(this.stateFile,state); this.state = state; }
  invoke(owner,method,payload = {}) {
    const epoch = this.epochs.get(owner) ?? 0;
    const current = this.queue.catch(() => undefined).then(async () => {
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
      if (this.stateError) throw cloudError('LOCAL_DECRYPT_FAILED','本机云仓库记录无法解密，请恢复系统安全存储后重试。');
      return this[method](owner,payload,epoch);
    });
    this.queue = current;
    return current;
  }
  closeOwner(owner) {
    this.epochs.set(owner,(this.epochs.get(owner) ?? 0)+1);
    this.sessions.get(owner)?.keys.encryption.fill(0);
    this.sessions.delete(owner);
    for (const [id,plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
  }
  session(owner) {
    let session = this.sessions.get(owner);
    if (!session && this.state.repository?.remembered) {
      const repo = this.state.repository;
      session = {...this.client.repository(repo.url),metadata:repo.metadata,keys:{auth:repo.remembered.auth,encryption:Buffer.from(repo.remembered.encryption,'base64')}};
      this.sessions.set(owner,session);
    }
    if (!session) throw cloudError('LOCKED','请先输入仓库链接和密码。');
    return session;
  }
  async status(owner) {
    return {url:this.state.repository?.url ?? '',unlocked:this.sessions.has(owner) || Boolean(this.state.repository?.remembered),remembered:Boolean(this.state.repository?.remembered),projects:(await this.store.listProjects()).map(p => ({projectId:p.projectId,name:p.name})),backups:await this.workspace.listBackups()};
  }
  async bind(owner,{url,password,remember = false},epoch) {
    const remote = await this.client.metadata(url);
    if (this.state.repository?.url === remote.url && snapshotDigest(remote.metadata) !== snapshotDigest(this.state.repository.metadata)) throw cloudError('REPOSITORY_CHANGED','仓库密钥参数已变化，请核对服务地址和仓库。');
    const keys = await deriveCloudKeys(password,remote.metadata);
    const session = {...remote,keys};
    try {
      await this.client.call(session,'head');
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
      await this.saveState({schemaVersion:1,repository:{url:remote.url,metadata:remote.metadata,...(remember ? {remembered:{auth:keys.auth,encryption:keys.encryption.toString('base64')}} : {})},mappings:this.state.repository?.url === remote.url ? this.state.mappings : []});
      for (const existing of [...this.sessions.keys()]) this.closeOwner(existing);
      this.sessions.set(owner,session);
      this.plans.clear();
      return this.status(owner);
    } catch (error) { keys.encryption.fill(0); throw error; }
  }
  async create(owner,{serviceUrl,adminToken,password,remember = false},epoch) {
    const url = this.client.origin(serviceUrl);
    if (url.pathname !== '/') throw cloudError('URL_INVALID','创建仓库时请输入服务根地址。');
    if (typeof adminToken !== 'string' || !/^[A-Za-z0-9_-]{32,1024}$/.test(adminToken)) throw cloudError('AUTH_FAILED','管理员令牌格式无效。');
    await this.workspace.seal({schemaVersion:1});
    const metadata = newCloudMeta();
    const keys = await deriveCloudKeys(password,metadata);
    try {
      await this.client.request(url.origin,'/api/v1/repos',{method:'POST',token:adminToken,body:{metadata,authHash:cloudHash(keys.auth)}});
    } finally { keys.encryption.fill(0); }
    return this.bind(owner,{url:`${url.origin}/r/${metadata.repoId}`,password,remember},epoch);
  }
  async unbind(owner) {
    await this.saveState(emptyState());
    for (const existing of [...this.sessions.keys()]) this.closeOwner(existing);
    this.closeOwner(owner);
    this.plans.clear();
    return this.status(owner);
  }
  async remote(owner,snapshotId = null) {
    const session = this.session(owner);
    const head = await this.client.call(session,'head');
    if (head.snapshotId !== null) cloudId(head.snapshotId);
    const selected = snapshotId ?? head.snapshotId;
    if (!selected) return {session,headId:null,snapshotId:null,payload:{schemaVersion:1,projects:[]}};
    cloudId(selected);
    const envelope = await this.client.call(session,`snapshots/${selected}`);
    if (envelope.snapshotId !== selected) throw cloudError('SCOPE_MISMATCH','下载内容与所选云版本不一致。');
    return {session,headId:head.snapshotId,snapshotId:selected,payload:normalizeCloudSnapshot(decryptCloudSnapshot(envelope,session.metadata,session.keys.encryption),this.vault)};
  }
  async catalog(owner,{snapshotId = null} = {}) {
    const remote = await this.remote(owner,snapshotId);
    const versions = await this.client.call(remote.session,'versions');
    if (!Array.isArray(versions.versions) || versions.versions.length > 100) throw cloudError('FORMAT_INVALID','云版本列表无效。');
    return {snapshotId:remote.snapshotId,projects:remote.payload.projects.map(p => ({projectId:p.projectId,name:p.name,warnings:cloudProjectWarnings(p)})),versions:versions.versions.map(v => ({snapshotId:cloudId(v.snapshotId),createdAt:String(v.createdAt).slice(0,40),bytes:Number(v.bytes)}))};
  }
  async local(projectId) {
    this.mutationCoordinator.assertProjectAvailable(projectId);
    const before = await this.workspace.capture(projectId);
    const portable = before.files['workspace.yaml'] ? await exportCloudProject(this.store,this.vault,projectId) : null;
    if (snapshotDigest(before) !== snapshotDigest(await this.workspace.capture(projectId))) throw cloudError('STALE','项目在读取时发生变化，请重新预览。');
    return {before,portable,expected:snapshotDigest(before),portableDigest:snapshotDigest(portable)};
  }
  async prepare(owner,{direction,projectIds,snapshotId = null}) {
    if (!['upload','download'].includes(direction) || !Array.isArray(projectIds) || !projectIds.length || projectIds.length > 200 || new Set(projectIds).size !== projectIds.length) throw cloudError('INVALID_ARGUMENT','请选择要上传或下载的项目。');
    const remote = await this.remote(owner,direction === 'download' ? snapshotId : null);
    const rows = [];
    for (const selectedId of projectIds) {
      const mapping = this.state.mappings.find(m => direction === 'upload' ? m.localId === selectedId : m.remoteId === selectedId);
      let localId,remoteId,local,cloud,candidate;
      if (direction === 'upload') {
        localId = selectedId;
        local = await this.local(localId);
        if (!local.portable) throw cloudError('NOT_FOUND','所选本地项目不存在。');
        remoteId = mapping?.remoteId ?? (remote.payload.projects.some(p => p.projectId === localId) ? `project-${crypto.randomBytes(10).toString('hex')}` : localId);
        cloud = remote.payload.projects.find(p => p.projectId === remoteId) ?? null;
        candidate = {...local.portable,projectId:remoteId};
      } else {
        remoteId = selectedId;
        cloud = remote.payload.projects.find(p => p.projectId === remoteId);
        if (!cloud) throw cloudError('NOT_FOUND','所选云端项目不存在。');
        localId = mapping?.localId ?? remoteId;
        if (!mapping) {
          const raw = await this.workspace.capture(localId);
          if (Object.keys(raw.files).length || Object.keys(raw.entries.primary).length || Object.keys(raw.entries.backup).length) localId = `project-${crypto.randomBytes(10).toString('hex')}`;
        }
        local = await this.local(localId);
        candidate = cloud;
      }
      const comparable = local.portable ? {...local.portable,projectId:remoteId} : null;
      const differs = snapshotDigest(comparable) !== snapshotDigest(cloud);
      const conflict = differs && Boolean(direction === 'upload' ? cloud && (!mapping || mapping.remoteDigest !== snapshotDigest(cloud)) : comparable && (!mapping || mapping.localDigest !== snapshotDigest(comparable)));
      rows.push({rowId:remoteId,localId,remoteId,local,cloud,candidate,mapping,summary:{rowId:remoteId,name:candidate.name,conflict,suggested:conflict ? null : direction === 'upload' ? 'local' : 'cloud',diff:cloudProjectDiff(direction === 'upload' ? cloud : comparable,candidate),warnings:cloudProjectWarnings(candidate),willDisconnect:direction === 'download' && Boolean(local.portable)}});
    }
    return this.rememberPlan(owner,{direction,remote,rows});
  }
  rememberPlan(owner,plan) {
    for (const [id,p] of this.plans) if (p.expiresAt < Date.now() || p.owner === owner) this.plans.delete(id);
    if (this.plans.size >= 16) throw cloudError('BUSY','云配置预览过多，请关闭其他窗口后重试。');
    const planId = crypto.randomUUID();
    const expiresAt = Date.now()+5*60_000;
    this.plans.set(planId,{...plan,owner,expiresAt});
    return {planId,direction:plan.direction,snapshotId:plan.remote?.snapshotId ?? null,expiresAt,rows:plan.rows.map(r => r.summary)};
  }
  async prepareRestore(owner,{backupId}) {
    const backup = await this.workspace.readBackup(backupId);
    const projectId = backup.record.projectId;
    const before = await this.workspace.capture(projectId);
    return this.rememberPlan(owner,{direction:'restore',backup,rows:[{rowId:projectId,localId:projectId,local:{before,expected:snapshotDigest(before)},summary:{rowId:projectId,name:(await this.workspace.listBackups()).find(b => b.backupId === backupId)?.name ?? projectId,conflict:true,suggested:null,diff:cloudBackupDiff(before,backup.record.before),warnings:['恢复此项目的配置和凭据，并保留当前审计记录。'],willDisconnect:Boolean(before.files['workspace.yaml'])}}]});
  }
  async withProject(projectId,operation) {
    const coordinator = this.mutationCoordinator;
    coordinator.assertProjectAvailable(projectId);
    for (const fence of coordinator.environmentFences.values()) if (fence.projectId === projectId) throw cloudError('PROJECT_BUSY','项目存在活动编辑或连接计划，请结束后重试。');
    if (this.serverWorkspaceFiles?.activeProjectTransfers?.(projectId)) throw cloudError('PROJECT_BUSY','项目存在活动传输，请完成或取消后重试。');
    coordinator.cloudProjects.add(projectId);
    try {
      await deadline(coordinator.waitProjectActivity(projectId));
      await deadline(Promise.allSettled([...this.store.writeQueues.entries()].filter(([key]) => key.split(':').includes(projectId)).map(([,value]) => value)));
      return await operation();
    } finally { coordinator.cloudProjects.delete(projectId); }
  }
  async assertCurrent(row,checkPortable = true) {
    if (snapshotDigest(await this.workspace.capture(row.localId)) !== row.local.expected) throw cloudError('STALE','本地项目或凭据已变化，请重新预览。');
    if (checkPortable && row.local.portable && snapshotDigest(await exportCloudProject(this.store,this.vault,row.localId)) !== row.local.portableDigest) throw cloudError('STALE','私钥或项目内容已变化，请重新预览。');
  }
  async quiesce(projectId,before) {
    if (this.serverWorkspaceFiles?.activeProjectTransfers?.(projectId)) throw cloudError('PROJECT_BUSY','项目仍有活动传输。');
    if (before.files['workspace.yaml']) {
      const project = await this.store.getProject(projectId);
      for (const environmentId of project.environmentOrder) {
        this.configTransactionJournal?.assertEnvironmentAvailable(projectId,environmentId);
        await deadline(this.connectionManager?.disconnect(projectId,environmentId,'cloud-config'),15_000);
        for (const plugin of await this.store.listPlugins(projectId,environmentId)) {
          if (this.pluginManager?.status(plugin)?.connected) throw cloudError('PROJECT_BUSY','项目仍有插件连接未断开，请结束后重试。');
        }
      }
    }
    this.v2Service?.redisWorkspaceManager?.invalidate({projectId});
    this.serverDocker?.closeScope({projectId});
    this.serverWorkspaceManager?.closeScope({projectId});
    this.serverWorkspaceFiles?.closeScope({projectId});
    this.pluginEditSessionManager?.invalidateProject(projectId);
    this.contextManager?.invalidateProject(projectId);
    this.confirmationManager?.invalidateProject(projectId);
  }
  async confirm(owner,{planId,choices}) {
    const plan = this.plans.get(planId);
    if (!plan || plan.owner !== owner || plan.expiresAt < Date.now()) throw cloudError('PLAN_EXPIRED','预览已失效，请重新预览。');
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length !== plan.rows.length || plan.rows.some(row => !['local','cloud'].includes(choices[row.rowId]))) throw cloudError('INVALID_ARGUMENT','请为每个项目选择保留本地或采用云端。');
    this.plans.delete(planId);
    if (plan.direction === 'upload') return this.confirmUpload(owner,plan,choices);
    const results = [];
    for (const row of plan.rows) {
      if (choices[row.rowId] === 'local') { results.push({projectId:row.localId,status:'skipped'}); continue; }
      try {
        const result = await this.withProject(row.localId,async () => {
          await this.assertCurrent(row,plan.direction !== 'restore');
          let after;
          if (plan.direction === 'restore') {
            const current = await this.workspace.readBackup(plan.backup.record.id);
            if (current.digest !== plan.backup.digest) throw cloudError('STALE','本地备份已变化，请重新预览。');
            after = this.workspace.rebaseRestore(current.record.before,row.local.before);
          } else after = await this.workspace.materialize(row.candidate,row.localId,row.local.before);
          await this.quiesce(row.localId,row.local.before);
          await this.assertCurrent(row,plan.direction !== 'restore');
          const committed = await this.workspace.commit(row.local.before,after);
          await this.connectionManager?.forgetProject?.(row.localId);
          if (plan.direction !== 'restore') {
            const mapping = {remoteId:row.remoteId,localId:row.localId,remoteDigest:snapshotDigest(row.candidate),localDigest:snapshotDigest(row.candidate)};
            try { await this.saveState({...this.state,mappings:[...this.state.mappings.filter(m => m.remoteId !== row.remoteId),mapping]}); }
            catch { committed.syncStateWarning = true; }
          } else {
            try { await this.saveState({...this.state,mappings:this.state.mappings.map(m => m.localId === row.localId ? {...m,localDigest:null} : m)}); }
            catch { committed.syncStateWarning = true; }
          }
          await this.store.appendAudit(row.localId,{type:'cloud-config-imported',actor:'user',result:'success'}).catch(() => undefined);
          this.broadcast?.('v2:workspace-changed',{type:'cloud-config-imported',projectId:row.localId});
          return committed;
        });
        results.push({projectId:row.localId,status:'imported',...result});
      } catch (error) { results.push({projectId:row.localId,status:'failed',error:publicFailure(error)}); }
    }
    return {results};
  }
  async confirmUpload(owner,plan,choices) {
    const session = this.session(owner);
    if (session !== plan.remote.session) throw cloudError('PLAN_EXPIRED','仓库已重新绑定，请重新预览。');
    const selected = plan.rows.filter(row => choices[row.rowId] === 'local');
    if (!selected.length) return {results:plan.rows.map(row => ({projectId:row.localId,status:'skipped'}))};
    // 上传期间同时冻结所选项目，使确认绑定的本地版本保持一致。
    const run = index => index === selected.length ? publish() : this.withProject(selected[index].localId,() => run(index+1));
    const publish = async () => {
      for (const row of selected) await this.assertCurrent(row);
      const head = await this.client.call(session,'head');
      if (head.snapshotId !== plan.remote.headId) throw cloudError('CONFLICT','云端已更新，请重新预览后上传。');
      const projects = [...plan.remote.payload.projects];
      for (const row of selected) {
        const index = projects.findIndex(p => p.projectId === row.remoteId);
        if (index < 0) projects.push(row.candidate); else projects[index] = row.candidate;
      }
      const payload = normalizeCloudSnapshot({schemaVersion:1,projects},this.vault);
      const envelope = encryptCloudSnapshot(payload,session.metadata,session.keys.encryption,head.snapshotId);
      await this.client.call(session,'snapshots',{method:'POST',body:envelope,parentId:head.snapshotId});
      const mappings = [...this.state.mappings];
      for (const row of selected) {
        const mapping = {remoteId:row.remoteId,localId:row.localId,remoteDigest:snapshotDigest(row.candidate),localDigest:snapshotDigest(row.candidate)};
        const index = mappings.findIndex(m => m.remoteId === row.remoteId);
        if (index < 0) mappings.push(mapping); else mappings[index] = mapping;
        await this.store.appendAudit(row.localId,{type:'cloud-config-uploaded',actor:'user',result:'success'}).catch(() => undefined);
      }
      let syncStateWarning = false;
      try { await this.saveState({...this.state,mappings}); } catch { syncStateWarning = true; }
      return {snapshotId:envelope.snapshotId,syncStateWarning,results:plan.rows.map(row => ({projectId:row.localId,status:choices[row.rowId] === 'local' ? 'uploaded' : 'skipped'}))};
    };
    return run(0);
  }
}
