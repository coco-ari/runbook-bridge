export const CONFIRMATION_EXECUTION_CACHE_LIMIT = 100

export type ConfirmationFeedbackStatus =
  | "waiting"
  | "running"
  | "success"
  | "error"
  | "rejected"

export interface ConfirmationExecutionItem {
  readonly requestId: string
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string
}

export type ConfirmationScopeMode = "environment" | "plugin"

export interface ConfirmationMatchScope {
  readonly mode: ConfirmationScopeMode
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string | null
}

export function confirmationFilterModes(
  scopeMode: ConfirmationScopeMode,
  pluginInstanceId: string | null,
): readonly ConfirmationScopeMode[] {
  if (scopeMode === "plugin") return ["plugin"]
  return pluginInstanceId ? ["environment", "plugin"] : ["environment"]
}

export function confirmationMatchesEnvironment(
  item: Readonly<{ readonly projectId?: unknown; readonly environmentId?: unknown }>,
  projectId: string,
  environmentId: string,
): boolean {
  return item.projectId === projectId && item.environmentId === environmentId
}

export function confirmationMatchesScope(
  item: Readonly<{
    readonly projectId?: unknown
    readonly environmentId?: unknown
    readonly pluginInstanceId?: unknown
  }>,
  scope: ConfirmationMatchScope,
): boolean {
  if (!confirmationMatchesEnvironment(item, scope.projectId, scope.environmentId)) {
    return false
  }
  if (scope.mode === "environment") return true
  return typeof scope.pluginInstanceId === "string"
    && scope.pluginInstanceId.length > 0
    && item.pluginInstanceId === scope.pluginInstanceId
}

export interface ConfirmationExecutionEvent {
  readonly confirmationId: string
  readonly status: "running" | "success" | "error"
  readonly projectId?: string
  readonly environmentId?: string
  readonly pluginInstanceId?: string
  readonly durationMs?: number
  readonly errorCode?: string
}

export interface ConfirmationFeedbackModel<T extends ConfirmationExecutionItem> {
  readonly item: T
  readonly status: ConfirmationFeedbackStatus
  readonly durationMs?: number
  readonly errorCode?: string
}

type UnknownRecord = Readonly<Record<string, unknown>>

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function boundedIdentifier(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : ""
}

export function normalizeConfirmationExecution(
  value: unknown,
): ConfirmationExecutionEvent | null {
  const event = asRecord(value)
  if (event.type !== "confirmation-execution") return null
  const confirmationId = boundedIdentifier(event.confirmationId)
  const status = String(event.status)
  if (!confirmationId || !["running", "success", "error"].includes(status)) return null
  const errorCode = typeof event.errorCode === "string"
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(event.errorCode)
    ? event.errorCode
    : ""
  const durationMs = typeof event.durationMs === "number"
    && Number.isFinite(event.durationMs)
    && event.durationMs >= 0
    ? Math.min(event.durationMs, Number.MAX_SAFE_INTEGER)
    : null
  const projectId = boundedIdentifier(event.projectId)
  const environmentId = boundedIdentifier(event.environmentId)
  const pluginInstanceId = boundedIdentifier(event.pluginInstanceId)
  return {
    confirmationId,
    status: status as ConfirmationExecutionEvent["status"],
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(pluginInstanceId ? { pluginInstanceId } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function confirmationExecutionMatchesItem(
  event: ConfirmationExecutionEvent,
  item: ConfirmationExecutionItem,
): boolean {
  if (event.confirmationId !== item.requestId) return false
  if (event.projectId !== undefined && event.projectId !== item.projectId) return false
  if (event.environmentId !== undefined && event.environmentId !== item.environmentId) return false
  if (event.pluginInstanceId !== undefined
    && event.pluginInstanceId !== item.pluginInstanceId) return false
  return true
}

export function pruneConfirmationExecutions(
  cache: ReadonlyMap<string, ConfirmationExecutionEvent>,
  activeFeedbackId: string | null,
  limit = CONFIRMATION_EXECUTION_CACHE_LIMIT,
): ReadonlyMap<string, ConfirmationExecutionEvent> {
  const boundedLimit = Number.isInteger(limit) ? Math.max(0, limit) : 0
  const ids = [...cache.keys()]
  const keep = new Set(ids.slice(-boundedLimit))
  if (activeFeedbackId && cache.has(activeFeedbackId)) keep.add(activeFeedbackId)
  return new Map([...cache].filter(([id]) => keep.has(id)))
}

export function rememberConfirmationExecution(
  cache: ReadonlyMap<string, ConfirmationExecutionEvent>,
  event: ConfirmationExecutionEvent,
  activeFeedbackId: string | null,
  limit = CONFIRMATION_EXECUTION_CACHE_LIMIT,
): ReadonlyMap<string, ConfirmationExecutionEvent> {
  const next = new Map(cache)
  next.delete(event.confirmationId)
  next.set(event.confirmationId, event)
  return pruneConfirmationExecutions(next, activeFeedbackId, limit)
}

export function boundedConfirmationItems<T extends ConfirmationExecutionItem>(
  items: readonly T[],
  activeFeedbackItem: T | null,
  limit = CONFIRMATION_EXECUTION_CACHE_LIMIT,
): ReadonlyMap<string, T> {
  const boundedLimit = Number.isInteger(limit) ? Math.max(0, limit) : 0
  const next = new Map<string, T>()
  for (const item of items.slice(-boundedLimit)) next.set(item.requestId, item)
  if (activeFeedbackItem) next.set(activeFeedbackItem.requestId, activeFeedbackItem)
  return next
}

export function applyConfirmationExecution<T extends ConfirmationExecutionItem>(
  feedback: ConfirmationFeedbackModel<T> | null,
  item: T,
  event: ConfirmationExecutionEvent,
): ConfirmationFeedbackModel<T> | null {
  if (!feedback || feedback.item.requestId !== item.requestId) return feedback
  if (!confirmationExecutionMatchesItem(event, item)) return feedback
  return {
    item,
    status: event.status,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
  }
}
