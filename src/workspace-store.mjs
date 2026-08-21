import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { AppError } from './errors.mjs';
import { classifyPluginChange } from './plugin-change-classifier.mjs';
import { assertPluginConfigurationReady } from './plugin-connection-adapters.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PLUGIN_TYPES = new Set(['server', 'mysql', 'redis']);
const ADDRESS_FAMILIES = new Set(['ipv4Preferred', 'ipv4Only', 'ipv6Preferred', 'ipv6Only']);
const TRANSPORTS = new Set(['direct', 'windowsVpn', 'serverTunnel']);
const POLICY_MODES = new Set(['auto', 'confirm', 'deny']);
const PLUGIN_METADATA_FIELDS = new Set(['displayName', 'description', 'tags', 'displayOrder']);
const PLUGIN_AGENT_FIELDS = new Set(['policy', 'sources', 'actions', 'patterns', 'limits']);
const PLUGIN_CONNECTION_FIELDS = Object.freeze({
  server:new Set(['target', 'auth', 'uplink', 'tunnelProvider']),
  mysql:new Set(['target', 'auth', 'transport', 'tls']),
  redis:new Set(['target', 'auth', 'transport', 'tls', 'mode', 'cluster']),
});
const PLUGIN_CONNECTION_NESTED_FIELDS = Object.freeze({
  server:Object.freeze({
    target:new Set(['host', 'port', 'addressFamily', 'hostKeyFingerprint']),
    auth:new Set(['type', 'username', 'privateKeyPath', 'agentSocket']),
    uplink:new Set(['type', 'host', 'port', 'username', 'remoteDns', 'interfaceAlias']),
  }),
  mysql:Object.freeze({
    target:new Set(['host', 'port', 'database', 'addressFamily']),
    auth:new Set(['username']),
    transport:new Set(['kind', 'serverPluginInstanceId', 'interfaceAlias']),
    tls:new Set(['mode']),
  }),
  redis:Object.freeze({
    target:new Set(['host', 'port', 'db', 'addressFamily']),
    auth:new Set(['username']),
    transport:new Set(['kind', 'serverPluginInstanceId', 'interfaceAlias']),
    tls:new Set(['mode']),
  }),
});
const NORMALIZATION_ROOT_GROUPS = Object.freeze([
  ['displayName'],['description'],['tags'],['displayOrder'],
  ['target'],['auth'],['transport'],['uplink'],['tls'],
  ['policy'],['sources'],['actions'],['patterns'],['limits'],
  ['tunnelProvider'],['mode','cluster'],['legacyProjectId'],['configState'],
]);
const FILE_READ_CONCURRENCY = 8;
const AUDIT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_AUDIT_LINE_BYTES = 1024 * 1024;
const FATAL_FILESYSTEM_ERRORS = new Set(['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC']);
const ISOLATABLE_CONFIG_ERRORS = new Set([
  'PROJECT_CONFIG_INVALID', 'ENVIRONMENT_CONFIG_INVALID', 'PLUGIN_CONFIG_INVALID',
  'ENVIRONMENT_NOT_FOUND', 'PLUGIN_NOT_FOUND', 'SCOPE_MISMATCH',
]);

function isConfigurationFailure(error) {
  return error?.name === 'YAMLParseError'
    || (error instanceof AppError && ISOLATABLE_CONFIG_ERRORS.has(error.code));
}

async function mapLimit(values, limit, operation) {
  const items = Array.from(values);
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const DEFAULT_RUNBOOK = (name) => `# ${name}\n\n## 环境说明\n\n记录环境用途、访问入口、部署方式和关键依赖。不要在此粘贴密码或私钥。\n\n## 服务器与服务\n\n按 Server 插件名称准确记录服务信息，例如：\n\n### 应用服务器\n- 主机职责：订单 API\n- systemd unit：\`orders.service\`\n- 安装目录：\`/srv/orders\`\n- 当前制品：\`/srv/orders/orders.jar\`\n- 配置文件：\`/etc/orders/application-prod.yml\`\n- 日志目录：\`/var/log/orders\`\n- 健康检查：\`http://127.0.0.1:8080/actuator/health\`\n\n## 中间件\n\n记录 MySQL、Redis、消息队列等实例的用途、配置位置、服务单元和相互依赖。\n\n## 查询建议\n\n记录常用只读排障顺序、应优先检查的路径以及需要避免的大目录或高负载查询。Agent 可以读取服务器上的任意普通文件，不需要把每个目录登记为数据源。\n\n## 发布与回滚\n\n记录制品来源、备份位置、发布步骤、重启顺序、验证标准和回滚步骤。任何服务器变更仍需用户逐次确认。\n`;

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function normalizeName(value, label = '名称') {
  const name = String(value ?? '').normalize('NFKC').trim();
  if (!name || name.length > 120 || CONTROL_RE.test(name)) {
    throw new AppError('INVALID_ARGUMENT', `${label}不能为空、不能超过 120 字符或包含控制字符。`);
  }
  return name;
}

function normalizeDescription(value) {
  const description = String(value ?? '').normalize('NFKC').trim();
  if (description.length > 4096 || CONTROL_RE.test(description)) {
    throw new AppError('INVALID_ARGUMENT', '插件说明不能超过 4096 字符或包含控制字符。');
  }
  return description;
}

function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new AppError('INVALID_ARGUMENT', '插件标签必须是最多 32 项的数组。');
  }
  const tags = value.map((item) => String(item ?? '').normalize('NFKC').trim());
  if (tags.some((item) => !item || item.length > 64 || CONTROL_RE.test(item))) {
    throw new AppError('INVALID_ARGUMENT', '插件标签不能为空、不能超过 64 字符或包含控制字符。');
  }
  return [...new Set(tags)];
}

function normalizeDisplayOrder(value) {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 0 || order > 1_000_000) {
    throw new AppError('INVALID_ARGUMENT', '插件展示顺序必须是 0 到 1000000 的整数。');
  }
  return order;
}

function assertPluginPatchScope(patch, allowed, label) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError('INVALID_ARGUMENT', `${label}更新内容无效。`);
  }
  const unexpected = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new AppError('INVALID_ARGUMENT', `${label}更新包含不允许的字段：${unexpected.join(', ')}。`, {
      fields:unexpected,
    });
  }
}

function assertPluginNestedPatchScope(patch, schema, label) {
  for (const [root,allowed] of Object.entries(schema ?? {})) {
    if (!Object.hasOwn(patch,root)) continue;
    const value = patch[root];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError('INVALID_ARGUMENT', `${label}字段 ${root} 必须是对象。`);
    }
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
    if (unexpected.length) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `${label}字段 ${root} 包含不允许的子字段：${unexpected.join(', ')}。`,
        {fields:unexpected.map((key) => `${root}.${key}`)},
      );
    }
  }
}

function rootGroupProjection(value, roots) {
  return Object.fromEntries(
    roots.flatMap((root) => (Object.hasOwn(value ?? {},root) ? [[root,value[root]]] : [])),
  );
}

function preserveNormalizationOnlyRoots(before, normalizedBaseline, normalizedCandidate) {
  const candidate = {...normalizedCandidate};
  for (const roots of NORMALIZATION_ROOT_GROUPS) {
    const baselineProjection = rootGroupProjection(normalizedBaseline,roots);
    const candidateProjection = rootGroupProjection(normalizedCandidate,roots);
    if (!isDeepStrictEqual(baselineProjection,candidateProjection)) continue;
    const beforeProjection = rootGroupProjection(before,roots);
    if (isDeepStrictEqual(beforeProjection,baselineProjection)) continue;
    for (const root of roots) delete candidate[root];
    for (const [root,value] of Object.entries(beforeProjection)) candidate[root] = clone(value);
  }
  return candidate;
}

function normalizeId(value, prefix) {
  const raw = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (ID_RE.test(normalized)) return normalized;
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function assertId(value, label) {
  if (!ID_RE.test(String(value ?? ''))) throw new AppError('INVALID_ARGUMENT', `${label}无效。`);
  return String(value);
}

function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', '端口必须在 1 到 65535 之间。');
  }
  return port;
}

function normalizeHost(value, { required = true } = {}) {
  const host = String(value ?? '').trim();
  if ((!host && required) || host.length > 255 || CONTROL_RE.test(host)) {
    throw new AppError('INVALID_ARGUMENT', '连接目标地址无效。');
  }
  return host;
}

function normalizeAddressFamily(value) {
  return ADDRESS_FAMILIES.has(value) ? value : 'ipv4Preferred';
}

function normalizePolicy(input, defaults) {
  const output = {};
  for (const [capability, fallback] of Object.entries(defaults)) {
    const mode = input?.[capability] ?? fallback;
    if (!POLICY_MODES.has(mode)) throw new AppError('INVALID_ARGUMENT', `操作规则 ${capability} 无效。`);
    output[capability] = mode;
  }
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in defaults));
  if (unknown.length) throw new AppError('INVALID_ARGUMENT', `不支持的操作规则：${unknown.join(', ')}。`);
  return output;
}

function normalizeTransport(input = {}) {
  const kind = TRANSPORTS.has(input.kind) ? input.kind : 'direct';
  const transport = { kind };
  if (kind === 'serverTunnel') {
    const providerId = String(input.serverPluginInstanceId ?? '').trim();
    if (providerId) transport.serverPluginInstanceId = assertId(providerId, '隧道 Server 插件标识');
  }
  if (kind === 'windowsVpn') {
    const interfaceAlias = String(input.interfaceAlias ?? '').trim();
    if (interfaceAlias.length > 128 || CONTROL_RE.test(interfaceAlias)) {
      throw new AppError('INVALID_ARGUMENT', 'Windows VPN 网卡名称无效。');
    }
    if (interfaceAlias) transport.interfaceAlias = interfaceAlias;
  }
  return transport;
}

function transportReady(transport) {
  if (transport?.kind === 'serverTunnel') return Boolean(transport.serverPluginInstanceId);
  if (transport?.kind === 'windowsVpn') return Boolean(transport.interfaceAlias);
  return true;
}

function normalizeServerSources(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 50) throw new AppError('INVALID_ARGUMENT', 'Server 数据源最多 50 个。');
  const ids = new Set();
  return input.map((item, index) => {
    const sourceId = normalizeId(item?.sourceId ?? `source-${index + 1}`, 'source');
    if (ids.has(sourceId)) throw new AppError('INVALID_ARGUMENT', 'Server sourceId 不能重复。');
    ids.add(sourceId);
    const kind = ['log', 'config', 'download'].includes(item?.kind) ? item.kind : 'log';
    const root = String(item?.root ?? '').trim().replace(/\\/g, '/');
    if (!root.startsWith('/') || root.includes('\0') || root.split('/').includes('..') || root.length > 4096) throw new AppError('INVALID_ARGUMENT', 'Server 数据源根目录必须是安全的绝对路径。');
    const patterns = (Array.isArray(item?.patterns) && item.patterns.length ? item.patterns : ['*']).map((value) => {
      const pattern = String(value ?? '').trim();
      if (!pattern || pattern.length > 256 || pattern.includes('/') || CONTROL_RE.test(pattern)) throw new AppError('INVALID_ARGUMENT', 'Server 文件匹配模式无效。');
      return pattern;
    });
    return {
      sourceId,
      displayName: normalizeName(item?.displayName ?? sourceId, '数据源名称'),
      kind,
      root: path.posix.normalize(root),
      patterns,
      maxFileBytes: Math.min(Math.max(Number(item?.maxFileBytes ?? 100 * 1024 * 1024), 1024), 1024 * 1024 * 1024),
      redactSecrets: kind === 'config' ? item?.redactSecrets !== false : false,
    };
  });
}

function normalizeServerActions(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 100) throw new AppError('INVALID_ARGUMENT', 'Server action 配置过多。');
  return input.map((item) => {
    const actionId = String(item?.actionId ?? '');
    if (!['system.summary', 'process.summary', 'network.listen', 'filesystem.usage', 'service.status'].includes(actionId)) throw new AppError('INVALID_ARGUMENT', `不支持的 Server action：${actionId}。`);
    if (actionId === 'service.status') {
      const serviceId = normalizeId(item.serviceId, 'service');
      const unit = String(item.unit ?? '').trim();
      if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(unit)) throw new AppError('INVALID_ARGUMENT', 'Systemd unit 名称无效。');
      return { actionId, serviceId, displayName: normalizeName(item.displayName ?? serviceId, '服务名称'), unit };
    }
    if (actionId === 'filesystem.usage') {
      const mountId = normalizeId(item.mountId, 'mount');
      const mountPath = String(item.mountPath ?? '').trim();
      if (!/^\/[A-Za-z0-9_./-]{0,1023}$/.test(mountPath) || mountPath.split('/').includes('..')) throw new AppError('INVALID_ARGUMENT', '挂载点路径无效。');
      return { actionId, mountId, displayName: normalizeName(item.displayName ?? mountId, '挂载点名称'), mountPath: path.posix.normalize(mountPath) };
    }
    return { actionId };
  });
}

function normalizePlugin(input, scope, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGUMENT', '插件配置无效。');
  }
  const pluginType = input.pluginType ?? existing?.pluginType;
  if (!PLUGIN_TYPES.has(pluginType)) throw new AppError('INVALID_ARGUMENT', '插件类型无效。');
  if (existing && existing.pluginType !== pluginType) throw new AppError('INVALID_ARGUMENT', '不能修改插件类型。');
  const pluginInstanceId = existing?.pluginInstanceId ?? normalizeId(input.pluginInstanceId ?? input.displayName, pluginType);
  const metadata = {...(existing ?? {}),...input};
  const base = {
    schemaVersion: 1,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    pluginInstanceId,
    pluginType,
    displayName: normalizeName(input.displayName ?? existing?.displayName ?? pluginType, '插件名称'),
    ...((Object.hasOwn(existing ?? {}, 'description') || Object.hasOwn(input, 'description'))
      ? {description:normalizeDescription(metadata.description)}
      : {}),
    ...((Object.hasOwn(existing ?? {}, 'tags') || Object.hasOwn(input, 'tags'))
      ? {tags:normalizeTags(metadata.tags ?? [])}
      : {}),
    ...((Object.hasOwn(existing ?? {}, 'displayOrder') || Object.hasOwn(input, 'displayOrder'))
      ? {displayOrder:normalizeDisplayOrder(metadata.displayOrder ?? 0)}
      : {}),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: now(),
  };

  if (pluginType === 'server') {
    const source = {
      ...(existing ?? {}),
      ...input,
      policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
      limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
    };
    const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
    const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
    const uplink = { ...(existing?.uplink ?? {}), ...(input.uplink ?? {}) };
    const host = normalizeHost(target.host, { required: false });
    const username = String(auth.username ?? '').trim();
    if (username.length > 128 || CONTROL_RE.test(username)) throw new AppError('INVALID_ARGUMENT', 'SSH 用户名无效。');
    const authType = ['password', 'privateKey', 'agent'].includes(auth.type) ? auth.type : 'password';
    const uplinkType = ['direct', 'socks5', 'http', 'windowsVpn'].includes(uplink.type) ? uplink.type : 'direct';
    const proxyHost = uplinkType === 'socks5' || uplinkType === 'http' ? normalizeHost(uplink.host, { required:false }) : '';
    const vpnAlias = uplinkType === 'windowsVpn' ? String(uplink.interfaceAlias ?? '').trim() : '';
    if (vpnAlias.length > 128 || CONTROL_RE.test(vpnAlias)) throw new AppError('INVALID_ARGUMENT', 'Windows VPN 网卡名称无效。');
    const authReady = Boolean(username) && (authType !== 'privateKey' || Boolean(auth.privateKeyPath));
    const uplinkReady = uplinkType === 'direct' || (['socks5','http'].includes(uplinkType) ? Boolean(proxyHost) : Boolean(vpnAlias));
    const port = normalizePort(target.port, 22);
    const addressUnchanged = !existing
      || (existing.target?.host === host && Number(existing.target?.port) === port);
    const plugin = {
      ...base,
      configState: host && authReady && uplinkReady ? 'ready' : 'draft',
      target: {
        host,
        port,
        addressFamily: normalizeAddressFamily(target.addressFamily),
        ...(addressUnchanged && target.hostKeyFingerprint
          ? { hostKeyFingerprint: String(target.hostKeyFingerprint) }
          : {}),
      },
      auth: {
        type: authType,
        username,
        ...(authType === 'privateKey' && auth.privateKeyPath ? { privateKeyPath: String(auth.privateKeyPath) } : {}),
        ...(authType === 'agent' && auth.agentSocket ? { agentSocket: String(auth.agentSocket) } : {}),
      },
      uplink: {
        type: uplinkType,
        ...(uplinkType === 'socks5' || uplinkType === 'http'
          ? {
              host: proxyHost,
              port: normalizePort(uplink.port, uplinkType === 'socks5' ? 1080 : 8080),
              username: String(uplink.username ?? '').trim(),
              remoteDns: false,
            }
          : {}),
        ...(uplinkType === 'windowsVpn'
          ? { ...(vpnAlias ? { interfaceAlias:vpnAlias } : {}) }
          : {}),
      },
      sources: normalizeServerSources(source.sources),
      actions: normalizeServerActions(source.actions),
      tunnelProvider: source.tunnelProvider !== false,
      policy: normalizePolicy(source.policy, {
        status: 'auto',
        logs: 'auto',
        config: 'auto',
        download: 'confirm',
        diagnostics: 'auto',
      }),
      limits: {
        timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 10_000), 1_000), 60_000),
        maxBytes: Math.min(Math.max(Number(source.limits?.maxBytes ?? 262_144), 1024), 1_048_576),
      },
      ...(source.legacyProjectId ? { legacyProjectId: String(source.legacyProjectId) } : {}),
    };
    return plugin;
  }

  if (pluginType === 'mysql') {
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
    const database = String(target.database ?? '').trim();
    const username = String(auth.username ?? '').trim();
    if (database.length > 128 || CONTROL_RE.test(database) || username.length > 128 || CONTROL_RE.test(username)) {
      throw new AppError('INVALID_ARGUMENT', 'MySQL 数据库或用户名无效。');
    }
    const transport = normalizeTransport({ ...(existing?.transport ?? {}), ...(input.transport ?? {}) });
    return {
      ...base,
      configState: host && database && username && transportReady(transport) ? 'ready' : 'draft',
      target: {
        host,
        port: normalizePort(target.port, 3306),
        database,
        addressFamily: normalizeAddressFamily(target.addressFamily),
      },
      auth: { username },
      transport,
      tls: { mode: ['disabled', 'preferred', 'required', 'verifyIdentity'].includes(source.tls?.mode) ? source.tls.mode : 'preferred' },
      policy: normalizePolicy(source.policy, { describe: 'auto', select: 'auto', explain: 'auto' }),
      limits: {
        maxRows: Math.min(Math.max(Number(source.limits?.maxRows ?? 100), 1), 1000),
        maxBytes: Math.min(Math.max(Number(source.limits?.maxBytes ?? 1_048_576), 1024), 4_194_304),
        timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 10_000), 500), 60_000),
        maxConcurrency: 1,
      },
    };
  }

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

function normalizePluginCandidate(input, scope, existing) {
  if (!existing) throw new AppError('PLUGIN_NOT_FOUND', '缺少候选配置的现有插件。');
  const normalized = normalizePlugin(input,scope,existing);
  return {
    ...normalized,
    revision:existing.revision,
    updatedAt:existing.updatedAt,
  };
}

function materializePluginCandidate(candidate, existing) {
  return {
    ...candidate,
    revision:existing.revision + 1,
    updatedAt:now(),
  };
}

function sanitizePluginSnapshot(plugin) {
  // Re-normalizing through the plugin schema is an allow-list operation. It
  // deliberately drops unknown YAML keys (including accidentally embedded
  // password/ciphertext fields) before configuration recovery metadata is
  // persisted outside the encrypted vault.
  const normalized = normalizePlugin(plugin, {
    projectId:plugin.projectId,
    environmentId:plugin.environmentId,
  });
  return {
    ...normalized,
    revision:plugin.revision,
    updatedAt:plugin.updatedAt,
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory handles cannot be flushed on every supported Windows build.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function* readLinesReverse(file, { chunkBytes = AUDIT_READ_CHUNK_BYTES, maxLineBytes = MAX_AUDIT_LINE_BYTES } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    let position = Number((await handle.stat()).size);
    let carry = Buffer.alloc(0);
    let discardingOversizedLine = false;
    const decode = (buffer) => {
      let end = buffer.length;
      if (end && buffer[end - 1] === 0x0d) end -= 1;
      if (end === 0 || end > maxLineBytes) return null;
      return buffer.subarray(0, end).toString('utf8');
    };
    while (position > 0) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const block = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(block, 0, length, position);
      const chunk = block.subarray(0, bytesRead);
      const combined = discardingOversizedLine || carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
      let end = combined.length;
      if (discardingOversizedLine) {
        let boundary = -1;
        for (let index = end - 1; index >= 0; index -= 1) {
          if (combined[index] === 0x0a) { boundary = index; break; }
        }
        if (boundary < 0) continue;
        end = boundary;
        discardingOversizedLine = false;
      }
      for (let index = end - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        const line = decode(combined.subarray(index + 1, end));
        if (line !== null) yield line;
        end = index;
      }
      carry = combined.subarray(0, end);
      if (carry.length > maxLineBytes) {
        carry = Buffer.alloc(0);
        discardingOversizedLine = true;
      }
    }
    if (!discardingOversizedLine && carry.length) {
      const line = decode(carry);
      if (line !== null) yield line;
    }
  } finally {
    await handle.close();
  }
}

async function rewriteJsonLines(file, shouldDelete) {
  try {
    await fs.access(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const output = await fs.open(temporary, 'w', 0o600);
  let deletedCount = 0;
  let buffered = '';
  try {
    const lines = readline.createInterface({ input:createReadStream(file), crlfDelay:Infinity });
    for await (const line of lines) {
      let remove = false;
      try { remove = shouldDelete(JSON.parse(line)); } catch { /* Preserve damaged historical lines. */ }
      if (remove) {
        deletedCount += 1;
        continue;
      }
      buffered += `${line}\n`;
      if (Buffer.byteLength(buffered, 'utf8') >= AUDIT_READ_CHUNK_BYTES) {
        await output.write(buffered, null, 'utf8');
        buffered = '';
      }
    }
    if (buffered) await output.write(buffered, null, 'utf8');
    await output.sync();
  } catch (error) {
    await output.close().catch(() => undefined);
    await fs.rm(temporary, {force:true}).catch(() => undefined);
    throw error;
  }
  await output.close();
  try {
    if (deletedCount > 0) await fs.rename(temporary, file);
    else await fs.rm(temporary, {force:true});
  } catch (error) {
    await fs.rm(temporary, {force:true}).catch(() => undefined);
    throw error;
  }
  return deletedCount;
}

export class WorkspaceStore {
  constructor(dataRoot, { legacyStore = null } = {}) {
    this.dataRoot = dataRoot;
    this.projectsRoot = path.join(dataRoot, 'projects');
    this.legacyStore = legacyStore;
    this.writeQueues = new Map();
  }

  async init({ migrateLegacy = true } = {}) {
    await fs.mkdir(this.projectsRoot, { recursive: true });
    if (this.legacyStore) await this.legacyStore.init();
    if (migrateLegacy && this.legacyStore) await this.migrateLegacyProjects();
  }

  projectDir(projectId) {
    return path.join(this.projectsRoot, assertId(projectId, '项目标识'));
  }

  workspacePath(projectId) {
    return path.join(this.projectDir(projectId), 'workspace.yaml');
  }

  environmentDir(projectId, environmentId) {
    return path.join(this.projectDir(projectId), 'environments', assertId(environmentId, '环境标识'));
  }

  environmentPath(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'environment.yaml');
  }

  pluginDir(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'plugins');
  }

  pluginPath(projectId, environmentId, pluginInstanceId) {
    return path.join(this.pluginDir(projectId, environmentId), `${assertId(pluginInstanceId, '插件标识')}.yaml`);
  }

  runbookPath(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'README.md');
  }

  async readYaml(file, missingCode, missingMessage) {
    try {
      return YAML.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new AppError(missingCode, missingMessage);
      throw error;
    }
  }

  enqueue(key, operation) {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writeQueues.set(key, current);
    return current.finally(() => {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key);
    });
  }

  async atomicWrite(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      await syncDirectoryBestEffort(path.dirname(file));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeYaml(file, value) {
    await this.atomicWrite(file, YAML.stringify(value, { lineWidth: 0 }));
  }

  async migrateLegacyProjects() {
    const legacyProjects = await this.legacyStore.list();
    const migrated = [];
    for (const legacy of legacyProjects) {
      const workspaceAlreadyExists = await pathExists(this.workspacePath(legacy.id));
      if (workspaceAlreadyExists) {
        let existingWorkspace;
        try { existingWorkspace = await this.readYaml(this.workspacePath(legacy.id), 'PROJECT_NOT_FOUND', '项目不存在。'); }
        catch { continue; }
        if (existingWorkspace?.migration?.source !== 'project-v1') continue;
      }
      const environmentId = 'default';
      const pluginInstanceId = 'server-primary';
      const projectDir = this.projectDir(legacy.id);
      const environmentDir = this.environmentDir(legacy.id, environmentId);
      await fs.mkdir(this.pluginDir(legacy.id, environmentId), { recursive: true });
      const timestamp = now();
      const workspace = {
        schemaVersion: 2,
        projectId: legacy.id,
        name: legacy.name,
        revision: 1,
        environmentOrder: [environmentId],
        createdAt: timestamp,
        updatedAt: timestamp,
        migration: { source: 'project-v1', migratedAt: timestamp },
      };
      const environment = {
        schemaVersion: 1,
        projectId: legacy.id,
        environmentId,
        name: '默认环境',
        revision: 1,
        pluginOrder: [pluginInstanceId],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const plugin = normalizePlugin({
        pluginInstanceId,
        pluginType: 'server',
        displayName: '应用服务器',
        target: { ...legacy.ssh, addressFamily: 'ipv4Preferred' },
        auth: { ...legacy.auth, username: legacy.ssh.username },
        uplink: legacy.proxy,
        legacyProjectId: legacy.id,
        policy: { status: 'auto', logs: 'auto', config: 'auto', download: 'confirm', diagnostics: 'auto' },
        limits: { timeoutMs: Number(legacy.limits?.commandTimeoutSeconds ?? 180) * 1000 },
      }, { projectId: legacy.id, environmentId });
      const legacyReadme = path.join(projectDir, 'docs', 'README.md');
      const runbook = (await pathExists(legacyReadme)) ? await fs.readFile(legacyReadme, 'utf8') : DEFAULT_RUNBOOK(environment.name);
      // workspace.yaml is the migration commit marker. Writing it last makes a
      // crash during materialization safely retryable on the next launch. For
      // historical partial migrations (marker exists), conservatively fill
      // only missing generated files and never overwrite user edits.
      if (!await pathExists(this.environmentPath(legacy.id, environmentId))) {
        await this.writeYaml(this.environmentPath(legacy.id, environmentId), environment);
      }
      if (!await pathExists(this.pluginPath(legacy.id, environmentId, pluginInstanceId))) {
        await this.writeYaml(this.pluginPath(legacy.id, environmentId, pluginInstanceId), plugin);
      }
      if (!await pathExists(path.join(environmentDir, 'README.md'))) {
        await this.atomicWrite(path.join(environmentDir, 'README.md'), runbook);
      }
      if (!workspaceAlreadyExists) await this.writeYaml(this.workspacePath(legacy.id), workspace);
      migrated.push(legacy.id);
    }
    return migrated;
  }

  configurationError(projectId, error = null) {
    return {
      schemaVersion: 2,
      projectId,
      name: projectId,
      revision: 0,
      environmentCount: 0,
      pluginCount: 0,
      environments: [],
      configurationError: {
        code: 'PROJECT_CONFIG_INVALID',
        message: '项目配置损坏或不完整，已隔离该项目；其他项目仍可正常使用。',
        source: `projects/${projectId}`,
        causeCode: error instanceof AppError ? error.code : 'CONFIG_PARSE_FAILED',
      },
    };
  }

  async listProjectOverviews() {
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const candidates = entries.filter((entry) => entry.isDirectory() && ID_RE.test(entry.name));
    const projects = await mapLimit(candidates, FILE_READ_CONCURRENCY, async (entry) => {
      try {
        const project = await this.getProject(entry.name);
        const environments = await this.listEnvironmentsForProject(project);
        return { ...project, environmentCount: environments.length, pluginCount: environments.reduce((sum, item) => sum + item.pluginCount, 0), environments };
      } catch (error) {
        if (error instanceof AppError && error.code === 'PROJECT_NOT_FOUND') return null;
        if (FATAL_FILESYSTEM_ERRORS.has(error?.code) || !isConfigurationFailure(error)) throw error;
        return this.configurationError(entry.name, error);
      }
    });
    return projects.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async listProjects() {
    return (await this.listProjectOverviews()).map(({ environments: _environments, ...project }) => project);
  }

  async getProject(projectId) {
    const value = await this.readYaml(this.workspacePath(projectId), 'PROJECT_NOT_FOUND', '项目不存在。');
    if (value?.schemaVersion !== 2 || value.projectId !== projectId || typeof value.name !== 'string' || !value.name.trim()
      || !Number.isInteger(value.revision) || value.revision < 1 || !Array.isArray(value.environmentOrder)
      || value.environmentOrder.some((id) => !ID_RE.test(String(id))) || new Set(value.environmentOrder).size !== value.environmentOrder.length) {
      throw new AppError('PROJECT_CONFIG_INVALID', '项目配置损坏。');
    }
    return value;
  }

  async createProject(input) {
    const name = normalizeName(input?.name, '项目名称');
    let projectId = normalizeId(input?.projectId ?? name, 'project');
    // Claim the project directory atomically. A check-then-recursive-mkdir race
    // allowed two windows to believe they owned the same directory; if one
    // later failed, its rollback could recursively remove the other window's
    // successfully-created project. Only the caller whose non-recursive mkdir
    // succeeds may ever remove that directory.
    await fs.mkdir(this.projectsRoot, { recursive:true });
    while (true) {
      try {
        await fs.mkdir(this.projectDir(projectId), { recursive:false });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        projectId = `project-${crypto.randomBytes(5).toString('hex')}`;
      }
    }
    const environmentId = normalizeId(input?.environmentId ?? input?.environmentName ?? 'default', 'environment');
    const timestamp = now();
    const workspace = {
      schemaVersion: 2,
      projectId,
      name,
      revision: 1,
      environmentOrder: [environmentId],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const environment = {
      schemaVersion: 1,
      projectId,
      environmentId,
      name: normalizeName(input?.environmentName ?? '默认环境', '环境名称'),
      revision: 1,
      pluginOrder: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await fs.mkdir(this.pluginDir(projectId, environmentId), { recursive: true });
      await this.writeYaml(this.workspacePath(projectId), workspace);
      await this.writeYaml(this.environmentPath(projectId, environmentId), environment);
      await this.atomicWrite(this.runbookPath(projectId, environmentId), String(input?.runbook ?? DEFAULT_RUNBOOK(environment.name)));
      for (const plugin of input?.plugins ?? []) await this.createPlugin(projectId, environmentId, plugin);
      return this.getProject(projectId);
    } catch (error) {
      await fs.rm(this.projectDir(projectId), { recursive: true, force: true });
      throw error;
    }
  }

  async updateProject(projectId, patch, expectedRevision = null) {
    return this.enqueue(`project:${projectId}`, async () => {
      const current = await this.getProject(projectId);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '项目配置已经变化，请刷新后重试。');
      const next = { ...current, name: patch.name === undefined ? current.name : normalizeName(patch.name, '项目名称'), revision: current.revision + 1, updatedAt: now() };
      await this.writeYaml(this.workspacePath(projectId), next);
      return next;
    });
  }

  async deleteProject(projectId) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      const environments = await this.listEnvironments(projectId);
      // The rename commit shares the audit queue. Audits already in flight are
      // included in the tombstone; audits submitted after this commit re-check
      // getProject and cannot recreate the deleted projects/<id> directory.
      return this.enqueue(`audit:${projectId}`, async () => {
      const source = this.projectDir(projectId);
      const tombstone = path.join(this.projectsRoot, `.deleting-${projectId}-${crypto.randomBytes(4).toString('hex')}`);
      await fs.rename(source, tombstone);
      // Renaming out of the indexed project namespace is the commit point.
      // Legacy credentials live inside the old project directory. Preserve the
      // complete legacy binding/config alongside its opaque ciphertext outside
      // the indexed projects tree; it must remain recoverable even when DPAPI
      // was temporarily unavailable during migration.
      const legacyCredential = path.join(tombstone, 'credentials.enc.json');
      let preserveLegacy = false;
      try {
        await fs.access(legacyCredential);
        preserveLegacy = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') preserveLegacy = true;
      }
      let credentialArchive = null;
      if (preserveLegacy) {
        const archiveRoot = path.join(this.dataRoot, 'credential-archives', 'deleted-projects');
        const archiveName = `${projectId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const finalArchive = path.join(archiveRoot, archiveName);
        const temporaryArchive = `${finalArchive}.tmp`;
        try {
          await fs.mkdir(archiveRoot, {recursive:true});
          await fs.mkdir(temporaryArchive, {recursive:false});
          const files = [];
          for (const name of ['credentials.enc.json','project.yaml']) {
            const sourceFile = path.join(tombstone,name);
            const targetFile = path.join(temporaryArchive,name);
            await fs.copyFile(sourceFile,targetFile);
            await fs.chmod(targetFile,0o600).catch(() => undefined);
            const handle = await fs.open(targetFile,'r');
            try { await handle.sync(); } finally { await handle.close(); }
            files.push({name,sha256:await sha256File(targetFile),bytes:Number((await fs.stat(targetFile)).size)});
          }
          await this.atomicWrite(path.join(temporaryArchive,'manifest.json'),JSON.stringify({
            schemaVersion:1,projectId,deletedAt:now(),files,
          },null,2));
          await syncDirectoryBestEffort(temporaryArchive);
          await fs.rename(temporaryArchive,finalArchive);
          await syncDirectoryBestEffort(archiveRoot);
          credentialArchive = finalArchive;
          await fs.rm(tombstone,{recursive:true,force:true}).catch(() => undefined);
        } catch {
          await fs.rm(temporaryArchive,{recursive:true,force:true}).catch(() => undefined);
          // The non-indexed tombstone still contains every original byte.
          credentialArchive = tombstone;
        }
      } else {
        // Cleanup is best effort so a transient antivirus/file-lock failure
        // cannot make the caller retry an already committed deletion.
        await fs.rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
      }
      return {
        projectId,
        name: project.name,
        environmentCount: environments.length,
        pluginCount: environments.reduce((sum, environment) => sum + Number(environment.pluginCount ?? 0), 0),
        ...(credentialArchive ? {credentialArchive} : {}),
      };
      });
    });
  }

  async listEnvironments(projectId) {
    const project = await this.getProject(projectId);
    return this.listEnvironmentsForProject(project);
  }

  async listEnvironmentsForProject(project) {
    return mapLimit(project.environmentOrder ?? [], FILE_READ_CONCURRENCY, async (environmentId) => {
      const projectId = project.projectId;
      const environment = await this.getEnvironment(projectId, environmentId);
      const plugins = await this.listPluginsForEnvironment(environment);
      return {
        ...environment,
        pluginCount: plugins.length,
        readyPluginCount: plugins.filter((item) => item.configState === 'ready').length,
        pluginTypeCounts: plugins.reduce((counts,item) => ({ ...counts, [item.pluginType]:(counts[item.pluginType] ?? 0) + 1 }), { server:0,mysql:0,redis:0 }),
        resourcePreview: plugins.slice(0,6).map((plugin) => this.publicPlugin(plugin)),
        resourcePreviewTruncated: plugins.length > 6,
      };
    });
  }

  async getEnvironment(projectId, environmentId) {
    const value = await this.readYaml(this.environmentPath(projectId, environmentId), 'ENVIRONMENT_NOT_FOUND', '环境不存在。');
    if (value?.projectId !== projectId || value.environmentId !== environmentId) throw new AppError('SCOPE_MISMATCH', '环境不属于当前项目。');
    if (value?.schemaVersion !== 1 || typeof value.name !== 'string' || !value.name.trim()
      || !Number.isInteger(value.revision) || value.revision < 1 || !Array.isArray(value.pluginOrder)
      || value.pluginOrder.some((id) => !ID_RE.test(String(id))) || new Set(value.pluginOrder).size !== value.pluginOrder.length) {
      throw new AppError('ENVIRONMENT_CONFIG_INVALID', '环境配置损坏。');
    }
    return value;
  }

  async createEnvironment(projectId, input) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      const existing = await this.listEnvironments(projectId);
      if (existing.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED', '每个项目最多 100 个环境。');
      const name = normalizeName(input?.name, '环境名称');
      const nameKey = name.normalize('NFKC').toLocaleLowerCase('zh-CN');
      if (existing.some((item) => item.name.normalize('NFKC').toLocaleLowerCase('zh-CN') === nameKey)) throw new AppError('DUPLICATE_ENVIRONMENT_NAME', '同一项目内环境名称不能重复。');
      let environmentId = normalizeId(input?.environmentId ?? name, 'environment');
      while (existing.some((item) => item.environmentId === environmentId)) environmentId = `environment-${crypto.randomBytes(5).toString('hex')}`;
      const timestamp = now();
      const environment = { schemaVersion: 1, projectId, environmentId, name, revision: 1, pluginOrder: [], createdAt: timestamp, updatedAt: timestamp };
      await fs.mkdir(this.pluginDir(projectId, environmentId), { recursive: true });
      await this.writeYaml(this.environmentPath(projectId, environmentId), environment);
      await this.atomicWrite(this.runbookPath(projectId, environmentId), String(input?.runbook ?? DEFAULT_RUNBOOK(name)));
      const nextProject = { ...project, environmentOrder: [...project.environmentOrder, environmentId], revision: project.revision + 1, updatedAt: timestamp };
      await this.writeYaml(this.workspacePath(projectId), nextProject);
      return environment;
    });
  }

  async updateEnvironment(projectId, environmentId, patch, expectedRevision = null) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const current = await this.getEnvironment(projectId, environmentId);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境配置已经变化，请刷新后重试。');
      const nextName = patch.name === undefined ? current.name : normalizeName(patch.name, '环境名称');
      const siblings = await this.listEnvironments(projectId);
      if (siblings.some((item) => item.environmentId !== environmentId && item.name.normalize('NFKC').toLowerCase() === nextName.normalize('NFKC').toLowerCase())) {
        throw new AppError('DUPLICATE_ENVIRONMENT_NAME', '同一项目内环境名称不能重复。');
      }
      const next = { ...current, name: nextName, revision: current.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), next);
      return next;
    });
  }

  async deleteEnvironment(projectId, environmentId, { runtimeActive = false } = {}) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      const environment = await this.getEnvironment(projectId, environmentId);
      if (project.environmentOrder.length <= 1) throw new AppError('POLICY_DENIED', '项目至少需要保留一个环境。');
      const plugins = await this.listPlugins(projectId, environmentId);
      if (plugins.length) throw new AppError('ENVIRONMENT_NOT_EMPTY', `该环境仍有 ${plugins.length} 个插件，不能删除。`);
      if (runtimeActive) throw new AppError('ENVIRONMENT_CONNECTED', '请先断开环境再删除。');
      const next = { ...project, environmentOrder: project.environmentOrder.filter((id) => id !== environmentId), revision: project.revision + 1, updatedAt: now() };
      const source = this.environmentDir(projectId, environmentId);
      const tombstone = `${source}.deleting-${crypto.randomBytes(4).toString('hex')}`;
      await fs.rename(source, tombstone);
      try {
        await this.writeYaml(this.workspacePath(projectId), next);
      } catch (error) {
        await fs.rename(tombstone, source).catch(() => undefined);
        throw error;
      }
      // The workspace index is authoritative after the write above. Leaving a
      // tombstone is safer than restoring an environment that the index omits.
      await fs.rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
      return { environmentId, name: environment.name };
    });
  }

  async reorderEnvironments(projectId, orderedIds, expectedRevision = null) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      if (expectedRevision !== null && project.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '项目配置已经变化，请刷新后重试。');
      if (!Array.isArray(orderedIds) || orderedIds.length !== project.environmentOrder.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !project.environmentOrder.includes(id))) {
        throw new AppError('INVALID_ARGUMENT', '环境排序列表无效。');
      }
      const next = { ...project, environmentOrder: [...orderedIds], revision: project.revision + 1, updatedAt: now() };
      await this.writeYaml(this.workspacePath(projectId), next);
      return next;
    });
  }

  async readRunbook(projectId, environmentId) {
    await this.getEnvironment(projectId, environmentId);
    const content = await fs.readFile(this.runbookPath(projectId, environmentId), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    return { content, bytes: Buffer.byteLength(content), hash: crypto.createHash('sha256').update(content).digest('hex'), empty: !content.trim() };
  }

  async saveRunbook(projectId, environmentId, content, expectedRevision = null) {
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new AppError('RESULT_LIMIT_EXCEEDED', '运维说明不能超过 64 KiB。');
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      if (expectedRevision !== null && environment.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境已经变化，请刷新后重试。');
      await this.atomicWrite(this.runbookPath(projectId, environmentId), text);
      const next = { ...environment, revision: environment.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), next);
      return { environment: next, ...(await this.readRunbook(projectId, environmentId)) };
    });
  }

  async listPlugins(projectId, environmentId) {
    const environment = await this.getEnvironment(projectId, environmentId);
    return this.listPluginsForEnvironment(environment);
  }

  async listPluginsForEnvironment(environment) {
    return mapLimit(environment.pluginOrder ?? [], FILE_READ_CONCURRENCY, (pluginInstanceId) => (
      this.getPlugin(environment.projectId, environment.environmentId, pluginInstanceId)
    ));
  }

  async getPlugin(projectId, environmentId, pluginInstanceId) {
    const value = await this.readYaml(this.pluginPath(projectId, environmentId, pluginInstanceId), 'PLUGIN_NOT_FOUND', '插件不存在。');
    if (value?.projectId !== projectId || value.environmentId !== environmentId || value.pluginInstanceId !== pluginInstanceId) {
      throw new AppError('SCOPE_MISMATCH', '插件不属于当前环境。');
    }
    if (value?.schemaVersion !== 1 || !PLUGIN_TYPES.has(value.pluginType) || typeof value.displayName !== 'string' || !value.displayName.trim()
      || !Number.isInteger(value.revision) || value.revision < 1 || !['ready','draft'].includes(value.configState)) {
      throw new AppError('PLUGIN_CONFIG_INVALID', '插件配置损坏。');
    }
    return value;
  }

  async createPlugin(projectId, environmentId, input, { expectedEnvironmentRevision = null } = {}) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      if (expectedEnvironmentRevision !== null && environment.revision !== expectedEnvironmentRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境配置已经变化，请重新打开环境后重试。');
      if (environment.pluginOrder.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED', '每个环境最多 100 个插件。');
      const plugin = normalizePlugin(input, { projectId, environmentId });
      if (environment.pluginOrder.includes(plugin.pluginInstanceId)) throw new AppError('PLUGIN_ALREADY_EXISTS', '插件标识已经存在。');
      assertPluginConfigurationReady(plugin);
      await this.assertPluginReferences(plugin);
      await this.writeYaml(this.pluginPath(projectId, environmentId, plugin.pluginInstanceId), plugin);
      const nextEnvironment = { ...environment, pluginOrder: [...environment.pluginOrder, plugin.pluginInstanceId], revision: environment.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), nextEnvironment);
      return plugin;
    });
  }

  async commitNewPluginSnapshot(plugin, {expectedEnvironmentRevision = null} = {}) {
    return this.enqueue(`environment:${plugin.projectId}:${plugin.environmentId}`,async () => {
      const environment = await this.getEnvironment(plugin.projectId,plugin.environmentId);
      if (expectedEnvironmentRevision !== null && environment.revision !== expectedEnvironmentRevision) {
        throw new AppError('CONFIG_REVISION_CONFLICT','环境配置已经变化，请重新打开环境后重试。');
      }
      if (environment.pluginOrder.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED','每个环境最多 100 个插件。');
      const snapshot = sanitizePluginSnapshot(plugin);
      if (snapshot.revision !== 1) throw new AppError('INVALID_ARGUMENT','新插件快照 revision 无效。');
      if (environment.pluginOrder.includes(snapshot.pluginInstanceId)) throw new AppError('PLUGIN_ALREADY_EXISTS','插件标识已经存在。');
      await this.assertPluginReferences(snapshot);
      await this.writeYaml(this.pluginPath(snapshot.projectId,snapshot.environmentId,snapshot.pluginInstanceId),snapshot);
      const nextEnvironment = {
        ...environment,
        pluginOrder:[...environment.pluginOrder,snapshot.pluginInstanceId],
        revision:environment.revision + 1,
        updatedAt:now(),
      };
      await this.writeYaml(this.environmentPath(snapshot.projectId,snapshot.environmentId),nextEnvironment);
      return snapshot;
    });
  }

  async ensurePluginIndexed(plugin) {
    return this.enqueue(`environment:${plugin.projectId}:${plugin.environmentId}`,async () => {
      const environment = await this.getEnvironment(plugin.projectId,plugin.environmentId);
      const current = await this.getPlugin(plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
      if (!isDeepStrictEqual(sanitizePluginSnapshot(current),sanitizePluginSnapshot(plugin))) {
        throw new AppError('CONFIG_REVISION_CONFLICT','插件文件与待恢复的草稿提升快照不一致。');
      }
      if (environment.pluginOrder.includes(plugin.pluginInstanceId)) return current;
      if (environment.pluginOrder.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED','每个环境最多 100 个插件。');
      await this.assertPluginReferences(current);
      const next = {
        ...environment,
        pluginOrder:[...environment.pluginOrder,plugin.pluginInstanceId],
        revision:environment.revision + 1,
        updatedAt:now(),
      };
      await this.writeYaml(this.environmentPath(plugin.projectId,plugin.environmentId),next);
      return current;
    });
  }

  async updatePlugin(projectId, environmentId, pluginInstanceId, patch, expectedRevision = null) {
    const prepared = await this.preparePluginUpdate(
      projectId,environmentId,pluginInstanceId,patch,expectedRevision,{requireReady:true},
    );
    if (prepared.change.kind === 'none') return prepared.before;
    return this.commitPluginSnapshot(prepared.after,prepared.before.revision);
  }

  async preparePluginUpdate(projectId, environmentId, pluginInstanceId, patch, expectedRevision = null, {
    credentialMutation = 'none',
    patchScope = null,
    requireReady = false,
  } = {}) {
    const before = await this.getPlugin(projectId, environmentId, pluginInstanceId);
    if (expectedRevision !== null && expectedRevision !== undefined && before.revision !== expectedRevision) {
      throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置已经变化，请刷新后重试。');
    }
    if (patchScope === 'metadata') assertPluginPatchScope(patch,PLUGIN_METADATA_FIELDS,'插件基本信息');
    if (patchScope === 'agent-policy-scope') assertPluginPatchScope(patch,PLUGIN_AGENT_FIELDS,'Agent 配置');
    if (patchScope === 'connection') {
      assertPluginPatchScope(patch,PLUGIN_CONNECTION_FIELDS[before.pluginType] ?? new Set(),'连接配置');
      assertPluginNestedPatchScope(
        patch,
        PLUGIN_CONNECTION_NESTED_FIELDS[before.pluginType],
        '连接配置',
      );
    }
    const normalizedBaseline = normalizePluginCandidate(
      {pluginInstanceId,pluginType:before.pluginType},
      {projectId,environmentId},
      before,
    );
    const normalizedCandidate = normalizePluginCandidate(
      {...patch,pluginInstanceId,pluginType:before.pluginType},
      {projectId,environmentId},
      before,
    );
    const candidate = preserveNormalizationOnlyRoots(
      before,normalizedBaseline,normalizedCandidate,
    );
    await this.assertPluginReferences(candidate);
    const dependentPluginInstanceIds = before.pluginType === 'server'
      ? (await this.listPlugins(projectId,environmentId))
          .filter((plugin) => plugin.transport?.kind === 'serverTunnel'
            && plugin.transport.serverPluginInstanceId === pluginInstanceId)
          .map((plugin) => plugin.pluginInstanceId)
      : [];
    const change = classifyPluginChange({
      before:normalizedBaseline,
      after:normalizedCandidate,
      credentialMutation,
      dependentPluginInstanceIds,
    });
    if (requireReady) assertPluginConfigurationReady(candidate);
    const after = change.kind === 'none' ? before : materializePluginCandidate(candidate,before);
    return {before,candidate,after,change};
  }

  preparePluginMetadataUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision) {
    return this.preparePluginUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision,{
      patchScope:'metadata',
    });
  }

  preparePluginAgentConfigurationUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision) {
    return this.preparePluginUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision,{
      patchScope:'agent-policy-scope',
    });
  }

  preparePluginConnectionUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision,credentialMutation = 'none') {
    return this.preparePluginUpdate(projectId,environmentId,pluginInstanceId,patch,expectedRevision,{
      patchScope:'connection',
      credentialMutation,
      requireReady:true,
    });
  }

  async commitPluginSnapshot(plugin, expectedCurrentRevision) {
    return this.enqueue(`environment:${plugin.projectId}:${plugin.environmentId}`, async () => {
      const current = await this.getPlugin(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId);
      if (current.revision !== expectedCurrentRevision || plugin.revision !== expectedCurrentRevision + 1) {
        throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置已经变化，请刷新后重试。');
      }
      await this.assertPluginReferences(plugin);
      await this.writeYaml(this.pluginPath(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId), plugin);
      return plugin;
    });
  }

  async restorePluginSnapshot(plugin, expectedCurrentRevision = null) {
    return this.enqueue(`environment:${plugin.projectId}:${plugin.environmentId}`, async () => {
      if (expectedCurrentRevision !== null) {
        const current = await this.getPlugin(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId);
        if (current.revision !== expectedCurrentRevision) {
          throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置在凭据保存期间再次变化，不能覆盖较新的配置。');
        }
      }
      await this.writeYaml(this.pluginPath(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId), plugin);
      return plugin;
    });
  }

  async preflightDeletePlugin(projectId, environmentId, pluginInstanceId) {
    const plugin = await this.getPlugin(projectId, environmentId, pluginInstanceId);
    const plugins = await this.listPlugins(projectId, environmentId);
    const dependents = plugins.filter((item) => item.transport?.kind === 'serverTunnel' && item.transport.serverPluginInstanceId === pluginInstanceId);
    if (dependents.length) {
      throw new AppError('PLUGIN_HAS_DEPENDENTS', `仍有 ${dependents.length} 个插件复用此隧道：${dependents.map((item) => item.displayName).join('、')}。`);
    }
    return { plugin, dependents: [] };
  }

  async deletePlugin(projectId, environmentId, pluginInstanceId, {expectedRevision = null} = {}) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      const plugin = await this.getPlugin(projectId, environmentId, pluginInstanceId);
      if (expectedRevision !== null && plugin.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置已经变化，不能移除较新的插件。');
      const plugins = await this.listPlugins(projectId, environmentId);
      const dependents = plugins.filter((item) => item.transport?.kind === 'serverTunnel' && item.transport.serverPluginInstanceId === pluginInstanceId);
      if (dependents.length) throw new AppError('PLUGIN_HAS_DEPENDENTS', `仍有 ${dependents.length} 个插件复用此隧道：${dependents.map((item) => item.displayName).join('、')}。`);
      const next = { ...environment, pluginOrder: environment.pluginOrder.filter((id) => id !== pluginInstanceId), revision: environment.revision + 1, updatedAt: now() };
      const source = this.pluginPath(projectId, environmentId, pluginInstanceId);
      const tombstone = `${source}.deleting-${crypto.randomBytes(4).toString('hex')}`;
      await fs.rename(source, tombstone);
      try {
        await this.writeYaml(this.environmentPath(projectId, environmentId), next);
      } catch (error) {
        await fs.rename(tombstone, source).catch(() => undefined);
        throw error;
      }
      // The environment index write is the commit point; delayed tombstone
      // cleanup must not resurrect an unindexed plugin.
      await fs.rm(tombstone, { force: true }).catch(() => undefined);
      return { pluginInstanceId, displayName: plugin.displayName };
    });
  }

  async assertPluginReferences(plugin) {
    if (plugin.transport?.kind !== 'serverTunnel') return;
    if (!plugin.transport.serverPluginInstanceId) return;
    const provider = await this.getPlugin(plugin.projectId, plugin.environmentId, plugin.transport.serverPluginInstanceId);
    if (provider.pluginType !== 'server' || provider.tunnelProvider === false) throw new AppError('INVALID_PLUGIN_REFERENCE', '隧道只能引用同环境且允许提供隧道的 Server 插件。');
  }

  publicPlugin(plugin) {
    const target = plugin.target ?? {};
    return {
      pluginInstanceId: plugin.pluginInstanceId,
      pluginType: plugin.pluginType,
      displayName: plugin.displayName,
      configState: plugin.configState,
      revision: plugin.revision,
      resource: plugin.pluginType === 'mysql'
        ? { database: target.database }
        : plugin.pluginType === 'redis'
          ? { db: target.db }
          : { host: target.host, port: target.port },
      transport: plugin.transport?.kind ?? plugin.uplink?.type ?? 'direct',
      accessModel: 'builtin-risk-v1',
      limits: clone(plugin.limits ?? {}),
    };
  }

  pluginBindingHash(plugin) {
    const projection = { pluginType: plugin.pluginType, target: plugin.target, auth: plugin.auth, transport: plugin.transport, uplink: plugin.uplink, tls: plugin.tls, sources: plugin.sources, actions: plugin.actions, limits: plugin.limits };
    return crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  }

  async appendAudit(projectId, entry) {
    return this.enqueue(`audit:${projectId}`, async () => {
      await this.getProject(projectId);
      const file = path.join(this.projectDir(projectId), 'audit', 'operations-v3.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const record = { schemaVersion: 3, time: now(), ...entry };
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return record;
    });
  }

  async listAudit(projectId, { environmentId = null, pluginInstanceId = null, cursor = 0, limit = 100 } = {}) {
    await this.getProject(projectId);
    const file = path.join(this.projectDir(projectId), 'audit', 'operations-v3.jsonl');
    const offset = Math.max(Number(cursor) || 0, 0);
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const entries = [];
    let matched = 0;
    for await (const line of readLinesReverse(file)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if ((environmentId && entry.environmentId !== environmentId) || (pluginInstanceId && entry.pluginInstanceId !== pluginInstanceId)) continue;
      if (matched < offset) {
        matched += 1;
        continue;
      }
      entries.push(entry);
      matched += 1;
      if (entries.length > pageSize) break;
    }
    const hasMore = entries.length > pageSize;
    return { entries:entries.slice(0, pageSize), nextCursor:hasMore ? String(offset + pageSize) : null };
  }

  async clearAudit(projectId, { environmentId, pluginInstanceId = null } = {}) {
    await this.getEnvironment(projectId, environmentId);
    if (pluginInstanceId) await this.getPlugin(projectId, environmentId, pluginInstanceId);
    return this.enqueue(`audit:${projectId}`, async () => {
      const file = path.join(this.projectDir(projectId), 'audit', 'operations-v3.jsonl');
      const deletedCount = await rewriteJsonLines(file, (entry) => (
        entry.environmentId === environmentId && (!pluginInstanceId || entry.pluginInstanceId === pluginInstanceId)
      ));
      return { deletedCount, environmentId, pluginInstanceId };
    });
  }
}

export const workspaceInternals = {
  normalizePlugin,
  normalizePluginCandidate,
  materializePluginCandidate,
  sanitizePluginSnapshot,
  normalizeId,
  normalizeName,
  readLinesReverse,
  rewriteJsonLines,
};
