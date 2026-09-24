const METADATA_PATHS = new Set(['displayName','description','tags','displayOrder']);
const AGENT_ROOTS = new Set(['policy','sources','actions','patterns','limits']);

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
