import crypto from 'node:crypto';
import os from 'node:os';

function snapshot(networkInterfaces = os.networkInterfaces) {
  const rows = [];
  for (const [name, values] of Object.entries(networkInterfaces())) {
    for (const value of values ?? []) rows.push([name, value.address, value.family, value.internal, value.scopeid ?? 0]);
  }
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export class NetworkChangeWatcher {
  constructor(callback, { intervalMs = 2_000, networkInterfaces = os.networkInterfaces } = {}) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.networkInterfaces = networkInterfaces;
    this.last = snapshot(networkInterfaces);
    this.timer = null;
  }

  setActive(active) {
    if (!active) { this.stop(); return; }
    if (this.timer) return;
    this.last = snapshot(this.networkInterfaces);
    this.timer = setInterval(() => {
      const current = snapshot(this.networkInterfaces);
      if (current === this.last) return;
      this.last = current;
      Promise.resolve(this.callback('network-interface-change')).catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const networkWatcherInternals = { snapshot };

