import {
  ArrowClockwise,
  ClockCounterClockwise,
  MagnifyingGlass,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

import {
  getAiOpsV2,
  type IpcResult,
  type PublicError,
} from "@/bridge/ai-ops-v2"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AuditRequestCoordinator } from "@/features/audit/audit-request-model"
import {
  auditOperationLabel,
  localizeOperationalSummary,
  publicErrorLabel,
} from "@/lib/operation-copy"

type UnknownRecord = Record<string, unknown>
type AuditResult = "success" | "pending" | "warning" | "cancelled" | "blocked" | "error"
type AuditResultFilter = "all" | AuditResult

interface AuditEntry extends UnknownRecord {
  readonly auditId?: string
  readonly type: string
  readonly result?: string
  readonly time?: string
  readonly environmentId?: string
  readonly pluginInstanceId?: string
}

interface AuditPage {
  readonly entries: readonly AuditEntry[]
  readonly nextCursor: string | null
}

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

function normalizeAuditPage(value: unknown): AuditPage {
  const record = asRecord(value)
  const entries = (Array.isArray(record.entries) ? record.entries : []).flatMap((entry) => {
    const item = asRecord(entry)
    if (typeof item.type !== "string" || !item.type) return []
    return [{ ...item, type: item.type } satisfies AuditEntry]
  })
  return {
    entries,
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
  }
}

export function auditScopeKey(
  projectId: string,
  environmentId: string,
  pluginInstanceId: string | null,
): string {
  return JSON.stringify([projectId, environmentId, pluginInstanceId])
}

function redactOperationalText(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value)
    : ""
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[已隐藏]@")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, "$1[已隐藏]")
    .replace(
      /(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)[^\s,;]+/giu,
      "$1[已隐藏]",
    )
    .slice(0, 2_000)
}

function auditResult(entry: AuditEntry): AuditResult {
  const value = String(entry.result ?? (entry.errorCode ? "error" : "success")).toLowerCase()
  if (["success", "connected", "disconnected", "complete", "completed", "already-satisfied"].includes(value)) return "success"
  if (["pending-confirmation", "started", "running", "connecting"].includes(value)) return "pending"
  if (["cancelled", "canceled"].includes(value)) return "cancelled"
  if (["partial", "warning", "needs-action", "stopped"].includes(value)) return "warning"
  if (["blocked", "denied"].includes(value)) return "blocked"
  return "error"
}

function operationName(entry: AuditEntry): string {
  return auditOperationLabel(entry.type)
}

function actorName(entry: AuditEntry): string {
  if (entry.actor === "agent" || ["plugin-operation", "policy-denied", "mysql-query"].includes(entry.type)) return "Agent"
  if (entry.actor === "system" || entry.type === "auto-reconnect" || entry.result === "connection-lost") return "系统"
  return "用户"
}

function auditPluginName(entry: AuditEntry, fallback: string): string {
  if (!entry.pluginInstanceId) return fallback
  return redactOperationalText(entry.pluginNameSnapshot) || "已删除的插件"
}

function description(entry: AuditEntry): string {
  const operationalCopy = entry.description
    ?? entry.operationSummary
    ?? entry.summary
    ?? entry.message
  if (operationalCopy !== undefined && operationalCopy !== null) {
    const text = redactOperationalText(operationalCopy)
    if (/^[A-Z][A-Z0-9_]{1,127}$/u.test(text)) {
      return publicErrorLabel(text, "操作状态已记录。")
    }
    return localizeOperationalSummary(text)
  }
  if (entry.errorCode) return publicErrorLabel(entry.errorCode, "操作未完成。")
  return "操作状态已记录。"
}

function resultLabel(result: AuditResult): string {
  return {
    success: "成功",
    pending: "等待确认",
    warning: "部分成功",
    cancelled: "已取消",
    blocked: "已拦截",
    error: "失败",
  }[result]
}

function resultVariant(result: AuditResult): "success" | "warning" | "danger" | "info" | "outline" {
  if (result === "success") return "success"
  if (result === "pending") return "info"
  if (result === "warning" || result === "cancelled") return "warning"
  if (result === "blocked" || result === "error") return "danger"
  return "outline"
}

function validInstant(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const instant = new Date(value)
  return Number.isNaN(instant.getTime()) ? null : instant
}

function dateLabel(instant: Date): string {
  const today = new Date()
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const startDate = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate())
  const days = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000)
  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  return instant.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
}

function errorMessage(error: unknown, fallback = "读取操作记录失败，请稍后重试。"): string {
  return error instanceof FeatureApiError
    ? publicErrorLabel(error.code, fallback)
    : fallback
}

export interface AuditFeatureProps {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string | null
  readonly projectName?: string
  readonly environmentName: string
  readonly pluginName?: string
}

export function AuditFeature({
  projectId,
  environmentId,
  pluginInstanceId,
  projectName = "当前项目",
  environmentName,
  pluginName,
}: AuditFeatureProps) {
  const [entries, setEntries] = useState<readonly AuditEntry[]>([])
  const [query, setQuery] = useState("")
  const [resultFilter, setResultFilter] = useState<AuditResultFilter>("all")
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const clearInFlightRef = useRef(false)
  const clearDialogRef = useRef<HTMLDivElement | null>(null)
  const [clearDialog, setClearDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("zh-CN"))
  const requestCoordinatorRef = useRef(new AuditRequestCoordinator<AuditPage>())

  const scopeKey = auditScopeKey(projectId, environmentId, pluginInstanceId)

  const loadAudit = useCallback((): Promise<AuditPage> => {
    const requestedKey = auditScopeKey(projectId, environmentId, pluginInstanceId)
    const coordinator = requestCoordinatorRef.current
    const { lease, started } = coordinator.start(requestedKey, async () => {
      const value = unwrap(
        await getAiOpsV2().listAudit({
          projectId,
          environmentId,
          ...(pluginInstanceId ? { pluginInstanceId } : {}),
          limit: 200,
        }) as unknown as IpcResult<unknown>,
      )
      return normalizeAuditPage(value)
    })
    if (!started) return lease.promise
    setLoading(true)
    setError(null)
    return lease.promise
      .then((page) => {
        if (coordinator.isCurrent(lease.ticket)) setEntries(page.entries)
        return page
      })
      .catch((caught) => {
        if (coordinator.isCurrent(lease.ticket)) setError(errorMessage(caught))
        throw caught
      })
      .finally(() => {
        if (coordinator.isCurrent(lease.ticket)) setLoading(false)
      })
  }, [environmentId, pluginInstanceId, projectId])

  useEffect(() => {
    const coordinator = requestCoordinatorRef.current
    coordinator.activateScope(scopeKey)
    setEntries([])
    setQuery("")
    setResultFilter("all")
    setError(null)
    void loadAudit().catch(() => undefined)
    return () => {
      coordinator.deactivateScope(scopeKey)
    }
  }, [loadAudit, scopeKey])

  const visibleEntries = useMemo(() => entries.filter((entry) => {
    const result = auditResult(entry)
    if (resultFilter !== "all" && result !== resultFilter) return false
    if (!deferredQuery) return true
    const haystack = [
      operationName(entry),
      auditPluginName(entry, environmentName),
      description(entry),
      actorName(entry),
    ].join(" ").toLocaleLowerCase("zh-CN")
    return haystack.includes(deferredQuery)
  }), [deferredQuery, entries, environmentName, resultFilter])
  const displayEntries = useMemo(() => visibleEntries.map((entry, index) => {
    const instant = validInstant(entry.time)
    const previous = index > 0 ? visibleEntries[index - 1] : undefined
    const previousInstant = validInstant(previous?.time)
    const day = instant ? dateLabel(instant) : "时间未知"
    return {
      entry,
      key: entry.auditId ?? `${String(entry.time ?? "unknown")}:${entry.type}:${index}`,
      instant,
      day,
      showDate: !previousInstant || !instant || dateLabel(previousInstant) !== day,
      result: auditResult(entry),
      operation: operationName(entry),
      target: auditPluginName(entry, environmentName),
      actor: actorName(entry),
      detail: description(entry),
    }
  }), [environmentName, visibleEntries])

  async function clearAudit() {
    if (clearInFlightRef.current) return
    focusWorkspaceElement(clearDialogRef.current)
    clearInFlightRef.current = true
    const requestedKey = scopeKey
    setClearing(true)
    setError(null)
    try {
      const coordinator = requestCoordinatorRef.current
      const pending = coordinator.invalidateScope(requestedKey)
      if (pending) await pending.catch(() => undefined)
      unwrap(await getAiOpsV2().clearAudit({
        projectId,
        environmentId,
        pluginInstanceId,
      }))
      if (!coordinator.isScopeActive(requestedKey)) return
      setEntries([])
      setClearDialog(false)
      await loadAudit()
      toast.success(pluginInstanceId ? "当前插件记录已清除。" : "当前环境记录已清除。")
    } catch (caught) {
      if (requestCoordinatorRef.current.isScopeActive(requestedKey)) {
        setError(errorMessage(caught, "清除操作记录失败，请稍后重试。"))
      }
    } finally {
      clearInFlightRef.current = false
      if (requestCoordinatorRef.current.isScopeActive(requestedKey)) setClearing(false)
    }
  }

  return (
    <section
      aria-labelledby="audit-feature-title"
      className="flex min-h-0 flex-1 flex-col @container/audit"
      data-feature="audit"
      data-scope-key={scopeKey}
    >
      <FeatureToolbar
        actions={(
          <ButtonGroup aria-label="操作记录管理">
            <Button
              aria-label="刷新操作记录"
              data-testid="audit-refresh-trigger"
              disabled={loading || clearing}
              onClick={() => void loadAudit().catch(() => undefined)}
              size="icon-xs"
              variant="outline"
            >
              <ArrowClockwise className={loading ? "animate-spin" : ""} />
            </Button>
            <Button
              disabled={entries.length === 0 || clearing}
              data-testid="audit-clear-trigger"
              onClick={() => { setError(null); setClearDialog(true) }}
              size="xs"
              variant="outline"
            >
              <Trash />
              {pluginInstanceId ? "清除插件记录" : "清除环境记录"}
            </Button>
          </ButtonGroup>
        )}
        description="记录保存在本机；清除不会改变插件配置、连接状态或待确认操作。"
        title={`${projectName} / ${pluginInstanceId ? pluginName ?? "当前插件" : environmentName} 操作记录`}
        titleId="audit-feature-title"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-52 flex-1">
          <InputGroupAddon><MagnifyingGlass aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput
            aria-label="搜索操作记录"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索操作、对象或结果"
            type="search"
            value={query}
          />
        </InputGroup>
        <Select value={resultFilter} onValueChange={(value) => setResultFilter(value as AuditResultFilter)}>
          <SelectTrigger aria-label="筛选操作结果" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部结果</SelectItem>
            <SelectItem value="success">成功</SelectItem>
            <SelectItem value="pending">等待确认</SelectItem>
            <SelectItem value="warning">部分成功</SelectItem>
            <SelectItem value="cancelled">已取消</SelectItem>
            <SelectItem value="blocked">已拦截</SelectItem>
            <SelectItem value="error">失败</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert className="mb-3 w-auto" variant="destructive">
          <WarningCircle aria-hidden="true" weight="fill" />
          <AlertTitle>操作记录读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {loading && entries.length === 0 ? (
          <div className="space-y-2 p-4" aria-label="正在读取操作记录">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : visibleEntries.length === 0 ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ClockCounterClockwise aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>没有符合条件的操作记录</EmptyTitle>
              <EmptyDescription>调整搜索或结果筛选后重试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ItemGroup aria-label="操作记录" className="gap-1.5 p-2 @lg/audit:hidden" data-audit-layout="compact">
              {displayEntries.map((row) => (
                <Item className="min-w-0 items-start" key={row.key} role="listitem" size="xs" variant="muted">
                  <ItemContent>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                      <span>{row.day}</span>
                      <span className="font-mono">
                        {row.instant ? row.instant.toLocaleTimeString("zh-CN", { hour12: false }) : "-"}
                      </span>
                      <span>{row.actor}</span>
                    </div>
                    <ItemTitle className="line-clamp-none w-full break-words text-xs">
                      {row.operation} / {row.target}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none break-words text-[11px] leading-4">
                      {row.detail}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="ml-auto self-start">
                    <Badge variant={resultVariant(row.result)}>{resultLabel(row.result)}</Badge>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>

            <div className="hidden @lg/audit:block" data-audit-layout="table">
              <Table aria-label="操作记录" className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">时间</TableHead>
                    <TableHead className="w-20">来源</TableHead>
                    <TableHead>操作</TableHead>
                    <TableHead className="w-24 text-right">结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayEntries.map((row) => [
                    row.showDate && (
                      <TableRow className="bg-surface-inset hover:bg-surface-inset" key={`${row.key}:date`}>
                        <TableCell className="h-7 py-1 text-xs font-medium text-muted-foreground" colSpan={4}>
                          {row.day}
                        </TableCell>
                      </TableRow>
                    ),
                    <TableRow key={row.key}>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {row.instant ? row.instant.toLocaleTimeString("zh-CN", { hour12: false }) : "-"}
                      </TableCell>
                      <TableCell className="text-xs">{row.actor}</TableCell>
                      <TableCell className="min-w-0 whitespace-normal py-2">
                        <div className="truncate text-xs font-medium">
                          {row.operation} / {row.target}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                          {row.detail}
                        </p>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={resultVariant(row.result)}>{resultLabel(row.result)}</Badge>
                      </TableCell>
                    </TableRow>,
                  ])}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </ScrollArea>

      <AlertDialog open={clearDialog} onOpenChange={(open) => { if (!clearing) setClearDialog(open) }}>
        <AlertDialogContent
          ref={clearDialogRef}
          aria-busy={clearing || undefined}
          data-testid="audit-clear-confirmation"
          onEscapeKeyDown={(event) => { if (clearing) event.preventDefault() }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const trigger = document.querySelector<HTMLElement>('[data-testid="audit-clear-trigger"]')
              if (focusWorkspaceElement(trigger)) return
              if (focusWorkspaceElement(document.querySelector<HTMLElement>('[data-testid="audit-refresh-trigger"]'))) return
              focusWorkspaceElement(document.getElementById("detail-main"))
            }))
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-danger"><Trash /></AlertDialogMedia>
            <AlertDialogTitle>清除操作记录</AlertDialogTitle>
            <AlertDialogDescription>
              这会永久删除当前{pluginInstanceId ? "插件" : "环境"}保存在本机的操作记录，不影响配置、连接状态或待确认操作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <WarningCircle aria-hidden="true" />
              <AlertTitle>记录尚未清除</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={clearing}
              onClick={(event) => {
                event.preventDefault()
                void clearAudit()
              }}
              variant="destructive"
            >
              {clearing ? "清除中" : "确认清除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
