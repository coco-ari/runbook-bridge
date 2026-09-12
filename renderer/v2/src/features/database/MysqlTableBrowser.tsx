import { useEffect, useRef, useState } from "react"
import { Play } from "@phosphor-icons/react"
import type { AiOpsV2Api, MysqlQueryResult, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MysqlQueryResults, type MysqlResultViewSnapshot } from "./MysqlQueryResults"
import { MYSQL_BROWSE_MAX_BYTES, MYSQL_BROWSE_MAX_ROWS, MYSQL_BROWSE_PAGE_SIZE, quoteMysqlIdentifier, type MysqlSort } from "./mysql-sql-assist"

export function MysqlTableBrowser({ api, scope, table, description, maxRows, visible, dragScope }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly table: string
  readonly visible: boolean; readonly dragScope: string
  readonly description: MysqlTableDescription | null; readonly maxRows: number
}) {
  const filterRef = useRef<HTMLInputElement>(null)
  const snapshot = useRef<MysqlResultViewSnapshot | null>(null)
  const started = useRef(false)
  const [where, setWhere] = useState("")
  const [sort, setSort] = useState<MysqlSort | null>(null)
  const [result, setResult] = useState<MysqlQueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [message, setMessage] = useState("")
  const [generation, setGeneration] = useState(0)
  const current = useRef<MysqlQueryResult | null>(null)
  const active = useRef(false)
  const owner = useRef(0)
  const busy = useRef(false)
  const applied = useRef<{ where: string; sort: MysqlSort | null }>({ where: "", sort: null })
  const pageSize = Math.max(1, Math.min(MYSQL_BROWSE_PAGE_SIZE, maxRows))
  useEffect(() => { active.current = true; return () => { active.current = false; owner.current++ } }, [])

  async function readPage(reset: boolean, configuration = applied.current) {
    if (!active.current || (!reset && (busy.current || !hasMore))) return
    const ticket = ++owner.current
    const previous = reset ? null : current.current
    if (reset) {
      applied.current = configuration
      current.current = null
      setResult(null)
      setGeneration(value => value + 1)
      setHasMore(false)
      setMessage("")
    }
    busy.current = true
    setLoading(true)
    setError(null)
    const primaryKeys = description?.columns.filter(column => column.key === "PRI").map(column => column.name) ?? []
    const orderBy: MysqlSort[] = [...(configuration.sort ? [configuration.sort] : []), ...primaryKeys.filter(column => column !== configuration.sort?.column).map(column => ({ column, direction: "asc" as const }))].slice(0, 8)
    try {
      const response = await api.mysqlPreviewTable({ ...scope, table, where: configuration.where, orderBy, limit: pageSize, offset: previous?.rowCount ?? 0 })
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
      current.current = next
      setResult(next)
      const capped = rows.length >= MYSQL_BROWSE_MAX_ROWS
      const more = !capped && data.rowCount > 0 && (data.rowCount >= pageSize || data.truncated)
      setHasMore(more)
      setMessage(capped ? `已加载 ${MYSQL_BROWSE_MAX_ROWS} 行，请缩小筛选范围后重新查询。` : data.truncated && !data.rowCount ? "单行数据超过读取上限，请在 SQL 页选择需要的字段。" : more ? "向下滚动继续加载" : "已加载完本次查询的数据")
    } catch (failure) {
      if (active.current && owner.current === ticket) setError(failure instanceof Error ? failure.message : "数据查询失败，请重试。")
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
  if (!visible) return null
  const apply = () => { void readPage(true, { where: where.trim(), sort }) }
  return <div className="mysql-table-browser">
    <form className="mysql-table-filter-bar" onSubmit={event => { event.preventDefault(); apply() }}>
      <span className="mysql-table-select" title={`SELECT * FROM ${quoteMysqlIdentifier(table)}`}>SELECT * FROM <strong>{quoteMysqlIdentifier(table)}</strong></span>
      <span className="text-primary">WHERE</span>
      <Input ref={filterRef} onDragOver={event => { if (event.dataTransfer.types.includes("application/x-runbook-mysql-column")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy" } }} onDrop={dropColumn} aria-label="表数据筛选条件" data-testid="mysql-table-where" maxLength={8192} onChange={event => setWhere(event.target.value)} placeholder="条件，如 id > 100；留空查询整表" value={where} />
      <span className="shrink-0 font-mono">LIMIT {pageSize}</span>
      <Button data-testid="mysql-preview-run" size="sm" type="submit"><Play />{loading ? "重新查询" : "执行"}</Button>
    </form>
    {error ? <p className="mysql-browser-error" data-testid="mysql-preview-error" role="alert">{error}{result ? <Button data-testid="mysql-preview-retry" onClick={() => void readPage(false)} size="sm" variant="ghost">重试加载</Button> : null}</p> : null}
    {result ? <MysqlQueryResults snapshot={snapshot} columnDragScope={{ workspace: dragScope, table }} kind="preview" result={result} sort={sort} onSort={next => { setSort(next); void readPage(true, { where: where.trim(), sort: next }) }} stream={{ key: `${table}/${generation}`, loading, hasMore: hasMore && !error, onLoadMore: () => void readPage(false), message }} /> : <div className="mysql-browser-empty" role="status">{loading ? "正在读取数据…" : message || `输入筛选条件或直接执行，每次读取 ${pageSize} 行。`}</div>}
  </div>
}
