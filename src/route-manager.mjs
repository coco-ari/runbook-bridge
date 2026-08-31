import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

const execFileAsync = promisify(execFile);
const FAMILY_POLICIES = new Set(['ipv4Preferred', 'ipv4Only', 'ipv6Preferred', 'ipv6Only']);
const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN']);

function candidateFamilies(policy) {
  if (policy === 'ipv4Only') return [4];
  if (policy === 'ipv6Only') return [6];
  if (policy === 'ipv6Preferred') return [6, 4];
  return [4, 6];
}

function isNetworkFailure(error) {
  return NETWORK_ERRORS.has(error?.code) || /timeout|unreachable|refused|reset/i.test(String(error?.message ?? ''));
}

async function connectSocket(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => finish();
    const onError = (error) => finish(error);
    const onTimeout = () => {
      const error = new Error('TCP connection timed out');
      error.code = 'ETIMEDOUT';
      finish(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

export class AddressResolver {
  constructor({ resolver = dns, maxCandidatesPerFamily = 3 } = {}) {
    this.resolver = resolver;
    this.maxCandidatesPerFamily = maxCandidatesPerFamily;
    this.inflight = new Map();
  }

  async resolve(host, policy = 'ipv4Preferred') {
    if (!FAMILY_POLICIES.has(policy)) throw new AppError('INVALID_ARGUMENT', '地址族策略无效。');
    const literalFamily = net.isIP(host);
    if (literalFamily) {
      if ((policy === 'ipv4Only' && literalFamily !== 4) || (policy === 'ipv6Only' && literalFamily !== 6)) {
        throw new AppError('ADDRESS_FAMILY_UNAVAILABLE', 'IP 地址与地址族策略不匹配。');
      }
      return [{ address: host, family: literalFamily }];
    }
    const requestKey = `${policy}:${host}`;
    const existing = this.inflight.get(requestKey);
    if (existing) return existing;
    const pending = this.resolveHostname(host, policy);
    this.inflight.set(requestKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inflight.get(requestKey) === pending) this.inflight.delete(requestKey);
    }
  }

  async resolveHostname(host, policy) {
    const records = new Map();
    const families = candidateFamilies(policy);
    let needsSystemFallback = false;
    await Promise.all(families.map(async (family) => {
      try {
        const values = family === 4 ? await this.resolver.resolve4(host) : await this.resolver.resolve6(host);
        records.set(family, values.slice(0, this.maxCandidatesPerFamily));
      } catch (error) {
        if (!['ENODATA', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED'].includes(error?.code)) throw error;
        if (['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED'].includes(error?.code)) needsSystemFallback = true;
        records.set(family, []);
      }
    }));
    let candidates = families.flatMap((family) => (records.get(family) ?? []).map((address) => ({ address, family })));
    if ((needsSystemFallback || !candidates.length) && typeof this.resolver.lookup === 'function') {
      try {
        const values = await this.resolver.lookup(host, { all:true, verbatim:true });
        candidates = families.flatMap((family) => values
          .filter((value) => value.family === family)
          .slice(0, this.maxCandidatesPerFamily)
          .map((value) => ({address:value.address,family})));
      } catch {
        // Preserve the explicit DNS result and the stable error below when the
        // operating-system resolver cannot provide a fallback either.
      }
    }
    if (!candidates.length) throw new AppError('ADDRESS_FAMILY_UNAVAILABLE', '目标没有符合地址族策略的 DNS 记录。');
    return candidates;
  }
}

export class WindowsVpnGuard {
  constructor({ platform = process.platform, networkInterfaces = os.networkInterfaces, exec = execFileAsync } = {}) {
    this.platform = platform;
    this.networkInterfaces = networkInterfaces;
    this.exec = exec;
  }

  async assertRoute(address, family, interfaceAlias) {
    if (!interfaceAlias) throw new AppError('VPN_REQUIRED', '未配置 Windows VPN 网卡。');
    const interfaces = this.networkInterfaces();
    const addresses = interfaces[interfaceAlias] ?? [];
    const local = addresses.find((item) => !item.internal && (family === 4 ? item.family === 'IPv4' || item.family === 4 : item.family === 'IPv6' || item.family === 6));
    if (!local) throw new AppError('VPN_REQUIRED', '指定 VPN 网卡未连接或没有匹配地址族的地址。');
    if (this.platform !== 'win32') return { localAddress: local.address, interfaceAlias, verified: false };
    if (!net.isIP(address)) throw new AppError('INVALID_ARGUMENT', 'VPN 路由检查只接受解析后的 IP。');
    const escaped = address.replace(/'/g, "''");
    const script = `$r=Find-NetRoute -RemoteIPAddress '${escaped}' -ErrorAction Stop | Select-Object -First 1; [Console]::Out.Write([string]$r.InterfaceAlias)`;
    try {
      const { stdout } = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
      if (String(stdout).trim().toLocaleLowerCase() !== interfaceAlias.toLocaleLowerCase()) {
        throw new AppError('VPN_REQUIRED', '目标路由没有经过指定 VPN 网卡。');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('VPN_REQUIRED', '无法验证目标的 Windows VPN 路由。');
    }
    return { localAddress: local.address, interfaceAlias, verified: true };
  }
}

export class LoopbackRelay {
  constructor(openTarget) {
    this.openTarget = openTarget;
    this.server = null;
    this.sockets = new Set();
    this.closed = false;
  }

  async start() {
    if (this.server) return this.address();
    this.server = net.createServer((local) => this.accept(local));
    this.server.on('error', () => undefined);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    return this.address();
  }

  address() {
    const value = this.server?.address();
    if (!value || typeof value === 'string') throw new AppError('ROUTE_UNAVAILABLE', '本地 Relay 尚未启动。');
    return { host: '127.0.0.1', port: value.port };
  }

  async accept(local) {
    if (this.closed) return local.destroy();
    this.sockets.add(local);
    local.once('close', () => this.sockets.delete(local));
    try {
      const remote = await this.openTarget();
      if (this.closed || local.destroyed) return remote.destroy();
      this.sockets.add(remote);
      remote.once('close', () => this.sockets.delete(remote));
      local.once('error', () => remote.destroy());
      remote.once('error', () => local.destroy());
      local.pipe(remote).pipe(local);
    } catch {
      local.destroy();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}

class SocketRoute {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // The protocol driver may already have closed the socket.
    }
  }
}

export class RouteManager {
  constructor({ resolver = new AddressResolver(), vpnGuard = new WindowsVpnGuard(), serverRuntime = null, connect = connectSocket } = {}) {
    this.resolver = resolver;
    this.vpnGuard = vpnGuard;
    this.serverRuntime = serverRuntime;
    this.connect = connect;
    this.relays = new Map();
    this.generations = new Map();
    this.generationSequence = 0;
  }

  routeKey(plugin) {
    return `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
  }

  generation(plugin) {
    return this.generations.get(this.routeKey(plugin)) ?? 0;
  }

  bumpGeneration(plugin) {
    const next = ++this.generationSequence;
    this.generations.set(this.routeKey(plugin), next);
    return next;
  }

  async openDirect(plugin, timeoutMs = 4_000) {
    const candidates = await this.resolver.resolve(plugin.target.host, plugin.target.addressFamily);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs * candidates.length, timeoutMs), 10_000);
    let lastError;
    for (const candidate of candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        let localAddress;
        if (plugin.transport?.kind === 'windowsVpn') {
          ({ localAddress } = await this.vpnGuard.assertRoute(candidate.address, candidate.family, plugin.transport.interfaceAlias));
        }
        const socket = await this.connect({ host: candidate.address, port: plugin.target.port, family: candidate.family, ...(localAddress ? { localAddress } : {}) }, Math.min(timeoutMs, remaining));
        socket.aiOpsRoute = { family: candidate.family, address: candidate.address };
        return socket;
      } catch (error) {
        lastError = error;
        if (error instanceof AppError && error.code === 'VPN_REQUIRED') throw error;
        if (!isNetworkFailure(error)) throw error;
      }
    }
    const code = lastError?.code === 'ETIMEDOUT' ? 'CONNECT_TIMEOUT' : 'ROUTE_UNAVAILABLE';
    throw new AppError(code, code === 'CONNECT_TIMEOUT' ? '连接目标超时。' : '目标网络不可达。');
  }

  async openTarget(plugin) {
    if (plugin.transport?.kind === 'serverTunnel') {
      if (!this.serverRuntime) throw new AppError('TUNNEL_PROVIDER_UNAVAILABLE', 'Server Runtime 不可用。');
      return this.serverRuntime.openForward(
        plugin.projectId,
        plugin.environmentId,
        plugin.transport.serverPluginInstanceId,
        plugin.target.host,
        plugin.target.port,
      );
    }
    return this.openDirect(plugin, Math.min(plugin.limits?.timeoutMs ?? 10_000, 4_000));
  }

  async createRelay(plugin, { signal = null } = {}) {
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const key = this.routeKey(plugin);
    await this.closeRelay(plugin);
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const generation = this.bumpGeneration(plugin);
    const relay = new LoopbackRelay(() => this.openTarget(plugin));
    const abort = () => {
      const current = this.relays.get(key);
      if (current?.relay === relay && current.generation === generation) this.relays.delete(key);
      void relay.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once:true });
    try {
      const endpoint = await relay.start();
      if (signal?.aborted || this.generation(plugin) !== generation) {
        throw new AppError('CONNECT_CANCELLED', '连接路由已被更新的尝试取代。');
      }
      this.relays.set(key, { relay, generation, endpoint });
      return { ...endpoint, generation };
    } catch (error) {
      await relay.close().catch(() => undefined);
      if (!this.relays.has(key) && this.generation(plugin) === generation) this.generations.delete(key);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async createStreamRoute(plugin, { signal = null } = {}) {
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const key = this.routeKey(plugin);
    await this.closeRelay(plugin);
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const generation = this.bumpGeneration(plugin);
    let socket = null;
    let route = null;
    const abort = () => {
      const current = this.relays.get(key);
      if (current?.relay === route && current.generation === generation) this.relays.delete(key);
      if (socket) void new SocketRoute(socket).close();
    };
    signal?.addEventListener('abort', abort, { once:true });
    try {
      socket = await this.openTarget(plugin);
      if (signal?.aborted || this.generation(plugin) !== generation) {
        throw new AppError('CONNECT_CANCELLED', '连接路由已被更新的尝试取代。');
      }
      route = new SocketRoute(socket);
      this.relays.set(key, { relay:route, generation, endpoint:null });
      return { stream:socket, generation };
    } catch (error) {
      if (route) await route.close().catch(() => undefined);
      else if (socket) await new SocketRoute(socket).close().catch(() => undefined);
      if (!this.relays.has(key) && this.generation(plugin) === generation) this.generations.delete(key);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async closeRelay(plugin, expectedGeneration = null) {
    const key = this.routeKey(plugin);
    const current = this.relays.get(key);
    if (expectedGeneration !== null && current?.generation !== expectedGeneration) {
      if (!current && this.generation(plugin) === expectedGeneration) this.generations.delete(key);
      return { closed:false, stale:true };
    }
    // An unconditional close is an ownership boundary (user disconnect or a
    // newer connect) and invalidates a relay that is still being created.
    if (expectedGeneration === null) this.bumpGeneration(plugin);
    this.relays.delete(key);
    if (current) await current.relay.close();
    // Generation values are globally unique, so a closed transient diagnostic
    // resource needs no per-key tombstone. An older in-flight create observes
    // zero (or a newer global value) and still fails its ownership check.
    if (!this.relays.has(key)) this.generations.delete(key);
    return { closed:Boolean(current), stale:false };
  }

  async closeAll() {
    const entries = [...this.relays.values()];
    this.relays.clear();
    this.generations.clear();
    await Promise.all(entries.map((entry) => entry.relay.close()));
  }
}
