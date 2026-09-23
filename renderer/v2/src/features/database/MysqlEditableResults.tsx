import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowClockwise, Check, Copy, FloppyDisk, Key, PencilSimple, Rows } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api, MysqlEditData, MysqlEditPlan, MysqlEditRow, MysqlEditStatus, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useMysqlEditingGuard } from "./MysqlEditingContext"
import { MysqlResultRowDetail } from "./MysqlResultRowDetail"
import { copyMysqlText } from "./mysql-clipboard"

type Drafts = Record<string, Record<string, string | null>>
interface ActiveCell { rowId: string; name: string; value: string; isNull: boolean; modal: boolean }
const display = (value: string | null | undefined) => value === null ? "NULL" : value === "" ? "（空字符串）" : value
const PAGE_SIZE = 100

export function MysqlEditableResults({ api, scope, documentKey, sql, visible = true, onReload, children }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly documentKey: string; readonly sql: string
  readonly visible?: boolean; readonly onReload: () => void; readonly children: ReactNode
}) {
  const guard = useMysqlEditingGuard()
  const [edit, setEdit] = useState<MysqlEditData | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const draftsRef = useRef(drafts)
  const [selection, setSelection] = useState(new Set<string>())
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null)
  const activeRef = useRef<ActiveCell | null>(null)
  const [busy, setBusy] = useState<"open" | "prepare" | "commit" | null>(null)
  const busyRef = useRef(busy)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [conflicts, setConflicts] = useState(new Set<string>())
  const [plan, setPlan] = useState<MysqlEditPlan | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState(false)
  const [filter, setFilter] = useState("")
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ name: string; descending: boolean } | null>(null)
  const [detailRow, setDetailRow] = useState<string | null>(null)
  const [batch, setBatch] = useState(false)
  const [batchColumn, setBatchColumn] = useState("")
  const [batchValue, setBatchValue] = useState("")
  const [batchNull, setBatchNull] = useState(false)
  const selectedAnchor = useRef<string | null>(null)
  const shiftSelection = useRef(false)
  const alive = useRef(false)
  const editRef = useRef(edit)
  const serial = useRef(0)
  const connectionEpoch = useRef(guard.connectionEpoch)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const setWorking = (value: typeof busy) => { busyRef.current = value; setBusy(value) }
  const updateDrafts = (value: Drafts) => { draftsRef.current = value; setDrafts(value) }
  const setCell = (value: ActiveCell | null) => { activeRef.current = value; setActiveCell(value) }
  editRef.current = edit
  const rowMap = useMemo(() => new Map(edit?.rows.map(row => [row.rowId, row]) ?? []), [edit])
  const pendingRows = Object.keys(drafts)
  const cellCount = Object.values(drafts).reduce((count, values) => count + Object.keys(values).length, 0)
  const locked = Boolean(busy || uncertain || stale || !guard.connected)
  useEffect(() => {
    alive.current = true
    const unregister = guard.register(documentKey, () => ({
      busy: busyRef.current === "commit" || busyRef.current === "prepare",
      dirty: Object.keys(draftsRef.current).length > 0 || Boolean(activeRef.current && (activeRef.current.isNull ? null : activeRef.current.value) !== editRef.current?.rows.find(row => row.rowId === activeRef.current?.rowId)?.values[activeRef.current.name]),
      discard: () => { updateDrafts({}); setCell(null); setPlan(null) },
    }))
    return () => {
      alive.current = false; serial.current++; unregister(); guard.setEditing(documentKey, false)
      const current = editRef.current
      if (current) void api.mysqlEditRelease({ ...scope, editId: current.editId }).catch(() => {})
    }
  }, [api, documentKey, scope.projectId, scope.environmentId, scope.pluginInstanceId, guard.register])
  useEffect(() => { if (!guard.connected && edit) { setStale(true); setError("连接已中断。草稿保留在当前标签，请重新加载后核对修改。") } }, [guard.connected, edit])
  useEffect(() => { if (connectionEpoch.current !== guard.connectionEpoch && editRef.current) { setStale(true); setError("连接已变化，旧数据不能继续保存。请重新加载并核对修改。") }; connectionEpoch.current = guard.connectionEpoch }, [guard.connectionEpoch])
  useEffect(() => { if (activeCell) inputRef.current?.focus() }, [activeCell?.rowId, activeCell?.name, activeCell?.modal])

  function applyValue(rowId: string, name: string, value: string | null, source = draftsRef.current): Drafts {
    const original = rowMap.get(rowId)?.values[name]
    const values: Record<string, string | null> = Object.assign(Object.create(null), source[rowId])
    const next: Drafts = { ...source, [rowId]: values }
    if (original === value) delete values[name]
    else values[name] = value
    if (!Object.keys(values).length) delete next[rowId]
    if (Object.keys(next).length > (edit?.limits.maxRows ?? 100)) { toast.error("每批最多暂存 100 行修改，请先保存当前修改。"); return source }
    return next
  }
  function finishCell(cancel = false) {
    const active = activeRef.current
    if (!active) return
    if (!cancel) updateDrafts(applyValue(active.rowId, active.name, active.isNull ? null : active.value))
    setCell(null)
  }
  function currentValue(row: MysqlEditRow, name: string) {
    return Object.hasOwn(drafts[row.rowId] ?? {}, name) ? drafts[row.rowId]?.[name] ?? null : row.values[name] ?? null
  }
  function focusCell(rowId: string, name: string) {
    window.setTimeout(() => rootRef.current?.querySelector<HTMLButtonElement>('[data-edit-row="' + CSS.escape(rowId) + '"] [data-edit-column="' + CSS.escape(name) + '"] button')?.focus(), 0)
  }
  function moveCell(rowId: string, name: string, direction: string, backwards = false) {
    const index = rows.findIndex(row => row.rowId === rowId), column = edit?.columns.findIndex(item => item.name === name) ?? -1
    const nextRow = rows[index + (direction === "ArrowDown" || direction === "Enter" ? 1 : direction === "ArrowUp" ? -1 : 0)]
    const nextColumn = edit?.columns[column + (direction === "ArrowRight" || (direction === "Tab" && !backwards) ? 1 : direction === "ArrowLeft" || direction === "Tab" ? -1 : 0)]
    finishCell()
    focusCell(nextRow?.rowId ?? rowId, nextColumn?.name ?? name)
  }
  function beginCell(row: MysqlEditRow, name: string, modal = false) {
    if (locked || !edit?.columns.find(column => column.name === name)?.editable) return
    finishCell()
    const value = Object.hasOwn(draftsRef.current[row.rowId] ?? {}, name) ? draftsRef.current[row.rowId]?.[name] ?? null : row.values[name] ?? null
    const column = edit?.columns.find(item => item.name === name)
    setCell({ rowId: row.rowId, name, value: value ?? "", isNull: value === null, modal: modal || column?.dataType === "json" || (value?.length ?? 0) > 180 || Boolean(value?.includes("\n")) })
  }
  async function open() {
    if (busyRef.current || !guard.connected) return
    const ticket = ++serial.current
    setWorking("open"); setError(""); setNotice("")
    try {
      const response = await api.mysqlEditOpen({ ...scope, sql })
      if (!response.ok) throw new Error(response.error.message)
      if (!alive.current || ticket !== serial.current) { void api.mysqlEditRelease({ ...scope, editId: response.data.editId }).catch(() => {}); return }
      if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
      setEdit(response.data); editRef.current = response.data; guard.setEditing(documentKey, true)
      updateDrafts({}); setSelection(new Set()); setConflicts(new Set()); setStale(false); setUncertain(false); setPlan(null); setCell(null); setPage(0)
      setNotice(response.data.auditWarning ? "已读取可编辑数据，但读取记录保存失败。修改先暂存，保存后才写入数据库。" : "已重新读取可编辑数据。修改先暂存，保存后才写入数据库。")
    } catch (failure) {
      if (alive.current && ticket === serial.current) setError(failure instanceof Error ? failure.message : "无法进入编辑模式")
    } finally { if (alive.current && ticket === serial.current) setWorking(null) }
  }
  function reset(action: () => void) { finishCell(); guard.protect(action, [documentKey]) }
  function leave() {
    reset(() => {
      if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
      setEdit(null); editRef.current = null; guard.setEditing(documentKey, false); updateDrafts({}); setCell(null); setPlan(null); setError(""); setNotice("")
      onReload()
    })
  }
  async function prepare() {
    finishCell()
    if (!edit || busyRef.current || locked) return
    const changes = Object.entries(draftsRef.current).map(([rowId, values]) => ({ rowId, values }))
    if (!changes.length) return
    setWorking("prepare"); setError(""); setNotice("")
    try {
      const response = await api.mysqlEditPrepare({ ...scope, editId: edit.editId, changes })
      if (!response.ok) { if (response.error.code === "MYSQL_EDIT_STALE") setStale(true); throw new Error(response.error.message) }
      if (alive.current) setPlan(response.data)
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "无法准备保存") }
    finally { if (alive.current) setWorking(null) }
  }
  function acceptResult(result: MysqlEditStatus) {
    if (result.status === "success" && result.result) {
      const updated = new Map(result.result.rows.map(row => [row.rowId, row]))
      setEdit(current => current ? { ...current, rows: current.rows.map(row => updated.get(row.rowId) ?? row) } : current)
      updateDrafts({}); setConflicts(new Set()); setPlan(null); setUncertain(false); setError("")
      setNotice(result.result.auditWarning ? "数据已保存，但操作记录写入失败。请检查本地存储。" : "已保存 " + result.result.rowCount + " 行修改。")
    } else if (result.status === "running") {
      setUncertain(true); setError("保存仍在进行，请稍后检查保存状态。不要重复提交。")
    } else {
      setUncertain(result.status === "unknown"); setError(result.error?.message ?? "保存未完成")
      setConflicts(new Set(result.error?.details?.rowIds ?? []))
      if (["MYSQL_EDIT_STALE", "MYSQL_EDIT_SCHEMA_CHANGED", "MYSQL_EDIT_CONFLICT"].includes(result.error?.code ?? "")) setStale(true)
      if (result.status !== "unknown") setPlan(null)
      const first = result.error?.details?.rowIds?.[0]
      if (first) { setFilter(""); const index = edit?.rows.findIndex(row => row.rowId === first) ?? -1; if (index >= 0) setPage(Math.floor(index / PAGE_SIZE)); setSort(null) }
    }
  }
  async function commit(checkOnly = false) {
    if (!edit || !plan || busyRef.current) return
    setWorking("commit")
    try {
      const payload = { ...scope, editId: edit.editId, planId: plan.planId }
      const response = checkOnly ? await api.mysqlEditStatus(payload) : await api.mysqlEditCommit(payload)
      if (!response.ok) {
        if (response.error.code === "MYSQL_EDIT_STALE") { setStale(true); setPlan(null) }
        throw new Error(response.error.message)
      }
      if (alive.current) acceptResult(response.data)
    } catch (failure) {
      if (alive.current) { setUncertain(true); setError((failure instanceof Error ? failure.message : "未能取得保存结果") + "。请检查保存状态或重新查询核实，不要重复提交。") }
    } finally { if (alive.current) setWorking(null) }
  }
  const filtered = useMemo(() => {
    const text = filter.toLocaleLowerCase()
    const rows = (edit?.rows ?? []).filter(row => !text || edit?.columns.some(column => (currentValue(row, column.name) ?? "NULL").toLocaleLowerCase().includes(text)))
    if (sort) rows.sort((a, b) => {
      const first = currentValue(a, sort.name) ?? "", second = currentValue(b, sort.name) ?? ""
      return first.localeCompare(second, "zh-CN", { numeric: true }) * (sort.descending ? -1 : 1)
    })
    return rows
  }, [edit, filter, sort, drafts])
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  function selectRow(rowId: string, checked: boolean, shift = false) {
    const next = new Set(selection)
    const anchor = rows.findIndex(row => row.rowId === selectedAnchor.current)
    const index = rows.findIndex(row => row.rowId === rowId)
    const targets = shift && anchor >= 0 ? rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(row => row.rowId) : [rowId]
    for (const id of targets) { if (checked) next.add(id); else next.delete(id) }
    if (next.size > (edit?.limits.maxRows ?? 100)) { toast.info("每批最多选择 100 行，请分批修改。"); return }
    selectedAnchor.current = rowId; setSelection(next)
  }
  function applyBatch() {
    if (!batchColumn || !selection.size || locked) return
    let next = draftsRef.current
    for (const rowId of selection) next = applyValue(rowId, batchColumn, batchNull ? null : batchValue, next)
    updateDrafts(next); setBatch(false)
    setNotice("已向选中的 " + selection.size + " 行暂存赋值，点击保存才会写入数据库。")
  }
  if (!visible && (edit || documentKey.startsWith("table:"))) return null
  if (!edit) return <div className="mysql-edit-container">
    <div className="mysql-edit-entry">
      <span>有主键的单表结果可进入编辑模式</span>
      <Button data-testid="mysql-edit-open" disabled={Boolean(busy) || !guard.connected || !sql} onClick={() => void open()} size="xs" variant="outline"><PencilSimple />{busy === "open" ? "检查并加载…" : "编辑数据"}</Button>
    </div>
    {error ? <p className="mysql-edit-message is-error" role="alert">{error}</p> : null}
    <div className="mysql-edit-readonly">{children}</div>
  </div>
  const allSelected = rows.length > 0 && rows.every(row => selection.has(row.rowId))
  const someSelected = rows.some(row => selection.has(row.rowId))
  const batchMetadata = edit.columns.find(column => column.name === batchColumn)
  return <div className="mysql-edit-container" data-testid="mysql-data-editor" style={{ position: "relative" }} ref={rootRef} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!batch && !plan) void prepare() }
  }}>
    <div className="mysql-edit-toolbar">
      <span className="mysql-edit-mode"><PencilSimple />编辑模式</span><strong className="font-mono">{edit.table}</strong>
      <Input aria-label="筛选可编辑数据" className="ml-auto h-7 w-44 text-xs" placeholder="筛选当前数据…" value={filter} onChange={event => { setFilter(event.target.value); setPage(0) }} />
      <Button size="xs" variant="ghost" disabled={Boolean(busy) || !guard.connected} data-testid="mysql-edit-refresh" aria-label="重新加载编辑数据" onClick={() => reset(() => void open())} title="重新加载编辑数据"><ArrowClockwise /></Button>
      <Button size="xs" variant="outline" disabled={Boolean(busy)} data-testid="mysql-edit-leave" onClick={leave}>退出编辑</Button>
    </div>
    <div className="mysql-edit-selection">
      <span>已选 <strong>{selection.size}</strong> 行</span>
      <Button size="xs" variant="outline" disabled={!selection.size || locked} data-testid="mysql-edit-batch" onClick={() => { finishCell(); setBatchColumn(edit.columns.find(column => column.editable)?.name ?? ""); setBatchValue(""); setBatchNull(false); setBatch(true) }}><Rows />批量赋值</Button>
      {selection.size ? <Button size="xs" variant="ghost" onClick={() => setSelection(new Set())}>取消选择</Button> : null}
      <span className="ml-auto text-muted-foreground">单击字段编辑 · Shift 连选 · 每批最多 {edit.limits.maxRows} 行</span>
    </div>
    {error || notice ? <p className={"mysql-edit-message" + (error ? " is-error" : "")} role={error ? "alert" : "status"}>{error || notice}{uncertain && plan ? <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => void commit(true)}>检查保存状态</Button> : null}</p> : null}
    {edit.truncated ? <p className="mysql-edit-message">仅加载了当前查询允许的部分数据，修改仅影响明确选中的行。</p> : null}
    <div className="mysql-edit-scroll" role="region" aria-label="可编辑数据表" tabIndex={0}>
      <table className="mysql-edit-table">
        <thead><tr><th className="mysql-edit-row-selector"><Checkbox aria-label="选择当前页全部行" checked={allSelected ? true : someSelected ? "indeterminate" : false} disabled={locked || !rows.length} onCheckedChange={checked => {
          const next = new Set(selection); for (const row of rows) { if (checked) next.add(row.rowId); else next.delete(row.rowId) }
          if (next.size > edit.limits.maxRows) toast.info("每批最多选择 100 行，请先取消其他页的选择。"); else setSelection(next)
        }} /></th><th className="mysql-edit-number">#</th>{edit.columns.map(column => <th key={column.name}><button type="button" onClick={() => { finishCell(); setSort({ name: column.name, descending: sort?.name === column.name ? !sort.descending : false }) }} title={column.type + (column.reason ? " · " + column.reason : "")}>{column.primary ? <Key /> : null}{column.name}<span>{sort?.name === column.name ? sort.descending ? "↓" : "↑" : ""}</span></button><small>{column.type}</small></th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.rowId} data-edit-row={row.rowId} data-selected={selection.has(row.rowId) || undefined} data-conflict={conflicts.has(row.rowId) || undefined}>
          <td className="mysql-edit-row-selector" onPointerDown={event => { shiftSelection.current = event.shiftKey }}><Checkbox aria-label={"选择第 " + (currentPage * PAGE_SIZE + index + 1) + " 行"} checked={selection.has(row.rowId)} disabled={locked} onCheckedChange={checked => { selectRow(row.rowId, checked === true, shiftSelection.current); shiftSelection.current = false }} /></td>
          <td className="mysql-edit-number"><button type="button" title="查看行详情" aria-label={"查看第 " + (currentPage * PAGE_SIZE + index + 1) + " 行详情"} onClick={() => { finishCell(); setDetailRow(row.rowId) }}>{currentPage * PAGE_SIZE + index + 1}</button></td>
          {edit.columns.map(column => {
            const value = currentValue(row, column.name), dirty = Object.hasOwn(drafts[row.rowId] ?? {}, column.name)
            const active = activeCell?.rowId === row.rowId && activeCell.name === column.name && !activeCell.modal
            return <td key={column.name} data-edit-column={column.name} data-dirty={dirty || undefined} data-readonly={!column.editable || undefined}>
              {active ? <Input ref={element => { inputRef.current = element }} className="mysql-cell-input" aria-label={"编辑 " + column.name} defaultValue={activeCell.value} onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false } }} onPaste={event => {
                const pasted = event.clipboardData.getData("text/plain")
                if (!/[\r\n]/u.test(pasted) || !activeRef.current) return
                event.preventDefault()
                const input = event.currentTarget, original = activeRef.current.value
                setCell({ ...activeRef.current, value: original.slice(0, input.selectionStart ?? 0) + pasted + original.slice(input.selectionEnd ?? original.length), isNull: false, modal: true })
              }} onBlur={() => { if (!activeRef.current?.modal) finishCell() }} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); moveCell(row.rowId, column.name, event.key, event.shiftKey) }
                if (event.key === "Escape") { event.preventDefault(); finishCell(true); focusCell(row.rowId, column.name) }
              }} /> : <button className="mysql-edit-cell" type="button" disabled={Boolean(busy)} aria-label={column.name + "：" + display(value)} title={dirty ? "原值：" + display(row.values[column.name]) + "\n新值：" + display(value) : column.reason ?? display(value)} onClick={() => beginCell(row, column.name)} onKeyDown={event => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void copyMysqlText(value ?? "NULL").then(() => toast.success("已复制"), () => toast.error("复制失败")) }
                if (event.key.startsWith("Arrow")) { event.preventDefault(); moveCell(row.rowId, column.name, event.key) }
                if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); beginCell(row, column.name, true) }
              }} onContextMenu={event => { event.preventDefault(); beginCell(row, column.name, true) }}>
                <span className={value === null ? "mysql-edit-null" : ""}>{display(value)}</span>{dirty ? <span className="mysql-edit-dirty-dot" aria-label="已修改" /> : null}
              </button>}
            </td>
          })}
        </tr>)}</tbody>
      </table>
      {!rows.length ? <div className="mysql-edit-empty">没有符合条件的数据。</div> : null}
    </div>
    {detailRow && rowMap.get(detailRow) ? <MysqlResultRowDetail id={documentKey + "-edit-detail"} prefix="mysql-edit" columns={edit.columns.map(column => ({ name: column.name, table: edit.table, type: 253 }))} row={Object.fromEntries(edit.columns.map(column => [column.name, currentValue(rowMap.get(detailRow)!, column.name)]))} rowNumber={edit.rows.findIndex(row => row.rowId === detailRow) + 1} onClose={() => setDetailRow(null)} onCopy={(text, description) => void copyMysqlText(text).then(() => toast.success(description), () => toast.error("复制失败"))} /> : null}
    <footer className="mysql-edit-footer">
      <span>{filtered.length} 行 · 第 {currentPage + 1} / {lastPage + 1} 页</span>
      <Button size="xs" variant="ghost" disabled={currentPage === 0} onClick={() => { finishCell(); setPage(currentPage - 1) }}>上一页</Button>
      <Button size="xs" variant="ghost" disabled={currentPage >= lastPage} onClick={() => { finishCell(); setPage(currentPage + 1) }}>下一页</Button>
      <strong className="ml-auto" data-testid="mysql-edit-dirty-count">{pendingRows.length ? pendingRows.length + " 行 · " + cellCount + " 处待保存" : "尚无待保存修改"}</strong>
      <Button size="xs" variant="outline" disabled={Boolean(busy) || !pendingRows.length} onClick={() => reset(() => { updateDrafts({}); setCell(null); setNotice("已撤销本地修改。") })}>撤销修改</Button>
      <Button size="xs" data-testid="mysql-edit-save" disabled={locked || (!pendingRows.length && !activeCell)} onClick={() => void prepare()}><FloppyDisk />{busy === "commit" ? "保存中…" : busy === "prepare" ? "准备中…" : "保存修改"}</Button>
    </footer>
    <Dialog open={batch} onOpenChange={setBatch}>
      <DialogContent className="sm:max-w-lg" data-testid="mysql-edit-batch-dialog">
        <DialogHeader><DialogTitle>向选中的 {selection.size} 行统一赋值</DialogTitle><DialogDescription>所有选中行的指定字段将暂存为同一个值，点击保存后才写入数据库。</DialogDescription></DialogHeader>
        <label className="grid gap-2 text-xs">修改字段<SelectControl aria-label="批量修改字段" value={batchColumn} onValueChange={value => { setBatchColumn(value); setBatchNull(false) }}>{edit.columns.filter(column => column.editable).map(column => <SelectItem key={column.name} value={column.name}>{column.name} · {column.type}</SelectItem>)}</SelectControl></label>
        <label className="grid gap-2 text-xs">新值<textarea className="mysql-edit-textarea" aria-label="批量赋值的新值" value={batchValue} disabled={batchNull} onChange={event => setBatchValue(event.target.value)} rows={4} /></label>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={batchNull} disabled={!batchMetadata?.nullable} onCheckedChange={value => setBatchNull(value === true)} />设为 NULL{!batchMetadata?.nullable ? "（此字段不允许）" : ""}</label>
        <DialogFooter><Button variant="outline" onClick={() => setBatch(false)}>取消</Button><Button data-testid="mysql-edit-apply-batch" disabled={!batchColumn || locked} onClick={applyBatch}>应用到选中行</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(activeCell?.modal)} onOpenChange={open => { if (!open) finishCell(true) }}>
      <DialogContent className="sm:max-w-2xl" data-testid="mysql-edit-cell-dialog">
        <DialogHeader><DialogTitle>编辑字段 {activeCell?.name}</DialogTitle><DialogDescription>支持多行文本。空字符串与 NULL 是不同的值。</DialogDescription></DialogHeader>
        {activeCell?.modal ? <textarea ref={element => { inputRef.current = element }} className="mysql-edit-textarea" aria-label={"编辑 " + activeCell.name} defaultValue={activeCell.value} rows={12} onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false } }} /> : null}
        <DialogFooter><Button variant="ghost" onClick={() => { if (activeCell) void copyMysqlText(activeRef.current?.value ?? "").then(() => toast.success("已复制"), () => toast.error("复制失败")) }}><Copy />复制</Button><Button variant="outline" disabled={!edit.columns.find(column => column.name === activeCell?.name)?.nullable} onClick={() => { if (activeRef.current) activeRef.current.isNull = true; finishCell() }}>设为 NULL</Button><Button variant="outline" onClick={() => finishCell(true)}>取消</Button><Button onClick={() => finishCell()}>暂存修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(plan) && !uncertain} onOpenChange={open => { if (!open && !busy) setPlan(null) }}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }} data-testid="mysql-edit-confirm-dialog">
        <DialogHeader><DialogTitle>确认保存 {plan?.rowCount} 行修改</DialogTitle><DialogDescription>{edit.table} · {plan?.cellCount} 个字段值。保存时会核对原值，冲突或失败时整批撤销。</DialogDescription></DialogHeader>
        <div className="mysql-edit-review">{plan?.changes.map(change => <section key={change.rowId}><h4>{Object.entries(change.keys).map(([name, value]) => name + " = " + display(value)).join(" · ")}</h4>{change.values.map(value => <div key={value.name}><strong>{value.name}</strong><pre>{display(value.original)}</pre><span aria-hidden="true">→</span><pre>{display(value.value)}</pre></div>)}</section>)}</div>
        <DialogFooter><Button variant="outline" disabled={Boolean(busy)} onClick={() => setPlan(null)}>继续编辑</Button><Button data-testid="mysql-edit-confirm-save" disabled={Boolean(busy) || !guard.connected} onClick={() => void commit()}><Check />{busy === "commit" ? "正在保存…" : "确认保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
