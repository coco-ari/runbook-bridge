import { AppError } from './errors.mjs';

const RULES = Object.freeze({
  server: Object.freeze({
    status: { decision:'auto', risk:'read', label:'读取服务器状态' },
    diagnostics: { decision:'auto', risk:'read', label:'运行有界只读诊断' },
    'service.inspect': { decision:'auto', risk:'read', label:'读取服务信息' },
    'journal.read': { decision:'auto', risk:'read', label:'查询 systemd journal' },
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
  }),
  mysql: Object.freeze({
    describe: { decision:'auto', risk:'read', label:'读取数据库结构' },
    select: { decision:'auto', risk:'read', label:'执行只读 SELECT' },
    explain: { decision:'auto', risk:'read', label:'读取执行计划' },
  }),
  redis: Object.freeze({
    scan: { decision:'auto', risk:'read', label:'扫描 Redis Key' },
    read: { decision:'auto', risk:'read', label:'读取 Redis 数据' },
    ttl: { decision:'auto', risk:'read', label:'读取 Redis TTL' },
  }),
});

export function capabilityRule(pluginType, capability) {
  return RULES[String(pluginType ?? '')]?.[String(capability ?? '')] ?? {
    decision:'deny', risk:'unknown', label:'未登记操作',
  };
}

export class OperationGate {
  constructor(confirmationManager) {
    this.confirmationManager = confirmationManager;
  }

  authorize({ scope, plugin, capability, args, approvalToken, summary, metadata = {} }) {
    const rule = capabilityRule(plugin.pluginType, capability);
    if (rule.decision === 'deny') {
      throw new AppError('POLICY_DENIED', '该操作未在应用内置能力表中登记，已拒绝执行。', { capability });
    }
    if (rule.decision === 'auto') return rule;

    const approved = approvalToken
      ? this.confirmationManager.consume(approvalToken, scope, capability, args)
      : this.confirmationManager.consumeMatching(scope, capability, args);
    if (approved) return { ...rule, confirmationId:approved.requestId };

    const pending = this.confirmationManager.request(scope, capability, args, summary, {
      ...metadata,
      riskLevel:rule.risk,
      approvalLevel:rule.approvalLevel ?? 'standard',
      capabilityLabel:rule.label,
    });
    throw new AppError('CONFIRMATION_REQUIRED', '该操作会改变服务器，需要在桌面端确认。', {
      requestId:pending.requestId,
      summary,
      riskLevel:rule.risk,
      approvalLevel:rule.approvalLevel ?? 'standard',
      confirmationCreated:pending.deduplicated !== true,
    });
  }
}

export const operationGateRules = RULES;
