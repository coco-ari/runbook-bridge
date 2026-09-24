import { serverAdapter } from './connection.mjs';
import { AppError } from '../../errors.mjs';
import { CONTROL_RE, normalizeHost, normalizePort, normalizeAddressFamily, normalizePolicy, normalizeId, normalizeName } from '../../plugin-config-utils.mjs';
import path from 'node:path';
import { normalizeDockerSocket } from '../../server-docker-reader.mjs';

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


const capabilities = {
  status: { decision:'auto', risk:'read', label:'读取服务器状态' },
  diagnostics: { decision:'auto', risk:'read', label:'运行有界只读诊断' },
  'service.inspect': { decision:'auto', risk:'read', label:'读取服务信息' },
  'journal.read': { decision:'auto', risk:'read', label:'查询 systemd journal' },
  'docker.list': { decision:'auto', risk:'read', label:'列出 Docker 容器' },
  'docker.inspect': { decision:'auto', risk:'read', label:'读取 Docker 容器概览' },
  'docker.logs': { decision:'auto', risk:'read', label:'读取 Docker 容器日志' },
  'docker.stats': { decision:'auto', risk:'read', label:'读取 Docker 容器资源' },
  'container.inspect': { decision:'auto', risk:'read', label:'读取容器信息' },
  logs: { decision:'auto', risk:'read', label:'有界搜索服务器日志' },
  config: { decision:'auto', risk:'read', label:'读取已登记配置' },
  download: { decision:'auto', risk:'read', label:'下载已登记文件' },
  'fs.stat': { decision:'auto', risk:'read', label:'查看文件属性' },
  'fs.list': { decision:'auto', risk:'read', label:'列出服务器目录' },
  'fs.find': { decision:'auto', risk:'read', label:'查找服务器文件' },
  'fs.read': { decision:'auto', risk:'read', label:'读取服务器文件' },
  'fs.search': { decision:'auto', risk:'read', label:'搜索服务器文件内容' },
  'fs.download': { decision:'auto', risk:'read', label:'下载服务器文件' },
  'fs.upload': { decision:'confirm', risk:'write', label:'上传服务器文件' },
  'fs.write': { decision:'confirm', risk:'write', label:'写入服务器文件' },
  'fs.move': { decision:'confirm', risk:'destructive', label:'移动或重命名服务器路径' },
  'fs.delete': { decision:'confirm', risk:'destructive', label:'删除服务器路径' },
  'service.control': { decision:'confirm', risk:'service', label:'变更服务器服务状态' },
  'shell.execute': { decision:'confirm', risk:'critical', approvalLevel:'strong', label:'执行任意 Shell' },
};

function normalizeConfiguration(input, existing, base) {
  const source = {
    ...(existing ?? {}),
    ...input,
    policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
    limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
  };
  const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
  const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
  const uplink = { ...(existing?.uplink ?? {}), ...(input.uplink ?? {}) };
  if (auth.privateKeySource !== undefined && !['file','vault'].includes(auth.privateKeySource)) throw new AppError('INVALID_ARGUMENT','SSH 私钥来源无效。');
  const host = normalizeHost(target.host, { required: false });
  const username = String(auth.username ?? '').trim();
  if (username.length > 128 || CONTROL_RE.test(username)) throw new AppError('INVALID_ARGUMENT', 'SSH 用户名无效。');
  const authType = ['password', 'privateKey', 'agent'].includes(auth.type) ? auth.type : 'password';
  const uplinkType = ['direct', 'socks5', 'http', 'windowsVpn'].includes(uplink.type) ? uplink.type : 'direct';
  const proxyHost = uplinkType === 'socks5' || uplinkType === 'http' ? normalizeHost(uplink.host, { required:false }) : '';
  const vpnAlias = uplinkType === 'windowsVpn' ? String(uplink.interfaceAlias ?? '').trim() : '';
  if (vpnAlias.length > 128 || CONTROL_RE.test(vpnAlias)) throw new AppError('INVALID_ARGUMENT', '系统 VPN 网卡名称无效。');
  const authReady = Boolean(username) && (authType !== 'privateKey' || auth.privateKeySource === 'vault' || Boolean(auth.privateKeyPath));
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
      ...(target.dockerSocket !== undefined && target.dockerSocket !== '' ? { dockerSocket:normalizeDockerSocket(target.dockerSocket) } : {}),
      ...(addressUnchanged && target.hostKeyFingerprint
        ? { hostKeyFingerprint: String(target.hostKeyFingerprint) }
        : {}),
    },
    auth: {
      type: authType,
      username,
      ...(authType === 'privateKey' && auth.privateKeySource === 'vault' ? {privateKeySource:'vault'} : {}),
      ...(authType === 'privateKey' && auth.privateKeySource !== 'vault' && auth.privateKeyPath ? { privateKeyPath: String(auth.privateKeyPath) } : {}),
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

function invoke({plugin, capability, args, serverOperations, scope = {}}) {
  if (capability === 'status' || capability === 'diagnostics') return serverOperations.runAction(plugin, args.actionId, args.parameters ?? {});
  if (capability === 'service.inspect') return serverOperations.inspectService(plugin, args);
  if (capability === 'journal.read') return serverOperations.queryJournal(plugin, args);
  if (['docker.list','docker.inspect','docker.logs','docker.stats'].includes(capability)) return serverOperations.docker.read('mcp:' + scope.clientInstanceId, { projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, kind:capability.slice(7), ...args }, scope.auditOperationId);
  if (capability === 'container.inspect') return serverOperations.inspectContainer(plugin, args);
  if (capability === 'logs') {
    if (args.operation === 'list') return serverOperations.listFiles(plugin, args);
    if (args.operation === 'search') return serverOperations.searchLogs(plugin, { ...args, _clientInstanceId:scope.clientInstanceId });
    return serverOperations.readLog(plugin, args);
  }
  if (capability === 'config') return serverOperations.readConfig(plugin, args);
  if (capability === 'download') return serverOperations.download(plugin, args);
  if (capability === 'fs.stat') return serverOperations.statPath(plugin, args);
  if (capability === 'fs.list') return serverOperations.listDirectory(plugin, args);
  if (capability === 'fs.find') return serverOperations.findFiles(plugin, args);
  if (capability === 'fs.read') return serverOperations.readFile(plugin, args);
  if (capability === 'fs.search') return serverOperations.searchFiles(plugin, args);
  if (capability === 'fs.download') return serverOperations.downloadPath(plugin, args);
  if (capabilities[capability]?.decision === 'confirm') return serverOperations.mutate(plugin, capability, args);
  throw new AppError('CAPABILITY_NOT_IMPLEMENTED', 'Server 操作尚未实现。');
}

export const serverPluginDefinition = {
  type:'server',
  connectionAdapter:serverAdapter,
  connectionFields:['target','auth','uplink','tunnelProvider'],
  connectionNestedFields:{
    target:['host','port','addressFamily','hostKeyFingerprint','dockerSocket'],
    auth:['type','username','privateKeyPath','privateKeySource','agentSocket'],
    uplink:['type','host','port','username','remoteDns','interfaceAlias'],
  },
  normalizeConfiguration,
  publicResource: plugin => ({host:plugin.target?.host, port:plugin.target?.port}),
  capabilities,
  invoke,
};
