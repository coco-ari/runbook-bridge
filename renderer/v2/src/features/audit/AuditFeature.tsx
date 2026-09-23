import { ArrowClockwise, ClockCounterClockwise, MagnifyingGlass, Trash, WarningCircle } from "@phosphor-icons/react"
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import { getAiOpsV2, type IpcResult, type PublicError } from "@/bridge/ai-ops-v2"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ButtonGroup } from "@/components/ui/button-group"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { AuditRequestCoordinator } from "./audit-request-model"
import { AuditOperationList } from "./AuditOperationList"
import { actorLabels, categoryLabels, presentAudit, type AuditDisplayEntry } from "./audit-display"
import { auditResultLabel, publicErrorLabel, type AuditResult } from "@/lib/operation-copy"

interface AuditPage {
  readonly entries: readonly AuditDisplayEntry[]
  readonly nextCursor: string | null
  readonly scanning: boolean
}

class FeatureApiError extends Error {
  readonly code: string
  constructor(error: PublicError) { super(error.message); this.name = "FeatureApiError"; this.code = error.code }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new FeatureApiError(result.error)
  return result.data
}

function normalizeAuditPage(value: unknown): AuditPage {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const source = Array.isArray(record.entries) ? record.entries : []
  return {
    entries: source.flatMap((entry, index) => { const row = presentAudit(entry, index); return row ? [row] : [] }),
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
    scanning: record.scanning === true,
  }
}

export function auditScopeKey(projectId: string, environmentId: string, pluginInstanceId: string | null): string {
  return JSON.stringify([projectId, environmentId, pluginInstanceId])
}

function errorMessage(error: unknown, fallback = "读取操作记录失败，请稍后重试。"): string {
  return error instanceof FeatureApiError ? publicErrorLabel(error.code, fallback) : fallback
}

export interface AuditFeatureProps {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string | null
  readonly projectName?: string
  readonly environmentName: string
  readonly pluginName?: string
}

const results: readonly AuditResult[] = ["success", "running", "pending", "approved", "rejected", "error", "blocked", "warning", "cancelled", "interrupted", "paused", "stopped", "expired", "invalidated", "unknown"]

export function AuditFeature({ projectId, environmentId, pluginInstanceId, projectName = "当前项目", environmentName, pluginName }: AuditFeatureProps) {
  const [entries, setEntries] = useState<readonly AuditDisplayEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [resultFilter, setResultFilter] = useState("all")
  const [actorFilter, setActorFilter] = useState("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [includeRedisScans, setIncludeRedisScans] = useState(false)
  const [range, setRange] = useState("all")
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [hasUpdates, setHasUpdates] = useState(false)
  const clearInFlightRef = useRef(false)
  const clearDialogRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [clearDialog, setClearDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(search.trim())
  const requestCoordinatorRef = useRef(new AuditRequestCoordinator<AuditPage>())
  const scopeKey = auditScopeKey(projectId, environmentId, pluginInstanceId)
  const from = useMemo(() => range === "all" ? "" : new Date(Date.now() - Number(range) * 86400000).toISOString(), [range])
  const requestedKey = JSON.stringify([scopeKey, deferredQuery, resultFilter, actorFilter, categoryFilter, from, includeRedisScans])

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setQuery(""); setSearch(""); setResultFilter("all"); setActorFilter("all"); setCategoryFilter("all"); setRange("all"); setIncludeRedisScans(false); setClearDialog(false)
  }, [scopeKey])

  const loadAudit = useCallback((cursor: string | null = null, quiet = false): Promise<AuditPage> => {
    const coordinator = requestCoordinatorRef.current
    const { lease, started } = coordinator.start(requestedKey, async () => normalizeAuditPage(unwrap(await getAiOpsV2().listAudit({
      projectId, environmentId, ...(pluginInstanceId ? { pluginInstanceId } : {}),
      view: "operations", includeRedisScans, limit: 50, query: deferredQuery, result: resultFilter, actor: actorFilter, category: categoryFilter,
      ...(from ? { from } : {}), ...(cursor ? { cursor } : {}),
    }) as IpcResult<unknown>)))
    if (!started) return lease.promise
    if (!quiet) setLoading(true)
    setError(null)
    return lease.promise.then((page) => {
      if (coordinator.isCurrent(lease.ticket)) {
        setEntries(previous => cursor
          ? [...previous, ...page.entries.filter(entry => !previous.some(item => item.auditId === entry.auditId))]
          : page.entries)
        setNextCursor(page.nextCursor)
        setScanning(page.scanning)
        if (!cursor) setHasUpdates(false)
      }
      return page
    }).catch((caught) => {
      if (coordinator.isCurrent(lease.ticket)) setError(errorMessage(caught))
      throw caught
    }).finally(() => {
      if (coordinator.isCurrent(lease.ticket)) setLoading(false)
    })
  }, [requestedKey, projectId, environmentId, pluginInstanceId, deferredQuery, resultFilter, actorFilter, categoryFilter, from, includeRedisScans])

  useEffect(() => {
    const coordinator = requestCoordinatorRef.current
    coordinator.activateScope(requestedKey)
    setEntries([]); setNextCursor(null); setError(null); setHasUpdates(false)
    void loadAudit().catch(() => undefined)
    return () => { coordinator.deactivateScope(requestedKey) }
  }, [requestedKey, loadAudit])

  useEffect(() => {
    let timer: number | undefined
    const unsubscribe = getAiOpsV2().onWorkspaceChanged(change => {
      if (!["audit-appended", "audit-cleared"].includes(change.type) || change.projectId !== projectId
        || (change.environmentId && change.environmentId !== environmentId)
        || (pluginInstanceId && change.pluginInstanceId && change.pluginInstanceId !== pluginInstanceId)
        || clearInFlightRef.current) return
      setHasUpdates(true)
      window.clearTimeout(timer)
      if (change.type === "audit-cleared") { void loadAudit().catch(() => undefined); return }
      timer = window.setTimeout(() => {
        const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]")
        if ((viewport?.scrollTop ?? 0) < 20 && entries.length <= 50 && !clearInFlightRef.current) void loadAudit(null, true).catch(() => undefined)
      }, 600)
    })
    return () => { unsubscribe(); window.clearTimeout(timer) }
  }, [projectId, environmentId, pluginInstanceId, entries.length, loadAudit])

  // 旧版桥接返回原始事件时仍提供本地筛选；正式查询由后端筛选全部历史。
  const visibleEntries = useMemo(() => entries.filter(entry => {
    if (entry.type === "audit-operation") return true
    if (resultFilter !== "all" && entry.result !== resultFilter) return false
    if (actorFilter !== "all" && !entry.participants.includes(actorFilter)) return false
    if (categoryFilter !== "all" && entry.category !== categoryFilter) return false
    return !deferredQuery || [entry.title, entry.target, entry.pluginName, actorLabels[entry.actor], auditResultLabel(entry.result)]
      .join(" ").toLocaleLowerCase("zh-CN").includes(deferredQuery.toLocaleLowerCase("zh-CN"))
  }), [entries, resultFilter, actorFilter, categoryFilter, deferredQuery])

  function refreshAudit() {
    scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]")?.scrollTo({ top: 0 })
    void loadAudit().catch(() => undefined)
  }

  async function clearAudit() {
    if (clearInFlightRef.current) return
    focusWorkspaceElement(clearDialogRef.current)
    clearInFlightRef.current = true
    setClearing(true); setError(null)
    try {
      const coordinator = requestCoordinatorRef.current
      const pending = coordinator.invalidateScope(requestedKey)
      if (pending) await pending.catch(() => undefined)
      unwrap(await getAiOpsV2().clearAudit({ projectId, environmentId, pluginInstanceId }))
      if (!coordinator.isScopeActive(requestedKey)) return
      setEntries([]); setNextCursor(null); setClearDialog(false)
      await loadAudit()
      toast.success(pluginInstanceId ? "当前插件记录已清除。" : "当前环境记录已清除。")
    } catch (caught) {
      if (requestCoordinatorRef.current.isScopeActive(requestedKey)) setError(errorMessage(caught, "清除操作记录失败，请稍后重试。"))
    } finally {
      clearInFlightRef.current = false
      setClearing(false)
    }
  }

  return (
    <section aria-labelledby="audit-feature-title" className="flex min-h-0 flex-1 flex-col @container/audit" data-feature="audit" data-scope-key={scopeKey}>
      <FeatureToolbar
        actions={<ButtonGroup aria-label="操作记录管理">
          <Button aria-label="刷新操作记录" data-testid="audit-refresh-trigger" disabled={loading || clearing} onClick={refreshAudit} size="icon-xs" variant="outline"><ArrowClockwise aria-hidden="true" className={loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button>
          <Button disabled={entries.length === 0 || clearing} data-testid="audit-clear-trigger" onClick={() => { setError(null); setClearDialog(true) }} size="xs" variant="outline"><Trash aria-hidden="true" />{pluginInstanceId ? "清除插件记录" : "清除环境记录"}</Button>
        </ButtonGroup>}
        description="查看谁做了什么，以及操作结果；展开记录可查看执行过程。"
        title={`${projectName} / ${pluginInstanceId ? pluginName ?? "当前插件" : environmentName} 操作记录`} titleId="audit-feature-title"
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon><MagnifyingGlass aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="搜索操作记录" name="audit-search" autoComplete="off" spellCheck={false} onChange={event => setQuery(event.target.value)} placeholder="搜索动作、目标或失败原因…" type="search" value={query} />
        </InputGroup>
        <Select value={actorFilter} onValueChange={setActorFilter}><SelectTrigger aria-label="筛选参与方" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部参与方</SelectItem>{Object.entries(actorLabels).map(([key,label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}><SelectTrigger aria-label="筛选操作类型" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem>{Object.entries(categoryLabels).map(([key,label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select>
        <Select value={resultFilter} onValueChange={setResultFilter}><SelectTrigger aria-label="筛选操作结果" className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部结果</SelectItem>{results.map(result => <SelectItem key={result} value={result}>{auditResultLabel(result)}</SelectItem>)}</SelectContent></Select>
        <Select value={range} onValueChange={setRange}><SelectTrigger aria-label="筛选记录时间" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部时间</SelectItem><SelectItem value="1">最近 24 小时</SelectItem><SelectItem value="7">最近 7 天</SelectItem><SelectItem value="30">最近 30 天</SelectItem></SelectContent></Select>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={includeRedisScans} onCheckedChange={value => setIncludeRedisScans(value === true)} aria-label="显示 Redis 扫描" />显示 Redis 扫描<span>（默认隐藏用户的成功扫描）</span></label>
      {hasUpdates ? <div role="status" className="mb-2 flex items-center justify-between gap-2 rounded-md bg-surface-inset px-3 py-2 text-xs"><span>操作记录有更新</span><Button size="xs" variant="outline" disabled={loading || clearing} onClick={refreshAudit}>查看最新记录</Button></div> : null}
      {error ? <Alert className="mb-3 w-auto" variant="destructive"><WarningCircle aria-hidden="true" weight="fill" /><AlertTitle>操作记录读取失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        {loading && entries.length === 0 ? <div className="space-y-2 p-4" aria-label="正在读取操作记录"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
          : visibleEntries.length === 0 ? <Empty className="min-h-48"><EmptyHeader><EmptyMedia variant="icon"><ClockCounterClockwise aria-hidden="true" /></EmptyMedia><EmptyTitle>{query || resultFilter !== "all" || actorFilter !== "all" || categoryFilter !== "all" || range !== "all" ? nextCursor ? "尚未找到匹配记录" : "没有符合条件的操作记录" : "还没有操作记录"}</EmptyTitle><EmptyDescription>{nextCursor ? "可继续查找更早的记录。" : "操作会按实际发起方和执行结果显示在这里。"}</EmptyDescription></EmptyHeader></Empty>
          : <AuditOperationList entries={visibleEntries} />}
        {nextCursor ? <div className="flex justify-center p-3"><Button data-testid="audit-load-more" disabled={loading || clearing} variant="outline" size="sm" onClick={() => void loadAudit(nextCursor).catch(() => undefined)}>{loading ? "读取中…" : scanning ? "继续查找更早记录" : "加载更多操作"}</Button></div> : null}
        <p className="p-3 text-center text-xs text-muted-foreground" aria-live="polite">{visibleEntries.length ? `已显示 ${visibleEntries.length} 项操作` : ""}{visibleEntries.length && !nextCursor ? " · 已到记录末尾" : ""}</p>
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
