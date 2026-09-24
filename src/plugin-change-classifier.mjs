import { builtinPluginRegistry } from './plugins/builtins.mjs';
import { classifyChangedPath } from './plugin-change-policy.mjs';
export { classifyChangedPath } from './plugin-change-policy.mjs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const CREDENTIAL_MUTATIONS = new Set(['none','replace','rebind-existing','clear-explicit']);
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

function connectionProjection(plugin, registry) {
  const fields = registry.get(plugin?.pluginType).connectionFields;
  return cloneDefined(Object.fromEntries(
    ['projectId','environmentId','pluginInstanceId','pluginType',...fields]
      .map(field => [field,plugin?.[field]]),
  ));
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

export function pluginConnectionFingerprint(plugin, registry = builtinPluginRegistry) {
  return digest(connectionProjection(plugin, registry));
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
