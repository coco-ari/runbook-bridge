import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

export const ADDRESS_FAMILIES = new Set(['ipv4Preferred','ipv4Only','ipv6Preferred','ipv6Only']);
export const TLS_MODES = new Set(['disabled','preferred','required','verifyIdentity']);
export const TRANSPORTS = new Set(['direct','windowsVpn','serverTunnel']);
export const UPLINKS = new Set(['direct','socks5','http','windowsVpn']);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key,canonicalize(value[key])]),
  );
}

export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function issue(field, code, message, action = 'edit-field', details = null) {
  return {field,code,message,action,details};
}

export function hasText(value) {
  return Boolean(String(value ?? '').trim());
}

export function isCredentialFreeServerAgent(plugin) {
  if (plugin?.pluginType !== 'server' || plugin.auth?.type !== 'agent') return false;
  const uplink = plugin.uplink ?? {type:'direct'};
  return ['direct','windowsVpn'].includes(uplink.type)
    || (['http','socks5'].includes(uplink.type) && !hasText(uplink.username));
}

export function portIssue(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? null
    : issue(field,'INVALID_PORT',`${label}端口必须在 1 到 65535 之间。`);
}

export function addressFamilyIssue(value) {
  return value === undefined || value === null || ADDRESS_FAMILIES.has(value)
    ? null
    : issue('target.addressFamily','INVALID_ADDRESS_FAMILY','地址族配置无效。');
}

export function configurationResult(issues) {
  const compact = issues.filter(Boolean);
  if (!compact.length) return {state:'complete',issues:[]};
  const state = compact.some((item) => item.code !== 'REQUIRED') ? 'invalid' : 'incomplete';
  return {state,issues:compact};
}

export function commonTargetIssues(plugin, defaultPort, label) {
  return [
    !hasText(plugin?.target?.host) ? issue('target.host','REQUIRED',`请输入${label}主机地址。`) : null,
    portIssue(plugin?.target?.port ?? defaultPort,'target.port',label),
    addressFamilyIssue(plugin?.target?.addressFamily),
  ];
}

export function transportIssues(transport = {kind:'direct'}) {
  const kind = transport?.kind ?? 'direct';
  if (!TRANSPORTS.has(kind)) return [issue('transport.kind','INVALID_TRANSPORT','连接路径无效。')];
  if (kind === 'windowsVpn' && !hasText(transport.interfaceAlias)) {
    return [issue('transport.interfaceAlias','REQUIRED','请选择 系统 VPN 网卡。')];
  }
  if (kind === 'serverTunnel' && !hasText(transport.serverPluginInstanceId)) {
    return [issue('transport.serverPluginInstanceId','REQUIRED','请选择 Server 隧道。')];
  }
  return [];
}

export function tlsIssues(tls = {mode:'disabled'}) {
  return TLS_MODES.has(tls?.mode ?? 'disabled')
    ? []
    : [issue('tls.mode','INVALID_TLS_MODE','TLS 模式无效。')];
}

export function dependencyRefs(plugin) {
  const providerId = plugin?.transport?.kind === 'serverTunnel'
    ? String(plugin.transport.serverPluginInstanceId ?? '').trim()
    : '';
  return providerId ? [providerId] : [];
}

export function targetIdentity(target = {}, {excludeDatabase = false, excludeDb = false} = {}) {
  return canonicalize({
    host:target.host,
    port:target.port,
    addressFamily:target.addressFamily,
    ...(!excludeDatabase ? {database:target.database} : {}),
    ...(!excludeDb ? {db:target.db} : {}),
    hostKeyFingerprint:target.hostKeyFingerprint,
  });
}

export function adapterValidate(pluginType) {
  return async ({
    draft,purpose,resolvedSecrets = {},runtimeFacade,signal,
    editSessionId,operationId,draftGeneration,configDigest,requestId,
  }) => {
    if (!runtimeFacade || typeof runtimeFacade.validate !== 'function') {
      throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE', `${pluginType} 临时验证运行时不可用。`);
    }
    return runtimeFacade.validate({
      pluginType,draft,purpose,resolvedSecrets,signal,
      editSessionId,operationId,draftGeneration,configDigest,requestId,
    });
  };
}
