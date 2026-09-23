import { auditOperationLabel, auditResult, localizeOperationalSummary, type AuditResult } from "../../lib/operation-copy.ts"

export interface AuditDisplayEntry {
  readonly auditId: string
  readonly type: string
  readonly time: string | null
  readonly updatedAt: string | null
  readonly title: string
  readonly actor: string
  readonly participants: readonly string[]
  readonly pluginName: string
  readonly target: string
  readonly category: string
  readonly result: AuditResult
  readonly errorCode: string
  readonly errorSummary: string
  readonly durationMs: number | null
  readonly phase: string
  readonly approval: string
  readonly eventCount: number
  readonly timelineTruncated: boolean
  readonly timeline: readonly AuditDisplayEntry[]
}

export const actorLabels: Readonly<Record<string, string>> = { user: "用户", agent: "Agent", system: "系统", unknown: "来源未记录" }
export const categoryLabels: Readonly<Record<string, string>> = { read: "只读操作", change: "变更操作", connection: "连接操作", configuration: "配置操作", session: "会话活动", other: "其他操作" }

export function safeDisplayText(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[已隐藏]@")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, "$1[已隐藏]")
    .replace(/(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[已隐藏]")
    .slice(0, 4096)
}

export function presentAudit(value: unknown, index = 0, nested = false): AuditDisplayEntry | null {
  if (!value || typeof value !== "object") return null
  const entry = value as Record<string, unknown>
  if (typeof entry.type !== "string") return null
  const actor = typeof entry.actor === "string" && Object.hasOwn(actorLabels, entry.actor) ? entry.actor
    : entry.source === "desktop-human" || entry.origin === "desktop-human" ? "user"
    : entry.origin === "agent" ? "agent" : "unknown"
  const participants = Array.isArray(entry.participants)
    ? entry.participants.filter((item): item is string => typeof item === "string" && Object.hasOwn(actorLabels, item)) : [actor]
  const instant = typeof entry.time === "string" && Number.isFinite(Date.parse(entry.time)) ? entry.time : null
  const projected = entry.type === "audit-operation"
  return {
    auditId: safeDisplayText(entry.auditId) || `${entry.type}:${String(entry.time)}:${index}`,
    type: entry.type, actor, participants, time: instant,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : instant,
    title: projected ? safeDisplayText(entry.title) || "操作类型未记录" : auditOperationLabel(entry.type),
    pluginName: safeDisplayText(entry.pluginNameSnapshot) || (entry.pluginInstanceId ? "插件名称未记录" : "当前环境"),
    target: projected ? safeDisplayText(entry.target) : localizeOperationalSummary(safeDisplayText(entry.description ?? entry.operationSummary)),
    category: typeof entry.category === "string" && Object.hasOwn(categoryLabels, entry.category) ? entry.category : "other",
    result: auditResult(entry), errorCode: typeof entry.errorCode === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(entry.errorCode) ? entry.errorCode : "",
    errorSummary: safeDisplayText(entry.errorSummary),
    durationMs: typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? entry.durationMs : null,
    phase: safeDisplayText(entry.phase), approval: safeDisplayText(entry.approval),
    eventCount: typeof entry.eventCount === "number" ? entry.eventCount : 1,
    timelineTruncated: entry.timelineTruncated === true,
    timeline: !nested && Array.isArray(entry.timeline) ? entry.timeline.flatMap((item, i) => {
      const event = presentAudit(item, i, true)
      return event ? [event] : []
    }) : [],
  }
}

export function durationLabel(value: number | null): string {
  if (value === null) return ""
  if (value < 1000) return `${Math.round(value)} 毫秒`
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1000)} 秒`
}

export function auditDay(time: string | null): string {
  if (!time) return "时间未记录"
  const date = new Date(time)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "今天"
  today.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "昨天"
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
}

export function auditTime(time: string | null): string {
  return time ? new Date(time).toLocaleTimeString("zh-CN", { hour12: false }) : "-"
}
