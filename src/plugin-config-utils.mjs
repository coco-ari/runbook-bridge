import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export const ADDRESS_FAMILIES = new Set(['ipv4Preferred', 'ipv4Only', 'ipv6Preferred', 'ipv6Only']);
export const TRANSPORTS = new Set(['direct', 'windowsVpn', 'serverTunnel']);
export const POLICY_MODES = new Set(['auto', 'confirm', 'deny']);
export const PLUGIN_METADATA_FIELDS = new Set(['displayName', 'description', 'tags', 'displayOrder']);
export const PLUGIN_AGENT_FIELDS = new Set(['policy', 'sources', 'actions', 'patterns', 'limits']);
export const NORMALIZATION_ROOT_GROUPS = Object.freeze([
  ['displayName'],['description'],['tags'],['displayOrder'],
  ['target'],['auth'],['transport'],['uplink'],['tls'],
  ['policy'],['sources'],['actions'],['patterns'],['limits'],
  ['tunnelProvider'],['mode','cluster'],['legacyProjectId'],['configState'],
]);

const clone = value => structuredClone(value);

export function normalizeName(value, label = '名称') {
  const name = String(value ?? '').normalize('NFKC').trim();
  if (!name || name.length > 120 || CONTROL_RE.test(name)) {
    throw new AppError('INVALID_ARGUMENT', `${label}不能为空、不能超过 120 字符或包含控制字符。`);
  }
  return name;
}

export function normalizeDescription(value) {
  const description = String(value ?? '').normalize('NFKC').trim();
  if (description.length > 4096 || CONTROL_RE.test(description)) {
    throw new AppError('INVALID_ARGUMENT', '插件说明不能超过 4096 字符或包含控制字符。');
  }
  return description;
}

export function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new AppError('INVALID_ARGUMENT', '插件标签必须是最多 32 项的数组。');
  }
  const tags = value.map((item) => String(item ?? '').normalize('NFKC').trim());
  if (tags.some((item) => !item || item.length > 64 || CONTROL_RE.test(item))) {
    throw new AppError('INVALID_ARGUMENT', '插件标签不能为空、不能超过 64 字符或包含控制字符。');
  }
  return [...new Set(tags)];
}

export function normalizeDisplayOrder(value) {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 0 || order > 1_000_000) {
    throw new AppError('INVALID_ARGUMENT', '插件展示顺序必须是 0 到 1000000 的整数。');
  }
  return order;
}

export function assertPluginPatchScope(patch, allowed, label) {
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

export function assertPluginNestedPatchScope(patch, schema, label) {
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

export function rootGroupProjection(value, roots) {
  return Object.fromEntries(
    roots.flatMap((root) => (Object.hasOwn(value ?? {},root) ? [[root,value[root]]] : [])),
  );
}

export function preserveNormalizationOnlyRoots(before, normalizedBaseline, normalizedCandidate) {
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

export function normalizeId(value, prefix) {
  const raw = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (ID_RE.test(normalized)) return normalized;
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

export function assertId(value, label) {
  if (!ID_RE.test(String(value ?? ''))) throw new AppError('INVALID_ARGUMENT', `${label}无效。`);
  return String(value);
}

export function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', '端口必须在 1 到 65535 之间。');
  }
  return port;
}

export function normalizeHost(value, { required = true } = {}) {
  const host = String(value ?? '').trim();
  if ((!host && required) || host.length > 255 || CONTROL_RE.test(host)) {
    throw new AppError('INVALID_ARGUMENT', '连接目标地址无效。');
  }
  return host;
}

export function normalizeAddressFamily(value) {
  return ADDRESS_FAMILIES.has(value) ? value : 'ipv4Preferred';
}

export function normalizePolicy(input, defaults) {
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

export function normalizeTransport(input = {}) {
  const kind = TRANSPORTS.has(input.kind) ? input.kind : 'direct';
  const transport = { kind };
  if (kind === 'serverTunnel') {
    const providerId = String(input.serverPluginInstanceId ?? '').trim();
    if (providerId) transport.serverPluginInstanceId = assertId(providerId, '隧道 Server 插件标识');
  }
  if (kind === 'windowsVpn') {
    const interfaceAlias = String(input.interfaceAlias ?? '').trim();
    if (interfaceAlias.length > 128 || CONTROL_RE.test(interfaceAlias)) {
      throw new AppError('INVALID_ARGUMENT', '系统 VPN 网卡名称无效。');
    }
    if (interfaceAlias) transport.interfaceAlias = interfaceAlias;
  }
  return transport;
}

export function transportReady(transport) {
  if (transport?.kind === 'serverTunnel') return Boolean(transport.serverPluginInstanceId);
  if (transport?.kind === 'windowsVpn') return Boolean(transport.interfaceAlias);
  return true;
}
