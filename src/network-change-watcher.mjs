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
  constructor(callback, { intervalMs = 2_000, debounceMs = 750, networkInterfaces = os.networkInterfaces } = {}) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.networkInterfaces = networkInterfaces;
    this.last = snapshot(networkInterfaces);
    this.timer = null;
    this.debounceTimer = null;
    this.callbackRunning = null;
    this.rerunRequested = false;
    this.active = false;
  }

  setActive(active) {
    if (!active) { this.stop(); return; }
    if (this.timer) return;
    this.active = true;
    this.last = snapshot(this.networkInterfaces);
    this.timer = setInterval(() => {
      const current = snapshot(this.networkInterfaces);
      if (current === this.last) return;
      this.last = current;
      this.scheduleCallback();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  scheduleCallback() {
    if (!this.active) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushCallback();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  flushCallback() {
    if (!this.active) return;
    if (this.callbackRunning) {
      this.rerunRequested = true;
      return;
    }
    this.callbackRunning = Promise.resolve(this.callback('network-interface-change'))
      .catch(() => undefined)
      .finally(() => {
        this.callbackRunning = null;
        if (this.rerunRequested && this.active) {
          this.rerunRequested = false;
          this.scheduleCallback();
        }
      });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.timer = null;
    this.debounceTimer = null;
    this.rerunRequested = false;
    this.active = false;
  }
}

export const networkWatcherInternals = { snapshot };
