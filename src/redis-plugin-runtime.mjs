import redisPackage from 'redis';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';

const { createClient } = redisPackage;

function key(plugin) {
  return `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
}

function findPattern(plugin, patternId) {
  const pattern = plugin.patterns.find((item) => item.patternId === patternId);
  if (!pattern) throw new AppError('POLICY_DENIED', 'Key patternId 未登记。');
  return pattern;
}

function keyAllowed(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}

async function withTimeout(plugin, operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError('PLUGIN_TIMEOUT', 'Redis 操作超时。')), plugin.limits.timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class RedisPluginRuntime extends EventEmitter {
  constructor(routeManager, credentialVault, { factory = createClient } = {}) {
    super();
    this.routeManager = routeManager;
    this.credentialVault = credentialVault;
    this.factory = factory;
    this.sessions = new Map();
  }

  status(plugin) {
    const session = this.sessions.get(key(plugin));
    return { connected: Boolean(session), connectedAt: session?.connectedAt ?? null, routeGeneration: session?.routeGeneration ?? 0 };
  }

  require(plugin) {
    const session = this.sessions.get(key(plugin));
    if (!session) throw new AppError('PLUGIN_NOT_CONNECTED', 'Redis 插件尚未连接。');
    return session;
  }

  async connect(plugin, suppliedSecrets = {}) {
    if (plugin.pluginType !== 'redis' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', 'Redis 插件配置不完整。');
    await this.disconnect(plugin);
    let saved = null;
    try {
      saved = await this.credentialVault.load(plugin);
    } catch (error) {
      if (!Object.keys(suppliedSecrets).length) throw error;
    }
    const secrets = { ...(saved ?? {}), ...suppliedSecrets };
    const relay = await this.routeManager.createRelay(plugin);
    const tls = plugin.tls?.mode && plugin.tls.mode !== 'disabled';
    const client = this.factory({
      socket: {
        host: relay.host,
        port: relay.port,
        connectTimeout: plugin.limits.timeoutMs,
        ...(tls
          ? {
              tls: true,
              servername: plugin.target.host,
              rejectUnauthorized: plugin.tls.mode === 'verifyIdentity',
              ...(secrets.caPem ? { ca: secrets.caPem } : {}),
              ...(secrets.clientCertPem ? { cert: secrets.clientCertPem } : {}),
              ...(secrets.clientKeyPem ? { key: secrets.clientKeyPem } : {}),
            }
          : {}),
      },
      database: plugin.target.db,
      ...(plugin.auth.username ? { username: plugin.auth.username } : {}),
      ...(secrets.password ? { password: secrets.password } : {}),
      disableOfflineQueue: true,
    });
    let session = null;
    const lost = (error) => {
      if (!session || session.closing || this.sessions.get(key(plugin)) !== session) return;
      this.sessions.delete(key(plugin));
      this.routeManager.closeRelay(plugin).catch(() => undefined);
      this.emit('lifecycle', { type:'lost', projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, error });
    };
    client.on?.('error', (error) => lost(error));
    client.on?.('end', () => lost(new AppError('ROUTE_UNAVAILABLE', 'Redis 连接已中断。')));
    try {
      await client.connect();
      await client.ping();
      session = { client, connectedAt: new Date().toISOString(), routeGeneration: relay.generation, closing:false };
      this.sessions.set(key(plugin), session);
      return { connected: true, connectedAt: this.sessions.get(key(plugin)).connectedAt, routeGeneration: relay.generation };
    } catch (error) {
      await client.disconnect?.().catch(() => undefined);
      await this.routeManager.closeRelay(plugin);
      if (/wrongpass|noauth|authentication/i.test(String(error?.message ?? ''))) throw new AppError('AUTHENTICATION_FAILED', 'Redis 用户名或密码认证失败。');
      if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code)) throw new AppError('TLS_IDENTITY_FAILED', 'Redis TLS 身份校验失败。');
      throw new AppError('PLUGIN_UNAVAILABLE', 'Redis 连接失败。');
    }
  }

  async disconnect(plugin) {
    const session = this.sessions.get(key(plugin));
    this.sessions.delete(key(plugin));
    if (session) session.closing = true;
    if (session?.client) {
      if (session.client.isOpen) await session.client.quit().catch(() => session.client.disconnect?.());
      else await session.client.disconnect?.().catch(() => undefined);
    }
    await this.routeManager.closeRelay(plugin);
    return { connected: false };
  }

  async health(plugin) {
    const session = this.require(plugin);
    await withTimeout(plugin, session.client.ping());
    return { connected:true, checkedAt:new Date().toISOString() };
  }

  async scan(plugin, { patternId, cursor = '0', limit } = {}) {
    const session = this.require(plugin);
    const pattern = findPattern(plugin, patternId);
    const count = Math.min(Math.max(Number(limit) || plugin.limits.maxKeys, 1), plugin.limits.maxKeys);
    const result = await withTimeout(plugin, session.client.scan(String(cursor), { MATCH: pattern.pattern, COUNT: count }));
    const keys = result.keys.slice(0, count);
    return {
      patternId,
      keys,
      nextCursor: String(result.cursor) === '0' ? null : String(result.cursor),
      truncated: result.keys.length > count || String(result.cursor) !== '0',
      limitsApplied: { maxKeys: count, timeoutMs: plugin.limits.timeoutMs },
    };
  }

  async read(plugin, { patternId, key: redisKey, field = null } = {}) {
    const session = this.require(plugin);
    const pattern = findPattern(plugin, patternId);
    const target = String(redisKey ?? '');
    if (!target || Buffer.byteLength(target) > 1024 || !keyAllowed(pattern.pattern, target)) throw new AppError('POLICY_DENIED', 'Redis Key 不在允许范围内。');
    const type = await withTimeout(plugin, session.client.type(target));
    if (type === 'none') return { key: target, type, exists: false };
    if (type === 'string') {
      const length = await withTimeout(plugin, session.client.strLen(target));
      const end = Math.max(0, Math.min(length, plugin.limits.maxValueBytes) - 1);
      const value = length ? await withTimeout(plugin, session.client.getRange(target, 0, end)) : '';
      return { key: target, type, exists: true, length, value, truncated: Buffer.byteLength(value) < length };
    }
    if (type === 'hash' && field !== null) {
      const fieldName = String(field);
      if (!fieldName || Buffer.byteLength(fieldName) > 1024) throw new AppError('INVALID_ARGUMENT', 'Redis Hash field 无效。');
      const length = await withTimeout(plugin, session.client.hStrLen(target, fieldName));
      if (length > plugin.limits.maxValueBytes) return { key: target, type, field: fieldName, length, value: null, truncated: true };
      const value = await withTimeout(plugin, session.client.hGet(target, fieldName));
      return { key: target, type, field: fieldName, length, value, truncated: false };
    }
    const cardinality = type === 'list'
      ? await withTimeout(plugin, session.client.lLen(target))
      : type === 'set'
        ? await withTimeout(plugin, session.client.sCard(target))
        : type === 'zset'
          ? await withTimeout(plugin, session.client.zCard(target))
          : type === 'hash'
            ? await withTimeout(plugin, session.client.hLen(target))
            : null;
    return { key: target, type, exists: true, cardinality, value: null, membersAvailable: false };
  }

  async ttl(plugin, { patternId, key: redisKey } = {}) {
    const session = this.require(plugin);
    const pattern = findPattern(plugin, patternId);
    const target = String(redisKey ?? '');
    if (!target || !keyAllowed(pattern.pattern, target)) throw new AppError('POLICY_DENIED', 'Redis Key 不在允许范围内。');
    return { key: target, ttlSeconds: await withTimeout(plugin, session.client.ttl(target)) };
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => { session.closing = true; await session.client.disconnect?.().catch(() => undefined); }));
  }
}

export const redisRuntimeInternals = { key, findPattern, keyAllowed, withTimeout };
