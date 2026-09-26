import type { PublicError } from "@/bridge/ai-ops-v2"

export type DiagnosticDomain = "connection" | "operation" | "cloud"
export interface Diagnostic {
  readonly stage: string
  readonly outcome: string
  readonly guidance: string
  readonly code: string
  readonly neutral: boolean
}

const STAGES: Readonly<Record<string, readonly [string, string]>> = {
  configuration: ["配置与凭据", "打开连接设置，检查必填项和凭据是否已保存，再验证配置。"],
  dns: ["地址解析", "检查主机名称与 IPv4 / IPv6 策略；确认当前网络能够解析该地址。"],
  network: ["网络与路由", "核对目标端口、VPN、代理和防火墙；隧道连接还需检查上游服务器。"],
  tunnel: ["上游与隧道", "先查看上游 Server 的连接状态及原因，再重试依赖它的插件。"],
  identity: ["主机身份与加密", "核对服务器指纹或证书及 TLS 配置；确认身份前不要继续连接。"],
  authentication: ["身份认证", "核对用户名、密码或私钥；在连接设置中更新凭据后重新验证。"],
  permission: ["资源与权限", "核对当前账号可访问的数据库、Key 范围或文件权限，以及应用允许的操作范围。"],
  protocol: ["协议与会话", "检查服务类型、协议设置及连接状态；重新连接后再打开工作区。"],
  queue: ["等待执行", "检查同一资源上正在运行的任务；本次请求尚在等待执行。"],
  query: ["查询执行", "核对表结构和查询范围；可缩小结果范围后重新发起只读查询。"],
  metadata: ["读取结构", "刷新表结构，确认目标表仍存在且当前账号可以访问。"],
  sql_preflight: ["SQL 执行检查", "查看具体提示，核对目标表、账号权限和当前版本支持的操作；未通过检查的语句不会继续执行。"],
  transaction: ["事务状态", "回到对应 SQL 标签提交或回滚；结果待核实时先查询确认，再关闭标签后继续其他操作。"],
  transfer: ["文件传输", "检查连接、目标路径和文件权限；传输中断后先核对目标文件，再选择恢复或重新传输。"],
  conflict: ["核对当前版本", "数据或配置已发生变化。重新读取并核对差异，再决定是否提交。"],
  cloud: ["云配置", "到配置 → 云配置检查所选仓库、解锁状态和检测结果；此问题不代表服务器连接失败。"],
  unknown: ["阶段尚未确定", "展开原始提示并核对当前目标。已提交的修改应先核实结果，再决定下一步。"],
}

// Reasons are an explicit public allowlist. Never display backend-provided
// guidance, permission names, SQL or other free-form driver details here.
const SQL_REASONS: Readonly<Record<string, readonly [string, string, string]>> = {
  trigger_visibility: ["触发器检查", "权限或可见性待确认", "请让管理员核对目标表的 TRIGGER 元数据可见性。应用目前仅能确认直接授权，角色授权可能无法核实；此提示不表示已发现触发器。"],
  cascade_visibility: ["级联关系检查", "元数据无法核实", "请让管理员核对入向外键元数据的访问权限（通常涉及 PROCESS）及数据库版本。无法完整核实关系时，本次修改或删除暂不执行。"],
  write_privilege: ["SQL 写入权限", "数据库拒绝访问", "请让管理员核对当前账号对目标表或字段的 INSERT / UPDATE / DELETE 权限，仅处理本次操作所需权限；已提交语句不会因此撤回。"],
  select_privilege: ["SQL 读取权限", "数据库拒绝访问", "请让管理员核对当前账号对目标表和字段的 SELECT 权限；写入前的表校验也需要读取权限。"],
  operation_privilege: ["SQL 操作权限", "数据库拒绝访问", "请让管理员核对当前账号对目标数据库、表和字段的本次操作权限。应用不会自动修改授权。"],
  table_unavailable: ["表访问检查", "表不存在或不可见", "刷新当前库的表结构并核对表名；仍不可见时，请让管理员确认该表是否存在及账号的访问范围。"],
  table_type: ["对象类型检查", "当前版本不支持", "当前版本仅支持基础表，暂不支持通过 SQL 操作视图等其他对象；增加权限不会解除此限制。"],
  non_transactional: ["事务能力检查", "当前版本不支持", "当前版本仅允许写入 InnoDB 基础表，以保证事务回滚。请核对目标表的存储引擎，应用不会自动更改表结构。"],
  trigger_side_effect: ["写入副作用检查", "当前版本不支持", "目标表已存在与本次写入相关的触发器，当前版本暂不执行带此类副作用的 SQL；增加权限不会解除此限制。"],
  cascade_side_effect: ["写入副作用检查", "当前版本不支持", "目标表已存在与本次修改或删除相关的级联外键，当前版本暂不执行此类 SQL；增加权限不会解除此限制。"],
  strict_mode: ["会话模式检查", "执行条件未满足", "当前会话需要 STRICT_TRANS_TABLES 或 STRICT_ALL_TABLES。请让管理员核对 SQL 模式；应用不会自动修改会话设置。"],
}

export function diagnosticFor(error: Pick<PublicError, "code" | "details">, domain: DiagnosticDomain = "connection"): Diagnostic {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "UNKNOWN_ERROR"
  const cancelled = /CANCELLED$|CANCELED$/.test(code)
  const uncertain = /OUTCOME_UNKNOWN|RESULT_UNKNOWN|COMMIT_UNKNOWN|WRITE_UNKNOWN|UNCERTAIN|COMMIT_UNCONFIRMED/.test(code)
  const timeout = /TIMEOUT/.test(code)
  const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {}
  if (code === "MYSQL_SQL_WRITE_UNSAFE" && typeof details.reason === "string" && Object.hasOwn(SQL_REASONS, details.reason)) {
    const [stage, outcome, guidance] = SQL_REASONS[details.reason]!
    return { code, stage: domain === "cloud" ? `云配置 · ${stage}` : stage, outcome, guidance, neutral: false }
  }
  let key = domain === "cloud" ? "cloud" : "unknown"
  if (code === "MYSQL_SQL_WRITE_UNSAFE") key = "sql_preflight"
  else if (/^MYSQL_SQL_(TRANSACTION_|NO_TRANSACTION)/.test(code)) key = "transaction"
  else if (code === "MYSQL_SQL_BUSY") key = "queue"
  else if (/CREDENTIAL|CONFIG_INCOMPLETE|IDENTITY_UNAVAILABLE/.test(code)) key = "configuration"
  else if (/DNS|ADDRESS_FAMILY|ENOTFOUND|EAI_AGAIN/.test(code)) key = "dns"
  else if (/TUNNEL|DEPENDENCY/.test(code)) key = "tunnel"
  else if (/HOST_KEY|TLS|CERTIFICATE/.test(code)) key = "identity"
  else if (/AUTHENTICATION|AUTH_FAILED/.test(code)) key = "authentication"
  else if (/ACCESS_DENIED|POLICY_DENIED|DATABASE_NOT_FOUND|SOURCE_NOT_ALLOWED|COMMAND_BLOCKED/.test(code)) key = "permission"
  else if (/ROUTE_|VPN_|CONNECT_TIMEOUT|CONNECTION_REFUSED/.test(code)) key = "network"
  else if (/REVISION_CONFLICT|STALE$|SOURCE_CHANGED|REMOTE_CHANGED|EDIT_CONFLICT/.test(code)) key = "conflict"
  else if (/DATABASE_(QUERY|SYNTAX|UNKNOWN_COLUMN|UNKNOWN_TABLE)/.test(code)) key = "query"
  else if (/TRANSFER|SFTP|FILE_/.test(code)) key = "transfer"
  else if (/NOT_CONNECTED|RECONNECTING|PROTOCOL/.test(code)) key = "protocol"
  // Never render or copy arbitrary error.details, SQL, paths or driver errors.
  const reportedPhase = typeof details.phase === "string" ? details.phase : ""
  const phaseKeys: Readonly<Record<string, string>> = { queue:"queue", query:"query", metadata:"metadata", sftp:"transfer", download:"transfer", upload:"transfer", read:"transfer" }
  if (Object.hasOwn(phaseKeys, reportedPhase) && domain !== "cloud") key = phaseKeys[reportedPhase]!
  if (domain === "cloud" && code.startsWith("CLOUD_")) key = "cloud"
  const [stage, guidance] = STAGES[key]!
  return {
    code, stage: domain === "cloud" && key !== "cloud" ? `云配置 · ${stage}` : stage,
    outcome: cancelled ? "已取消" : uncertain ? "结果待核实" : timeout ? "等待超时" : "未完成",
    neutral: cancelled,
    guidance: cancelled ? "本次操作已取消。若此前已提交修改，请核实执行结果。"
      : uncertain ? "请求可能已经提交。请先读取当前结果或使用“核实结果”，不要直接重复写入。"
      : timeout && domain === "operation" ? "等待响应超时不等于远端未执行。修改操作请先核实结果；只读查询可缩小范围后重试。" : guidance,
  }
}

export function diagnosticCopy(diagnostic: Diagnostic): string {
  return `阶段：${diagnostic.stage}\n结果：${diagnostic.outcome}\n错误代码：${diagnostic.code}\n建议：${diagnostic.guidance}`
}
