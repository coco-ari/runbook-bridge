import { toast } from "sonner"
import { useMysqlInlineEditing } from "./MysqlInlineEditingContext"
import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { copyMysqlText } from "./mysql-clipboard"
import { CaretLeft, CaretRight, CheckCircle, Clock, MagnifyingGlass, Table as TableIcon, WarningCircle, X } from "@phosphor-icons/react"
import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MysqlResultRowDetail, mysqlCopyCellText } from "@/features/database/MysqlResultRowDetail"
import { MYSQL_RESULT_PAGE_SIZE, mysqlByteSize, mysqlCellText } from "@/features/database/mysql-workspace-model"

import { compareMysqlCells, type MysqlSort } from "./mysql-sql-assist"

interface MysqlQueryResultsProps {
  readonly result: MysqlQueryResult
  readonly kind: "query" | "preview"
  readonly testIdPrefix?: string
  readonly columnDragScope?: Readonly<{ workspace: string; table: string }>
  readonly snapshot?: RefObject<MysqlResultViewSnapshot | null>
  readonly sort?: MysqlSort | null
  readonly onSort?: (sort: MysqlSort | null) => void
  readonly stream?: Readonly<{ key: string; loading: boolean; hasMore: boolean; message: string; onLoadMore: () => void }>
}

interface ResultViewState {
  readonly result: MysqlQueryResult | string
  readonly sort: MysqlSort | null
  readonly filter: string
  readonly page: number
  readonly pageSize: number
  readonly selectedRow: number | null
}

export interface MysqlResultViewSnapshot { readonly state: ResultViewState; readonly top: number; readonly left: number }

interface CopyNotice {
  readonly result: MysqlQueryResult
  readonly message: string
  readonly failed: boolean
}

export function MysqlQueryResults({ result, kind, testIdPrefix, sort, onSort, stream, columnDragScope, snapshot }: MysqlQueryResultsProps) {
  const editing = useMysqlInlineEditing()
  const selectionAnchor = useRef<number | null>(null)
  const shiftSelection = useRef(false)
  const viewIdentity = stream?.key ?? result
  const [viewState, setViewState] = useState<ResultViewState>(snapshot?.current?.state.result === viewIdentity ? snapshot.current.state : { result: viewIdentity, sort: null, filter: "", page: 0, pageSize: MYSQL_RESULT_PAGE_SIZE, selectedRow: null })
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastScrollTop = useRef(0)
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null)
  const detailId = useId()
  const prefix = testIdPrefix ?? `mysql-${kind}`
  const state: ResultViewState = viewState.result === viewIdentity ? viewState : { result: viewIdentity, sort: null, filter: "", page: 0, pageSize: MYSQL_RESULT_PAGE_SIZE, selectedRow: null }
  const filter = state.filter.trim().toLocaleLowerCase()
  const duplicateColumns = new Set(result.columns.map((column) => column.name)).size !== result.columns.length
  const selectedSort = onSort ? sort : state.sort
  // 输入和保存不重排当前视图；用户重新筛选、排序或加载结果时按最新显示值计算。
  const filteredRows = useMemo(() => {
    if (duplicateColumns) return []
    const cellValue = (row: Record<string, unknown>, name: string) => editing ? editing.value(row, name, row[name]) : row[name]
    const filtered = result.rows.map((row, index) => ({ row, index })).filter(({ row }) => !filter || result.columns.some((column) => mysqlCellText(cellValue(row, column.name)).toLocaleLowerCase().includes(filter)))
    if (selectedSort && !onSort) {
      const type = result.columns.find(column => column.name === selectedSort.column)?.type
      const numeric = type !== undefined && [0, 1, 2, 3, 4, 5, 8, 9, 13, 246].includes(type)
      filtered.sort((a, b) => (compareMysqlCells(cellValue(a.row, selectedSort.column), cellValue(b.row, selectedSort.column), numeric) * (selectedSort.direction === "asc" ? 1 : -1)) || a.index - b.index)
    }
    return filtered
  }, [duplicateColumns, filter, result, selectedSort, onSort])
  const columnWidths = useMemo(() => result.columns.map((column) => Math.min(280, Math.max(168, column.name.length * 8 + 32))), [result])
  const lastPage = Math.max(0, Math.ceil(filteredRows.length / state.pageSize) - 1)
  const visiblePage = Math.min(state.page, lastPage)
  const start = visiblePage * state.pageSize
  const rows = stream ? filteredRows : filteredRows.slice(start, start + state.pageSize)
  const selectedRow = !duplicateColumns && state.selectedRow !== null ? result.rows[state.selectedRow] : undefined
  const detailRow = selectedRow && editing ? Object.fromEntries(result.columns.map(column => [column.name, editing.value(selectedRow, column.name, selectedRow[column.name])])) : selectedRow
  const notice = copyNotice?.result === result ? copyNotice : null

  const latestState = useRef(state)
  latestState.current = state
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && snapshot?.current?.state.result === viewIdentity) {
      element.scrollTop = snapshot.current.top
      element.scrollLeft = snapshot.current.left
      lastScrollTop.current = element.scrollTop
    }
    return () => {
      if (snapshot && element) snapshot.current = { state: latestState.current, top: element.scrollTop, left: element.scrollLeft }
    }
  }, [snapshot, viewIdentity])
  useLayoutEffect(() => {
    if (snapshot?.current?.state === state) return
    lastScrollTop.current = 0
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [viewIdentity, filter, visiblePage, state.pageSize])

  function changeView(update: Partial<Omit<ResultViewState, "result">>) {
    setViewState({ ...state, ...update, result: viewIdentity })
    setCopyNotice(null)
  }

  function sortColumn(column: string) {
    editing?.finish()
    const next: MysqlSort | null = selectedSort?.column !== column ? { column, direction: "desc" } : selectedSort.direction === "desc" ? { column, direction: "asc" } : null
    if (onSort) onSort(next)
    else changeView({ sort: next, page: 0, selectedRow: null })
  }
  function loadAtBottom(element: HTMLDivElement) {
    if (!editing?.locked && stream?.hasMore && !stream.loading && !filter && element.scrollHeight - element.scrollTop - element.clientHeight < 64) stream.onLoadMore()
  }
  function closeDetail() {
    changeView({ selectedRow: null })
    if (selectedRowRef.current?.isConnected) selectedRowRef.current.focus()
    else scrollRef.current?.focus()
  }

  async function copyText(text: string, description: string) {
    try {
      await copyMysqlText(text)
      if (editing) toast.success(description)
      else setCopyNotice({ result, message: description, failed: false })
    } catch {
      if (editing) toast.error("复制失败，请选中详情内容后手动复制。")
      else setCopyNotice({ result, message: "复制失败，请选中详情内容后手动复制。", failed: true })
    }
  }

  return (
    <section aria-label={kind === "preview" ? "数据预览结果" : "SQL 查询结果"} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface" data-testid={`${prefix}-result`}>
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <h3 className="flex shrink-0 items-center gap-2 text-xs font-medium"><TableIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />{kind === "preview" ? "数据预览" : "查询结果"}</h3>
        <span aria-hidden="true" className="h-3.5 w-px bg-border" />
        <p aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground" data-testid={`${prefix}-summary`}>
          <span className="flex items-center gap-1 text-success"><CheckCircle aria-hidden="true" className="size-3" />成功</span>
          <span>返回 {result.rowCount} 行</span>
          <span className="flex items-center gap-1"><Clock aria-hidden="true" className="size-3" />耗时 {Math.round(result.durationMs)} ms</span>
          <span>{mysqlByteSize(result.bytes)}</span>
        </p>
        {!duplicateColumns ? (
          <div className="relative ml-auto w-40 xl:w-52">
            <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="筛选当前返回结果"
              className="h-7 pl-7 pr-7 text-xs md:text-xs"
              data-testid={`${prefix}-filter`}
              onChange={(event) => changeView({ filter: event.target.value, page: 0, selectedRow: null })}
              placeholder="筛选当前结果…"
              type="search"
              value={state.filter}
            />
            {state.filter ? <Button aria-label="清除结果筛选" className="absolute right-0 top-0" onClick={() => changeView({ filter: "", page: 0, selectedRow: null })} size="icon-xs" type="button" variant="ghost"><X aria-hidden="true" className="size-3" /></Button> : null}
          </div>
        ) : null}
      </header>
      {result.truncated || result.auditWarning || duplicateColumns ? (
        <div className="max-h-40 shrink-0 overflow-auto border-b bg-surface-inset">
          {result.truncated ? (
            <Alert className="rounded-none border-0 bg-transparent px-3 py-2 text-xs" data-testid={`${prefix}-truncated`}>
              <WarningCircle aria-hidden="true" />
              <AlertTitle className="text-xs">结果已截断</AlertTitle>
              <AlertDescription className="text-xs">仅展示已返回的数据。当前最多返回 {result.limitsApplied.maxRows} 行、{mysqlByteSize(result.limitsApplied.maxBytes)}；可使用 WHERE 条件缩小查询范围。</AlertDescription>
            </Alert>
          ) : null}
          {result.auditWarning ? (
            <Alert className="rounded-none border-0 bg-transparent px-3 py-2 text-xs" data-testid={`${prefix}-audit-warning`}>
              <WarningCircle aria-hidden="true" />
              <AlertTitle className="text-xs">操作记录写入失败</AlertTitle>
              <AlertDescription className="text-xs">查询已完成，但本次操作记录未能保存。请检查本机存储空间和权限。</AlertDescription>
            </Alert>
          ) : null}
          {duplicateColumns ? (
            <Alert className="rounded-none border-0 bg-transparent px-3 py-2 text-xs" data-testid={`${prefix}-duplicate-columns`}>
              <WarningCircle aria-hidden="true" />
              <AlertTitle className="text-xs">查询返回了重名列</AlertTitle>
              <AlertDescription className="text-xs">重名列的数据无法完整区分，暂不展示表格。请使用 AS 为每一列设置不同的别名后重新查询。</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
      {!duplicateColumns ? (
        <>
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div aria-label="查询结果表格，可横向和纵向滚动" className="min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-testid={`${prefix}-table-scroll`} onScroll={(event) => { if (event.currentTarget.scrollTop > lastScrollTop.current) loadAtBottom(event.currentTarget); lastScrollTop.current = event.currentTarget.scrollTop }} onWheel={(event) => { if (event.deltaY > 0) loadAtBottom(event.currentTarget) }} ref={scrollRef} role="region" tabIndex={0}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-xs" style={{ minWidth: (editing ? 80 : 48) + columnWidths.reduce((sum, width) => sum + width, 0) }}>
                <colgroup>{editing ? <col style={{ width: 32 }} /> : null}<col style={{ width: 48 }} />{result.columns.map((column, index) => <col key={column.name} style={{ width: columnWidths[index] }} />)}</colgroup>
                <thead>
                  <tr>
                    {editing ? <th className="mysql-inline-selector sticky top-0 z-10 border-b bg-surface-inset"><Checkbox aria-label="选择当前页全部行" disabled={editing.locked || !rows.length} checked={rows.length > 0 && rows.every(({row}) => editing.selection.has(row)) ? true : rows.some(({row}) => editing.selection.has(row)) ? "indeterminate" : false} onCheckedChange={checked => editing.select(rows.map(item => item.row), checked === true)} /></th> : null}
                    <th className="sticky top-0 z-10 h-8 border-b border-r bg-surface-inset px-3 text-right font-normal text-text-faint" scope="col"><span className="sr-only">行号</span>#</th>
                    {result.columns.map((column) => (
                      <th aria-sort={selectedSort?.column === column.name ? selectedSort.direction === "asc" ? "ascending" : "descending" : "none"} className="sticky top-0 z-10 h-8 border-b bg-surface-inset px-3 text-left font-mono text-xs font-normal text-muted-foreground" key={column.name} scope="col" title={column.table ? `${column.table}.${column.name}` : column.name}>
                        <button aria-label={`按 ${column.name} 排序`} draggable={Boolean(columnDragScope)} onDragStart={event => { if (columnDragScope) { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-runbook-mysql-column", JSON.stringify({ ...columnDragScope, column: column.name })) } }} className="mysql-column-sort" data-column={column.name} data-testid={`${prefix}-sort`} onClick={() => sortColumn(column.name)} title={onSort ? "在数据库中排序：降序 / 升序 / 默认" : "当前返回结果排序：降序 / 升序 / 默认"} type="button"><span>{column.name}</span><span aria-hidden="true">{selectedSort?.column === column.name ? selectedSort.direction === "asc" ? "↑" : "↓" : "↕"}</span></button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map(({ row, index }) => (
                    <tr
                      aria-controls={detailId}
                      aria-expanded={state.selectedRow === index}
                      className={`h-8 cursor-pointer outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${state.selectedRow === index ? "bg-surface-selected" : "even:bg-surface-inset/25"}`}
                      data-edit-row={editing?.rowId(row)}
                      data-selected={editing?.selection.has(row) || undefined}
                      data-conflict={editing?.conflict(row) || undefined}
                      data-row-index={index}
                      data-testid={`${prefix}-row`}
                      key={index}
                      onClick={(event) => { selectedRowRef.current = event.currentTarget; changeView({ selectedRow: index }) }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        selectedRowRef.current = event.currentTarget
                        changeView({ selectedRow: index })
                      }}
                      tabIndex={0}
                    >
                      {editing ? <td className="mysql-inline-selector mysql-edit-row-selector" onClick={event => event.stopPropagation()} onPointerDown={event => { shiftSelection.current = event.shiftKey }}><Checkbox aria-label={"选择第 " + (index + 1) + " 行"} checked={editing.selection.has(row)} disabled={editing.locked} onCheckedChange={checked => {
                        const anchor = rows.findIndex(item => item.index === selectionAnchor.current), position = rows.findIndex(item => item.index === index)
                        const targets = shiftSelection.current && anchor >= 0 ? rows.slice(Math.min(anchor, position), Math.max(anchor, position) + 1).map(item => item.row) : [row]
                        editing.select(targets, checked === true); selectionAnchor.current = index; shiftSelection.current = false
                      }} /></td> : null}
                      <td className="mysql-edit-number h-8 border-b border-r border-border/50 px-3 py-0 text-right font-mono text-xs tabular-nums text-text-faint"><button type="button" className="block h-[31px] w-full leading-[31px]" title="查看行详情" aria-label={"查看第 " + (index + 1) + " 行详情"}>{index + 1}</button></td>
                      {result.columns.map((column) => {
                        const value = editing ? editing.value(row, column.name, row[column.name]) : row[column.name]
                        const content = <span className={`block h-[31px] truncate leading-[31px] ${typeof row[column.name] === "number" ? "text-right tabular-nums" : ""} ${value === null || value === undefined ? "text-muted-foreground italic" : ""}`}>{mysqlCellText(value)}</span>
                        return <td className="mysql-inline-cell relative h-8 border-b border-border/50 px-3 py-0 font-mono text-xs" key={column.name} data-edit-column={column.name} data-numeric={typeof row[column.name] === "number" || undefined} data-dirty={editing?.dirty(row, column.name) || undefined} tabIndex={editing ? 0 : undefined}
                          onClick={event => { if (editing) { event.stopPropagation(); if (event.target === event.currentTarget || !(event.target instanceof HTMLInputElement)) event.currentTarget.focus({ preventScroll: true }) } }}
                          onDoubleClick={event => { event.stopPropagation(); if (event.target instanceof HTMLInputElement) return; if (editing) editing.begin(row, column.name); else void copyText(mysqlCopyCellText(value), "单元格已复制") }}
                          onContextMenu={event => { if (editing && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); editing.begin(row, column.name, true) } }}
                          onKeyDown={event => {
                            if (!editing || event.target !== event.currentTarget) return
                            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void copyText(mysqlCopyCellText(value), "单元格已复制") }
                            if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); event.stopPropagation(); editing.begin(row, column.name, event.shiftKey) }
                            if (event.key.startsWith("Arrow")) {
                              event.preventDefault(); event.stopPropagation()
                              const cell = event.currentTarget
                              const target = event.key === "ArrowLeft" ? cell.previousElementSibling : event.key === "ArrowRight" ? cell.nextElementSibling : (event.key === "ArrowUp" ? cell.parentElement?.previousElementSibling : cell.parentElement?.nextElementSibling)?.querySelector('[data-edit-column="' + CSS.escape(column.name) + '"]')
                              if (target?.hasAttribute("data-edit-column")) (target as HTMLElement).focus({ preventScroll: true })
                            }
                          }} title={editing ? "双击编辑 · Ctrl+C 复制 · 右键打开完整字段" : "单击查看行详情，双击复制完整单元格"}>
                          {editing ? editing.cell(row, column.name, content) : content}
                        </td>
                      })}
                    </tr>
                  )) : (
                    <tr><td className="h-28 px-4 text-center text-xs text-muted-foreground" colSpan={Math.max(1, result.columns.length + (editing ? 2 : 1))}>{filter ? "当前返回结果中没有匹配的数据。" : "查询成功，没有符合条件的数据。"}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {selectedRow && state.selectedRow !== null ? <MysqlResultRowDetail columns={result.columns} id={detailId} key={`${state.selectedRow}`} onClose={closeDetail} onCopy={(text, description) => { void copyText(text, description) }} prefix={prefix} row={detailRow!} rowNumber={state.selectedRow + 1} /> : null}
          </div>
          <footer className="mysql-results-footer flex h-9 shrink-0 items-center gap-x-3 border-t px-3 py-1 text-xs tabular-nums text-muted-foreground">
            <span>{filteredRows.length ? `${start + 1} 至 ${start + rows.length}` : "0"} / {filteredRows.length} 行{filter ? ` · 共返回 ${result.rows.length} 行` : " · 当前返回结果"}</span>
            <span aria-live="polite" className={`min-w-0 flex-1 truncate ${notice?.failed ? "text-danger" : "text-text-faint"}`} role="status">{editing?.status || notice?.message || "单击行查看详情 · 双击单元格复制"}</span>
            {stream ? <><span className="ml-auto" data-testid={`${prefix}-load-status`}>{stream.message}</span><Button data-testid={`${prefix}-load-more`} disabled={!stream.hasMore || stream.loading || Boolean(filter) || Boolean(editing?.locked)} onClick={stream.onLoadMore} size="sm" variant="ghost">{stream.loading ? "加载中…" : "继续加载"}</Button></> : <><label className="ml-auto flex items-center gap-1.5"><span className="sr-only">每页结果行数</span><SelectControl aria-label="每页结果行数" size="sm" onValueChange={(value) => changeView({ pageSize: Number(value), page: 0, selectedRow: null })} value={String(state.pageSize)}>{[25, 50, MYSQL_RESULT_PAGE_SIZE].map((size) => <SelectItem key={size} value={String(size)}>{size} 行 / 页</SelectItem>)}</SelectControl></label>
            <Button aria-label="上一页结果" disabled={visiblePage === 0} onClick={() => changeView({ page: visiblePage - 1, selectedRow: null })} size="icon-xs" type="button" variant="ghost"><CaretLeft aria-hidden="true" className="size-3.5" /></Button>
            <span className="min-w-10 text-center">{visiblePage + 1} / {lastPage + 1}</span>
            <Button aria-label="下一页结果" data-testid={`${prefix}-next-page`} disabled={visiblePage === lastPage} onClick={() => changeView({ page: visiblePage + 1, selectedRow: null })} size="icon-xs" type="button" variant="ghost"><CaretRight aria-hidden="true" className="size-3.5" /></Button></>}
            {editing?.footer}
          </footer>
        </>
      ) : <div className="min-h-0 flex-1" />}
    </section>
  )
}
