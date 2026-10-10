import { readReleaseRevision } from './software-updates.mjs';

// 事件仅作失效信号；客户端必须重新读取并验证实际内容。
export class CloudEvents {
  constructor({releasesDirectory, intervalMs = 5000, heartbeatMs = 15_000, maxConnections = 1000} = {}) {
    Object.assign(this,{releasesDirectory,maxConnections});
    this.clients = new Set();
    this.revisions = new Map();
    this.closed = false;
    this.polling = false;
    this.timer = setInterval(() => { void this.poll(); },intervalMs);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.write(client,': heartbeat\n\n');
    },heartbeatMs);
    this.timer.unref?.(); this.heartbeat.unref?.();
  }
  subscribe(request,response,key,revision = null) {
    const ip = request.socket.remoteAddress;
    if (this.closed || this.clients.size >= this.maxConnections || [...this.clients].filter(c => c.ip === ip).length >= 64) {
      throw Object.assign(new Error('CLOUD_RATE_LIMITED'),{status:429,code:'CLOUD_RATE_LIMITED'});
    }
    response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
    const client = {response,key,ip};
    this.clients.add(client);
    response.on('close',() => this.clients.delete(client));
    // 每次连接发送当前状态，断线期间无需重放过时的每一次变化。
    this.write(client,`event: change\ndata: ${JSON.stringify({revision})}\n\n`);
    if (key.startsWith('software:')) void this.poll();
  }
  write(client,value) {
    if (client.response.destroyed) { this.clients.delete(client); return; }
    if (!client.response.write(value)) { this.clients.delete(client); client.response.destroy(); }
  }
  publish(key,revision) {
    for (const client of this.clients) if (client.key === key) this.write(client,`event: change\ndata: ${JSON.stringify({revision})}\n\n`);
  }
  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const keys = new Set([...this.clients].map(c => c.key).filter(key => key.startsWith('software:')));
      for (const key of this.revisions.keys()) if (!keys.has(key)) this.revisions.delete(key);
      for (const key of keys) {
        const [,platform,arch] = key.split(':');
        let revision;
        try { revision = await readReleaseRevision(this.releasesDirectory,platform,arch); }
        catch { continue; }
        if (this.closed) return;
        if (this.revisions.get(key) !== revision) { this.revisions.set(key,revision); this.publish(key,revision); }
      }
    } finally { this.polling = false; }
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer); clearInterval(this.heartbeat);
    for (const client of this.clients) client.response.end();
    this.clients.clear(); this.revisions.clear();
  }
}
