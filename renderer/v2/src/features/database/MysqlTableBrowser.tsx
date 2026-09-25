import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { useEffect, useRef, useState } from "react"
import { MysqlEditableResults } from "./MysqlEditableResults"
import { useMysqlEditingGuard } from "./MysqlEditingContext"
import { Code, Play } from "@phosphor-icons/react"
import type { AiOpsV2Api, MysqlQueryResult, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MysqlQueryResults, type MysqlResultViewSnapshot } from "./MysqlQueryResults"
import { MYSQL_BROWSE_MAX_BYTES, MYSQL_BROWSE_MAX_ROWS, MYSQL_BROWSE_PAGE_SIZE, quoteMysqlIdentifier, type MysqlSort } from "./mysql-sql-assist"

export function MysqlTableBrowser({ api, scope, table, description, maxRows, visible, dragScope, filterHost }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly table: string
  readonly filterHost: HTMLElement | null
  readonly visible: boolean; readonly dragScope: string
  readonly description: MysqlTableDescription | null; readonly maxRows: number
}) {
  const editing = useMysqlEditingGuard()
  const documentKey = "table:" + table
  const protect = (action: () => void) => editing.protect(action, [documentKey])
  const filterRef = useRef<HTMLInputElement>(null)
  const columnWidthCache = useRef(new Map<string, readonly number[]>())
  const snapshot = useRef<MysqlResultViewSnapshot | null>(null)
  const started = useRef(false)
  const [where, setWhere] = useState("")
  const [requestedPageSize, setRequestedPageSize] = useState(Math.max(1, Math.min(MYSQL_BROWSE_PAGE_SIZE, maxRows)))
  const [sort, setSort] = useState<MysqlSort | null>(null)
  const [result, setResult] = useState<MysqlQueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [message, setMessage] = useState("")
  const [writeSummary, setWriteSummary] = useState("")
  const writeSummaryRef = useRef("")
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [generation, setGeneration] = useState(0)
  const current = useRef<MysqlQueryResult | null>(null)
  const active = useRef(false)
  const owner = useRef(0)
  const busy = useRef(false)
  const applied = useRef<{ where: string; sort: MysqlSort | null; limit: number }>({ where: "", sort: null, limit: requestedPageSize })
  const pageSize = applied.current.limit
  const pageSizes = [...new Set([20, 50, 100].map(size => Math.max(1, Math.min(size, maxRows))))]
  useEffect(() => { active.current = true; return () => { active.current = false; owner.current++ } }, [])

  async function readPage(reset: boolean, configuration = applied.current, summary?: string) {
    if (!editing.connected || !active.current || (!reset && (busy.current || !hasMore))) return
    if (summary !== undefined) { writeSummaryRef.current = summary; setWriteSummary(summary) }
    const ticket = ++owner.current
    const previous = reset ? null : current.current
    if (reset) {
      applied.current = configuration
      setRefreshRequired(true)
      setHasMore(false)
      setMessage("")
    }
    busy.current = true
    setLoading(true)
    setError(null)
    const primaryKeys = description?.columns.filter(column => column.key === "PRI").map(column => column.name) ?? []
    const orderBy: MysqlSort[] = [...(configuration.sort ? [configuration.sort] : []), ...primaryKeys.filter(column => column !== configuration.sort?.column).map(column => ({ column, direction: "asc" as const }))].slice(0, 8)
    try {
      const response = await api.mysqlPreviewTable({ ...scope, table, where: configuration.where, orderBy, limit: configuration.limit, offset: previous?.rowCount ?? 0 })
      if (!active.current || owner.current !== ticket) return
      if (!response.ok) throw new Error(response.error.message)
      const data = response.data
      if (previous && JSON.stringify(previous.columns) !== JSON.stringify(data.columns)) throw new Error("表结构已变化，请重新执行查询。")
      if ((previous?.bytes ?? 0) + data.bytes > MYSQL_BROWSE_MAX_BYTES) {
        setHasMore(false)
        setMessage("已达到当前浏览的 4 MB 上限，请缩小筛选范围后重新查询。")
        return
      }
      const rows = [...(previous?.rows ?? []), ...data.rows].slice(0, MYSQL_BROWSE_MAX_ROWS)
      const next: MysqlQueryResult = { ...data, rows, rowCount: rows.length, bytes: (previous?.bytes ?? 0) + data.bytes, durationMs: (previous?.durationMs ?? 0) + data.durationMs, truncated: Boolean(previous?.truncated || data.truncated), auditWarning: Boolean(previous?.auditWarning || data.auditWarning) }
      if (reset) { setGeneration(value => value + 1); setRefreshRequired(false) }
      current.current = next
      setResult(next)
      const capped = rows.length >= MYSQL_BROWSE_MAX_ROWS
      const more = !capped && data.rowCount > 0 && (data.rowCount >= configuration.limit || data.truncated)
      setHasMore(more)
      setMessage(capped ? `已加载 ${MYSQL_BROWSE_MAX_ROWS} 行，请缩小筛选范围后重新查询。` : data.truncated && !data.rowCount ? "单行数据超过读取上限，请在 SQL 页选择需要的字段。" : more ? "向下滚动继续加载" : "已加载完本次查询的数据")
    } catch (failure) {
      if (active.current && owner.current === ticket) setError((writeSummaryRef.current ? writeSummaryRef.current + " 刷新失败，可点击刷新重新读取。" : "") + (failure instanceof Error ? failure.message : "数据查询失败，请重试。"))
    } finally {
      if (active.current && owner.current === ticket) { busy.current = false; setLoading(false) }
    }
  }
  useEffect(() => {
    if (description && !started.current) { started.current = true; void readPage(true) }
  }, [description])
  function dropColumn(event: React.DragEvent<HTMLInputElement>) {
    const raw = event.dataTransfer.getData("application/x-runbook-mysql-column")
    if (!raw) return
    event.preventDefault()
    try {
      const payload = JSON.parse(raw)
      if (payload.workspace !== dragScope || payload.table !== table || typeof payload.column !== "string" || !result?.columns.some(column => column.name === payload.column)) return
      const input = event.currentTarget
      const start = input.selectionStart ?? where.length
      const end = input.selectionEnd ?? start
      const quoted = quoteMysqlIdentifier(payload.column)
      const prefix = start && !/\s$/.test(where.slice(0, start)) ? " " : ""
      const inserted = prefix + quoted + " "
      const next = where.slice(0, start) + inserted + where.slice(end)
      if (next.length > 8192) return
      setWhere(next)
      window.setTimeout(() => { filterRef.current?.focus(); filterRef.current?.setSelectionRange(start + inserted.length, start + inserted.length) }, 0)
    } catch { /* 只接收本表的字段拖放。 */ }
  }
  const order = [...(applied.current.sort ? [applied.current.sort] : []), ...(description?.columns.filter(column => column.key === "PRI" && column.name !== applied.current.sort?.column).map(column => ({ column: column.name, direction: "asc" as const })) ?? [])].slice(0, 8)
  const editSql = "SELECT * FROM " + quoteMysqlIdentifier(table) + (applied.current.where ? " WHERE " + applied.current.where : "") + (order.length ? " ORDER BY " + order.map(item => quoteMysqlIdentifier(item.column) + " " + item.direction.toUpperCase()).join(",") : "") + " LIMIT " + Math.max(result?.rowCount ?? pageSize, pageSize)
  const apply = () => protect(() => { void readPage(true, { where: where.trim(), sort, limit: requestedPageSize }, "") })
  return <div className="mysql-table-browser" hidden={!visible}>
    {visible ? <><form className="mysql-table-filter-bar" onSubmit={event => { event.preventDefault(); apply() }}>
      <span className="text-primary">WHERE</span>
      <Input ref={filterRef} onDragOver={event => { if (event.dataTransfer.types.includes("application/x-runbook-mysql-column")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy" } }} onDrop={dropColumn} aria-label="表数据筛选条件" data-testid="mysql-table-where" maxLength={8192} onChange={event => setWhere(event.target.value)} title="在数据库中执行 WHERE 条件；按 Enter 查询" placeholder="条件，如 id > 100；留空查询整表" value={where} />
      <Popover><PopoverTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label="查询设置与 SQL" title="查询设置与 SQL" data-testid="mysql-query-options"><Code /></Button></PopoverTrigger><PopoverContent align="end" className="w-80 max-w-[calc(100vw-24px)]" data-testid="mysql-query-options-panel">
        <p className="text-xs font-medium">查询设置</p>
        <label className="flex items-center justify-between gap-3 text-xs">每批读取<SelectControl aria-label="每批读取行数" size="sm" value={String(requestedPageSize)} onValueChange={value => setRequestedPageSize(Number(value))}>{pageSizes.map(size => <SelectItem key={size} value={String(size)}>{size} 行</SelectItem>)}</SelectControl></label>
        <p className="text-xs text-muted-foreground">点击执行后生效。滚动或点击加载更多继续读取。</p>
        <p className="text-xs font-medium">本次查询 SQL</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border p-2 font-mono text-xs">{"SELECT * FROM " + quoteMysqlIdentifier(table) + (where.trim() ? " WHERE " + where.trim() : "") + (order.length ? " ORDER BY " + order.map(item => quoteMysqlIdentifier(item.column) + " " + item.direction.toUpperCase()).join(", ") : "") + " LIMIT " + requestedPageSize}</pre>
      </PopoverContent></Popover>
      <Button data-testid="mysql-preview-run" size="sm" type="submit"><Play />{loading ? "重新查询" : "执行"}</Button>
    </form>
    </> : null}
    {result ? <MysqlEditableResults key={generation} feedback={{busy: loading, error: error ?? "", message: writeSummary}} api={api} scope={scope} documentKey={documentKey} result={result} sql={editSql} visible={visible} onReload={summary => void readPage(true, applied.current, summary)}><MysqlQueryResults columnWidthCache={columnWidthCache.current} columnWidthScope={JSON.stringify([dragScope, table])} persistColumnWidths filterHost={filterHost} snapshot={snapshot} columnDragScope={{ workspace: dragScope, table }} kind="preview" result={result} sort={sort} onSort={next => protect(() => { setSort(next); void readPage(true, { where: where.trim(), sort: next, limit: requestedPageSize }) })} stream={{ key: `${table}/${generation}`, loading, hasMore: hasMore && !error && !refreshRequired, retry: Boolean(error) && !refreshRequired && editing.connected, onLoadMore: () => void readPage(false), message }} /></MysqlEditableResults> : <div className="mysql-browser-empty" data-testid={error ? "mysql-preview-error" : undefined} role={error ? "alert" : "status"}>{loading ? "正在读取数据…" : error || message || `输入筛选条件或直接执行，每次读取 ${pageSize} 行。`}</div>}
  </div>
}
