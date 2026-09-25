import { createPortal } from "react-dom"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { mergeMysqlDraftRows } from "./mysql-row-draft-model"
import { useMysqlRowSelection } from "./use-mysql-row-selection"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/components/ui/context-menu"
import { toast } from "sonner"
import { useMysqlInlineEditing } from "./MysqlInlineEditingContext"
import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { copyMysqlText } from "./mysql-clipboard"
import { CaretDown, CaretLeft, CaretRight, MagnifyingGlass, WarningCircle, X } from "@phosphor-icons/react"
import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MysqlResultRowDetail, mysqlCopyCellText } from "@/features/database/MysqlResultRowDetail"
import { MYSQL_RESULT_PAGE_SIZE, mysqlByteSize, mysqlCellText } from "@/features/database/mysql-workspace-model"

import { compareMysqlCells, type MysqlSort } from "./mysql-sql-assist"

interface MysqlQueryResultsProps {
  readonly filterHost?: HTMLElement | null
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

export function MysqlQueryResults({ result, kind, testIdPrefix, sort, onSort, stream, columnDragScope, snapshot, filterHost }: MysqlQueryResultsProps) {
  const editing = useMysqlInlineEditing()
  const searchRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ row: Record<string, unknown>; index: number; column: string | null; element: HTMLElement } | null>(null)
  const menuAction = useRef<(() => void) | null>(null)
  const viewIdentity = stream?.key ?? result
  const [viewState, setViewState] = useState<ResultViewState>(snapshot?.current?.state.result === viewIdentity ? snapshot.current.state : { result: viewIdentity, sort: null, filter: "", page: 0, pageSize: MYSQL_RESULT_PAGE_SIZE, selectedRow: null })
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastScrollTop = useRef(0)
  const selectedRowRef = useRef<HTMLElement | null>(null)
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
  const resultRows = stream ? filteredRows : filteredRows.slice(start, start + state.pageSize)
  const rows = mergeMysqlDraftRows(resultRows, editing?.pendingRows ?? [], row => editing?.rowId(row), result.rows.length)
  const rowSelection = useMysqlRowSelection(rows, editing, scrollRef)
  const selectedRow = !duplicateColumns && state.selectedRow !== null ? rows.find(item => item.index === state.selectedRow)?.row : undefined
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

  function rowStateLabel(row: Record<string, unknown>) {
    const state = editing?.rowState?.(row)
    return state ? { insert: "新增", copy: "复制", update: "修改", delete: "删除" }[state] : ""
  }

  function changeView(update: Partial<Omit<ResultViewState, "result">>) {
    if (update.filter !== undefined && update.filter !== state.filter) editing?.clearSelection()
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
    if (!rowSelection.dragging.current && !editing?.locked && !editing?.pendingRows?.length && stream?.hasMore && !stream.loading && !filter && element.scrollHeight - element.scrollTop - element.clientHeight < 64) stream.onLoadMore()
  }
  function closeDetail() {
    changeView({ selectedRow: null })
    if (selectedRowRef.current?.isConnected) selectedRowRef.current.focus({ preventScroll: true })
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

  const filterControl = !duplicateColumns ? (
          <div className="mysql-result-filter relative">
            <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="筛选已加载数据" title="只筛选当前已加载的数据，不重新查询数据库"
              className="h-7 pl-7 pr-7 text-xs md:text-xs"
              data-testid={`${prefix}-filter`}
              onChange={(event) => changeView({ filter: event.target.value, page: 0, selectedRow: null })}
              placeholder="筛选已加载数据…"
              ref={searchRef}
              type="text"
              value={state.filter}
            />
            {state.filter ? <Button aria-label="清除结果筛选" className="absolute right-0 top-0" onMouseDown={event => event.preventDefault()} onClick={() => { changeView({ filter: "", page: 0, selectedRow: null }); searchRef.current?.focus() }} size="icon-xs" type="button" variant="ghost"><X aria-hidden="true" className="size-3" /></Button> : null}
          </div>
        ) : null

  return (
    <section aria-label={kind === "preview" ? "数据预览结果" : "SQL 查询结果"} className="mysql-results-region flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface" data-testid={`${prefix}-result`}>
      {filterHost ? createPortal(filterControl, filterHost) : <header className="mysql-result-search-bar">{filterControl}</header>}
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
            {editing?.toolbar}
            <ContextMenu><ContextMenuTrigger asChild>
            <div onPointerDownCapture={rowSelection.pointerStart} onContextMenuCapture={event => {
              const target = event.target as HTMLElement
              if (target.closest("input,textarea") || !target.closest("td")) { event.stopPropagation(); return }
              const cell = target.closest<HTMLTableCellElement>("td"), row = cell?.closest<HTMLTableRowElement>("tr[data-row-index]")
              const index = Number(row?.dataset.rowIndex ?? -1)
              const source = rows.find(item => item.index === index)?.row
              if (!source || !cell) { event.stopPropagation(); return }
              setMenu({row:source,index,column:cell.dataset.editColumn ?? null,element:cell.querySelector<HTMLElement>("button") ?? cell})
            }} onPointerMove={rowSelection.move} onPointerUp={() => rowSelection.finish()} onPointerCancel={() => rowSelection.finish(true)} onLostPointerCapture={() => rowSelection.finish(true)} onClickCapture={rowSelection.click} aria-label="查询结果表格，可横向和纵向滚动" className="min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-testid={`${prefix}-table-scroll`} onScroll={(event) => { if (event.currentTarget.scrollTop > lastScrollTop.current) loadAtBottom(event.currentTarget); lastScrollTop.current = event.currentTarget.scrollTop }} onWheel={(event) => { if (event.deltaY > 0) loadAtBottom(event.currentTarget) }} ref={scrollRef} role="region" tabIndex={0}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-xs" style={{ minWidth: (editing ? 160 : 48) + columnWidths.reduce((sum, width) => sum + width, 0) }}>
                <colgroup>{editing ? <col style={{ width: 32 }} /> : null}<col style={{ width: 48 }} />{editing ? <col style={{ width: 80 }} /> : null}{result.columns.map((column, index) => <col key={column.name} style={{ width: columnWidths[index] }} />)}</colgroup>
                <thead>
                  <tr>
                    {editing ? <th className="mysql-inline-selector sticky top-0 z-10 border-b bg-surface-inset"><Checkbox aria-label="选择当前页全部行" disabled={editing.locked || !rows.length} checked={rows.length > 0 && rows.every(({row}) => editing.selection.has(row)) ? true : rows.some(({row}) => editing.selection.has(row)) ? "indeterminate" : false} onCheckedChange={checked => editing.select(rows.map(item => item.row), checked === true)} /></th> : null}
                    <th className="sticky top-0 z-10 h-8 border-b border-r bg-surface-inset px-3 text-right font-normal text-text-faint" scope="col"><span className="sr-only">行号</span>#</th>
                    {editing ? <th className="mysql-row-status sticky top-0 z-10 h-8 border-b bg-surface-inset" scope="col">状态</th> : null}
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
                      data-pending-delete={editing?.deleted?.(row) || undefined}
                      data-row-state={editing?.rowState?.(row) ?? undefined}
                      data-draft-row={index >= result.rows.length || undefined}
                      data-edit-row={editing?.rowId(row)}
                      data-selected={editing?.selection.has(row) || undefined}
                      data-conflict={editing?.conflict(row) || undefined}
                      data-row-index={index}
                      data-testid={`${prefix}-row`}
                      key={index >= result.rows.length ? editing?.rowId(row) : index}
                    >
                      {editing ? <td className="mysql-inline-selector mysql-edit-row-selector" onPointerDown={event => rowSelection.down(event,index)}><Checkbox aria-label={"选择第 " + (index + 1) + " 行"} checked={editing.selection.has(row)} disabled={editing.locked} onCheckedChange={checked => editing.select([row],checked === true)} /></td> : null}
                      <td onPointerDown={event => rowSelection.down(event,index)} className="mysql-edit-number h-8 border-b border-r border-border/50 px-3 py-0 text-right font-mono text-xs tabular-nums text-text-faint"><button type="button" className="block h-[31px] w-full leading-[31px]" title="点击或拖动选择行 · 右键更多操作" aria-label={"选择第 " + (index + 1) + " 行号"} onClick={() => { if (!editing?.locked) editing?.select([row],!editing.selection.has(row)) }}>{index >= result.rows.length ? "+" : index + 1}</button></td>
                      {editing ? <td className="mysql-row-status h-8 border-b border-border/50"><div className="mysql-row-status-content"><span>{rowStateLabel(row)}</span>{editing.rowActions?.(row)}</div></td> : null}
                      {result.columns.map((column) => {
                        const value = editing ? editing.value(row, column.name, row[column.name]) : row[column.name]
                        const placeholder = editing?.placeholder?.(row, column.name)
                        const content = placeholder ? <span className="block h-[31px] truncate leading-[31px] text-muted-foreground italic" title={placeholder}>{placeholder}</span> : <span className={`block h-[31px] truncate leading-[31px] ${typeof row[column.name] === "number" ? "text-right tabular-nums" : ""} ${value === null || value === undefined ? "text-muted-foreground italic" : ""}`}>{mysqlCellText(value)}</span>
                        return <td className="mysql-inline-cell relative h-8 border-b border-border/50 px-3 py-0 font-mono text-xs" key={column.name} data-edit-column={column.name} data-numeric={typeof row[column.name] === "number" || undefined} data-dirty={editing?.dirty(row, column.name) || undefined} tabIndex={0}
                          onClick={event => { if (editing) { event.stopPropagation(); if (event.target === event.currentTarget || !(event.target instanceof HTMLInputElement)) event.currentTarget.focus({ preventScroll: true }) } }}
                          onDoubleClick={event => { event.stopPropagation(); if (event.target instanceof HTMLInputElement) return; if (editing) editing.begin(row, column.name); else void copyText(mysqlCopyCellText(value), "单元格已复制") }}
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
                          }} title={editing ? "双击编辑 · Ctrl+C 复制 · 右键更多操作" : "右键查看行详情，双击复制完整单元格"}>
                          {editing ? editing.cell(row, column.name, content) : content}
                        </td>
                      })}
                    </tr>
                  )) : (
                    <tr><td className="h-28 px-4 text-center text-xs text-muted-foreground" colSpan={Math.max(1, result.columns.length + (editing ? 3 : 1))}>{filter ? "当前返回结果中没有匹配的数据。" : "查询成功，没有符合条件的数据。"}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent data-testid="mysql-result-menu" onCloseAutoFocus={event => {
              event.preventDefault()
              const action = menuAction.current
              menuAction.current = null
              window.setTimeout(() => { if (action) action(); else menu?.element.focus({preventScroll:true}) }, 0)
            }}>
              {menu ? <>
                <ContextMenuLabel>{menu.column ?? "行操作"} · {menu.index >= result.rows.length ? "未保存草稿" : "第 " + (menu.index + 1) + " 行"}</ContextMenuLabel>
                {menu.column ? <>
                  {editing ? <><ContextMenuItem disabled={editing.locked || !editing.canEdit(menu.column, menu.row)} onSelect={() => { menuAction.current = () => editing.begin(menu.row,menu.column!) }}>编辑单元格</ContextMenuItem><ContextMenuItem disabled={editing.locked || !editing.canEdit(menu.column, menu.row)} onSelect={() => { menuAction.current = () => editing.begin(menu.row,menu.column!,true) }}>完整字段编辑…</ContextMenuItem></> : null}
                  <ContextMenuItem onSelect={() => { menuAction.current = () => { void copyText(mysqlCopyCellText(editing ? editing.value(menu.row,menu.column!,menu.row[menu.column!]) : menu.row[menu.column!]),"单元格已复制") } }}>复制单元格</ContextMenuItem>
                </> : null}
                {menu.index >= result.rows.length && editing?.fullRow ? <ContextMenuItem disabled={editing.locked} onSelect={() => { menuAction.current = () => editing.fullRow?.(menu.row) }}>编辑完整行字段…</ContextMenuItem> : null}
                {editing?.copyRow ? <><ContextMenuItem disabled={editing.locked} onSelect={() => { menuAction.current = () => editing.copyRow?.(menu.row) }}>复制为新行</ContextMenuItem><ContextMenuItem disabled={editing.locked} onSelect={() => { menuAction.current = () => editing.deleted?.(menu.row) ? editing.restore?.(menu.row) : editing.deleteRow?.(menu.row) }}>{editing.deleted?.(menu.row) ? "撤销删除" : menu.index >= result.rows.length ? "移除草稿" : "删除行"}</ContextMenuItem><ContextMenuSeparator /></> : null}
                <ContextMenuItem onSelect={() => { menuAction.current = () => { selectedRowRef.current = menu.element; changeView({selectedRow:menu.index}) } }}>查看行详情</ContextMenuItem>
                {editing ? <>
                  <ContextMenuSeparator />
                  <ContextMenuLabel>已勾选 {editing.selection.size} 行{!editing.selection.has(menu.row) ? " · 当前行未勾选" : ""}</ContextMenuLabel>
                  <ContextMenuItem disabled={editing.locked || !editing.selection.has(menu.row) || [...editing.selection].some(row => ["insert", "copy"].includes(editing.rowState?.(row) ?? ""))} onSelect={() => { menuAction.current = editing.batch }}>批量修改已选 {editing.selection.size} 行…</ContextMenuItem>
                  <ContextMenuSub><ContextMenuSubTrigger disabled={editing.locked || !editing.selection.has(menu.row) || [...editing.selection].some(row => ["insert", "copy"].includes(editing.rowState?.(row) ?? ""))}>生成已选行 SQL</ContextMenuSubTrigger><ContextMenuSubContent>
                    {(["SELECT","INSERT","UPDATE","DELETE"] as const).map(kind => <ContextMenuItem key={kind} onSelect={() => { menuAction.current = () => editing.exportSql(kind,menu.column ?? undefined) }}>{kind}</ContextMenuItem>)}
                  </ContextMenuSubContent></ContextMenuSub>
                </> : null}
              </> : null}
            </ContextMenuContent></ContextMenu>
            {selectedRow && state.selectedRow !== null ? <MysqlResultRowDetail columns={result.columns} id={detailId} key={`${state.selectedRow}`} onClose={closeDetail} onCopy={(text, description) => { void copyText(text, description) }} prefix={prefix} row={detailRow!} rowNumber={state.selectedRow + 1} /> : null}
          </div>
          <footer className="mysql-results-footer" data-has-changes={Boolean(editing?.pendingCount) || undefined}>
            <Popover><PopoverTrigger asChild><Button className="mysql-result-metrics" size="xs" variant="ghost" data-testid={`${prefix}-summary`} title={"查询成功 · 已返回 " + result.rowCount + " 行 · 耗时 " + Math.round(result.durationMs) + " ms · " + mysqlByteSize(result.bytes) + (stream ? " · " + stream.message : "")} aria-label="查看查询统计">
              <span>{filter ? filteredRows.length + "/" + result.rowCount : result.rowCount} 行</span><span className="mysql-duration"> · {Math.round(result.durationMs)} ms</span>
            </Button></PopoverTrigger><PopoverContent align="start" className="text-xs"><p className="font-medium">查询成功</p><p>返回 {result.rowCount} 行 · 当前匹配 {filteredRows.length} 行</p><p>耗时 {Math.round(result.durationMs)} ms · {mysqlByteSize(result.bytes)}</p>{stream ? <p data-testid={`${prefix}-load-status`}>{stream.message}</p> : null}</PopoverContent></Popover>
            <div aria-live="polite" className={`mysql-results-status ${notice?.failed ? "text-danger" : ""}`}>{editing?.status || notice?.message}</div>
            {stream ? stream.hasMore || stream.loading ? <Button className="mysql-results-loadmore" data-testid={`${prefix}-load-more`} disabled={stream.loading || Boolean(filter) || Boolean(editing?.locked)} onClick={stream.onLoadMore} size="xs" variant="ghost" aria-label="加载更多数据" title={stream.loading ? "正在加载更多数据" : "加载更多数据"}><CaretDown /><span className="mysql-load-label">{stream.loading ? "加载中…" : "加载更多"}</span></Button> : null : lastPage > 0 ? <div className="mysql-results-pagination">
              <label className="mysql-page-size"><span className="sr-only">每页结果行数</span><SelectControl aria-label="每页结果行数" size="sm" onValueChange={value => changeView({ pageSize: Number(value), page: 0, selectedRow: null })} value={String(state.pageSize)}>{[25, 50, MYSQL_RESULT_PAGE_SIZE].map(size => <SelectItem key={size} value={String(size)}>{size} 行 / 页</SelectItem>)}</SelectControl></label>
              <Button aria-label="上一页结果" disabled={visiblePage === 0} onClick={() => changeView({ page: visiblePage - 1, selectedRow: null })} size="icon-xs" type="button" variant="ghost"><CaretLeft /></Button>
              <span>{visiblePage + 1}/{lastPage + 1}</span>
              <Button aria-label="下一页结果" data-testid={`${prefix}-next-page`} disabled={visiblePage === lastPage} onClick={() => changeView({ page: visiblePage + 1, selectedRow: null })} size="icon-xs" type="button" variant="ghost"><CaretRight /></Button>
            </div> : null}
            {editing?.footer}
          </footer>
        </>
      ) : <div className="min-h-0 flex-1" />}
    </section>
  )
}
