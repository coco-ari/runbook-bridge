import { cloudUpdateNotices, softwareUpdateNotices } from './update-notifications.mjs';
import { subscribeUpdateEvents } from './update-event-client.mjs';

export class UpdateCoordinator {
  constructor({cloud,software,notifications,checkSoftware,broadcast,subscribe = subscribeUpdateEvents,now = Date.now,pollMs = 30_000}) {
    Object.assign(this,{cloud,software,notifications,checkSoftware,broadcast,subscribe,now});
    this.owner = null;
    this.generation = 0;
    this.streams = new Map();
    this.lastChecks = new Map();
    this.pendingChecks = new Set();
    this.checkFlights = new Map();
    this.disposed = false;
    this.timer = setInterval(() => this.schedule(),pollMs);
    this.timer.unref?.();
  }
  activate(owner) {
    if (this.disposed || this.owner === owner) return;
    this.closeOwner(this.owner);
    this.owner = owner;
    this.schedule();
  }
  closeOwner(owner) {
    if (owner !== this.owner) return;
    this.generation++;
    this.owner = null;
    for (const stream of this.streams.values()) stream.connection.dispose();
    this.streams.clear(); this.lastChecks.clear(); this.pendingChecks.clear(); this.checkFlights.clear();
    if (this.notifications.clear) this.notifications.clear();
    else this.notifications.items = [];
    this.broadcast?.('v2:update-center',{kind:'changed'});
  }
  schedule() {
    this.prune();
    if (this.disposed || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; void this.refresh(); },250);
    this.scheduled.unref?.();
  }
  prune() {
    for (const [key,stream] of this.streams) {
      const valid = key === 'software'
        ? stream.identity === `${this.software.state.source?.repositoryId}:${this.software.state.source?.origin}`
        : this.cloud.state.repositories.some(repo => `repo:${repo.repositoryId}` === key)
          && this.cloud.sessions.get(this.owner)?.get(key.slice(5)) === stream.identity;
      if (!valid) { stream.connection.dispose(); this.streams.delete(key); }
    }
  }
  refresh() {
    if (this.disposed) return Promise.resolve();
    if (this.flight) { this.again = true; return this.flight; }
    this.flight = this.reconcile().catch(() => {
      // 自动检测失败由原服务状态展示，不将底层异常或认证信息发往界面。
    }).finally(() => { this.flight = null; if (this.again) { this.again = false; this.schedule(); } });
    return this.flight;
  }
  async reconcile() {
    const owner = this.owner, generation = this.generation;
    const current = () => !this.disposed && this.owner === owner && this.generation === generation;
    if (!owner || !current()) return;
    await this.cloud.queue.catch(() => undefined);
    if (!current()) return;
    const cloudState = this.cloud.state;
    const state = await this.cloud.invoke(owner,'status');
    const software = await this.software.invoke('status');
    if (!current()) return;
    if (this.cloud.state !== cloudState) { this.again = true; return; }
    const wanted = new Map();
    for (const repo of state.repositories) {
      if (!repo.unlocked) continue;
      const session = this.cloud.session(owner,repo.repositoryId);
      wanted.set(`repo:${repo.repositoryId}`,{identity:session,url:`${session.origin}/api/v1/repos/${session.repoId}/events`,token:session.keys.auth,
        onChange:() => this.requestCheck(repo.repositoryId)});
      const minutes = state.checkIntervalMinutes;
      if (!this.lastChecks.has(repo.repositoryId) || minutes > 0 && this.now()-this.lastChecks.get(repo.repositoryId) >= minutes*60_000) this.requestCheck(repo.repositoryId);
    }
    if (software.supported && software.source?.origin.startsWith('https://')) {
      const source = software.source;
      wanted.set('software',{identity:`${source.repositoryId}:${source.origin}`,url:`${source.origin}/api/v1/updates/${this.software.platform}/${this.software.arch}/events`,
        onChange:() => { void this.checkSoftware().catch(() => undefined); }});
    }
    for (const [key,stream] of this.streams) {
      if (wanted.get(key)?.identity !== stream.identity) { stream.connection.dispose(); this.streams.delete(key); }
    }
    for (const [key,options] of wanted) if (!this.streams.has(key)) {
      const marker = {};
      const onChange = options.onChange;
      const connection = this.subscribe({...options,onChange:() => {
        this.prune();
        if (current() && this.streams.get(key)?.marker === marker) onChange();
      }});
      this.streams.set(key,{identity:options.identity,connection,marker});
    }
    const softwareGeneration = this.software.generation;
    const scopeCurrent = () => current() && this.cloud.state === cloudState && this.software.generation === softwareGeneration;
    await this.notifications.reconcile([...softwareUpdateNotices(software,this.software.platform,this.software.arch),...cloudUpdateNotices(cloudState,state)],scopeCurrent);
    if (current() && !scopeCurrent()) this.again = true;
  }
  requestCheck(repositoryId) {
    if (this.disposed || !this.owner) return;
    this.pendingChecks.add(repositoryId);
    if (this.checkTimer || this.checkFlights.has(repositoryId)) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      const owner = this.owner, generation = this.generation;
      const ids = [...this.pendingChecks]; this.pendingChecks.clear();
      for (const id of ids) {
        if (!owner || this.disposed || !this.cloud.state.repositories.some(repo => repo.repositoryId === id)) continue;
        if (this.checkFlights.has(id)) { this.pendingChecks.add(id); continue; }
        this.lastChecks.set(id,this.now());
        const flight = this.cloud.invoke(owner,'check',{repositoryId:id});
        this.checkFlights.set(id,flight);
        void flight.catch(() => undefined).finally(() => {
          if (this.checkFlights.get(id) === flight) this.checkFlights.delete(id);
          if (this.generation === generation && !this.disposed) {
            this.broadcast?.('v2:update-center',{kind:'cloud'}); this.schedule();
            // 在途检查期间的新信号需要再读一次 head，不能被同仓库请求合并吞掉。
            if (this.pendingChecks.has(id)) this.requestCheck(id);
          }
        });
      }
    },500);
    this.checkTimer.unref?.();
  }
  wake() {
    if (this.disposed) return;
    for (const stream of this.streams.values()) stream.connection.dispose();
    this.streams.clear(); this.lastChecks.clear();
    this.schedule();
    void this.checkSoftware().catch(() => undefined);
  }
  dispose() {
    this.closeOwner(this.owner);
    this.disposed = true;
    clearInterval(this.timer); clearTimeout(this.scheduled); clearTimeout(this.checkTimer);
  }
}
