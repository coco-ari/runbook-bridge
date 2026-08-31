import {
  CheckCircle,
  Hourglass,
  ShieldCheck,
  SpinnerGap,
  Warning,
  XCircle,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  getAiOpsV2,
  type IpcResult,
  type PublicError,
  type WorkspaceChange,
} from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  applyConfirmationExecution,
  boundedConfirmationItems,
  confirmationExecutionMatchesItem,
  confirmationFilterModes,
  confirmationMatchesScope,
  normalizeConfirmationExecution,
  pruneConfirmationExecutions,
  rememberConfirmationExecution,
  type ConfirmationExecutionEvent,
  type ConfirmationFeedbackModel,
  type ConfirmationMatchScope,
  type ConfirmationScopeMode,
} from "@/features/confirmations/confirmation-execution-model"
import {
  capabilityLabel as operationCapabilityLabel,
  publicErrorLabel,
  remoteTypeLabel,
  serviceActionLabel,
} from "@/lib/operation-copy"

type UnknownRecord = Record<string, unknown>
type ConfirmationFilter = "environment" | "plugin"

interface ConfirmationItem extends UnknownRecord {
  readonly requestId: string
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string
  readonly capability: string
  readonly summary: string
  readonly approvalLevel: "standard" | "strong"
  readonly riskLevel: string
  readonly expiresAt: number
  readonly createdAt?: string
  readonly presentation?: UnknownRecord
}

type ConfirmationFeedback = ConfirmationFeedbackModel<ConfirmationItem>

class FeatureApiError extends Error {
  readonly code: string

  constructor(error: PublicError) {
    super(error.message)
    this.name = "FeatureApiError"
    this.code = error.code
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new FeatureApiError(result.error)
  return result.data
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {}
}

function safeText(value: unknown, fallback = ""): string {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[已隐藏]@")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, "$1[已隐藏]")
    .replace(
      /(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)[^\s,;]+/giu,
      "$1[已隐藏]",
    )
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/giu, "[私钥内容已隐藏]")
    .slice(0, 4_000)
}

function normalizeExpiresAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const timestamp = new Date(value).getTime()
    if (Number.isFinite(timestamp)) return timestamp
  }
  return 0
}

function normalizeConfirmations(value: unknown): readonly ConfirmationItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = asRecord(entry)
    if (
      typeof item.requestId !== "string"
      || typeof item.projectId !== "string"
      || typeof item.environmentId !== "string"
      || typeof item.pluginInstanceId !== "string"
      || typeof item.capability !== "string"
    ) return []
    const expiresAt = normalizeExpiresAt(item.expiresAt)
    if (!expiresAt) return []
    return [{
      ...item,
      requestId: item.requestId,
      projectId: item.projectId,
      environmentId: item.environmentId,
      pluginInstanceId: item.pluginInstanceId,
      capability: item.capability,
      summary: safeText(item.summary, "对服务器执行一次变更操作"),
      approvalLevel: item.approvalLevel === "strong" ? "strong" : "standard",
      riskLevel: typeof item.riskLevel === "string" ? item.riskLevel : "write",
      expiresAt,
      ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
      ...(item.presentation && typeof item.presentation === "object"
        ? { presentation: asRecord(item.presentation) }
        : {}),
    } satisfies ConfirmationItem]
  })
}

function itemMatchesFilter(
  item: ConfirmationItem,
  filter: ConfirmationFilter,
  projectId: string,
  environmentId: string,
  pluginInstanceId: string | null,
): boolean {
  return confirmationMatchesScope(item, {
    mode: filter,
    projectId,
    environmentId,
    pluginInstanceId,
  })
}

function riskLabel(value: string): string {
  return {
    write: "写入",
    destructive: "破坏性变更",
    service: "服务变更",
    critical: "最高风险",
  }[value] ?? "服务器变更"
}

function capabilityLabel(item: ConfirmationItem): string {
  return operationCapabilityLabel(item.capability)
}

function itemNames(
  item: ConfirmationItem,
  current: {
    readonly projectId: string
    readonly environmentId: string
    readonly pluginInstanceId: string | null
    readonly projectName: string
    readonly environmentName: string
    readonly pluginName?: string
  },
) {
  return {
    project: safeText(item.projectNameSnapshot)
      || (item.projectId === current.projectId ? current.projectName : "项目"),
    environment: safeText(item.environmentNameSnapshot)
      || (item.projectId === current.projectId && item.environmentId === current.environmentId
        ? current.environmentName
        : "环境"),
    plugin: safeText(item.pluginNameSnapshot)
      || (
        item.projectId === current.projectId
        && item.environmentId === current.environmentId
        && item.pluginInstanceId === current.pluginInstanceId
          ? current.pluginName ?? "当前插件"
          : "插件"
      ),
  }
}

function presentationRows(item: ConfirmationItem): readonly { label: string; value: string; mono?: boolean }[] {
  const value = item.presentation ?? {}
  const kind = safeText(value.kind)
  if (kind === "shell") return [
    { label: "完整命令", value: safeText(value.command, item.summary), mono: true },
    ...(value.workingDirectory
      ? [{ label: "工作目录", value: safeText(value.workingDirectory), mono: true }]
      : []),
  ]
  if (kind === "file-transfer") return [
    { label: "本地文件", value: safeText(value.source), mono: true },
    { label: "服务器目标", value: safeText(value.destination), mono: true },
    { label: "文件大小", value: `${Number(value.bytes ?? 0).toLocaleString("zh-CN")} 字节` },
    { label: "覆盖现有文件", value: value.overwrite ? "是" : "否" },
    { label: "SHA-256", value: safeText(value.sha256), mono: true },
  ]
  if (kind === "file-write") return [
    { label: "服务器目标", value: safeText(value.destination), mono: true },
    { label: "写入大小", value: `${Number(value.bytes ?? 0).toLocaleString("zh-CN")} 字节` },
    { label: "覆盖现有文件", value: value.overwrite ? "是" : "否" },
    { label: "新内容 SHA-256", value: safeText(value.sha256), mono: true },
  ]
  if (kind === "path-move") return [
    { label: "原路径", value: safeText(value.source), mono: true },
    { label: "目标路径", value: safeText(value.destination), mono: true },
    { label: "覆盖目标", value: value.overwrite ? "是" : "否" },
  ]
  if (kind === "path-delete") return [
    { label: "删除目标", value: safeText(value.destination), mono: true },
    { label: "目标类型", value: remoteTypeLabel(value.remoteType) },
  ]
  if (kind === "service-control") return [
    { label: "systemd unit", value: safeText(value.unit), mono: true },
    { label: "动作", value: serviceActionLabel(value.action) },
  ]
  return [{ label: "操作摘要", value: safeText(item.summary, "对服务器执行一次变更操作") }]
}

function feedbackCopy(feedback: ConfirmationFeedback): [string, string] {
  if (feedback.status === "waiting") return ["已授权，等待 Agent 执行", "本次授权只匹配完全相同的操作内容。"]
  if (feedback.status === "running") return ["Agent 正在执行", "操作已开始，请等待实际结果。"]
  if (feedback.status === "success") return [
    "操作执行成功",
    Number.isFinite(feedback.durationMs)
      ? `实际执行耗时 ${Number(feedback.durationMs).toLocaleString("zh-CN")} ms`
      : "实际操作已经完成。",
  ]
  if (feedback.status === "rejected") return ["操作已拒绝", "Agent 需要重新发起请求后才能再次确认。"]
  return ["操作执行失败", publicErrorLabel(feedback.errorCode, "远程操作未完成，请检查连接与目标状态。")]
}

function errorMessage(error: unknown): string {
  return error instanceof FeatureApiError
    ? publicErrorLabel(error.code, "读取确认队列失败，请稍后重试。")
    : "读取确认队列失败，请稍后重试。"
}

export interface ConfirmationScope {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string
}

export interface ConfirmationsFeatureProps {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string | null
  readonly scopeMode?: ConfirmationScopeMode
  readonly projectName: string
  readonly environmentName: string
  readonly pluginName?: string
  readonly onLocateScope?: (scope: ConfirmationScope) => void
  readonly onOpenAudit?: (scope: ConfirmationScope, confirmationId: string) => void
}

export function ConfirmationsFeature({
  projectId,
  environmentId,
  pluginInstanceId,
  scopeMode = "environment",
  projectName,
  environmentName,
  pluginName,
  onLocateScope,
  onOpenAudit,
}: ConfirmationsFeatureProps) {
  const [items, setItems] = useState<readonly ConfirmationItem[]>([])
  const [filter, setFilter] = useState<ConfirmationFilter>(
    scopeMode === "plugin" ? "plugin" : "environment",
  )
  const [loading, setLoading] = useState(true)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set())
  const [feedback, setFeedback] = useState<ConfirmationFeedback | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const loadGenerationRef = useRef(0)
  const knownItemsRef = useRef(new Map<string, ConfirmationItem>())
  const feedbackRef = useRef<ConfirmationFeedback | null>(null)
  const executionCacheRef = useRef<ReadonlyMap<string, ConfirmationExecutionEvent>>(new Map())
  const matchScope = useMemo<ConfirmationMatchScope>(() => ({
    mode: scopeMode,
    projectId,
    environmentId,
    pluginInstanceId,
  }), [environmentId, pluginInstanceId, projectId, scopeMode])
  const matchesCurrentScope = useCallback(
    (item: ConfirmationItem) => confirmationMatchesScope(item, matchScope),
    [matchScope],
  )

  const rememberItems = useCallback((next: readonly ConfirmationItem[]) => {
    const activeFeedbackItem = feedbackRef.current?.item ?? null
    knownItemsRef.current = new Map(boundedConfirmationItems(next, activeFeedbackItem))
    executionCacheRef.current = pruneConfirmationExecutions(
      executionCacheRef.current,
      activeFeedbackItem?.requestId ?? null,
    )
    setItems(next)
    setAcknowledged((current) => new Set(
      [...current].filter((id) => next.some((item) => item.requestId === id)),
    ))
  }, [])

  const commitFeedback = useCallback((next: ConfirmationFeedback) => {
    const execution = executionCacheRef.current.get(next.item.requestId)
    const resolved = execution
      ? applyConfirmationExecution(next, next.item, execution)
      : next
    feedbackRef.current = resolved
    executionCacheRef.current = pruneConfirmationExecutions(
      executionCacheRef.current,
      resolved?.item.requestId ?? null,
    )
    setFeedback(resolved)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const value = unwrap(
        await getAiOpsV2().listConfirmations() as unknown as IpcResult<unknown>,
      )
      if (generation !== loadGenerationRef.current) return
      rememberItems(normalizeConfirmations(value).filter(matchesCurrentScope))
    } catch (caught) {
      if (generation === loadGenerationRef.current) setError(errorMessage(caught))
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [matchesCurrentScope, rememberItems])

  useEffect(() => {
    feedbackRef.current = null
    knownItemsRef.current = new Map()
    executionCacheRef.current = new Map()
    setItems([])
    setAcknowledged(new Set())
    setFeedback(null)
    setFilter(scopeMode === "plugin" ? "plugin" : "environment")
    void refresh()
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    const api = getAiOpsV2()
    const unsubscribeConfirmations = api.onConfirmations((pending) => {
      loadGenerationRef.current += 1
      rememberItems(normalizeConfirmations(pending).filter(matchesCurrentScope))
      setLoading(false)
    })
    const unsubscribeWorkspace = api.onWorkspaceChanged((change: WorkspaceChange) => {
      const event = normalizeConfirmationExecution(change)
      if (!event) return
      const activeFeedback = feedbackRef.current
      const item = knownItemsRef.current.get(event.confirmationId)
        ?? (activeFeedback?.item.requestId === event.confirmationId
          ? activeFeedback.item
          : null)
      if (!item || !confirmationExecutionMatchesItem(event, item)) return
      executionCacheRef.current = rememberConfirmationExecution(
        executionCacheRef.current,
        event,
        activeFeedback?.item.requestId ?? null,
      )
      setFeedback((current) => {
        const next = applyConfirmationExecution(current, item, event)
        feedbackRef.current = next
        return next
      })
    })
    return () => {
      window.clearInterval(timer)
      unsubscribeConfirmations()
      unsubscribeWorkspace()
      loadGenerationRef.current += 1
    }
  }, [matchesCurrentScope, refresh, rememberItems, scopeMode])

  const pending = useMemo(() => items
    .filter(matchesCurrentScope)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => {
      const order: Record<string, number> = { critical: 0, destructive: 1, service: 2, write: 3 }
      return (order[left.riskLevel] ?? 9) - (order[right.riskLevel] ?? 9)
        || new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime()
    }), [items, matchesCurrentScope, now])
  const scopedItemCount = items.filter(matchesCurrentScope).length
  const expiredCount = scopedItemCount - pending.length
  const visible = pending.filter((item) => itemMatchesFilter(
    item,
    filter,
    projectId,
    environmentId,
    pluginInstanceId,
  ))

  const filterCounts = useMemo(() => ({
    environment: pending.filter((item) => (
      item.projectId === projectId && item.environmentId === environmentId
    )).length,
    plugin: pluginInstanceId
      ? pending.filter((item) => (
        item.projectId === projectId
        && item.environmentId === environmentId
        && item.pluginInstanceId === pluginInstanceId
      )).length
      : 0,
  }), [environmentId, pending, pluginInstanceId, projectId])

  useEffect(() => {
    if (scopeMode === "plugin" && filter !== "plugin") {
      setFilter("plugin")
      return
    }
    if (scopeMode === "environment" && !pluginInstanceId && filter === "plugin") {
      setFilter("environment")
    }
  }, [filter, pluginInstanceId, scopeMode])

  async function decide(item: ConfirmationItem, decision: "approve" | "reject") {
    if (!matchesCurrentScope(item)) return
    if (busyIds.has(item.requestId) || item.expiresAt <= Date.now()) return
    if (decision === "approve" && item.approvalLevel === "strong" && !acknowledged.has(item.requestId)) return
    setBusyIds((current) => new Set(current).add(item.requestId))
    knownItemsRef.current = new Map(boundedConfirmationItems(
      [...knownItemsRef.current.values(), item],
      feedbackRef.current?.item ?? null,
    ))
    setError(null)
    try {
      if (decision === "approve") {
        unwrap(await getAiOpsV2().approveConfirmation(item.requestId))
        commitFeedback({ item, status: "waiting" })
        toast.success("已授权一次，正在等待 Agent 执行。")
      } else {
        unwrap(await getAiOpsV2().rejectConfirmation(item.requestId))
        commitFeedback({ item, status: "rejected" })
        toast.success("操作已拒绝。")
      }
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
      if (caught instanceof FeatureApiError && ["CONFIRMATION_EXPIRED", "CONFIRMATION_NOT_FOUND"].includes(caught.code)) {
        await refresh()
      }
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(item.requestId)
        return next
      })
    }
  }

  const currentNames = {
    projectId,
    environmentId,
    pluginInstanceId,
    projectName,
    environmentName,
    ...(pluginName ? { pluginName } : {}),
  }
  const filterOptions: readonly (readonly [ConfirmationFilter, string, number])[] =
    confirmationFilterModes(scopeMode, pluginInstanceId).map((value) => [
      value,
      value === "plugin" ? pluginName ?? "当前插件" : environmentName,
      filterCounts[value],
    ])

  return (
    <section
      aria-labelledby="confirmations-feature-title"
      className="flex min-h-0 flex-1 flex-col @container/confirmations"
      data-feature="confirmations"
    >
      <FeatureToolbar
        actions={(
          <Button disabled={loading} onClick={() => void refresh()} size="xs" variant="outline">
            {loading ? <SpinnerGap className="animate-spin" /> : <Hourglass />}
            刷新队列
          </Button>
        )}
        description="每次批准只绑定一组精确参数；内容、目标或环境变化后必须重新确认。"
        meta={<Badge variant={pending.length ? "warning" : "success"}>{pending.length} 项待处理</Badge>}
        title="操作确认"
        titleId="confirmations-feature-title"
      />

      {filterOptions.length > 1 ? (
        <nav aria-label="筛选待确认操作" className="mb-3 min-w-0">
          <ScrollArea className="max-w-full" orientation="horizontal" viewportClassName="pb-2">
            <ToggleGroup
              aria-label="确认范围筛选"
              className="w-max min-w-max"
              data-testid="confirmation-scope-filter"
              onValueChange={(value) => {
                if (value) setFilter(value as ConfirmationFilter)
              }}
              orientation="horizontal"
              size="sm"
              spacing={1}
              type="single"
              value={filter}
            >
              {filterOptions.map(([value, label, count]) => (
                <ToggleGroupItem className="max-w-52 gap-1.5" key={value} value={value}>
                  <span className="truncate">{label}</span>
                  <Badge className="h-4 min-w-4 justify-center px-1 font-mono text-[9px]" variant="outline">{count}</Badge>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </ScrollArea>
        </nav>
      ) : null}

      {error && (
        <Alert className="mx-3 mt-3" variant="destructive">
          <Warning weight="fill" />
          <AlertTitle>确认队列不可用</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {expiredCount > 0 && (
        <Alert className="mx-3 mt-3 bg-surface-inset" role="status">
          <Hourglass />
          <AlertTitle>{expiredCount} 项请求已经过期</AlertTitle>
          <AlertDescription>过期请求不能再批准或拒绝。</AlertDescription>
        </Alert>
      )}

      {feedback && (
        <Alert
          aria-live="polite"
          className="mx-3 mt-3 bg-surface-inset"
          variant={feedback.status === "error" || feedback.status === "rejected" ? "destructive" : "default"}
        >
          {feedback.status === "success" ? (
            <CheckCircle className="text-success" weight="fill" />
          ) : feedback.status === "error" || feedback.status === "rejected" ? (
            <XCircle weight="fill" />
          ) : feedback.status === "running" ? (
            <SpinnerGap className="animate-spin text-info" />
          ) : (
            <ShieldCheck className="text-warning" weight="fill" />
          )}
          <AlertTitle>{feedbackCopy(feedback)[0]}</AlertTitle>
          <AlertDescription>
            <p>{feedbackCopy(feedback)[1]}</p>
            {onOpenAudit && (
              <Button
                className="mt-2"
                onClick={() => onOpenAudit({
                  projectId: feedback.item.projectId,
                  environmentId: feedback.item.environmentId,
                  pluginInstanceId: feedback.item.pluginInstanceId,
                }, feedback.item.requestId)}
                size="xs"
                variant="outline"
              >
                查看操作记录
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {loading && items.length === 0 ? (
          <div className="space-y-3 p-4" aria-label="正在读取确认队列">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : visible.length === 0 ? (
          <Empty className="min-h-56 px-6">
            <EmptyHeader>
              <EmptyMedia className="bg-primary/10 text-primary" variant="icon">
                <ShieldCheck weight="duotone" />
              </EmptyMedia>
              <EmptyTitle>
              {pending.length ? "当前筛选没有待确认操作" : "当前没有待确认操作"}
              </EmptyTitle>
              <EmptyDescription>
                {pending.length
                  ? scopeMode === "plugin"
                    ? "当前插件没有符合条件的待确认操作。"
                    : "切换当前插件筛选以查看该环境中的其他请求。"
                  : "Agent 发起服务器变更后会显示在这里，不会自动执行。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-3 p-3">
            {visible.map((item) => {
              const names = itemNames(item, currentNames)
              const strong = item.approvalLevel === "strong"
              const busy = busyIds.has(item.requestId)
              const remaining = Math.max(0, Math.ceil((item.expiresAt - now) / 1_000))
              const acknowledgedStrong = acknowledged.has(item.requestId)
              return (
                <article data-confirmation-id={item.requestId} key={item.requestId}>
                  <Card className={strong ? "gap-0 py-0 ring-danger/30" : "gap-0 py-0"} size="sm">
                    <CardHeader className="px-3 py-3">
                      <header className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] text-muted-foreground">
                            Agent 请求 / {names.project} / {names.environment}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold">{capabilityLabel(item)}</h3>
                            <Badge variant={strong ? "danger" : "warning"}>{riskLabel(item.riskLevel)}</Badge>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground" title={names.plugin}>目标插件：{names.plugin}</p>
                        </div>
                        {onLocateScope && (
                          <Button
                            onClick={() => onLocateScope({
                              projectId: item.projectId,
                              environmentId: item.environmentId,
                              pluginInstanceId: item.pluginInstanceId,
                            })}
                            size="xs"
                            variant="outline"
                          >
                            定位插件
                          </Button>
                        )}
                      </header>
                    </CardHeader>

                    <CardContent className="space-y-3 px-3 pb-3">
                      <ItemGroup
                        aria-label={capabilityLabel(item) + "操作参数"}
                        className="gap-1.5 @md/confirmations:hidden"
                      >
                        {presentationRows(item).map((row, index) => (
                          <Item
                            className="min-w-0 bg-surface-inset px-2.5 py-2 ring-1 ring-inset ring-border/55"
                            key={`${row.label}:${index}`}
                            role="listitem"
                            size="xs"
                            variant="muted"
                          >
                            <ItemContent>
                              <ItemDescription className="text-[10px] font-medium">{row.label}</ItemDescription>
                              <ItemTitle className={`line-clamp-none w-full break-words text-xs ${row.mono ? "font-mono" : ""}`}>
                                {row.value}
                              </ItemTitle>
                            </ItemContent>
                          </Item>
                        ))}
                      </ItemGroup>
                      <div className="hidden @md/confirmations:block">
                        <Table aria-label={capabilityLabel(item) + "操作参数"}>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="h-8 w-36 text-[10px]">参数</TableHead>
                              <TableHead className="h-8 text-[10px]">确认值</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {presentationRows(item).map((row, index) => (
                              <TableRow key={`${row.label}:${index}`}>
                                <TableCell className="py-2 text-xs text-muted-foreground whitespace-normal">
                                  {row.label}
                                </TableCell>
                                <TableCell className={`break-words py-2 text-xs whitespace-normal ${row.mono ? "font-mono" : ""}`}>
                                  {row.value}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      {strong && (
                        <Alert className="p-3" variant="destructive">
                          <Warning weight="fill" />
                          <AlertTitle>这是任意 Shell 命令</AlertTitle>
                          <AlertDescription>
                            <p>命令可能修改或删除数据、停止服务，必须完整核对后才能授权。</p>
                            <Field className="mt-3" orientation="horizontal">
                              <Checkbox
                                checked={acknowledgedStrong}
                                disabled={busy}
                                id={`confirmation-ack-${item.requestId}`}
                                onCheckedChange={(checked) => setAcknowledged((current) => {
                                  const next = new Set(current)
                                  if (checked === true) next.add(item.requestId)
                                  else next.delete(item.requestId)
                                  return next
                                })}
                              />
                              <FieldLabel className="text-foreground" htmlFor={`confirmation-ack-${item.requestId}`}>
                                我已核对完整命令、工作目录和目标环境
                              </FieldLabel>
                            </Field>
                          </AlertDescription>
                        </Alert>
                      )}
                    </CardContent>

                    <CardFooter className="flex-wrap justify-between gap-3 px-3 py-2.5">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        只授权本次操作 / {remaining} 秒后过期
                      </span>
                      <ButtonGroup
                        aria-label={capabilityLabel(item) + "确认操作"}
                        className="w-full @sm/confirmations:w-auto"
                      >
                        <Button className="flex-1 @sm/confirmations:flex-none" disabled={busy} onClick={() => void decide(item, "reject")} size="xs" variant="outline">
                          拒绝
                        </Button>
                        <Button
                          className="flex-1 @sm/confirmations:flex-none"
                          disabled={busy || (strong && !acknowledgedStrong)}
                          onClick={() => void decide(item, "approve")}
                          size="xs"
                          variant={strong ? "destructive" : "default"}
                        >
                          {busy ? <SpinnerGap className="animate-spin" /> : <ShieldCheck />}
                          {strong ? "确认执行一次" : "确认一次"}
                        </Button>
                      </ButtonGroup>
                    </CardFooter>
                  </Card>
                </article>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}
