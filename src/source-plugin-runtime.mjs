import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { SourceClient } from './source-client.mjs';
import { SourceStore } from './source-store.mjs';
import { sourceCacheIdentity } from './source-protocol.mjs';

const key = plugin => `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
const scope = plugin => ({projectId:plugin.projectId,environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId});
export class SourcePluginRuntime extends EventEmitter {
  constructor(dataRoot,credentialVault,{clientFactory = (plugin,password) => new SourceClient(plugin,password),store = new SourceStore(dataRoot),pollMs = 60000} = {}) {
    super(); Object.assign(this,{credentialVault,clientFactory,store,pollMs});
    this.sessions = new Map(); this.attempts = new Map(); this.operations = new Map();
  }
  status(plugin) {
    const s = this.sessions.get(key(plugin));
    return {connected:Boolean(s && s.identity === sourceCacheIdentity(plugin)),connectedAt:s?.connectedAt ?? null};
  }
  require(plugin) {
    const session = this.sessions.get(key(plugin));
    if (!session || session.identity !== sourceCacheIdentity(plugin)) throw new AppError('PLUGIN_NOT_CONNECTED','请先连接源码服务；已下载源码仍可离线浏览。');
    return session;
  }
  changed(plugin) { this.emit('changed',scope(plugin)); }
  async connect(plugin,suppliedSecrets = {},{signal,attemptToken = Symbol('source-connect')} = {}) {
    if (plugin.pluginType !== 'source' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE','源码配置不完整。');
    await this.disconnect(plugin);
    this.attempts.set(key(plugin),attemptToken);
    const assertOwned = () => { if (signal?.aborted || this.attempts.get(key(plugin)) !== attemptToken) throw new AppError('CONNECT_CANCELLED','源码连接已取消。'); };
    let saved = {};
    if (!suppliedSecrets.password) saved = await this.credentialVault.load(plugin) ?? {};
    assertOwned();
    const client = this.clientFactory(plugin,suppliedSecrets.password || saved.password);
    const head = await client.head(signal); assertOwned();
    const session = {plugin,identity:sourceCacheIdentity(plugin),client,head,connectedAt:new Date().toISOString(),attemptToken,controller:new AbortController(),poll:null,checking:null};
    this.sessions.set(key(plugin),session);
    if (!plugin.pluginInstanceId.startsWith('diagnostic-edit-')) {
      session.poll = setInterval(() => { void this.check(plugin).catch(() => {}); },this.pollMs); session.poll.unref?.();
      this.watch(session);
    }
    this.changed(plugin); return this.status(plugin);
  }
  watch(session) {
    if (!session.client.subscribe) return;
    const current = () => this.sessions.get(key(session.plugin)) === session && !session.controller.signal.aborted;
    void session.client.subscribe(session.controller.signal,() => {
      if (current()) void this.check(session.plugin).catch(() => {});
    }).catch(() => {}).finally(() => {
      if (!current()) return;
      void this.check(session.plugin).catch(() => {});
      session.retry = setTimeout(() => { if (current()) this.watch(session); },Math.min(this.pollMs,15000)); session.retry.unref?.();
    });
  }
  async check(plugin) {
    const session = this.require(plugin);
    if (session.checking) return session.checking;
    session.checking = (async () => {
      try {
        const head = await session.client.head(session.controller.signal);
        if (this.sessions.get(key(plugin)) !== session) throw new AppError('SOURCE_CANCELLED','源码连接已变化。');
        session.head = head; this.changed(plugin); return head;
      } catch (error) {
        if (this.sessions.get(key(plugin)) === session) {
          await this.disconnect(plugin);
          this.emit('lifecycle',{type:'lost',...scope(plugin),error});
        }
        throw error;
      } finally { session.checking = null; }
    })();
    return session.checking;
  }
  async health(plugin) { await this.check(plugin); return this.status(plugin); }
  async workspaceStatus(plugin) {
    const session = this.sessions.get(key(plugin)), local = await this.store.current(plugin), operation = this.operations.get(key(plugin));
    return {...this.status(plugin),local,remote:session?.identity === sourceCacheIdentity(plugin) ? session.head : null,
      update:operation?.identity === sourceCacheIdentity(plugin) ? operation.progress : null};
  }
  async update(plugin,snapshotId,{owner,assertCurrent = () => {}} = {}) {
    const session = this.require(plugin);
    if (this.operations.has(key(plugin))) throw new AppError('SOURCE_BUSY','源码正在更新。');
    const controller = new AbortController(), identity = sourceCacheIdentity(plugin);
    const operation = {owner,identity,controller,progress:{phase:'manifest'}};
    this.operations.set(key(plugin),operation); this.changed(plugin);
    let lastEvent = 0;
    try {
      return await this.store.update(plugin,session.client,snapshotId,{signal:AbortSignal.any([controller.signal,session.controller.signal]),
        assertCurrent:() => { assertCurrent(); if (this.sessions.get(key(plugin)) !== session) throw new AppError('SOURCE_CANCELLED','源码连接已变化。'); },
        progress:value => { operation.progress = value; if (Date.now()-lastEvent > 100) { lastEvent = Date.now(); this.changed(plugin); } }});
    } finally { if (this.operations.get(key(plugin)) === operation) this.operations.delete(key(plugin)); this.changed(plugin); }
  }
  cancel(plugin,owner) {
    const operation = this.operations.get(key(plugin));
    if (operation && operation.owner !== owner) throw new AppError('WORKSPACE_ACCESS_DENIED','不能取消其他工作区的更新。');
    operation?.controller.abort(); return {cancelled:Boolean(operation)};
  }
  closeOwner(owner) { for (const operation of this.operations.values()) if (operation.owner === owner) operation.controller.abort(); }
  async disconnect(plugin) {
    this.attempts.delete(key(plugin));
    const session = this.sessions.get(key(plugin)); this.sessions.delete(key(plugin));
    session?.controller.abort(); clearInterval(session?.poll); clearTimeout(session?.retry);
    this.operations.get(key(plugin))?.controller.abort(); this.changed(plugin);
    return {disconnected:true};
  }
  async forceDisconnect(plugin,reason,{attemptToken} = {}) {
    if (attemptToken !== undefined && this.attempts.get(key(plugin)) !== attemptToken) return {disconnected:false};
    return this.disconnect(plugin,reason);
  }
  async closeAll() { await Promise.all([...this.sessions.values()].map(s => this.disconnect(s.plugin))); }
  async sourceHints(plugins) {
    return Promise.all(plugins.filter(p => p.pluginType === 'source').slice(0,64).map(async plugin => {
      const base = {...scope(plugin),pluginName:plugin.displayName,readOnly:true};
      try { const local = await this.store.current(plugin); return {...base,status:local ? 'available' : 'not-downloaded',...(local ?? {})}; }
      catch { return {...base,status:'unavailable'}; }
    }));
  }
}
