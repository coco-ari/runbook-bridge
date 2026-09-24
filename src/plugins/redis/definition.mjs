import { redisAdapter } from './connection.mjs';
import { AppError } from '../../errors.mjs';
import { CONTROL_RE, normalizeHost, normalizePort, normalizeAddressFamily, normalizePolicy, normalizeTransport, transportReady, normalizeId, normalizeName } from '../../plugin-config-utils.mjs';

const capabilities = {
  scan: { decision:'auto', risk:'read', label:'扫描 Redis Key' },
  read: { decision:'auto', risk:'read', label:'读取 Redis 数据' },
  ttl: { decision:'auto', risk:'read', label:'读取 Redis TTL' },
};

function normalizeConfiguration(input, existing, base) {
  const source = {
    ...(existing ?? {}),
    ...input,
    policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
    limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
    tls: { ...(existing?.tls ?? {}), ...(input.tls ?? {}) },
  };
  const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
  const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
  const host = normalizeHost(target.host, { required: false });
  const username = String(auth.username ?? '').trim();
  const db = Number(target.db ?? 0);
  if (!Number.isInteger(db) || db < 0 || db > 15) throw new AppError('INVALID_ARGUMENT', 'Redis logical DB 必须在 0 到 15 之间。');
  if (username.length > 128 || CONTROL_RE.test(username)) throw new AppError('INVALID_ARGUMENT', 'Redis 用户名无效。');
  const patterns = Array.isArray(source.patterns) && source.patterns.length
    ? source.patterns.map((item, index) => ({
        patternId: normalizeId(item.patternId ?? `pattern-${index + 1}`, 'pattern'),
        pattern: String(item.pattern ?? '').trim(),
        displayName: normalizeName(item.displayName ?? item.pattern ?? `范围 ${index + 1}`, 'Key 范围名称'),
      }))
    : [{ patternId: 'default-pattern', pattern: '*', displayName: '全部允许 Key' }];
  for (const pattern of patterns) {
    if (!pattern.pattern || pattern.pattern.length > 256 || CONTROL_RE.test(pattern.pattern)) {
      throw new AppError('INVALID_ARGUMENT', 'Redis Key pattern 无效。');
    }
  }
  const transport = normalizeTransport({ ...(existing?.transport ?? {}), ...(input.transport ?? {}) });
  let redisMode = null;
  if (Object.hasOwn(input,'mode')) {
    if (!['standalone','cluster'].includes(input.mode)) throw new AppError('INVALID_ARGUMENT', 'Redis 运行模式无效。');
    redisMode = input.mode;
  } else if (Object.hasOwn(input,'cluster')) {
    if (typeof input.cluster !== 'boolean') throw new AppError('INVALID_ARGUMENT', 'Redis Cluster 标志无效。');
    redisMode = input.cluster ? 'cluster' : 'standalone';
  } else if (['standalone','cluster'].includes(existing?.mode)) {
    redisMode = existing.mode;
  } else if (typeof existing?.cluster === 'boolean') {
    redisMode = existing.cluster ? 'cluster' : 'standalone';
  }
  return {
    ...base,
    configState: host && transportReady(transport) ? 'ready' : 'draft',
    target: {
      host,
      port: normalizePort(target.port, 6379),
      db,
      addressFamily: normalizeAddressFamily(target.addressFamily),
    },
    auth: { username },
    transport,
    tls: { mode: ['disabled', 'preferred', 'required', 'verifyIdentity'].includes(source.tls?.mode) ? source.tls.mode : 'disabled' },
    ...(redisMode ? {mode:redisMode} : {}),
    patterns,
    policy: normalizePolicy(source.policy, { scan: 'auto', read: 'auto', ttl: 'auto' }),
    limits: {
      maxKeys: Math.min(Math.max(Number(source.limits?.maxKeys ?? 100), 1), 1000),
      maxValueBytes: Math.min(Math.max(Number(source.limits?.maxValueBytes ?? 65_536), 256), 262_144),
      timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 5_000), 500), 30_000),
      maxConcurrency: 1,
    },
  };
}

function invoke({plugin, capability, args, runtime}) {
  if (capability === 'scan') return runtime.scan(plugin, args);
  if (capability === 'read') return runtime.read(plugin, args);
  if (capability === 'ttl') return runtime.ttl(plugin, args);
  throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '该插件操作尚未实现。');
}

export const redisPluginDefinition = {
  type:'redis',
  connectionAdapter:redisAdapter,
  connectionFields:['target','auth','transport','tls','mode','cluster'],
  connectionNestedFields:{
    target:['host','port','db','addressFamily'],
    auth:['username'],
    transport:['kind','serverPluginInstanceId','interfaceAlias'],
    tls:['mode'],
  },
  normalizeConfiguration,
  publicResource: plugin => ({db:plugin.target?.db}),
  capabilities,
  invoke,
};
