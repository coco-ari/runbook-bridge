export type AuditResult = "success" | "started" | "running" | "pending" | "warning" | "cancelled" | "blocked" | "error"

export function auditResult(entry: { readonly result?: unknown; readonly errorCode?: unknown }): AuditResult {
  const value = String(entry.result ?? (entry.errorCode ? "error" : "success")).toLowerCase()
  if (["success", "connected", "disconnected", "complete", "completed", "already-satisfied"].includes(value)) return "success"
  // Audit rows describe historical events; a start event is not a pending approval.
  if (value === "started") return "started"
  if (["running", "connecting"].includes(value)) return "running"
  if (value === "pending-confirmation") return "pending"
  if (["cancelled", "canceled"].includes(value)) return "cancelled"
  if (["partial", "warning", "needs-action", "stopped"].includes(value)) return "warning"
  if (["blocked", "denied"].includes(value)) return "blocked"
  return "error"
}

export function auditResultLabel(result: AuditResult): string {
  return {
    success: "成功",
    started: "已开始",
    running: "进行中",
    pending: "等待确认",
    warning: "部分成功",
    cancelled: "已取消",
    blocked: "已拦截",
    error: "失败",
  }[result]
}

export function auditResultVariant(result: AuditResult): "success" | "warning" | "danger" | "info" | "outline" {
  if (result === "success") return "success"
  if (["started", "running", "pending"].includes(result)) return "info"
  if (result === "warning" || result === "cancelled") return "warning"
  if (result === "blocked" || result === "error") return "danger"
  return "outline"
}

const AUDIT_OPERATION_LABELS: Readonly<Record<string, string>> = {
  "auto-reconnect": "自动重新连接",
  connect: "建立服务器连接",
  disconnect: "断开服务器连接",
  download: "下载服务器文件",
  "environment-blocked": "环境连接受阻",
  "environment-connected": "连接环境",
  "environment-connecting": "连接环境",
  "environment-connect-cancelled": "取消环境连接",
  "environment-disconnected": "断开环境",
  "environment-error": "环境连接失败",
  "environment-partial": "部分连接环境",
  execute: "执行服务器命令",
  "execute-approved": "执行已授权命令",
  "execute-blocked": "拦截服务器命令",
  "confirmation-approved": "批准操作",
  "confirmation-rejected": "拒绝操作",
  "connection-plan-completed": "完成连接计划",
  "connection-plan-resumed": "恢复连接计划",
  "legacy-credential-migrated": "迁移旧版凭据",
  "log-search": "搜索服务器日志",
  "log-search-page": "读取日志搜索结果",
  "mysql-query": "查询数据库",
  "plugin-added": "添加插件",
  "plugin-connected": "连接插件",
  "plugin-disconnected": "断开插件",
  "plugin-operation": "执行插件操作",
  "plugin-operation-decision": "检查插件操作权限",
  "plugin-operation-started": "开始插件操作",
  "policy-denied": "策略拦截",
  "runbook-updated": "更新运维说明",
  "server-host-key-trusted": "信任服务器主机密钥",
  upload: "上传服务器文件",
}

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "fs.delete": "删除服务器路径",
  "fs.move": "移动或重命名服务器路径",
  "fs.upload": "上传服务器文件",
  "fs.write": "写入服务器文件",
  "service.control": "控制服务器服务",
  "shell.execute": "执行任意 Shell 命令",
}

const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  AUTHENTICATION_FAILED: "身份验证失败，请检查连接凭据。",
  CAPABILITY_NOT_GRANTED: "当前 Agent 没有执行此操作的权限。",
  COMMAND_BLOCKED: "命令已被安全策略拦截。",
  CONFIG_REVISION_CONFLICT: "配置已被其他操作更新，请刷新后重试。",
  CONFIRMATION_EXPIRED: "本次确认已过期，请让 Agent 重新发起。",
  CONFIRMATION_NOT_FOUND: "本次确认已失效，请刷新确认队列。",
  CONFIRMATION_REQUIRED: "此操作需要用户确认。",
  CONFIRMATION_SCOPE_MISMATCH: "确认请求与当前项目、环境或插件不匹配。",
  CONNECTION_FAILED: "连接失败，请检查网络和插件配置。",
  CONNECTION_FAILED_AFTER_SAVE: "配置已保存，但重新连接失败。",
  CONNECTION_OPERATION_CONFLICT: "已有连接操作正在进行，请稍后重试。",
  CONTEXT_REQUIRED: "需要先建立有效的 Agent 上下文。",
  CONTEXT_STALE: "Agent 上下文已过期，请重新获取。",
  CREDENTIAL_ACCESS_DENIED: "凭据访问被拒绝。",
  CREDENTIAL_NOT_FOUND: "没有找到此插件所需的凭据。",
  CREDENTIAL_REENTRY_REQUIRED: "凭据需要重新录入后才能继续。",
  ENVIRONMENT_NOT_CONNECTED: "环境尚未连接。",
  INTERNAL_ERROR: "应用内部操作未完成，请稍后重试。",
  INVALID_ARGUMENT: "操作参数无效，请重新发起。",
  LOCAL_FILE_CHANGED: "本地文件在确认后发生变化，请重新确认。",
  MANUAL_RECONNECT_REQUIRED: "配置已变化，需要手动重新连接。",
  OPERATION_FAILED: "远程操作未完成，请检查连接与目标状态。",
  PLUGIN_CONFIG_INCOMPLETE: "插件配置尚未完成。",
  PLUGIN_CONFIG_INVALID: "插件配置无效，请检查后重试。",
  PLUGIN_DEPENDENCY_BLOCKED: "插件依赖尚未就绪。",
  PLUGIN_NOT_CONNECTED: "插件尚未连接。",
  PLUGIN_NOT_FOUND: "插件不存在或已被删除。",
  POLICY_DENIED: "操作已被安全策略拒绝。",
  PROTECTED_PATH: "目标路径受保护，不能执行此操作。",
  REMOTE_CHANGED: "服务器目标在确认后发生变化，请重新确认。",
  SCOPE_MISMATCH: "操作范围与当前项目、环境或插件不匹配。",
  SSH_AUTH_FAILED: "SSH 身份验证失败。",
  SSH_CONNECTION_FAILED: "SSH 连接失败。",
  SSH_EXEC_FAILED: "服务器命令执行失败。",
  SSH_HOST_KEY_CHANGED: "服务器主机密钥已变化，连接已停止。",
  SSH_NOT_CONNECTED: "SSH 尚未连接。",
  TARGET_EXISTS: "目标已经存在，请检查覆盖选项。",
  TRANSFER_FAILED: "文件传输失败。",
  TRANSFER_INTEGRITY_FAILED: "文件完整性校验失败。",
  TRANSFER_INTERRUPTED: "文件传输已中断。",
}

const SERVICE_ACTION_LABELS: Readonly<Record<string, string>> = {
  reload: "重新加载",
  restart: "重新启动",
  start: "启动",
  stop: "停止",
}

const REMOTE_TYPE_LABELS: Readonly<Record<string, string>> = {
  directory: "目录",
  file: "文件",
  path: "路径",
  special: "特殊文件",
  symlink: "符号链接",
  "路径": "路径",
}

function normalizedCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value)
    ? value
    : ""
}

export function auditOperationLabel(value: unknown): string {
  if (typeof value !== "string") return "其他受控操作"
  return AUDIT_OPERATION_LABELS[value] ?? "其他受控操作"
}

export function capabilityLabel(value: unknown): string {
  if (typeof value !== "string") return "未识别的服务器操作"
  return CAPABILITY_LABELS[value] ?? "未识别的服务器操作"
}

export function serviceActionLabel(value: unknown): string {
  if (typeof value !== "string") return "服务变更"
  return SERVICE_ACTION_LABELS[value] ?? "服务变更"
}

export function remoteTypeLabel(value: unknown): string {
  if (typeof value !== "string") return "服务器路径"
  return REMOTE_TYPE_LABELS[value] ?? "服务器路径"
}

export function publicErrorLabel(
  value: unknown,
  fallback = "操作未完成，请稍后重试。",
): string {
  const code = normalizedCode(value)
  if (!code) return fallback
  const exact = ERROR_CODE_LABELS[code]
  if (exact) return exact

  if (/CONFIRMATION/u.test(code)) return "确认请求已失效或与当前操作不匹配，请重新发起。"
  if (/(?:SCOPE|CONTEXT|BINDING)_/u.test(code)) return "操作范围已经变化，请刷新后重新发起。"
  if (/(?:AUTH|CREDENTIAL|PERMISSION|ACCESS_DENIED|UNAUTHORIZED)/u.test(code)) return "身份验证或访问授权失败。"
  if (/(?:POLICY|BLOCKED|PROTECTED|FORBIDDEN|NOT_ALLOWED)/u.test(code)) return "操作已被安全策略拦截。"
  if (/(?:NOT_FOUND|NO_SUCH|UNKNOWN_TABLE|UNKNOWN_COLUMN)/u.test(code)) return "操作目标不存在或已经被移除。"
  if (/(?:TIMEOUT|TIMEDOUT)/u.test(code)) return "操作等待超时，请检查连接后重试。"
  if (/(?:CONNECTION|CONNECT|NETWORK|DNS|SOCKET|TUNNEL|ROUTE)/u.test(code)) return "连接不可用，请检查网络和插件状态。"
  if (/(?:TLS|SSL|CERT|HOST_KEY)/u.test(code)) return "连接安全校验失败，请核对证书或主机密钥。"
  if (/(?:CONFIG|REVISION|CHANGED|CONFLICT|STALE)/u.test(code)) return "配置或目标状态已经变化，请刷新后重试。"
  if (/(?:LIMIT|TOO_LARGE|EXHAUSTED|RESPONSE_TOO_LARGE)/u.test(code)) return "操作超过安全限制，请缩小范围后重试。"
  if (/(?:UNAVAILABLE|UNSUPPORTED|NOT_IMPLEMENTED)/u.test(code)) return "当前环境不支持此操作。"
  if (/(?:FAILED|ERROR|IO_ERROR|EIO)/u.test(code)) return "操作未完成，请检查目标状态后重试。"
  return fallback
}

export function localizeOperationalSummary(value: string): string {
  return value
    .replace(/\bfs\.upload\b/giu, "上传服务器文件")
    .replace(/\bfs\.write\b/giu, "写入服务器文件")
    .replace(/\bfs\.move\b/giu, "移动或重命名服务器路径")
    .replace(/\bfs\.delete\b/giu, "删除服务器路径")
    .replace(/\bservice\.control\b/giu, "控制服务器服务")
    .replace(/\bshell\.execute\b/giu, "执行任意 Shell 命令")
    .replace(/\brestart\s+systemd\b/giu, "重新启动 systemd")
    .replace(/\breload\s+systemd\b/giu, "重新加载 systemd")
    .replace(/\bstart\s+systemd\b/giu, "启动 systemd")
    .replace(/\bstop\s+systemd\b/giu, "停止 systemd")
}
