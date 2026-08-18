import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { classifyChangedPath } from './plugin-change-classifier.mjs';

const ADDRESS_FAMILIES = new Set(['ipv4Preferred','ipv4Only','ipv6Preferred','ipv6Only']);
const TLS_MODES = new Set(['disabled','preferred','required','verifyIdentity']);
const TRANSPORTS = new Set(['direct','windowsVpn','serverTunnel']);
const UPLINKS = new Set(['direct','socks5','http','windowsVpn']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key,canonicalize(value[key])]),
  );
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function issue(field, code, message, action = 'edit-field', details = null) {
  return {field,code,message,action,details};
}

function hasText(value) {
  return Boolean(String(value ?? '').trim());
}

function portIssue(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? null
    : issue(field,'INVALID_PORT',`${label}端口必须在 1 到 65535 之间。`);
}

function addressFamilyIssue(value) {
  return value === undefined || value === null || ADDRESS_FAMILIES.has(value)
    ? null
    : issue('target.addressFamily','INVALID_ADDRESS_FAMILY','地址族配置无效。');
}

function configurationResult(issues) {
  const compact = issues.filter(Boolean);
  if (!compact.length) return {state:'complete',issues:[]};
  const state = compact.some((item) => item.code !== 'REQUIRED') ? 'invalid' : 'incomplete';
  return {state,issues:compact};
}

function commonTargetIssues(plugin, defaultPort, label) {
  return [
    !hasText(plugin?.target?.host) ? issue('target.host','REQUIRED',`请输入${label}主机地址。`) : null,
    portIssue(plugin?.target?.port ?? defaultPort,'target.port',label),
    addressFamilyIssue(plugin?.target?.addressFamily),
  ];
}

function transportIssues(transport = {kind:'direct'}) {
  const kind = transport?.kind ?? 'direct';
  if (!TRANSPORTS.has(kind)) return [issue('transport.kind','INVALID_TRANSPORT','连接路径无效。')];
  if (kind === 'windowsVpn' && !hasText(transport.interfaceAlias)) {
    return [issue('transport.interfaceAlias','REQUIRED','请选择 Windows VPN 网卡。')];
  }
  if (kind === 'serverTunnel' && !hasText(transport.serverPluginInstanceId)) {
    return [issue('transport.serverPluginInstanceId','REQUIRED','请选择 Server 隧道。')];
  }
  return [];
}

function tlsIssues(tls = {mode:'disabled'}) {
  return TLS_MODES.has(tls?.mode ?? 'disabled')
    ? []
    : [issue('tls.mode','INVALID_TLS_MODE','TLS 模式无效。')];
}

function dependencyRefs(plugin) {
  const providerId = plugin?.transport?.kind === 'serverTunnel'
    ? String(plugin.transport.serverPluginInstanceId ?? '').trim()
    : '';
  return providerId ? [providerId] : [];
}

function targetIdentity(target = {}, {excludeDatabase = false, excludeDb = false} = {}) {
  return canonicalize({
    host:target.host,
    port:target.port,
    addressFamily:target.addressFamily,
    ...(!excludeDatabase ? {database:target.database} : {}),
    ...(!excludeDb ? {db:target.db} : {}),
    hostKeyFingerprint:target.hostKeyFingerprint,
  });
}

function adapterValidate(pluginType) {
  return async ({draft,purpose,resolvedSecrets = {},runtimeFacade,signal}) => {
    if (!runtimeFacade || typeof runtimeFacade.validate !== 'function') {
      throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE', `${pluginType} 临时验证运行时不可用。`);
    }
    return runtimeFacade.validate({pluginType,draft,purpose,resolvedSecrets,signal});
  };
}

const serverAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const authType = plugin?.auth?.type ?? 'password';
    const uplinkType = plugin?.uplink?.type ?? 'direct';
    const issues = [
      ...commonTargetIssues(plugin,22,'SSH'),
      !hasText(plugin?.auth?.username) ? issue('auth.username','REQUIRED','请输入 SSH 用户名。') : null,
      !['password','privateKey','agent'].includes(authType)
        ? issue('auth.type','INVALID_AUTH_TYPE','SSH 认证方式无效。')
        : null,
      authType === 'privateKey' && !hasText(plugin?.auth?.privateKeyPath)
        ? issue('auth.privateKeyPath','REQUIRED','请选择 SSH 私钥文件。')
        : null,
      !UPLINKS.has(uplinkType) ? issue('uplink.type','INVALID_TRANSPORT','SSH 上行路径无效。') : null,
      ['socks5','http'].includes(uplinkType) && !hasText(plugin?.uplink?.host)
        ? issue('uplink.host','REQUIRED','请输入代理主机地址。')
        : null,
      ...(['socks5','http'].includes(uplinkType)
        ? [portIssue(plugin?.uplink?.port,'uplink.port','代理')]
        : []),
      uplinkType === 'windowsVpn' && !hasText(plugin?.uplink?.interfaceAlias)
        ? issue('uplink.interfaceAlias','REQUIRED','请选择 Windows VPN 网卡。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope() {
    return {state:'not-required',kind:null,value:null};
  },
  dependencyRefs() {
    return [];
  },
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'server',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      privateKeyPath:plugin?.auth?.privateKeyPath,
      agentSocket:plugin?.auth?.agentSocket,
      uplink:plugin?.uplink ?? {type:'direct'},
    });
  },
  validationDigest(plugin,purpose) {
    return digest({purpose,identity:this.credentialIdentity(plugin)});
  },
  classifyChangedPath(path,context) {
    return classifyChangedPath('server',path,context);
  },
  validate:adapterValidate('server'),
});

const mysqlAdapter = Object.freeze({
  assessConfiguration(plugin,purpose = 'connection') {
    const databaseRequired = !['tls-probe','server-auth','resource-discovery'].includes(purpose);
    const issues = [
      ...commonTargetIssues(plugin,3306,'MySQL'),
      !hasText(plugin?.auth?.username) ? issue('auth.username','REQUIRED','请输入 MySQL 用户名。') : null,
      ...(transportIssues(plugin?.transport)),
      ...(tlsIssues(plugin?.tls)),
      databaseRequired && !hasText(plugin?.target?.database)
        ? issue('target.database','REQUIRED','请选择或输入 MySQL 数据库。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope(plugin,{verified = false} = {}) {
    const database = String(plugin?.target?.database ?? '').trim();
    if (!database) return {state:'missing',kind:'mysql-database',value:null};
    return {state:verified ? 'verified' : 'selected-unverified',kind:'mysql-database',value:database};
  },
  dependencyRefs,
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'mysql',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      transport:plugin?.transport ?? {kind:'direct'},
      tls:plugin?.tls ?? {mode:'preferred'},
    });
  },
  validationDigest(plugin,purpose) {
    const includeResource = !['tls-probe','server-auth','resource-discovery'].includes(purpose);
    return digest({
      purpose,
      identity:this.credentialIdentity(plugin),
      ...(includeResource ? {resource:this.resourceScope(plugin).value} : {}),
    });
  },
  classifyChangedPath(path,context) {
    return classifyChangedPath('mysql',path,context);
  },
  validate:adapterValidate('mysql'),
});

function redisCluster(plugin) {
  return plugin?.mode === 'cluster' || plugin?.cluster === true || plugin?.target?.cluster === true;
}

const redisAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const rawDb = plugin?.target?.db ?? 0;
    const db = Number(rawDb);
    const issues = [
      ...commonTargetIssues(plugin,6379,'Redis'),
      ...(transportIssues(plugin?.transport)),
      ...(tlsIssues(plugin?.tls)),
      !Number.isInteger(db) || db < 0 || db > 15
        ? issue('target.db','INVALID_REDIS_DB','Redis Logical DB 必须在 0 到 15 之间。')
        : null,
      redisCluster(plugin) && Number.isInteger(db) && db !== 0
        ? issue('target.db','REDIS_CLUSTER_DB_UNSUPPORTED','Redis Cluster 只支持 Logical DB 0。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope(plugin,{verified = false} = {}) {
    const value = plugin?.target?.db === undefined ? 0 : Number(plugin.target.db);
    return {state:verified ? 'verified' : 'selected-unverified',kind:'redis-logical-db',value};
  },
  dependencyRefs,
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'redis',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      transport:plugin?.transport ?? {kind:'direct'},
      tls:plugin?.tls ?? {mode:'disabled'},
    });
  },
  validationDigest(plugin,purpose) {
    const includeResource = !['tls-probe','server-auth','resource-discovery'].includes(purpose);
    return digest({
      purpose,
      identity:this.credentialIdentity(plugin),
      ...(includeResource ? {resource:this.resourceScope(plugin).value} : {}),
    });
  },
  classifyChangedPath(path,context) {
    return classifyChangedPath('redis',path,context);
  },
  validate:adapterValidate('redis'),
});

export const pluginConnectionAdapters = Object.freeze({
  server:serverAdapter,
  mysql:mysqlAdapter,
  redis:redisAdapter,
});

export function getPluginConnectionAdapter(pluginType) {
  const adapter = pluginConnectionAdapters[pluginType];
  if (!adapter) throw new TypeError(`Unsupported plugin type: ${pluginType}`);
  return adapter;
}

export const pluginConnectionAdapterInternals = {
  canonicalize,
  configurationResult,
  dependencyRefs,
  redisCluster,
};
