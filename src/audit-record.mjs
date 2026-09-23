import { AsyncLocalStorage } from 'node:async_hooks';
import { validateMysqlSelect } from './mysql-policy.mjs';
import { summarizeTerminalCommand } from './server-terminal-audit.mjs';

export const auditExecutionContext = new AsyncLocalStorage();

const ACTIONS = {
  'fs.stat':'查看文件属性', 'fs.list':'浏览服务器目录', 'fs.find':'查找服务器文件',
  'fs.read':'读取服务器文件', 'fs.search':'搜索文件内容', 'fs.download':'下载服务器文件',
  'fs.upload':'上传服务器文件', 'fs.write':'写入服务器文件', 'fs.move':'移动或重命名文件',
  'fs.delete':'删除服务器路径', 'fs.mkdir':'创建服务器目录',
  'logs':'访问服务器日志', 'logs.list':'列出日志文件', 'logs.read':'读取服务器日志', 'logs.search':'搜索服务器日志',
  'config':'读取服务器配置', 'download':'下载服务器文件', 'status':'查看服务器状态', 'diagnostics':'诊断服务器',
  'service.inspect':'查看服务状态', 'service.control':'控制服务器服务', 'service.start':'启动服务',
  'service.stop':'停止服务', 'service.restart':'重启服务', 'service.reload':'重新加载服务',
  'journal.read':'查询系统日志', 'shell.execute':'执行 Shell 命令', 'container.inspect':'查看容器状态',
  'docker.list':'列出容器', 'docker.inspect':'查看容器详情', 'docker.logs':'读取容器日志', 'docker.stats':'查看容器资源',
  'mysql.describe':'查看数据库结构', 'mysql.tables':'列出数据表', 'mysql.table':'查看表结构',
  'mysql.select':'执行只读查询', 'mysql.preview':'预览数据表', 'mysql.explain':'分析查询计划', 'mysql.search':'搜索数据库结构',
  'redis.scan':'扫描 Redis 键', 'redis.read':'读取 Redis 数据', 'redis.ttl':'查看 Redis 有效期', 'redis.type':'查看 Redis 类型',
  'terminal':'使用服务器终端', 'metrics':'查看服务器资源监控',
  'connect':'连接服务器', 'disconnect':'断开服务器', 'auto-reconnect':'自动重新连接',
  'plugin-metadata-updated':'修改插件基本信息', 'plugin-agent-updated':'修改 Agent 操作配置', 'plugin-connection-updated':'修改插件连接配置', 'plugin-deleted':'删除插件',
  'plugin-connected':'连接插件', 'plugin-disconnected':'断开插件', 'plugin-added':'添加插件',
  'environment-connected':'连接环境', 'environment-connecting':'连接环境', 'environment-disconnected':'断开环境',
  'environment-error':'连接环境', 'environment-partial':'连接环境', 'environment-blocked':'连接环境',
  'environment-connect-cancelled':'取消环境连接', 'connection-plan-completed':'连接环境', 'connection-plan-resumed':'继续连接环境',
  'runbook-updated':'更新运维说明', 'server-host-key-trusted':'信任服务器主机密钥',
  'legacy-credential-migrated':'迁移旧版凭据', 'cloud-config-imported':'导入云端配置', 'cloud-config-uploaded':'上传云端配置',
  'execute':'执行服务器命令', 'execute-approved':'执行服务器命令', 'execute-blocked':'执行服务器命令',
  'policy-denied':'操作被策略拦截', 'log-search':'搜索服务器日志', 'log-search-page':'读取日志搜索结果', 'mysql-query':'执行只读查询',
};

export const AUDIT_ACTORS = { user:'用户', agent:'Agent', system:'系统', unknown:'来源未记录' };
export const AUDIT_RESULTS = {
  success:'成功', running:'进行中', pending:'等待确认', approved:'已批准待执行', rejected:'已拒绝',
  cancelled:'已取消', interrupted:'已中断', paused:'已暂停', stopped:'已结束', expired:'已过期',
  invalidated:'已失效', warning:'部分完成', blocked:'已拦截', error:'失败', unknown:'结果未记录',
};

export function safeAuditText(value, limit = 4096) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, '$1[已隐藏]@')
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, '$1[已隐藏]')
    .replace(/(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[已隐藏]')
    .slice(0, limit);
}

export function auditActor(entry) {
  if (Object.hasOwn(AUDIT_ACTORS, entry.actor)) return entry.actor;
  if (entry.actor === 'Agent') return 'agent';
  if ([entry.origin, entry.source].includes('desktop-human')) return 'user';
  if ([entry.origin, entry.source].includes('agent')) return 'agent';
  if (entry.type === 'auto-reconnect' || entry.result === 'connection-lost') return 'system';
  return 'unknown';
}

export function auditAction(entry) {
  if (Object.hasOwn(ACTIONS, entry.auditAction)) return entry.auditAction;
  if (entry.type === 'desktop-file-action') return {mkdir:'fs.mkdir',rename:'fs.move',delete:'fs.delete'}[entry.operation?.kind] ?? '';
  if (entry.type === 'desktop-upload') return 'fs.upload';
  if (entry.type === 'desktop-download') return 'fs.download';
  if (entry.type === 'docker-read') return `docker.${entry.operation}`;
  if (entry.type?.startsWith('terminal-')) return 'terminal';
  if (entry.type?.startsWith('server-metrics-')) return 'metrics';
  if (entry.capability) {
    if (entry.pluginType === 'mysql') return `mysql.${entry.capability}`;
    if (entry.pluginType === 'redis') return `redis.${entry.capability}`;
    return entry.capability;
  }
  return entry.type;
}

export function auditCategory(action) {
  if (/^(fs\.(?:upload|write|move|delete|mkdir)|service\.(?:control|start|stop|restart|reload)|shell\.execute|execute)/u.test(action)) return 'change';
  if (/runbook|plugin-added|plugin-.*updated|plugin-deleted|config-imported|config-uploaded|credential|host-key/u.test(action)) return 'configuration';
  if (/connect|connection-plan/u.test(action)) return 'connection';
  if (['terminal','metrics'].includes(action)) return 'session';
  return Object.hasOwn(ACTIONS, action) ? 'read' : 'other';
}

// 摘要只提取允许的元数据，不保存 SQL、命令、凭据、文件正文或远端输出。
export function operationAuditMetadata(plugin, capability, args = {}, desktopOperation = '') {
  let action = capability;
  let target = args.path ?? args.remotePath ?? args.sourcePath ?? args.unit ?? args.actionId ?? args.sourceId ?? '';
  if (plugin.pluginType === 'mysql') {
    action = `mysql.${{listTables:'tables',describeTable:'table',previewTable:'preview',queryReadonly:'select'}[desktopOperation]
      ?? (capability === 'describe' ? args.table ? 'table' : 'tables' : capability)}`;
    let tables = typeof args.table === 'string' ? [args.table] : [];
    if (!tables.length && typeof args.sql === 'string') {
      try { tables = validateMysqlSelect(args.sql).tables; } catch { /* 无法安全解析时不提取查询正文。 */ }
    }
    target = `固定数据库 ${plugin.target?.database ?? ''}` + (tables.length ? ' · 表 ' + tables.slice(0,20).join('、') : '');
  } else if (plugin.pluginType === 'redis') {
    action = `redis.${capability}`;
    target = `固定 DB ${plugin.target?.db ?? ''}`;
  } else if (capability === 'logs') action = `logs.${['list','search'].includes(args.operation) ? args.operation : 'read'}`;
  else if (capability === 'service.control' && ['start','stop','restart','reload'].includes(args.action)) action = `service.${args.action}`;
  if (capability === 'shell.execute') target = summarizeTerminalCommand(args.command);
  if (capability === 'fs.move' && args.destinationPath) target = `${target} → ${args.destinationPath}`;
  return { auditAction:action, auditTarget:safeAuditText(target), pluginNameSnapshot:safeAuditText(plugin.displayName, 200) };
}

export function auditOutcome(entry) {
  if (entry.type === 'confirmation-approved') return 'approved';
  if (entry.type === 'confirmation-rejected') return 'rejected';
  if (entry.type === 'terminal-open') return 'unknown';
  if (entry.type === 'terminal-close') return ['user','user-closed','closed','workspace-closed','window-closed','application-closed','remote-exit','disposed'].includes(entry.reason) ? 'stopped' : 'interrupted';
  if (entry.type === 'server-metrics-stop') return ['paused','closed','application-closed','disposed'].includes(entry.result) ? 'stopped' : 'interrupted';
  const raw = String(entry.result ?? '');
  if (entry.type === 'server-metrics-status') return raw.endsWith(':ready') ? 'success' : 'warning';
  if (['success','connected','disconnected','completed','complete','already-satisfied','ready'].includes(raw)) return 'success';
  if (['error','failed'].includes(raw)) return 'error';
  if (['blocked','denied'].includes(raw)) return 'blocked';
  if (raw === 'pending-confirmation') return 'pending';
  if (['partial','warning','needs-action','unsupported'].includes(raw)) return 'warning';
  if (raw === 'connection-lost') return 'interrupted';
  if (['cancelled','canceled'].includes(raw)) return 'cancelled';
  if (['interrupted','paused','stopped','expired','invalidated','approved','rejected'].includes(raw)) return raw;
  return entry.errorCode ? 'error' : 'unknown';
}

function legacyTarget(entry) {
  if (entry.operation && typeof entry.operation === 'object') {
    const source = entry.operation.remotePath ?? entry.operation.path ?? '';
    return entry.operation.destinationPath ? `${source} → ${entry.operation.destinationPath}` : source;
  }
  // 旧审批摘要可能包含任意 Shell 或 SQL，不能作为记录详情返回。
  const summary = typeof entry.operationSummary === 'string' ? entry.operationSummary : '';
  if (entry.capability && summary.startsWith(`${entry.capability} · `)) return summary.slice(entry.capability.length + 3);
  return '';
}

export function auditErrorSummary(code) {
  if (!code) return '';
  if (code === 'SERVICE_CONTROL_FAILED') return '服务执行失败，请检查服务状态和日志。';
  if (/CONFIRMATION/u.test(code)) return '确认请求已失效或与当前操作不匹配，请重新发起。';
  if (/TIMEOUT|TIMEDOUT/u.test(code)) return '操作等待超时，请检查连接后重试。';
  if (/AUTH|CREDENTIAL|PERMISSION|ACCESS_DENIED/u.test(code)) return '身份验证或访问授权失败。';
  if (/POLICY|BLOCKED|PROTECTED|FORBIDDEN/u.test(code)) return '操作已被安全策略拦截。';
  if (/NOT_FOUND|NO_SUCH/u.test(code)) return '操作目标不存在或已经被移除。';
  if (/CONNECTION|CONNECT|NETWORK|TUNNEL/u.test(code)) return '连接不可用，请检查网络和插件状态。';
  if (/REVISION|CHANGED|CONFLICT|STALE|SCOPE|CONTEXT/u.test(code)) return '配置或操作范围已经变化，请刷新后重新发起。';
  return '操作未完成，请检查目标状态后重试。';
}

export function presentAuditEvent(entry, offset = 0) {
  const action = auditAction(entry);
  const result = auditOutcome(entry);
  const errorCode = typeof entry.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/u.test(entry.errorCode) && entry.errorCode !== 'CONFIRMATION_REQUIRED' ? entry.errorCode : '';
  const phase = entry.type === 'confirmation-approved' ? '批准操作'
    : entry.type === 'confirmation-rejected' ? '拒绝操作'
    : entry.type === 'terminal-open' ? '打开终端会话'
    : entry.type === 'terminal-close' ? '结束终端会话'
    : entry.type === 'server-metrics-start' ? '开启资源监控'
    : entry.type === 'server-metrics-stop' ? '结束资源监控'
    : entry.type === 'server-metrics-status' ? '更新监控状态'
    : entry.result === 'started' ? '开始执行'
    : result === 'pending' ? '请求用户确认'
    : result === 'success' ? '执行完成' : AUDIT_RESULTS[result];
  return {
    auditId:safeAuditText(entry.auditId,128) || `event-${offset}`, type:'audit-operation',
    time:Number.isFinite(Date.parse(entry.time)) ? entry.time : null,
    actor:auditActor(entry), action, title:Object.hasOwn(ACTIONS,action) ? ACTIONS[action] : '操作类型未记录', category:auditCategory(action),
    projectId:entry.projectId, environmentId:entry.environmentId, pluginInstanceId:entry.pluginInstanceId,
    pluginNameSnapshot:safeAuditText(entry.pluginNameSnapshot,200) || (entry.pluginInstanceId ? '插件名称未记录' : '当前环境'),
    target:safeAuditText(entry.auditTarget ?? legacyTarget(entry)), result, phase,
    errorCode, errorSummary:auditErrorSummary(errorCode),
    ...(Number.isInteger(entry.exitCode) && entry.exitCode >= 0 && entry.exitCode <= 255 ? {exitCode:entry.exitCode} : {}),
    ...(Number.isSafeInteger(entry.rowCount) && entry.rowCount >= 0 ? {rowCount:entry.rowCount,truncated:entry.truncated === true} : {}),
    ...(Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? {durationMs:entry.durationMs} : {}),
    ...(Number.isFinite(entry.operation?.bytes) ? {bytes:entry.operation.bytes} : {}),
  };
}
