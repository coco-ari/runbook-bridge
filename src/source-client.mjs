import { AppError } from './errors.mjs';
import { SOURCE_PROTOCOL, SOURCE_LIMITS, SOURCE_HASH, SOURCE_PROJECT, normalizeServiceUrl, validateManifest, readBounded, sourceError } from './source-protocol.mjs';

export class SourceClient {
  constructor(plugin, password, {fetchImpl = fetch} = {}) {
    const base = normalizeServiceUrl(plugin.target?.serviceUrl), id = plugin.target?.remoteProjectId;
    if (!base || !SOURCE_PROJECT.test(id ?? '')) throw new AppError('PLUGIN_CONFIG_INCOMPLETE','请填写源码服务地址和项目 ID。');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password ?? '')) throw new AppError('CREDENTIAL_NOT_FOUND','请填写源码服务的项目下载密码。');
    this.base = `${base}/api/v1/projects/${id}/source`;
    this.projectId = id;
    this.password = password;
    this.fetchImpl = fetchImpl;
  }
  async request(route,{signal,body,timeoutMs = 30000} = {}) {
    try {
      const response = await this.fetchImpl(this.base + route,{redirect:'error',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        method:body ? 'POST' : 'GET',headers:{Authorization:`Bearer ${this.password}`,Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
      if (!response.ok) {
        await response.body?.cancel();
        const known = {401:['SOURCE_UNAUTHORIZED','项目下载密码无效或项目已停用。'],409:['SOURCE_NOT_READY','源码快照尚未开启或发布。'],410:['SOURCE_EXPIRED','远端快照已清理，请重新检查版本。'],429:['SOURCE_BUSY','源码服务繁忙，请稍后重试。']};
        const [code,message] = known[response.status] ?? ['SOURCE_UNAVAILABLE',`源码服务请求失败（HTTP ${response.status}）。`];
        throw new AppError(code,message);
      }
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) throw new AppError('SOURCE_CANCELLED','源码操作已取消。');
      throw new AppError('SOURCE_UNAVAILABLE','无法连接源码服务，或请求超时。');
    }
  }
  async json(route,options = {},limit = SOURCE_LIMITS.maxManifestBytes) {
    const response = await this.request(route,options);
    try { return JSON.parse((await readBounded(response.body,limit,options.signal)).toString('utf8')); }
    catch (error) { if (options.signal?.aborted) throw new AppError('SOURCE_CANCELLED','源码操作已取消。'); if (error instanceof AppError) throw error; throw sourceError('源码服务返回的数据无效。'); }
  }
  async head(signal) {
    const head = await this.json('/head',{signal},65536);
    if (head.protocol !== SOURCE_PROTOCOL || head.projectId !== this.projectId || (head.snapshot && (!SOURCE_HASH.test(head.snapshot.snapshotId)
      || !/^[a-f0-9]{40,64}$/.test(head.snapshot.revision) || !Number.isSafeInteger(head.snapshot.fileCount) || head.snapshot.fileCount < 0 || head.snapshot.fileCount > SOURCE_LIMITS.maxFiles
      || !Number.isSafeInteger(head.snapshot.totalBytes) || head.snapshot.totalBytes < 0 || head.snapshot.totalBytes > SOURCE_LIMITS.maxTotalBytes))) throw sourceError('源码服务协议不兼容。');
    // Remote errors may contain arbitrary operational data. Do not forward them to the renderer or MCP.
    return {protocol:SOURCE_PROTOCOL,projectId:this.projectId,snapshot:head.snapshot ? {snapshotId:head.snapshot.snapshotId,revision:String(head.snapshot.revision ?? '').slice(0,64),createdAt:String(head.snapshot.createdAt ?? '').slice(0,40),fileCount:head.snapshot.fileCount,totalBytes:head.snapshot.totalBytes} : null,
      syncStatus:['idle','queued','syncing','ready','failed'].includes(head.sync?.status) ? head.sync.status : 'idle',lastAttempt:head.sync?.lastAttemptAt ?? null,
      error:head.sync?.error ? '服务端最近一次同步未成功，当前已发布版本仍可使用。' : null};
  }
  async manifest(snapshotId,signal) {
    if (!SOURCE_HASH.test(snapshotId)) throw sourceError('快照标识无效。');
    return validateManifest(await this.json(`/snapshots/${snapshotId}/manifest`,{signal}),this.projectId,snapshotId);
  }
  async files(snapshotId,hashes,signal) {
    const result = await this.json(`/snapshots/${snapshotId}/files`,{signal,body:{hashes}},24*1024*1024);
    if (result.protocol !== SOURCE_PROTOCOL || result.snapshotId !== snapshotId || !Array.isArray(result.files) || result.files.length !== hashes.length) throw sourceError('增量响应无效。');
    return result.files;
  }
  archive(snapshotId,signal) { return this.request(`/snapshots/${snapshotId}/archive`,{signal,timeoutMs:120000}); }
  async subscribe(signal,onChange) {
    const response = await this.request('/events',{signal,timeoutMs:300000});
    let pending = '';
    try {
      for await (const bytes of response.body) {
        pending += Buffer.from(bytes).toString('utf8');
        if (pending.length > 65536) throw sourceError('源码通知数据无效。');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0,end); pending = pending.slice(end+2);
          const line = frame.split('\n').find(value => value.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.protocol === SOURCE_PROTOCOL && (event.snapshotId === null || SOURCE_HASH.test(event.snapshotId))) onChange(event.snapshotId);
        }
      }
    } finally { await response.body.cancel().catch(() => {}); }
  }
}
