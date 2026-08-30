import type { QuickQuestionRecord } from "@/bridge/ai-ops-v2"

export const QUICK_QUESTION_OPENING_MAX_CHARACTERS = 500
export const QUICK_QUESTION_MAX_CHARACTERS = 1_200
export const QUICK_QUESTION_COLLECTION_LIMIT = 8

export interface QuickQuestionOpeningState {
  readonly text: string
  readonly defaultText: string
  readonly revision: number
}

export interface QuickQuestionCollection {
  readonly items: readonly QuickQuestionRecord[]
  readonly revision: number
}

export interface QuickQuestionPreviewInput {
  readonly opening: QuickQuestionOpeningState | null
  readonly projectName: string
  readonly environmentName: string
  readonly question: string
  readonly discoveredDate?: string
}

type UnknownRecord = Readonly<Record<string, unknown>>

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function boundedText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : ""
  return Array.from(text).slice(0, limit).join("")
}

export function quickQuestionHasStrictCredential(text: string): boolean {
  const value = String(text ?? "")
  return [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/iu,
    /\bAuthorization\b["']?\s*[:=：]?\s*["']?(?:Bearer|Basic)\s+[^\s,;"']+/iu,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]{8,}/iu,
    /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/iu,
    /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16})\b/iu,
    /\beyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/iu,
  ].some((pattern) => pattern.test(value))
}

export function redactQuickQuestionPreview(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/giu,
      "[私钥内容已隐藏]",
    )
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/giu, "[私钥内容已隐藏]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[已脱敏]@")
    .replace(
      /(\bAuthorization\b["']?\s*[:=：]?\s*["']?(?:Bearer|Basic)\s+)[^\s,;"']+/giu,
      "$1[已脱敏]",
    )
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, "$1[已脱敏]")
    .replace(
      /(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/giu,
      "$1[已脱敏]",
    )
    .replace(
      /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16})\b/giu,
      "[已脱敏]",
    )
    .replace(/\beyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/giu, "[已脱敏]")
}

export function quickQuestionOpeningIssue(value: string): string | null {
  const text = String(value ?? "").normalize("NFKC").trim()
  if (!text) return "开场词不能为空。"
  if (Array.from(text).length > QUICK_QUESTION_OPENING_MAX_CHARACTERS) {
    return "开场词不能超过 500 个字符。"
  }
  if (quickQuestionHasStrictCredential(text)) {
    return "开场词不能包含密码、密钥或其他明确凭据。"
  }
  if (!/\bAI(?:\s*-\s*|\s+)Ops\s+MCP\b/iu.test(text)) {
    return "开场词必须明确包含“AI Ops MCP”。"
  }
  return null
}

export function quickQuestionIssue(value: string): string | null {
  const text = String(value ?? "").normalize("NFKC").trim()
  if (!text) return "问题正文不能为空。"
  if (Array.from(text).length > QUICK_QUESTION_MAX_CHARACTERS) {
    return "问题正文不能超过 1200 个字符。"
  }
  if (quickQuestionHasStrictCredential(text)) {
    return "常见问题不能包含密码、密钥或其他明确凭据。"
  }
  return null
}

export function normalizeQuickQuestionOpening(value: unknown): QuickQuestionOpeningState {
  const record = asRecord(value)
  const text = typeof record.text === "string"
    ? record.text.normalize("NFKC").trim()
    : ""
  const defaultText = typeof record.defaultText === "string"
    ? record.defaultText.normalize("NFKC").trim()
    : text
  const issue = quickQuestionOpeningIssue(text)
  if (issue) throw new TypeError(issue)
  if (quickQuestionOpeningIssue(defaultText)) throw new TypeError("默认开场词无效。")
  const revision = Number.isInteger(record.revision) && Number(record.revision) >= 0
    ? Number(record.revision)
    : 0
  return { text, defaultText, revision }
}

export function normalizeQuickQuestionCollection(value: unknown): QuickQuestionCollection {
  const record = asRecord(value)
  const source = Array.isArray(record.items) ? record.items : []
  const items = source.flatMap((entry) => {
    const item = asRecord(entry)
    const questionId = boundedText(item.questionId, 200)
    const createdAt = boundedText(item.createdAt, 100)
    const updatedAt = boundedText(item.updatedAt, 100)
    const sourceText = typeof item.text === "string"
      ? item.text.normalize("NFKC").trim()
      : ""
    if (!questionId || !sourceText || !createdAt || !updatedAt) return []
    const safeText = quickQuestionHasStrictCredential(sourceText)
      ? redactQuickQuestionPreview(sourceText)
      : sourceText
    const text = Array.from(safeText).slice(0, QUICK_QUESTION_MAX_CHARACTERS).join("")
    if (!text) return []
    return [{
      questionId,
      text,
      createdAt,
      updatedAt,
    } satisfies QuickQuestionRecord]
  }).slice(0, QUICK_QUESTION_COLLECTION_LIMIT)
  const revision = Number.isInteger(record.revision) && Number(record.revision) >= 0
    ? Number(record.revision)
    : 0
  return { items, revision }
}

export function formatQuickQuestionUpdatedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "已保存"
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)}更新`
}

export function formatQuickQuestionDiscoveredDate(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? "").trim())
  if (!match) return ""
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year < 1_000
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return ""
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)
}

export function buildQuickQuestionPreview({
  opening,
  projectName,
  environmentName,
  question,
  discoveredDate,
}: QuickQuestionPreviewInput): string {
  if (!opening) return "正在加载开场词..."
  const formattedDate = formatQuickQuestionDiscoveredDate(discoveredDate)
  const normalizedQuestion = boundedText(
    redactQuickQuestionPreview(question),
    QUICK_QUESTION_MAX_CHARACTERS,
  ) || "（请先输入问题）"
  return [
    boundedText(redactQuickQuestionPreview(opening.text), QUICK_QUESTION_OPENING_MAX_CHARACTERS),
    "",
    "【当前范围】",
    `项目：${boundedText(redactQuickQuestionPreview(projectName), 200)}`,
    `环境：${boundedText(redactQuickQuestionPreview(environmentName), 200)}`,
    ...(formattedDate ? [`问题发现时间：${formattedDate}`] : []),
    "",
    "【问题】",
    normalizedQuestion,
  ].join("\n")
}
