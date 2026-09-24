import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowClockwise, Copy, FloppyDisk, Rows, ArrowCounterClockwise } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api, MysqlEditData, MysqlEditPlan, MysqlEditRow, MysqlEditStatus, MysqlQueryResult, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useMysqlEditingGuard } from "./MysqlEditingContext"
import { MysqlInlineEditingContext, type MysqlInlineEditing } from "./MysqlInlineEditingContext"
import { bindMysqlEditRows, mysqlEditValueMatches, type MysqlDisplayedRow } from "./mysql-inline-edit-model"
import { copyMysqlText } from "./mysql-clipboard"

type Drafts = Record<string, Record<string, string | null>>
interface ActiveCell { rowId: string; name: string; value: string; isNull: boolean; modal: boolean }

export function MysqlEditableResults({ api, scope, documentKey, sql, result, visible = true, onReload, children }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly documentKey: string; readonly sql: string; readonly result: MysqlQueryResult
  readonly visible?: boolean; readonly onReload: () => void; readonly children: ReactNode
}) {
  const guard = useMysqlEditingGuard()
  const [edit, setEdit] = useState<MysqlEditData | null>(null)
  const editRef = useRef(edit)
  const [drafts, setDrafts] = useState<Drafts>({})
  const draftsRef = useRef(drafts)
  const [selection, setSelection] = useState(new Set<MysqlDisplayedRow>())
  const [saved, setSaved] = useState(new Map<MysqlDisplayedRow, Record<string, string | null>>())
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
  const [batch, setBatch] = useState(false)
  const [batchColumn, setBatchColumn] = useState("")
  const [batchValue, setBatchValue] = useState("")
  const [batchNull, setBatchNull] = useState(false)
  const alive = useRef(false)
  const serial = useRef(0)
  const connectionEpoch = useRef(guard.connectionEpoch)
  const currentResult = useRef(result)
  currentResult.current = result
  const connected = useRef(guard.connected)
  connected.current = guard.connected
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const setWorking = (value: typeof busy) => { busyRef.current = value; setBusy(value) }
  const updateDrafts = (value: Drafts) => { draftsRef.current = value; setDrafts(value) }
  const setCell = (value: ActiveCell | null) => { activeRef.current = value; setActiveCell(value) }
  editRef.current = edit
  const rowMap = useMemo(() => new Map(edit?.rows.map(row => [row.rowId, row]) ?? []), [edit])
  const bindings = useMemo(() => edit ? bindMysqlEditRows(result.rows, edit) : new Map<MysqlDisplayedRow, MysqlEditRow>(), [result, edit])
  const pendingRows = Object.keys(drafts)
  const cellCount = Object.values(drafts).reduce((count, values) => count + Object.keys(values).length, 0)
  const locked = Boolean(busy || uncertain || stale || !guard.connected)
  useEffect(() => {
    alive.current = true
    const unregister = guard.register(documentKey, () => ({
      busy: Boolean(busyRef.current),
      dirty: Object.keys(draftsRef.current).length > 0 || Boolean(activeRef.current && (activeRef.current.isNull ? null : activeRef.current.value) !== editRef.current?.rows.find(row => row.rowId === activeRef.current?.rowId)?.values[activeRef.current.name]),
      discard: () => { updateDrafts({}); setCell(null); setPlan(null) },
    }))
    return () => {
      alive.current = false; serial.current++; unregister(); guard.setEditing(documentKey, false)
      if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
    }
  }, [api, documentKey, scope.projectId, scope.environmentId, scope.pluginInstanceId, guard.register])
  useEffect(() => {
    if (!guard.connected && edit) { setStale(true); setError("连接已中断，草稿已保留。重新连接后请刷新并核对修改。") }
  }, [guard.connected, edit])
  useEffect(() => {
    if (connectionEpoch.current !== guard.connectionEpoch && editRef.current) { setStale(true); setError("连接已变化，旧数据不能继续保存。请刷新并核对修改。") }
    connectionEpoch.current = guard.connectionEpoch
  }, [guard.connectionEpoch])
  useEffect(() => { if (activeCell) inputRef.current?.focus({ preventScroll: true }) }, [activeCell?.rowId, activeCell?.name, activeCell?.modal])

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
  function valueOf(row: MysqlDisplayedRow, name: string, fallback: unknown): unknown {
    const target = bindings.get(row)
    if (target && Object.hasOwn(drafts[target.rowId] ?? {}, name)) return drafts[target.rowId]![name]
    const committed = saved.get(row)
    return committed && Object.hasOwn(committed, name) ? committed[name] : fallback
  }
  function focusCell(rowId: string, name: string, direction = "", backwards = false) {
    window.setTimeout(() => {
      const row = rootRef.current?.querySelector<HTMLTableRowElement>('[data-edit-row="' + CSS.escape(rowId) + '"]')
      const cell = row?.querySelector<HTMLTableCellElement>('[data-edit-column="' + CSS.escape(name) + '"]')
      let target: Element | null | undefined = cell
      if (direction === "ArrowDown" || direction === "Enter") target = row?.nextElementSibling?.querySelector('[data-edit-column="' + CSS.escape(name) + '"]') ?? cell
      if (direction === "ArrowUp") target = row?.previousElementSibling?.querySelector('[data-edit-column="' + CSS.escape(name) + '"]') ?? cell
      if (direction === "ArrowRight" || (direction === "Tab" && !backwards)) target = cell?.nextElementSibling ?? cell
      if (direction === "ArrowLeft" || (direction === "Tab" && backwards)) target = cell?.previousElementSibling?.hasAttribute("data-edit-column") ? cell.previousElementSibling : cell
      ;(target as HTMLElement | null)?.focus({ preventScroll: true })
    }, 0)
  }
  async function ensureSnapshot(targets: readonly MysqlDisplayedRow[]): Promise<MysqlEditData | null> {
    if (busyRef.current || !connected.current) return null
    if (editRef.current) {
      const captured = bindMysqlEditRows(result.rows, editRef.current)
      if (targets.every(row => captured.has(row))) return editRef.current
      if (Object.keys(draftsRef.current).length) { toast.info("请先保存或撤销当前修改，再编辑新加载的行。"); return null }
      void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
      editRef.current = null; setEdit(null)
    }
    const ticket = ++serial.current, source = result, epoch = connectionEpoch.current
    setWorking("open"); setError(""); setNotice("")
    try {
      const response = await api.mysqlEditOpen({ ...scope, sql })
      if (!response.ok) throw new Error(response.error.message)
      if (!alive.current || ticket !== serial.current || source !== currentResult.current || epoch !== connectionEpoch.current || !connected.current) {
        void api.mysqlEditRelease({ ...scope, editId: response.data.editId }).catch(() => {})
        return null
      }
      setEdit(response.data); editRef.current = response.data; guard.setEditing(documentKey, true)
      if (response.data.auditWarning) setNotice("数据已读取，但操作记录保存失败。")
      return response.data
    } catch (failure) {
      if (alive.current) { const message = failure instanceof Error ? failure.message : "此结果暂不支持编辑"; setError(message); toast.error(message) }
      return null
    } finally { if (alive.current && ticket === serial.current) setWorking(null) }
  }
  function matchedRow(data: MysqlEditData, row: MysqlDisplayedRow, name: string): MysqlEditRow {
    const target = bindMysqlEditRows(result.rows, data).get(row)
    if (!target) throw new Error("无法按完整主键定位此行。请先保存当前修改，再刷新结果后编辑。")
    const column = data.columns.find(item => item.name === name)
    if (!column?.editable) throw new Error(column?.reason ?? "此字段只读")
    const shown = valueOf(row, name, row[name])
    const captured = Object.hasOwn(draftsRef.current[target.rowId] ?? {}, name) ? draftsRef.current[target.rowId]![name]! : target.values[name] ?? null
    if (!mysqlEditValueMatches(shown, captured)) throw new Error("此字段已变化或显示值无法无损核对，请刷新结果后再编辑。")
    return target
  }
  async function beginCell(source: MysqlDisplayedRow, name: string, modal = false) {
    if (locked || busyRef.current) return
    finishCell()
    const data = await ensureSnapshot([source])
    if (!data || !alive.current || !connected.current) return
    try {
      const row = matchedRow(data, source, name)
      const value = Object.hasOwn(draftsRef.current[row.rowId] ?? {}, name) ? draftsRef.current[row.rowId]![name] ?? null : row.values[name] ?? null
      const column = data.columns.find(item => item.name === name)
      setError(""); setCell({ rowId: row.rowId, name, value: value ?? "", isNull: value === null, modal: modal || column?.dataType === "json" || (value?.length ?? 0) > 180 || Boolean(value?.includes("\n")) })
    } catch (failure) { const message = failure instanceof Error ? failure.message : "无法编辑此字段"; setError(message); toast.error(message) }
  }
  function reset(action: () => void) { finishCell(); guard.protect(action, [documentKey]) }
  function refresh() {
    reset(() => {
      if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
      setEdit(null); editRef.current = null; guard.setEditing(documentKey, false)
      updateDrafts({}); setCell(null); setPlan(null); setError(""); setNotice(""); setUncertain(false); setStale(false); setConflicts(new Set()); setSelection(new Set()); setSaved(new Map())
      onReload()
    })
  }
  function acceptResult(status: MysqlEditStatus) {
    if (status.status === "success" && status.result) {
      const updated = new Map(status.result.rows.map(row => [row.rowId, row]))
      setSaved(previous => {
        const next = new Map(previous)
        for (const [source, target] of bindings) { const row = updated.get(target.rowId); if (row) next.set(source, row.values) }
        return next
      })
      setEdit(current => current ? { ...current, rows: current.rows.map(row => updated.get(row.rowId) ?? row) } : current)
      updateDrafts({}); setConflicts(new Set()); setPlan(null); setUncertain(false); setError("")
      setNotice(status.result.auditWarning ? "数据已保存，但操作记录写入失败。" : "已保存 " + status.result.rowCount + " 行修改。")
    } else if (status.status === "running") { setUncertain(true); setError("保存仍在进行，请检查保存状态，不要重复提交。") }
    else {
      setUncertain(status.status === "unknown"); setError(status.error?.message ?? "保存未完成")
      setConflicts(new Set(status.error?.details?.rowIds ?? []))
      if (["MYSQL_EDIT_STALE", "MYSQL_EDIT_SCHEMA_CHANGED", "MYSQL_EDIT_CONFLICT"].includes(status.error?.code ?? "")) setStale(true)
      if (status.status !== "unknown") setPlan(null)
    }
  }
  async function commit(prepared: MysqlEditPlan, checkOnly = false) {
    if (!editRef.current) return
    setWorking("commit")
    try {
      const payload = { ...scope, editId: editRef.current.editId, planId: prepared.planId }
      const response = checkOnly ? await api.mysqlEditStatus(payload) : await api.mysqlEditCommit(payload)
      if (!response.ok) throw new Error(response.error.message)
      if (alive.current) acceptResult(response.data)
    } catch (failure) {
      if (alive.current) { setUncertain(true); setError((failure instanceof Error ? failure.message : "未能取得保存结果") + "。请检查保存状态或重新查询核实，不要重复提交。") }
    } finally { if (alive.current) setWorking(null) }
  }
  async function save() {
    finishCell()
    if (!edit || busyRef.current || locked) return
    const changes = Object.entries(draftsRef.current).map(([rowId, values]) => ({ rowId, values }))
    if (!changes.length) return
    setWorking("prepare"); setError(""); setNotice("")
    try {
      const response = await api.mysqlEditPrepare({ ...scope, editId: edit.editId, changes })
      if (!response.ok) { if (response.error.code === "MYSQL_EDIT_STALE") setStale(true); throw new Error(response.error.message) }
      if (!alive.current) return
      setPlan(response.data)
      // 点击保存即授权本次精确修改，仍由后端生成并消费一次性保存计划。
      await commit(response.data)
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "无法保存") }
    finally { if (alive.current) setWorking(null) }
  }
  async function openBatch() {
    if (locked || busyRef.current || !selection.size) return
    finishCell()
    const data = await ensureSnapshot([...selection])
    if (!data || !alive.current) return
    setBatchColumn(data.columns.find(column => column.editable)?.name ?? ""); setBatchValue(""); setBatchNull(false); setBatch(true)
  }
  function applyBatch() {
    if (!edit || !batchColumn || !selection.size || locked) return
    try {
      const targets = [...selection].map(row => matchedRow(edit, row, batchColumn))
      let next = draftsRef.current
      for (const row of targets) next = applyValue(row.rowId, batchColumn, batchNull ? null : batchValue, next)
      updateDrafts(next); setBatch(false); setError("")
    } catch (failure) { const message = failure instanceof Error ? failure.message : "无法批量赋值"; setError(message); toast.error(message) }
  }
  const controller: MysqlInlineEditing = {
    locked, selection,
    select: (rows, checked) => {
      const next = new Set(selection)
      for (const row of rows) { if (checked) next.add(row); else next.delete(row) }
      if (next.size > 100) toast.info("每批最多选择 100 行。")
      else setSelection(next)
    },
    value: valueOf,
    rowId: row => bindings.get(row)?.rowId,
    conflict: row => conflicts.has(bindings.get(row)?.rowId ?? ""),
    dirty: (row, name) => Object.hasOwn(drafts[bindings.get(row)?.rowId ?? ""] ?? {}, name),
    begin: (row, name, modal) => { void beginCell(row, name, modal) },
    finish: () => finishCell(),
    cell: (source, name, content) => {
      const row = bindings.get(source)
      if (!row || activeCell?.rowId !== row.rowId || activeCell.name !== name || activeCell.modal) return content
      return <Input ref={element => { inputRef.current = element }} className="mysql-inline-input" aria-label={"编辑 " + name} defaultValue={activeCell.value}
        onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false } }}
        onPaste={event => {
          const pasted = event.clipboardData.getData("text/plain")
          if (!/[\r\n]/u.test(pasted) || !activeRef.current) return
          event.preventDefault()
          const input = event.currentTarget, original = activeRef.current.value
          setCell({ ...activeRef.current, value: original.slice(0, input.selectionStart ?? 0) + pasted + original.slice(input.selectionEnd ?? original.length), isNull: false, modal: true })
        }}
        onBlur={() => { if (!activeRef.current?.modal) finishCell() }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save() }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); finishCell(); focusCell(row.rowId, name, event.key, event.shiftKey) }
          if (event.key === "Escape") { event.preventDefault(); finishCell(true); focusCell(row.rowId, name) }
        }} />
    },
    status: <span title={error || notice || "双击编辑 · Ctrl+C 复制 · 点击行号查看详情"} className={error ? "text-danger" : ""} role="status">
      <span data-testid="mysql-edit-dirty-count">{pendingRows.length ? pendingRows.length + " 行 · " + cellCount + " 处待保存" : busy === "open" ? "正在核对可编辑字段…" : error || notice || "双击编辑 · Ctrl+C 复制"}</span>
      {error && pendingRows.length ? " · " + error : ""}
      {selection.size ? " · 已选 " + selection.size + " 行" : ""}
    </span>,
    footer: <div className="mysql-inline-actions">
      {uncertain && plan ? <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => void commit(plan, true)}>检查保存状态</Button> : null}
      {selection.size ? <Button size="xs" variant="ghost" onClick={() => setSelection(new Set())}>取消选择</Button> : null}
      <Button size="icon-xs" variant="ghost" disabled={!selection.size || locked} data-testid="mysql-edit-batch" aria-label="批量赋值" title="批量赋值" onClick={() => void openBatch()}><Rows /></Button>
      <Button size="icon-xs" variant="ghost" disabled={Boolean(busy) || !guard.connected} data-testid="mysql-edit-refresh" aria-label="刷新数据" title="刷新数据" onClick={refresh}><ArrowClockwise /></Button>
      <Button size="icon-xs" variant="ghost" disabled={Boolean(busy) || (!pendingRows.length && !activeCell)} data-testid="mysql-edit-undo" aria-label="撤销修改" title="撤销修改" onClick={() => { finishCell(true); updateDrafts({}); setNotice("已撤销本地修改。") }}><ArrowCounterClockwise /></Button>
      <Button size="xs" data-testid="mysql-edit-save" disabled={locked || (!pendingRows.length && !activeCell)} onClick={() => void save()}><FloppyDisk />{busy === "commit" || busy === "prepare" ? "保存中…" : "保存"}</Button>
    </div>,
  }
  const batchMetadata = edit?.columns.find(column => column.name === batchColumn)
  if (!visible && documentKey.startsWith("table:")) return null
  return <MysqlInlineEditingContext.Provider value={controller}>
    <div className="mysql-edit-container" data-testid={visible ? "mysql-data-editor" : undefined} ref={rootRef} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!batch && !activeRef.current?.modal) void save() }
    }}>
      {children}
    {edit ? <><Dialog open={batch} onOpenChange={setBatch}>
      <DialogContent className="sm:max-w-lg" data-testid="mysql-edit-batch-dialog">
        <DialogHeader><DialogTitle>向选中的 {selection.size} 行统一赋值</DialogTitle><DialogDescription>所有选中行的指定字段将暂存为同一个值，点击保存后才写入数据库。</DialogDescription></DialogHeader>
        <label className="grid gap-2 text-xs">修改字段<SelectControl aria-label="批量修改字段" value={batchColumn} onValueChange={value => { setBatchColumn(value); setBatchNull(false) }}>{edit!.columns.filter(column => column.editable).map(column => <SelectItem key={column.name} value={column.name}>{column.name} · {column.type}</SelectItem>)}</SelectControl></label>
        <label className="grid gap-2 text-xs">新值<textarea className="mysql-edit-textarea" aria-label="批量赋值的新值" value={batchValue} disabled={batchNull} onChange={event => setBatchValue(event.target.value)} rows={4} /></label>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={batchNull} disabled={!batchMetadata?.nullable} onCheckedChange={value => setBatchNull(value === true)} />设为 NULL{!batchMetadata?.nullable ? "（此字段不允许）" : ""}</label>
        <DialogFooter><Button variant="outline" onClick={() => setBatch(false)}>取消</Button><Button data-testid="mysql-edit-apply-batch" disabled={!batchColumn || locked} onClick={applyBatch}>应用到选中行</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(activeCell?.modal)} onOpenChange={open => { if (!open) finishCell(true) }}>
      <DialogContent className="sm:max-w-2xl" data-testid="mysql-edit-cell-dialog">
        <DialogHeader><DialogTitle>编辑字段 {activeCell?.name}</DialogTitle><DialogDescription>支持多行文本。空字符串与 NULL 是不同的值。</DialogDescription></DialogHeader>
        {activeCell?.modal ? <textarea ref={element => { inputRef.current = element }} className="mysql-edit-textarea" aria-label={"编辑 " + activeCell.name} defaultValue={activeCell.value} rows={12} onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false } }} /> : null}
        <DialogFooter><Button variant="ghost" onClick={() => { if (activeCell) void copyMysqlText(activeRef.current?.value ?? "").then(() => toast.success("已复制"), () => toast.error("复制失败")) }}><Copy />复制</Button><Button variant="outline" disabled={!edit!.columns.find(column => column.name === activeCell?.name)?.nullable} onClick={() => { if (activeRef.current) activeRef.current.isNull = true; finishCell() }}>设为 NULL</Button><Button variant="outline" onClick={() => finishCell(true)}>取消</Button><Button onClick={() => finishCell()}>暂存修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    </> : null}
    </div>
  </MysqlInlineEditingContext.Provider>
}
