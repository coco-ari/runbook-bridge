import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const CREDENTIAL_MUTATIONS = new Set(['none','replace','rebind-existing','clear-explicit']);
const METADATA_PATHS = new Set(['displayName','description','tags','displayOrder']);
const AGENT_ROOTS = new Set(['policy','sources','actions','patterns','limits']);
const RECORD_PATHS = new Set(['schemaVersion','revision','updatedAt','configState']);

function cloneDefined(value) {
  if (Array.isArray(value)) return value.map(cloneDefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([,item]) => item !== undefined)
      .map(([key,item]) => [key,cloneDefined(item)]),
  );
}

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

function connectionProjection(plugin) {
  const common = {
    projectId:plugin?.projectId,
    environmentId:plugin?.environmentId,
    pluginInstanceId:plugin?.pluginInstanceId,
    pluginType:plugin?.pluginType,
    target:plugin?.target,
    auth:plugin?.auth,
  };
  if (plugin?.pluginType === 'server') {
    return cloneDefined({...common,uplink:plugin.uplink,tunnelProvider:plugin.tunnelProvider});
  }
  return cloneDefined({
    ...common,
    transport:plugin?.transport,
    tls:plugin?.tls,
    mode:plugin?.mode,
    cluster:plugin?.cluster,
  });
}

function agentProjection(plugin) {
  return cloneDefined({
    projectId:plugin?.projectId,
    environmentId:plugin?.environmentId,
    pluginInstanceId:plugin?.pluginInstanceId,
    pluginType:plugin?.pluginType,
    policy:plugin?.policy,
    sources:plugin?.sources,
    actions:plugin?.actions,
    patterns:plugin?.patterns,
    limits:plugin?.limits,
  });
}

export function pluginSemanticProjection(plugin) {
  const source = plugin && typeof plugin === 'object' ? plugin : {};
  return cloneDefined(Object.fromEntries(
    Object.entries(source).filter(([key]) => !RECORD_PATHS.has(key)),
  ));
}

export function pluginConnectionFingerprint(plugin) {
  return digest(connectionProjection(plugin));
}

export function pluginAgentFingerprint(plugin) {
  return digest(agentProjection(plugin));
}

function collectChangedPaths(before, after, prefix = '', output = []) {
  if (isDeepStrictEqual(canonicalize(before),canonicalize(after))) return output;
  if (Array.isArray(before) || Array.isArray(after)) {
    output.push(prefix);
    return output;
  }
  const beforeObject = before && typeof before === 'object';
  const afterObject = after && typeof after === 'object';
  if (!beforeObject || !afterObject) {
    output.push(prefix);
    return output;
  }
  const keys = [...new Set([...Object.keys(before),...Object.keys(after)])].sort();
  for (const key of keys) {
    collectChangedPaths(before[key],after[key],prefix ? `${prefix}.${key}` : key,output);
  }
  return output;
}

function rootPath(path) {
  return String(path ?? '').split('.')[0];
}

export function classifyChangedPath(pluginType, path, {
  before = null,
  after = null,
  hasDependents = false,
} = {}) {
  if (METADATA_PATHS.has(path)) return 'metadata';
  if (AGENT_ROOTS.has(rootPath(path))) return 'agent-policy-scope';
  if (['projectId','environmentId','pluginInstanceId','pluginType'].includes(rootPath(path))) {
    return 'dependency-affecting';
  }
  if (path === 'tunnelProvider' || path.startsWith('tunnelProvider.')) return 'dependency-affecting';
  if (path === 'transport.serverPluginInstanceId' || path.startsWith('transport.serverPluginInstanceId.')) {
    return 'dependency-affecting';
  }
  if (rootPath(path) === 'transport') {
    const beforeKind = before?.transport?.kind;
    const afterKind = after?.transport?.kind;
    if (beforeKind === 'serverTunnel' || afterKind === 'serverTunnel') return 'dependency-affecting';
  }
  if (pluginType === 'server' && hasDependents && ['target','auth','uplink'].includes(rootPath(path))) {
    return 'dependency-affecting';
  }
  return 'session-affecting';
}

const KIND_PRIORITY = new Map([
  ['none',0],
  ['metadata',1],
  ['agent-policy-scope',2],
  ['session-affecting',3],
  ['dependency-affecting',4],
]);

export function classifyPluginChange({
  before,
  after,
  credentialMutation = 'none',
  dependentPluginInstanceIds = [],
} = {}) {
  if (!CREDENTIAL_MUTATIONS.has(credentialMutation)) {
    throw new TypeError(`Unsupported credential mutation: ${credentialMutation}`);
  }
  const beforeProjection = pluginSemanticProjection(before);
  const afterProjection = pluginSemanticProjection(after);
  const changedPaths = collectChangedPaths(beforeProjection,afterProjection).filter(Boolean);
  const pluginType = after?.pluginType ?? before?.pluginType;
  const hasDependents = dependentPluginInstanceIds.length > 0;
  let kind = 'none';
  for (const path of changedPaths) {
    const candidate = classifyChangedPath(pluginType,path,{before,after,hasDependents});
    if (KIND_PRIORITY.get(candidate) > KIND_PRIORITY.get(kind)) kind = candidate;
  }
  if (credentialMutation !== 'none' && KIND_PRIORITY.get(kind) < KIND_PRIORITY.get('session-affecting')) {
    kind = 'session-affecting';
  }
  const pluginInstanceId = after?.pluginInstanceId ?? before?.pluginInstanceId;
  const affectedPluginInstanceIds = kind === 'none'
    ? []
    : [...new Set([
        pluginInstanceId,
        ...(kind === 'dependency-affecting' ? dependentPluginInstanceIds : []),
      ].filter(Boolean))];
  return {kind,changedPaths,affectedPluginInstanceIds,credentialMutation};
}

export const pluginChangeClassifierInternals = {
  canonicalize,
  collectChangedPaths,
  connectionProjection,
  agentProjection,
};
