import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CloudConfigClient } from './cloud-config-client.mjs';
import { cloudError, cloudHash, cloudId, deriveCloudKeys, newCloudMeta, encryptCloudSnapshot, decryptCloudSnapshot } from './cloud-config-crypto.mjs';
import { exportCloudProject, normalizeCloudSnapshot, snapshotDigest, cloudProjectWarnings, cloudProjectDiff, cloudBackupDiff, cloudTrashAvailable } from './cloud-config-snapshot.mjs';
import { appendCloudVersion, pruneCloudHistory, projectSummary, cloudVersionSummaries } from './cloud-config-history.mjs';

const emptyState = () => ({schemaVersion:2,repositories:[],activeRepositoryId:null,mappings:[],detachedMappings:[],checkIntervalMinutes:15});
const projectIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const newProjectId = () => `project-${crypto.randomUUID()}`;
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
    this.snapshots = new Map();
    this.histories = new Map();
    this.epochs = new Map();
    this.plans = new Map();
    this.queue = Promise.resolve();
    this.checkFlights = new Map();
    this.checkSlots = 0;
    this.checkWaiters = [];
    this.stateError = false;
    mutationCoordinator.cloudRecoveryGuard = projectId => workspace.assertProjectAvailable(projectId);
    this.store.cloudMutationGuard = projectId => mutationCoordinator.assertCloudProjectAvailable(projectId);
  }
  async init() {
    try {
      this.state = await this.workspace.unseal(await fs.readFile(this.stateFile,'utf8'));
      if (this.state.schemaVersion === 1 && Array.isArray(this.state.mappings)) {
        const old = this.state, repositoryId = old.repository ? crypto.randomUUID() : null;
        await this.saveState({...emptyState(),activeRepositoryId:repositoryId,
          repositories:old.repository ? [{...old.repository,repositoryId,name:'云仓库 1',hiddenProjectIds:[],catalog:[]}] : [],
          mappings:old.mappings.map(mapping => ({...mapping,repositoryId}))});
      }
      if (this.state.schemaVersion !== 2 || !Array.isArray(this.state.repositories) || !Array.isArray(this.state.mappings)) throw new Error();
      this.state.detachedMappings ??= [];
      if (!Array.isArray(this.state.detachedMappings)) throw new Error();
    } catch (error) { if (error.code !== 'ENOENT') this.stateError = true; }
  }
  async saveState(state) { await this.workspace.writeSealed(this.stateFile,state); this.state = state; }
  invoke(owner,method,payload = {}) {
    const epoch = this.epochs.get(owner) ?? 0;
    const run = async () => {
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
      if (this.stateError) throw cloudError('LOCAL_DECRYPT_FAILED','本机云仓库记录无法解密，请恢复系统安全存储后重试。');
      return this[method](owner,payload,epoch);
    };
    // Network checks run independently; only their small state commits join the
    // mutation queue. Read-only status never waits for an unreachable server.
    return ['check','status','backups'].includes(method) ? run() : this.enqueue(run);
  }
  enqueue(run) {
    const current = this.queue.catch(() => undefined).then(run);
    this.queue = current;
    return current;
  }
  cancelChecks(predicate) {
    for (const flight of this.checkFlights.values()) if (predicate(flight)) flight.controller.abort();
  }
  closeOwner(owner) {
    this.epochs.set(owner,(this.epochs.get(owner) ?? 0)+1);
    this.cancelChecks(flight => flight.owner === owner);
    for (const session of this.sessions.get(owner)?.values() ?? []) session.keys.encryption.fill(0);
    this.sessions.delete(owner);
    this.snapshots.clear();
    this.histories.clear();
    for (const [id,plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
  }
  repository(repositoryId = this.state.activeRepositoryId) {
    const repo = this.state.repositories.find(item => item.repositoryId === repositoryId);
    if (!repo) throw cloudError('NOT_FOUND','云仓库尚未关联或已解除绑定。');
    return repo;
  }
  async saveRepository(repo) {
    await this.saveState({...this.state,repositories:this.state.repositories.map(item => item.repositoryId === repo.repositoryId ? repo : item)});
  }
  session(owner,repositoryId) {
    const repo = this.repository(repositoryId);
    let sessions = this.sessions.get(owner);
    if (!sessions) { sessions = new Map(); this.sessions.set(owner,sessions); }
    let session = sessions.get(repo.repositoryId);
    if (!session && repo.remembered) {
      session = {...this.client.repository(repo.url),metadata:repo.metadata,keys:{auth:repo.remembered.auth,encryption:Buffer.from(repo.remembered.encryption,'base64')}};
      sessions.set(repo.repositoryId,session);
    }
    if (!session) throw cloudError('LOCKED','请先输入仓库链接和密码。');
    return session;
  }
  async status(owner) {
    const localProjects = await this.store.listProjects();
    const localIds = new Set(localProjects.map(p => p.projectId));
    const repositories = this.state.repositories.map(repo => ({repositoryId:repo.repositoryId,name:repo.name,url:repo.url,
      unlocked:this.sessions.get(owner)?.has(repo.repositoryId) || Boolean(repo.remembered),remembered:Boolean(repo.remembered),
      checkedAt:repo.checkedAt ?? null,error:repo.error ?? null,snapshotId:repo.snapshotId ?? null}));
    const cloudProjects = [];
    for (const repo of this.state.repositories) for (const project of repo.catalog ?? []) {
      const mapping = this.state.mappings.find(m => m.repositoryId === repo.repositoryId && m.remoteId === project.projectId);
      const downloaded = Boolean(mapping && localIds.has(mapping.localId));
      let syncStatus = downloaded ? 'unknown' : 'remote';
      if (downloaded) {
        try {
          const local = await this.local(mapping.localId);
          const digest = snapshotDigest({...local.portable,projectId:project.projectId});
          syncStatus = digest === project.digest ? 'synced'
            : digest === mapping.localDigest || (repo.hashes?.[project.projectId] ?? []).includes(digest) ? 'behind' : 'modified';
        } catch { syncStatus = 'error'; }
      }
      if (repo.error) syncStatus = 'error';
      else if (!repositories.find(r => r.repositoryId === repo.repositoryId)?.unlocked) syncStatus = 'locked';
      cloudProjects.push({projectId:project.projectId,name:project.name,repositoryId:repo.repositoryId,localId:downloaded ? mapping.localId : null,
        visible:!(repo.hiddenProjectIds ?? []).includes(project.projectId),downloaded,syncStatus,
        environmentCount:project.environmentCount,pluginCount:project.pluginCount});
    }
    const active = repositories.find(repo => repo.repositoryId === this.state.activeRepositoryId);
    return {repositoryId:active?.repositoryId,url:active?.url ?? '',unlocked:active?.unlocked ?? false,remembered:active?.remembered ?? false,
      repositories,cloudProjects,deletedCloudProjects:this.state.repositories.flatMap(repo => (repo.deletedProjects ?? []).filter(p => cloudTrashAvailable(p)).map(p => ({...p,repositoryId:repo.repositoryId}))),
      checkIntervalMinutes:this.state.checkIntervalMinutes,projects:localProjects.map(p => ({projectId:p.projectId,name:p.name}))};
  }
  async backups(_owner,options) { return this.workspace.listBackups(options); }
  async bind(owner,{url,password,remember = false,name},epoch) {
    const remote = await this.client.metadata(url);
    const previous = this.state.repositories.find(repo => repo.url === remote.url);
    if (previous && snapshotDigest(remote.metadata) !== snapshotDigest(previous.metadata)) throw cloudError('REPOSITORY_CHANGED','仓库密钥参数已变化，请核对服务地址和仓库。');
    if (!previous && this.state.repositories.length >= 20) throw cloudError('TOO_LARGE','最多关联 20 个云仓库。');
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80)) throw cloudError('INVALID_ARGUMENT','仓库名称应为 1 到 80 个字符。');
    const keys = await deriveCloudKeys(password,remote.metadata);
    const session = {...remote,keys};
    try {
      await this.client.call(session,'head');
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
      const repositoryId = previous?.repositoryId ?? crypto.randomUUID();
      const repo = {...previous,repositoryId,url:remote.url,metadata:remote.metadata,name:name?.trim() ?? previous?.name ?? `云仓库 ${this.state.repositories.length+1}`,
        hiddenProjectIds:previous?.hiddenProjectIds ?? [],catalog:previous?.catalog ?? [],
        remembered:remember ? {auth:keys.auth,encryption:keys.encryption.toString('base64')} : undefined};
      const repositoryKey = snapshotDigest(remote.metadata);
      const detached = this.state.detachedMappings.filter(m => m.repositoryKey === repositoryKey);
      const mappings = [...this.state.mappings];
      for (const {repositoryKey:_key,...mapping} of detached) {
        if (!mappings.some(m => m.repositoryId === repositoryId && m.remoteId === mapping.remoteId)) mappings.push({...mapping,repositoryId});
      }
      await this.saveState({...this.state,activeRepositoryId:repositoryId,repositories:[...this.state.repositories.filter(r => r.repositoryId !== repositoryId),repo],mappings,
        detachedMappings:this.state.detachedMappings.filter(m => m.repositoryKey !== repositoryKey)});
      this.cancelChecks(flight => flight.repositoryId === repositoryId);
      for (const sessions of this.sessions.values()) { sessions.get(repositoryId)?.keys.encryption.fill(0); sessions.delete(repositoryId); }
      if (!this.sessions.has(owner)) this.sessions.set(owner,new Map());
      this.sessions.get(owner).set(repositoryId,session);
      for (const [id,plan] of this.plans) if (plan.repositoryId === repositoryId) this.plans.delete(id);
      this.snapshots.delete(repositoryId);
      this.histories.delete(repositoryId);
      return this.status(owner);
    } catch (error) { keys.encryption.fill(0); throw error; }
  }
  async create(owner,{serviceUrl,adminToken,password,remember = false,name},epoch) {
    const url = this.client.origin(serviceUrl);
    if (url.pathname !== '/') throw cloudError('URL_INVALID','创建仓库时请输入服务根地址。');
    if (typeof adminToken !== 'string' || !/^[A-Za-z0-9_-]{32,1024}$/.test(adminToken)) throw cloudError('AUTH_FAILED','管理员令牌格式无效。');
    await this.workspace.seal({schemaVersion:1});
    const metadata = newCloudMeta();
    const keys = await deriveCloudKeys(password,metadata);
    try {
      await this.client.request(url.origin,'/api/v1/repos',{method:'POST',token:adminToken,body:{metadata,authHash:cloudHash(keys.auth)}});
    } finally { keys.encryption.fill(0); }
    return this.bind(owner,{url:`${url.origin}/r/${metadata.repoId}`,password,remember,name},epoch);
  }
  async unbind(owner,{repositoryId} = {}) {
    const repo = this.repository(repositoryId);
    const repositories = this.state.repositories.filter(r => r.repositoryId !== repo.repositoryId);
    // Retain only project provenance, never remembered authentication material.
    const repositoryKey = snapshotDigest(repo.metadata);
    const detached = this.state.mappings.filter(m => m.repositoryId === repo.repositoryId).map(({repositoryId:_id,...mapping}) => ({...mapping,repositoryKey}));
    await this.saveState({...this.state,repositories,activeRepositoryId:repositories[0]?.repositoryId ?? null,mappings:this.state.mappings.filter(m => m.repositoryId !== repo.repositoryId),
      detachedMappings:[...this.state.detachedMappings.filter(m => m.repositoryKey !== repositoryKey),...detached]});
    this.cancelChecks(flight => flight.repositoryId === repo.repositoryId);
    for (const sessions of this.sessions.values()) { sessions.get(repo.repositoryId)?.keys.encryption.fill(0); sessions.delete(repo.repositoryId); }
    for (const [id,plan] of this.plans) if (plan.repositoryId === repo.repositoryId) this.plans.delete(id);
    this.snapshots.delete(repo.repositoryId);
    this.histories.delete(repo.repositoryId);
    return this.status(owner);
  }
  async remote(owner,snapshotId = null,repositoryId,{cache = true,signal} = {}) {
    const repo = this.repository(repositoryId);
    const session = this.session(owner,repo.repositoryId);
    const head = await this.client.call(session,'head',{signal});
    if (head.snapshotId !== null) cloudId(head.snapshotId);
    const selected = snapshotId ?? head.snapshotId;
    if (!selected) return {session,headId:null,snapshotId:null,payload:{schemaVersion:1,projects:[]}};
    cloudId(selected);
    const cached = this.snapshots.get(repo.repositoryId);
    if (cached?.snapshotId === selected) return {...cached,session,headId:head.snapshotId};
    const envelope = await this.client.call(session,`snapshots/${selected}`,{signal});
    if (envelope.snapshotId !== selected) throw cloudError('SCOPE_MISMATCH','下载内容与所选云版本不一致。');
    const result = {session,headId:head.snapshotId,snapshotId:selected,payload:normalizeCloudSnapshot(decryptCloudSnapshot(envelope,session.metadata,session.keys.encryption),this.vault)};
    if (cache && !snapshotId) this.snapshots.set(repo.repositoryId,result);
    return result;
  }
  async catalog(owner,{snapshotId = null,repositoryId} = {}) {
    const remote = await this.remote(owner,snapshotId,repositoryId);
    const versions = await this.client.call(remote.session,'versions');
    if (!Array.isArray(versions.versions) || versions.versions.length > 100) throw cloudError('FORMAT_INVALID','云版本列表无效。');
    return {snapshotId:remote.snapshotId,projects:remote.payload.projects.map(p => ({projectId:p.projectId,name:p.name,warnings:cloudProjectWarnings(p)})),versions:versions.versions.map(v => ({snapshotId:cloudId(v.snapshotId),createdAt:String(v.createdAt).slice(0,40),bytes:Number(v.bytes)}))};
  }
  async rememberRemote(repositoryId,remote) {
    const repo = this.repository(repositoryId), hashes = {...repo.hashes};
    const catalog = remote.payload.projects.map(project => {
      const digest = snapshotDigest(project);
      hashes[project.projectId] = [...new Set([...(hashes[project.projectId] ?? []),digest])].slice(-256);
      return {projectId:project.projectId,name:project.name,digest,environmentCount:project.environments.length,
        pluginCount:project.environments.reduce((sum,env) => sum+env.plugins.length,0)};
    });
    for (const record of remote.payload.history ?? []) {
      hashes[record.projectId] = [...new Set([...(hashes[record.projectId] ?? []),...record.versions.map(v => snapshotDigest(v.project))])].slice(-256);
    }
    const deletedProjects = (remote.payload.history ?? []).filter(record => cloudTrashAvailable(record)).map(record => ({...projectSummary(record.versions.at(-1).project),deletedAt:record.deletedAt}));
    await this.saveRepository({...repo,catalog,hashes,deletedProjects,snapshotId:remote.snapshotId,checkedAt:new Date().toISOString(),error:null});
  }
  async renameRepository(owner,{repositoryId,name}) {
    if (typeof repositoryId !== 'string' || typeof name !== 'string' || !name.normalize('NFKC').trim() || name.normalize('NFKC').trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw cloudError('INVALID_ARGUMENT','仓库名称应为 1 到 80 个字符，且不能包含控制字符。');
    await this.saveRepository({...this.repository(repositoryId),name:name.normalize('NFKC').trim()});
    return this.status(owner);
  }
  async projectArchive(owner,repositoryId,remote) {
    if (remote.payload.schemaVersion >= 2) return pruneCloudHistory(remote.payload);
    const cached = this.histories.get(repositoryId);
    if (cached?.snapshotId === remote.snapshotId) return cached.payload;
    let payload = {schemaVersion:3,projects:[],history:[],tombstones:[]};
    if (remote.snapshotId) {
      const {versions} = await this.client.call(remote.session,'versions');
      if (!Array.isArray(versions) || versions.length > 100) throw cloudError('FORMAT_INVALID','云版本列表无效。');
      if (versions[0]?.snapshotId !== remote.snapshotId) throw cloudError('CONFLICT','云仓库已变化，请重新检测后操作。');
      const activeIds = new Set(remote.payload.projects.map(p => p.projectId));
      // Only legacy active projects are migrated; there was no trash in schema 1.
      for (const version of [...versions].reverse()) {
        const snapshotId = cloudId(version.snapshotId);
        const snapshot = snapshotId === remote.snapshotId ? remote : await this.remote(owner,snapshotId,repositoryId);
        for (const project of snapshot.payload.projects.filter(p => activeIds.has(p.projectId))) {
          payload = appendCloudVersion(payload,project,{versionId:snapshotId,createdAt:version.createdAt});
        }
      }
      // Keep the current project ordering, even if a historical snapshot differs.
      payload.projects = remote.payload.projects;
    }
    payload = normalizeCloudSnapshot(payload,this.vault);
    this.histories.set(repositoryId,{snapshotId:remote.snapshotId,payload});
    return payload;
  }
  async projectHistory(owner,{repositoryId,projectId}) {
    if (typeof repositoryId !== 'string' || typeof projectId !== 'string' || !projectIdPattern.test(projectId)) throw cloudError('INVALID_ARGUMENT','请选择仓库中的单个项目。');
    const remote = await this.remote(owner,null,repositoryId);
    const payload = await this.projectArchive(owner,repositoryId,remote);
    const record = payload.history.find(r => r.projectId === projectId && (r.deletedAt === null || cloudTrashAvailable(r)));
    if (!record) throw cloudError('NOT_FOUND','项目不存在或已超过恢复期限。');
    await this.rememberRemote(repositoryId,remote);
    return {projectHistory:{repositoryId,projectId,snapshotId:remote.snapshotId,name:record.versions.at(-1).project.name,deletedAt:record.deletedAt,versions:cloudVersionSummaries(record)}};
  }
  async prepareProjectOperation(owner,{repositoryId,projectId,operation,snapshotId,versionId}) {
    if (typeof repositoryId !== 'string' || typeof projectId !== 'string' || !projectIdPattern.test(projectId) || !['delete','restore','restoreVersion'].includes(operation) || (operation !== 'restoreVersion' && versionId !== undefined)) throw cloudError('INVALID_ARGUMENT','云项目操作范围无效。');
    cloudId(snapshotId);
    if (operation === 'restoreVersion') cloudId(versionId);
    const epoch = this.epochs.get(owner) ?? 0;
    const remote = await this.remote(owner,null,repositoryId);
    if (remote.snapshotId !== snapshotId) throw cloudError('CONFLICT','云仓库已变化，请重新检测或打开版本记录后操作。');
    const archive = await this.projectArchive(owner,repositoryId,remote);
    const record = archive.history.find(r => r.projectId === projectId);
    if (!record || (operation === 'restore' ? !cloudTrashAvailable(record) : record.deletedAt !== null)) throw cloudError('NOT_FOUND','项目不存在或已超过恢复期限。');
    const version = operation === 'restoreVersion' ? record.versions.find(v => v.versionId === versionId) : record.versions.at(-1);
    if (!version) throw cloudError('NOT_FOUND','所选项目版本已不存在，请重新打开版本记录。');
    if ((this.epochs.get(owner) ?? 0) !== epoch || this.session(owner,repositoryId) !== remote.session) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
    const plan = this.rememberPlan(owner,{direction:'project-operation',repositoryId,remote,archive,operation,projectId,version,rows:[]});
    return {projectOperation:{planId:plan.planId,repositoryId,repositoryName:this.repository(repositoryId).name,...projectSummary(record.versions.at(-1).project),operation,
      versionId:version.versionId,versionName:version.project.name,createdAt:version.createdAt,expiresAt:plan.expiresAt}};
  }
  async confirmProjectOperation(owner,{planId}) {
    const plan = this.plans.get(planId);
    if (!plan || plan.direction !== 'project-operation' || plan.owner !== owner || plan.expiresAt < Date.now()) throw cloudError('PLAN_EXPIRED','确认已失效，请重新操作。');
    this.plans.delete(planId);
    const epoch = this.epochs.get(owner) ?? 0;
    const session = this.session(owner,plan.repositoryId);
    if (session !== plan.remote.session) throw cloudError('PLAN_EXPIRED','仓库会话已变化，请重新操作。');
    const head = await this.client.call(session,'head');
    if (head.snapshotId !== plan.remote.snapshotId) throw cloudError('CONFLICT','云仓库已变化，请重新检测后确认。');
    let payload = pruneCloudHistory(plan.archive);
    if (!payload.history.some(r => r.projectId === plan.projectId)) throw cloudError('NOT_FOUND','项目已超过恢复期限。');
    if (plan.operation === 'delete') {
      payload = pruneCloudHistory({...payload,projects:payload.projects.filter(p => p.projectId !== plan.projectId),history:payload.history.map(r => r.projectId === plan.projectId ? {...r,deletedAt:new Date().toISOString()} : r)});
    } else payload = appendCloudVersion(payload,plan.version.project,{force:true,restore:plan.operation === 'restore'});
    payload = normalizeCloudSnapshot(payload,this.vault);
    const envelope = encryptCloudSnapshot(payload,session.metadata,session.keys.encryption,head.snapshotId);
    if ((this.epochs.get(owner) ?? 0) !== epoch || this.session(owner,plan.repositoryId) !== session) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
    await this.client.call(session,'snapshots',{method:'POST',body:envelope,parentId:head.snapshotId});
    const remote = {session,headId:envelope.snapshotId,snapshotId:envelope.snapshotId,payload};
    this.snapshots.set(plan.repositoryId,remote);
    this.histories.delete(plan.repositoryId);
    let syncStateWarning = false;
    try { await this.rememberRemote(plan.repositoryId,remote); } catch { syncStateWarning = true; }
    const mapping = this.state.mappings.find(m => m.repositoryId === plan.repositoryId && m.remoteId === plan.projectId);
    if (mapping) await this.store.appendAudit(mapping.localId,{type:`cloud-project-${plan.operation === 'delete' ? 'deleted' : 'restored'}`,actor:'user',result:'success'}).catch(() => undefined);
    return {snapshotId:envelope.snapshotId,syncStateWarning,results:[{projectId:plan.projectId,status:plan.operation === 'delete' ? 'cloud-deleted' : 'cloud-restored'}]};
  }
  async knownHistory(owner,repositoryId,remoteId,digest) {
    const repo = this.repository(repositoryId);
    if ((repo.hashes?.[remoteId] ?? []).includes(digest)) return true;
    const session = this.session(owner,repositoryId);
    const versions = await this.client.call(session,'versions');
    if (!Array.isArray(versions.versions) || versions.versions.length > 100) throw cloudError('FORMAT_INVALID','云版本列表无效。');
    const hashes = {...repo.hashes};
    for (const version of versions.versions) {
      const id = cloudId(version.snapshotId);
      const envelope = await this.client.call(session,`snapshots/${id}`);
      if (envelope.snapshotId !== id) throw cloudError('SCOPE_MISMATCH','历史版本与下载内容不一致。');
      const snapshot = normalizeCloudSnapshot(decryptCloudSnapshot(envelope,session.metadata,session.keys.encryption),this.vault);
      for (const p of [...snapshot.projects,...(snapshot.history ?? []).flatMap(record => record.versions.map(v => v.project))]) hashes[p.projectId] = [...new Set([...(hashes[p.projectId] ?? []),snapshotDigest(p)])].slice(-256);
      if ((hashes[remoteId] ?? []).includes(digest)) break;
    }
    await this.saveRepository({...this.repository(repositoryId),hashes});
    return (hashes[remoteId] ?? []).includes(digest);
  }
  async withCheckSlot(signal,run) {
    if (this.checkSlots < 2) this.checkSlots++;
    else await new Promise((resolve,reject) => {
      const waiter = () => { signal.removeEventListener('abort',abort); resolve(); };
      const abort = () => { this.checkWaiters = this.checkWaiters.filter(w => w !== waiter); reject(cloudError('CANCELLED','云仓库检测已取消。')); };
      signal.addEventListener('abort',abort,{once:true});
      this.checkWaiters.push(waiter);
      if (signal.aborted) abort();
    });
    try { if (!signal.aborted) return await run(); }
    finally { const next = this.checkWaiters.shift(); if (next) next(); else this.checkSlots--; }
  }
  checkRepository(owner,repositoryId,epoch) {
    const key = JSON.stringify([owner,repositoryId]);
    const previous = this.checkFlights.get(key);
    if (previous && !previous.controller.signal.aborted) return previous.promise;
    const controller = new AbortController();
    const flight = {owner,repositoryId,controller};
    flight.promise = this.withCheckSlot(controller.signal,async () => {
      const repo = this.repository(repositoryId), cached = this.snapshots.get(repositoryId);
      let remote, failure;
      try { remote = await this.remote(owner,null,repositoryId,{cache:false,signal:controller.signal}); }
      catch (error) { failure = error; }
      await this.enqueue(async () => {
        const current = this.state.repositories.find(r => r.repositoryId === repositoryId);
        if (controller.signal.aborted || (this.epochs.get(owner) ?? 0) !== epoch || !current || current.snapshotId !== repo.snapshotId || this.snapshots.get(repositoryId) !== cached) return;
        if (failure) {
          await this.saveRepository({...current,error:{code:failure?.code?.startsWith('CLOUD_') ? failure.code : 'CLOUD_CHECK_FAILED',
            message:failure?.code === 'CLOUD_FORMAT_UNSUPPORTED' ? '云仓库格式已升级，请更新应用后重试。' : '检测失败，请检查仓库解锁状态和网络。'}});
        } else {
          if (this.session(owner,repositoryId) !== remote.session) return;
          await this.rememberRemote(repositoryId,remote);
          this.snapshots.set(repositoryId,remote);
        }
      });
    }).catch(error => { if (!controller.signal.aborted) throw error; }).finally(() => {
      if (this.checkFlights.get(key) === flight) this.checkFlights.delete(key);
    });
    this.checkFlights.set(key,flight);
    return flight.promise;
  }
  async check(owner,{repositoryId} = {},epoch = this.epochs.get(owner) ?? 0) {
    const repositories = repositoryId !== undefined ? [this.repository(repositoryId)] : [...this.state.repositories];
    await Promise.all(repositories.map(repo => this.checkRepository(owner,repo.repositoryId,epoch)));
    if ((this.epochs.get(owner) ?? 0) !== epoch) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
    return this.status(owner);
  }
  async visibility(owner,{repositoryId,projectIds,visible}) {
    const repo = this.repository(repositoryId);
    if (typeof visible !== 'boolean' || !Array.isArray(projectIds) || projectIds.length > 200 || projectIds.some(id => !(repo.catalog ?? []).some(p => p.projectId === id))) throw cloudError('INVALID_ARGUMENT','显示设置的项目范围无效。');
    const hidden = new Set(repo.hiddenProjectIds);
    for (const id of projectIds) { if (visible) hidden.delete(id); else hidden.add(id); }
    await this.saveRepository({...repo,hiddenProjectIds:[...hidden]});
    return this.status(owner);
  }
  async preferences(owner,{checkIntervalMinutes}) {
    if (![0,5,15,30,60].includes(checkIntervalMinutes)) throw cloudError('INVALID_ARGUMENT','检测间隔无效。');
    await this.saveState({...this.state,checkIntervalMinutes});
    return this.status(owner);
  }
  async sync(owner,{repositoryId,direction,projectId}) {
    if (typeof repositoryId !== 'string' || !repositoryId) throw cloudError('INVALID_ARGUMENT','请选择需要操作的云仓库。');
    const repo = this.repository(repositoryId);
    if (!['upload','download'].includes(direction) || (projectId !== undefined && (typeof projectId !== 'string' || !projectIdPattern.test(projectId))) || (direction === 'upload' && !projectId)) throw cloudError('INVALID_ARGUMENT','请选择单个项目上传或需要更新的仓库。');
    let projectIds = projectId ? [projectId] : null;
    if (!projectIds) {
      const localIds = new Set((await this.store.listProjects()).map(p => p.projectId));
      const remote = await this.remote(owner,null,repo.repositoryId);
      await this.rememberRemote(repo.repositoryId,remote);
      projectIds = this.state.mappings.filter(m => m.repositoryId === repo.repositoryId && localIds.has(m.localId) && remote.payload.projects.some(p => p.projectId === m.remoteId)).map(m => m.remoteId);
    }
    if (!projectIds.length) return {results:[]};
    const prepared = await this.prepare(owner,{repositoryId:repo.repositoryId,direction,projectIds,newIdentity:true});
    const plan = this.plans.get(prepared.planId);
    if (direction === 'upload') {
      plan.overwrite = true;
      return this.confirm(owner,{planId:prepared.planId,choices:Object.fromEntries(plan.rows.map(row => [row.rowId,'local']))});
    }
    this.plans.delete(prepared.planId);
    const conflicts = plan.rows.filter(row => row.summary.conflict);
    const safe = plan.rows.filter(row => !row.summary.conflict && row.summary.diff.contentChanged);
    let results = plan.rows.filter(row => !row.summary.diff.contentChanged).map(row => ({projectId:row.localId,status:'unchanged'}));
    if (safe.length) {
      const ready = this.rememberPlan(owner,{...plan,rows:safe});
      const applied = await this.confirm(owner,{planId:ready.planId,choices:Object.fromEntries(safe.map(row => [row.rowId,'cloud']))});
      results = [...results,...applied.results];
    }
    if (conflicts.length) return {...this.rememberPlan(owner,{...plan,rows:conflicts}),results};
    return {results};
  }
  async local(projectId) {
    this.mutationCoordinator.assertProjectAvailable(projectId);
    const before = await this.workspace.capture(projectId);
    const portable = before.files['workspace.yaml'] ? await exportCloudProject(this.store,this.vault,projectId) : null;
    if (snapshotDigest(before) !== snapshotDigest(await this.workspace.capture(projectId))) throw cloudError('STALE','项目在读取时发生变化，请重新预览。');
    return {before,portable,expected:snapshotDigest(before),portableDigest:snapshotDigest(portable)};
  }
  async prepare(owner,{direction,projectIds,snapshotId = null,repositoryId,newIdentity = false}) {
    if (!['upload','download'].includes(direction) || !Array.isArray(projectIds) || !projectIds.length || projectIds.length > 200 || new Set(projectIds).size !== projectIds.length) throw cloudError('INVALID_ARGUMENT','请选择要上传或下载的项目。');
    const repo = this.repository(repositoryId);
    const remote = await this.remote(owner,direction === 'download' ? snapshotId : null,repo.repositoryId);
    const rows = [];
    for (const selectedId of projectIds) {
      const mapping = this.state.mappings.find(m => m.repositoryId === repo.repositoryId && (direction === 'upload' ? m.localId === selectedId || m.pendingUploadSource === selectedId : m.remoteId === selectedId));
      let localId,remoteId,local,cloud,candidate,linkLocalId;
      if (direction === 'upload') {
        localId = selectedId;
        local = await this.local(localId);
        if (!local.portable) throw cloudError('NOT_FOUND','所选本地项目不存在。');
        const copied = this.state.mappings.some(m => m.localId === localId && m.repositoryId !== repo.repositoryId)
          || this.state.detachedMappings.some(m => m.localId === localId);
        remoteId = mapping?.remoteId ?? (newIdentity || copied || remote.payload.projects.some(p => p.projectId === localId) ? newProjectId() : localId);
        linkLocalId = mapping?.localId ?? (copied ? remoteId : localId);
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
      let conflict = differs && Boolean(direction === 'upload' ? cloud && (!mapping || mapping.remoteDigest !== snapshotDigest(cloud)) : comparable && (!mapping || mapping.localDigest !== snapshotDigest(comparable)));
      if (direction === 'download' && conflict && mapping && await this.knownHistory(owner,repo.repositoryId,remoteId,snapshotDigest(comparable))) conflict = false;
      rows.push({rowId:remoteId,localId,linkLocalId,remoteId,local,cloud,candidate,mapping,summary:{rowId:remoteId,name:candidate.name,conflict,suggested:conflict ? null : direction === 'upload' ? 'local' : 'cloud',diff:cloudProjectDiff(direction === 'upload' ? cloud : comparable,candidate),warnings:cloudProjectWarnings(candidate),willDisconnect:direction === 'download' && Boolean(local.portable)}});
    }
    return this.rememberPlan(owner,{repositoryId:repo.repositoryId,direction,remote,rows});
  }
  rememberPlan(owner,plan) {
    for (const [id,p] of this.plans) if (p.expiresAt < Date.now() || p.owner === owner) this.plans.delete(id);
    if (this.plans.size >= 16) throw cloudError('BUSY','云配置预览过多，请关闭其他窗口后重试。');
    const planId = crypto.randomUUID();
    const expiresAt = Date.now()+5*60_000;
    this.plans.set(planId,{...plan,owner,expiresAt});
    return {planId,repositoryId:plan.repositoryId,direction:plan.direction,snapshotId:plan.remote?.snapshotId ?? null,expiresAt,rows:plan.rows.map(r => r.summary)};
  }
  async prepareRestore(owner,{backupId}) {
    const backup = await this.workspace.readBackup(backupId);
    const projectId = backup.record.projectId;
    const before = await this.workspace.capture(projectId);
    return this.rememberPlan(owner,{direction:'restore',backup,rows:[{rowId:projectId,localId:projectId,local:{before,expected:snapshotDigest(before)},summary:{rowId:projectId,name:this.workspace.backupSummary(backup.record)?.name ?? projectId,conflict:true,suggested:null,diff:cloudBackupDiff(before,backup.record.before),warnings:['恢复此项目的配置和凭据，并保留当前审计记录。'],willDisconnect:Boolean(before.files['workspace.yaml'])}}]});
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
  async reserveMappings(repositoryId,rows,direction) {
    const mappings = [...this.state.mappings];
    for (const row of rows) {
      const localId = direction === 'upload' ? row.linkLocalId ?? row.localId : row.localId;
      const existing = mappings.find(m => m.repositoryId === repositoryId && m.remoteId === row.remoteId);
      if (existing) {
        if (existing.localId !== localId) throw cloudError('STALE','项目关联已变化，请重新操作。');
        continue;
      }
      mappings.push({repositoryId,remoteId:row.remoteId,localId,remoteDigest:null,localDigest:null,
        ...(direction === 'upload' ? {pendingUploadSource:row.localId} : {})});
    }
    // Persist identity BEFORE either side changes. A crash, lost response or
    // failed baseline write can then be retried without allocating another ID.
    if (mappings.length !== this.state.mappings.length) await this.saveState({...this.state,mappings});
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
    if (!plan || !['upload','download','restore'].includes(plan.direction) || plan.owner !== owner || plan.expiresAt < Date.now()) throw cloudError('PLAN_EXPIRED','预览已失效，请重新预览。');
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length !== plan.rows.length || plan.rows.some(row => !['local','cloud'].includes(choices[row.rowId]))) throw cloudError('INVALID_ARGUMENT','请为每个项目选择保留本地或采用云端。');
    this.plans.delete(planId);
    if (plan.direction !== 'restore' && this.session(owner,plan.repositoryId) !== plan.remote.session) throw cloudError('PLAN_EXPIRED','仓库会话已变化，请重新操作。');
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
          if (plan.direction !== 'restore') await this.reserveMappings(plan.repositoryId,[row],'download');
          const committed = await this.workspace.commit(row.local.before,after);
          await this.connectionManager?.forgetProject?.(row.localId);
          if (plan.direction !== 'restore') {
            const mapping = {repositoryId:plan.repositoryId,remoteId:row.remoteId,localId:row.localId,remoteDigest:snapshotDigest(row.candidate),localDigest:snapshotDigest(row.candidate)};
            try { await this.saveState({...this.state,mappings:[...this.state.mappings.filter(m => m.repositoryId !== plan.repositoryId || m.remoteId !== row.remoteId),mapping]}); }
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
    if (plan.direction !== 'restore' && plan.remote.snapshotId === plan.remote.headId) {
      try { await this.rememberRemote(plan.repositoryId,plan.remote); }
      catch { return {results,syncStateWarning:true}; }
    }
    return {results};
  }
  async confirmUpload(owner,plan,choices) {
    const epoch = this.epochs.get(owner) ?? 0;
    const session = this.session(owner,plan.repositoryId);
    if (session !== plan.remote.session) throw cloudError('PLAN_EXPIRED','仓库已重新绑定，请重新预览。');
    const selected = plan.rows.filter(row => choices[row.rowId] === 'local');
    if (!selected.length) return {results:plan.rows.map(row => ({projectId:row.localId,status:'skipped'}))};
    // 上传期间同时冻结所选项目，使确认绑定的本地版本保持一致。
    const run = index => index === selected.length ? publish() : this.withProject(selected[index].localId,() => run(index+1));
    const publish = async () => {
      for (const row of selected) await this.assertCurrent(row);
      await this.reserveMappings(plan.repositoryId,selected,'upload');
      let envelope, payload;
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = plan.overwrite ? await this.remote(owner,null,plan.repositoryId) : plan.remote;
        const head = await this.client.call(session,'head');
        if (head.snapshotId !== remote.headId) {
          if (plan.overwrite && attempt < 2) continue;
          throw cloudError('CONFLICT','云端持续变化，请重试上传。');
        }
        payload = pruneCloudHistory(await this.projectArchive(owner,plan.repositoryId,remote));
        for (const row of selected) {
          await this.assertCurrent(row);
          payload = appendCloudVersion(payload,row.candidate);
        }
        payload = normalizeCloudSnapshot(payload,this.vault);
        if ((this.epochs.get(owner) ?? 0) !== epoch || this.session(owner,plan.repositoryId) !== session) throw cloudError('SESSION_EXPIRED','云配置会话已关闭。');
        envelope = encryptCloudSnapshot(payload,session.metadata,session.keys.encryption,head.snapshotId);
        try { await this.client.call(session,'snapshots',{method:'POST',body:envelope,parentId:head.snapshotId}); break; }
        catch (error) { if (!plan.overwrite || error.code !== 'CLOUD_CONFLICT' || attempt === 2) throw error; }
      }
      const mappings = [...this.state.mappings];
      for (const row of selected) {
        const localId = row.linkLocalId ?? row.localId;
        const mapping = {repositoryId:plan.repositoryId,remoteId:row.remoteId,localId,remoteDigest:snapshotDigest(row.candidate),localDigest:localId === row.localId ? snapshotDigest(row.candidate) : null};
        const index = mappings.findIndex(m => m.repositoryId === plan.repositoryId && m.remoteId === row.remoteId);
        if (index < 0) mappings.push(mapping); else mappings[index] = mapping;
        await this.store.appendAudit(row.localId,{type:'cloud-config-uploaded',actor:'user',result:'success'}).catch(() => undefined);
      }
      let syncStateWarning = false;
      const remote = {session,headId:envelope.snapshotId,snapshotId:envelope.snapshotId,payload};
      this.snapshots.set(plan.repositoryId,remote);
      this.histories.delete(plan.repositoryId);
      try { await this.saveState({...this.state,mappings}); await this.rememberRemote(plan.repositoryId,remote); } catch { syncStateWarning = true; }
      return {snapshotId:envelope.snapshotId,syncStateWarning,results:plan.rows.map(row => ({projectId:row.localId,status:choices[row.rowId] === 'local' ? 'uploaded' : 'skipped'}))};
    };
    return run(0);
  }
}
