import { OperationMessage, OperationSpinner, useOperationLabel } from "@/components/workspace/OperationFeedback"
import { MysqlRowSheet } from "./MysqlRowSheet"
import { mysqlDraftColumn, mysqlDraftPlaceholder, type MysqlInsertDraft } from "./mysql-row-draft-model"
import { useEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps } from "react"
import { ArrowClockwise, PencilSimple, Copy, FloppyDisk, Rows, ArrowCounterClockwise, Plus, Trash, SelectionSlash } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api, MysqlEditData, MysqlEditChange, MysqlEditPlan, MysqlEditRow, MysqlEditStatus, MysqlQueryResult, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useMysqlEditingGuard } from "./MysqlEditingContext"
import { MysqlInlineEditingContext, type MysqlInlineEditing } from "./MysqlInlineEditingContext"
import { bindMysqlEditRows, mysqlEditValueMatches, type MysqlDisplayedRow } from "./mysql-inline-edit-model"
import { copyMysqlText } from "./mysql-clipboard"

import { MysqlSqlExportDialog, type MysqlSqlExportSelection } from "./MysqlSqlExportDialog"
import type { MysqlSqlKind } from "./mysql-sql-export"

type Drafts = Record<string, Record<string, string | null>>
interface ActiveCell { rowId: string; name: string; value: string; isNull: boolean; modal: boolean; isDefault?: boolean }

function MysqlRowAction({ hint, railClassName, ...props }: ComponentProps<typeof Button> & { readonly hint: string; readonly railClassName?: string }) {
  return <Tooltip><TooltipTrigger asChild><span className={"mysql-row-action " + (railClassName ?? "")} tabIndex={props.disabled ? 0 : undefined}><Button {...props} size="icon-sm" variant="ghost" /></span></TooltipTrigger><TooltipContent side="right" sideOffset={8}>{hint}</TooltipContent></Tooltip>
}

export function MysqlEditableResults({ api, scope, documentKey, sql, result, visible = true, onReload, feedback, children }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly documentKey: string; readonly sql: string; readonly result: MysqlQueryResult
  readonly visible?: boolean; readonly onReload: (summary?: string) => void; readonly children: ReactNode
  readonly feedback?: { busy: boolean; error: string; message: string }
}) {
  const guard = useMysqlEditingGuard()
  const [edit, setEdit] = useState<MysqlEditData | null>(null)
  const editRef = useRef(edit)
  const [drafts, setDrafts] = useState<Drafts>({})
  const draftsRef = useRef(drafts)
  const [inserts, setInserts] = useState<readonly MysqlInsertDraft[]>([])
  const insertsRef = useRef(inserts)
  const insertSources = useRef(new Map<string, MysqlDisplayedRow>())
  const [deleted, setDeleted] = useState(new Set<string>())
  const deletedRef = useRef(deleted)
  const [rowDraft, setRowDraft] = useState<MysqlInsertDraft | null>(null)
  const rowDraftRef = useRef(rowDraft)
  const [deleteConfirmation, setDeleteConfirmation] = useState(false)
  const updateInserts = (value: readonly MysqlInsertDraft[]) => {
    const ids = new Set(value.map(row => row.rowId)), removed = new Set<MysqlDisplayedRow>()
    for (const [id, source] of insertSources.current) if (!ids.has(id)) { removed.add(source); insertSources.current.delete(id) }
    if (removed.size) setSelection(previous => new Set([...previous].filter(row => !removed.has(row))))
    insertsRef.current = value; setInserts(value)
  }
  const updateDeleted = (value: Set<string>) => { deletedRef.current = value; setDeleted(value) }
  const updateRowDraft = (value: MysqlInsertDraft | null) => { rowDraftRef.current = value; setRowDraft(value) }
  const [selection, setSelection] = useState(new Set<MysqlDisplayedRow>())
  const [saved, setSaved] = useState(new Map<MysqlDisplayedRow, Record<string, string | null>>())
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null)
  const activeRef = useRef<ActiveCell | null>(null)
  const [busy, setBusy] = useState<"open" | "prepare" | "commit" | "check" | null>(null)
  const [reading, setReading] = useState("正在读取字段…")
  const [rowAction, setRowAction] = useState<"add" | "copy" | "delete" | null>(null)
  const busyRef = useRef(busy)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [conflicts, setConflicts] = useState(new Set<string>())
  const [plan, setPlan] = useState<MysqlEditPlan | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const uncertainRef = useRef(false)
  uncertainRef.current = uncertain
  const [stale, setStale] = useState(false)
  const [exportSelection, setExportSelection] = useState<MysqlSqlExportSelection | null>(null)
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
  const gridDrafts = useMemo(() => inserts.map(draft => {
    let row = insertSources.current.get(draft.rowId)
    if (!row) { row = {}; insertSources.current.set(draft.rowId, row) }
    return { row, rowId: draft.rowId, afterRowId: draft.afterRowId }
  }), [inserts])
  const insertBindings = new Map(gridDrafts.map(item => [item.row, item.rowId]))
  const copiedCount = inserts.filter(row => row.copied).length
  const pendingRows = Object.keys(drafts).filter(id => !deleted.has(id))
  const pendingCount = pendingRows.length + inserts.length + deleted.size
  const cellCount = Object.entries(drafts).filter(([id]) => !deleted.has(id)).reduce((count, [, values]) => count + Object.keys(values).length, 0) + inserts.reduce((count, row) => count + Object.keys(row.values).length, 0)
  const locked = Boolean(busy || uncertain || stale || !guard.connected || feedback?.busy || feedback?.error)
  const waiting = useOperationLabel(Boolean(busy || feedback?.busy), busy === "check" ? "正在检查保存状态…" : busy === "prepare" ? "正在校验更改…" : busy === "commit" ? "正在保存更改…" : busy === "open" ? reading : "正在刷新数据…")
  useEffect(() => {
    alive.current = true
    const unregister = guard.register(documentKey, () => ({
      busy: Boolean(busyRef.current),
      uncertain: uncertainRef.current,
      dirty: insertsRef.current.length > 0 || deletedRef.current.size > 0 || Boolean(rowDraftRef.current) || Object.keys(draftsRef.current).length > 0 || Boolean(activeRef.current && (activeRef.current.isNull ? null : activeRef.current.value) !== editRef.current?.rows.find(row => row.rowId === activeRef.current?.rowId)?.values[activeRef.current.name]),
      discard: () => { updateDrafts({}); updateInserts([]); updateDeleted(new Set()); updateRowDraft(null); setCell(null); setPlan(null) },
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
  useEffect(() => { if (activeCell) { inputRef.current?.focus({ preventScroll: true }); if (insertsRef.current.some(row => row.rowId === activeCell.rowId && row.copied)) inputRef.current?.select() } }, [activeCell?.rowId, activeCell?.name, activeCell?.modal])

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
    if (!cancel) {
      const draft = insertsRef.current.find(row => row.rowId === active.rowId)
      if (draft && editRef.current) {
        const column = mysqlDraftColumn(editRef.current, active.name)
        if (column) {
          const values = { ...draft.values }
          if (active.isDefault) delete values[column.name]
          else values[column.name] = active.isNull ? null : active.value
          updateInserts(insertsRef.current.map(row => row.rowId === draft.rowId ? { ...row, values } : row))
        }
      } else updateDrafts(applyValue(active.rowId, active.name, active.isNull ? null : active.value))
    }
    setCell(null)
  }
  function valueOf(row: MysqlDisplayedRow, name: string, fallback: unknown): unknown {
    const draft = insertsRef.current.find(item => insertSources.current.get(item.rowId) === row)
    if (draft && editRef.current) {
      const column = mysqlDraftColumn(editRef.current, name)
      return column ? draft.values[column.name] : undefined
    }
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
      if (Object.keys(draftsRef.current).length || insertsRef.current.length || deletedRef.current.size) { toast.info("请先保存或撤销当前修改，再编辑新加载的行。"); return null }
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
      if (alive.current) { const message = failure instanceof Error ? failure.message : "此结果暂不支持编辑"; setError(message) }
      return null
    } finally { if (alive.current && ticket === serial.current) setWorking(null) }
  }
  function matchedRow(data: MysqlEditData, row: MysqlDisplayedRow, name: string): MysqlEditRow {
    const target = bindMysqlEditRows(result.rows, data).get(row)
    if (!target) throw new Error("无法按完整主键定位此行。请先保存当前修改，再刷新结果后编辑。")
    if (deletedRef.current.has(target.rowId)) throw new Error("此行待删除，请先撤销删除再修改字段。")
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
    const draft = insertsRef.current.find(row => insertSources.current.get(row.rowId) === source)
    if (draft && editRef.current) {
      const column = mysqlDraftColumn(editRef.current, name)
      if (!column?.editable || column.generated || column.autoIncrement) { toast.info(column?.reason ?? "此字段由数据库自动生成。"); return }
      const value = draft.values[column.name]
      setError(""); setCell({ rowId: draft.rowId, name, value: value ?? "", isNull: value === null, isDefault: !Object.hasOwn(draft.values, column.name), modal: modal || column.dataType === "json" || (value?.length ?? 0) > 180 || Boolean(value?.includes("\n")) })
      return
    }
    const data = await ensureSnapshot([source])
    if (!data || !alive.current || !connected.current) return
    try {
      const row = matchedRow(data, source, name)
      if (deletedRef.current.has(row.rowId)) return
      const value = Object.hasOwn(draftsRef.current[row.rowId] ?? {}, name) ? draftsRef.current[row.rowId]![name] ?? null : row.values[name] ?? null
      const column = data.columns.find(item => item.name === name)
      setError(""); setCell({ rowId: row.rowId, name, value: value ?? "", isNull: value === null, modal: modal || column?.dataType === "json" || (value?.length ?? 0) > 180 || Boolean(value?.includes("\n")) })
    } catch (failure) { const message = failure instanceof Error ? failure.message : "无法编辑此字段"; setError(message) }
  }
  function reset(action: () => void) { finishCell(); guard.protect(action, [documentKey]) }
  function refresh() {
    reset(() => {
      if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
      setEdit(null); editRef.current = null; guard.setEditing(documentKey, false)
      updateDrafts({}); updateInserts([]); updateDeleted(new Set()); updateRowDraft(null); setCell(null); setPlan(null); setError(""); setNotice(""); setUncertain(false); setStale(false); setConflicts(new Set()); setSelection(new Set()); setSaved(new Map())
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
      const refreshRows = insertsRef.current.length > 0 || deletedRef.current.size > 0
      const copies = insertsRef.current.filter(row => row.copied).length
      const summary = `已保存：新增 ${insertsRef.current.length - copies} · 复制 ${copies} · 修改 ${Object.keys(draftsRef.current).filter(id => !deletedRef.current.has(id)).length} · 删除 ${deletedRef.current.size}` + (status.result.auditWarning ? "；操作记录写入失败。" : "。") + (insertsRef.current.length ? " 新增和复制行按当前筛选及返回行数限制显示。" : "")
      updateDrafts({}); updateInserts([]); updateDeleted(new Set()); setConflicts(new Set()); setPlan(null); setUncertain(false); setError("")
      setNotice(summary)
      if (refreshRows) {
        if (editRef.current) void api.mysqlEditRelease({ ...scope, editId: editRef.current.editId }).catch(() => {})
        setSelection(new Set()); setEdit(null); editRef.current = null; guard.setEditing(documentKey, false)
        toast.success(summary)
        onReload(summary)
      }
    } else if (status.status === "running") { setUncertain(true); setError("保存仍在进行，请检查保存状态，不要重复提交。") }
    else {
      setUncertain(status.status === "unknown"); setError(status.error?.message ?? "保存未完成")
      setConflicts(new Set(status.error?.details?.rowIds ?? []))
      if (["MYSQL_EDIT_STALE", "MYSQL_EDIT_SCHEMA_CHANGED", "MYSQL_EDIT_CONFLICT"].includes(status.error?.code ?? "")) setStale(true)
      if (status.status !== "unknown") setPlan(null)
    }
  }
  async function commit(prepared: MysqlEditPlan, checkOnly = false) {
    if (!editRef.current || busyRef.current === "commit" || busyRef.current === "check") return
    setError(""); setWorking(checkOnly ? "check" : "commit")
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
    const changes: MysqlEditChange[] = [
      ...Object.entries(draftsRef.current).filter(([id]) => !deletedRef.current.has(id)).map(([rowId, values]) => ({ rowId, values })),
      ...[...deletedRef.current].map(rowId => ({ kind: "delete" as const, rowId })),
      ...insertsRef.current.map(row => ({ kind: "insert" as const, rowId: row.rowId, values: row.values })),
    ]
    if (!changes.length) return
    setWorking("prepare"); setError(""); setNotice("")
    try {
      const response = await api.mysqlEditPrepare({ ...scope, editId: edit.editId, changes })
      if (!response.ok) {
        if (response.error.code === "MYSQL_EDIT_STALE") setStale(true)
        const details = response.error.details as { column?: string; rowIds?: string[] } | undefined
        const draft = insertsRef.current.find(row => row.rowId === details?.rowIds?.[0])
        if (draft && details?.column) {
          const column = edit.columns.find(item => item.source === details.column)
          if (column) focusCell(draft.rowId, column.name)
          else updateRowDraft(draft)
        }
        throw new Error(response.error.message)
      }
      if (!alive.current) return
      setPlan(response.data)
      // 点击保存即授权本次精确修改，仍由后端生成并消费一次性保存计划。
      if (deletedRef.current.size) setDeleteConfirmation(true)
      else await commit(response.data)
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "无法保存") }
    finally { if (alive.current) setWorking(null) }
  }
  async function addRow(copySource?: MysqlDisplayedRow) {
    if (locked || busyRef.current) return
    finishCell()
    if (pendingCount >= (edit?.limits.maxRows ?? 100)) { toast.error("每批最多暂存 100 行，请先保存。"); return }
    const localSource = insertsRef.current.find(row => insertSources.current.get(row.rowId) === copySource)
    setRowAction(copySource ? "copy" : "add"); setReading(copySource ? "正在读取源行…" : "正在读取字段…")
    const data = await ensureSnapshot(copySource && !localSource ? [copySource] : [])
    if (!data?.insertColumns || !alive.current) { setRowAction(null); return }
    try {
      let values: Record<string, string | null> = {}
      if (localSource) values = { ...localSource.values }
      else if (copySource) {
        const source = bindMysqlEditRows(result.rows, data).get(copySource)
        if (!source) throw new Error("无法定位原行，请刷新后重试。")
        setWorking("open")
        const response = await api.mysqlEditRow({ ...scope, editId: data.editId, rowId: source.rowId })
        if (!response.ok) throw new Error(response.error.message)
        if (!alive.current) return
        const available = data.insertColumns.filter(column => !column.autoIncrement && !column.generated)
        if (available.some(column => response.data.unsupportedColumns.includes(column.name) || (!column.editable && (response.data.values[column.name] !== null || column.defaultValue !== null)))) throw new Error("原行包含无法完整复制的字段类型，暂不支持复制此行。")
        values = Object.fromEntries(available.filter(column => column.editable).map(column => [column.name, response.data.values[column.name] ?? null]))
        for (const column of data.columns) if (Object.hasOwn(draftsRef.current[source.rowId] ?? {}, column.name)) values[column.source] = draftsRef.current[source.rowId]![column.name] ?? null
      }
      const draft: MysqlInsertDraft = { rowId: crypto.randomUUID(), values, copied: Boolean(copySource), afterRowId: localSource?.rowId ?? (copySource ? bindings.get(copySource)?.rowId ?? bindMysqlEditRows(result.rows, data).get(copySource)?.rowId : undefined) }
      updateInserts([...insertsRef.current, draft]); setError("")
      const source: MysqlDisplayedRow = {}; insertSources.current.set(draft.rowId, source)
      const fields = data.insertColumns?.filter(column => column.editable && !column.generated && !column.autoIncrement) ?? []
      const preferred = fields.find(column => draft.copied && (column.primary || column.unique)) ?? fields.find(column => column.required) ?? fields[0]
      const visibleColumn = data.columns.find(column => column.source === preferred?.name) ?? data.columns.find(column => fields.some(field => field.name === column.source))
      window.setTimeout(() => {
        if (!alive.current) return
        const element = rootRef.current?.querySelector('[data-edit-row="' + CSS.escape(draft.rowId) + '"]')
        element?.scrollIntoView({ block: "nearest" })
        if (visibleColumn) void beginCell(source, visibleColumn.name)
        else updateRowDraft(draft)
      }, 0)
      if (draft.copied) toast.info("已复制为草稿，请检查主键和唯一字段，避免与已有记录重复。")
      setNotice(draft.copied ? "已复制为草稿，请检查主键和唯一字段后统一保存。" : "已添加草稿，填写后统一保存。")
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法添加行") }
    finally { if (alive.current) { setWorking(null); setRowAction(null) } }
  }
  async function deleteRows(targets = [...selection]) {
    if (locked || busyRef.current || !targets.length) return
    finishCell()
    const localIds = new Set(targets.map(source => insertBindings.get(source)).filter((id): id is string => Boolean(id)))
    if (localIds.size) {
      updateInserts(insertsRef.current.filter(row => !localIds.has(row.rowId)))
      setSelection(previous => new Set([...previous].filter(row => !localIds.has(insertBindings.get(row) ?? ""))))
    }
    targets = targets.filter(row => !insertBindings.has(row))
    if (!targets.length) return
    setRowAction("delete"); setReading("正在核对待删除行…")
    const data = await ensureSnapshot(targets)
    if (!data || !alive.current) { setRowAction(null); return }
    setWorking("open")
    try {
      const mapped = bindMysqlEditRows(result.rows, data), next = new Set(deletedRef.current)
      for (const [index, source] of targets.entries()) {
        setReading(`正在核对待删除行 ${index + 1}/${targets.length}…`)
        const row = mapped.get(source)
        if (!row) throw new Error("无法定位待删除行，请刷新后重试。")
        if (next.has(row.rowId)) continue
        const response = await api.mysqlEditRow({ ...scope, editId: data.editId, rowId: row.rowId })
        if (!response.ok) throw new Error(response.error.message)
        next.add(row.rowId)
      }
      if (alive.current) { updateDeleted(next); setError(""); setNotice("已标记待删除，保存前可撤销。") }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "无法删除行") }
    finally { if (alive.current) { setWorking(null); setRowAction(null) } }
  }
  function stageRow() {
    const draft = rowDraftRef.current
    if (!draft) return
    const next = insertsRef.current.map(row => row.rowId === draft.rowId ? draft : row)
    if (next.length + deletedRef.current.size + Object.keys(draftsRef.current).filter(id => !deletedRef.current.has(id)).length > 100) { toast.error("每批最多暂存 100 行，请先保存。"); return }
    updateInserts(next); updateRowDraft(null); setNotice("新增行已暂存，尚未写入数据库。")
  }
  async function openBatch() {
    if (locked || busyRef.current || !selection.size) return
    if ([...selection].some(row => insertBindings.has(row))) { toast.info("新增和复制草稿请直接编辑单元格或打开完整行字段。"); return }
    finishCell()
    const data = await ensureSnapshot([...selection])
    if (!data || !alive.current) return
    if (!data.columns.some(column => column.editable)) { toast.info("当前结果没有可批量修改的字段。"); return }
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
  async function openExport(kind: MysqlSqlKind, field?: string) {
    if (locked || busyRef.current || !selection.size) return
    if ([...selection].some(row => insertBindings.has(row))) { toast.info("新增和复制草稿请直接编辑单元格或打开完整行字段。"); return }
    finishCell()
    const sources = [...selection]
    const data = await ensureSnapshot(sources)
    if (!data || !alive.current) return
    try {
      const mapped = bindMysqlEditRows(result.rows, data)
      const targets = sources.map(source => {
        const target = mapped.get(source)
        if (!target) throw new Error("无法按完整主键定位已选行，请刷新后重试。")
        if (deletedRef.current.has(target.rowId)) throw new Error("已选行待删除，请先保存或取消删除再生成 SQL。")
        if (Object.keys(draftsRef.current[target.rowId] ?? {}).length) throw new Error("已选行包含未保存修改，请先保存或撤销后生成 SQL。")
        for (const column of data.columns) {
          if (column.generated || (!column.editable && !column.primary)) continue
          if (!mysqlEditValueMatches(valueOf(source, column.name, source[column.name]), target.values[column.name] ?? null)) throw new Error("已选行的数据已变化，请刷新后再生成 SQL。")
        }
        return target
      })
      setExportSelection({data, rows:targets, kind, field})
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : "无法生成 SQL") }
  }
  const controller: MysqlInlineEditing = {
    locked: locked || deleteConfirmation, selection,
    toolbar: <aside className="mysql-row-toolbar" aria-label="数据行操作" data-testid="mysql-row-toolbar">
      <MysqlRowAction disabled={locked} onClick={() => void addRow()} data-testid="mysql-add-row" aria-label="新增行" hint="新增行">{busy && rowAction === "add" ? <OperationSpinner /> : <Plus />}</MysqlRowAction>
      <MysqlRowAction disabled={locked || selection.size !== 1} onClick={() => void addRow([...selection][0])} data-testid="mysql-copy-row" aria-label="复制为新行" hint={selection.size === 1 ? "复制为新行" : "复制为新行 · 请先选择一行"}>{busy && rowAction === "copy" ? <OperationSpinner /> : <Copy />}</MysqlRowAction>
      <MysqlRowAction className="text-danger" disabled={locked || !selection.size} onClick={() => void deleteRows()} data-testid="mysql-delete-rows" aria-label="删除行" hint={selection.size ? "删除选中行 · 保存后生效" : "删除行 · 请先选择要删除的行"}>{busy && rowAction === "delete" ? <OperationSpinner /> : <Trash />}</MysqlRowAction>
      <hr className="my-1 border-border" />
      <MysqlRowAction disabled={!selection.size || locked || [...selection].some(row => insertBindings.has(row))} data-testid="mysql-edit-batch" aria-label="批量赋值" hint="批量赋值 · 请先选择已有行" onClick={() => void openBatch()}><Rows /></MysqlRowAction>
      {selection.size ? <MysqlRowAction aria-label="取消选择" hint={"取消选择 · 已选 " + selection.size + " 行"} onClick={() => setSelection(new Set())}><SelectionSlash /></MysqlRowAction> : null}
      <MysqlRowAction railClassName="mysql-row-refresh" disabled={Boolean(busy || feedback?.busy) || !guard.connected} data-testid="mysql-edit-refresh" aria-label="刷新数据" hint="刷新数据 · 有草稿时先确认是否放弃" onClick={refresh}>{feedback?.busy ? <OperationSpinner /> : <ArrowClockwise />}</MysqlRowAction>
    </aside>,
    pendingRows: gridDrafts,
    rowState: row => {
      const draft = inserts.find(item => item.rowId === insertBindings.get(row))
      if (draft) return draft.copied ? "copy" : "insert"
      const id = bindings.get(row)?.rowId ?? ""
      return deleted.has(id) ? "delete" : Object.keys(drafts[id] ?? {}).length ? "update" : null
    },
    placeholder: (row, name) => {
      const draft = inserts.find(item => item.rowId === insertBindings.get(row))
      return draft && edit ? mysqlDraftPlaceholder(draft, edit, name) : null
    },
    fullRow: row => { finishCell(); const draft = insertsRef.current.find(item => item.rowId === insertBindings.get(row)); if (draft) updateRowDraft(draft) },
    rowActions: row => {
      const draft = inserts.find(item => item.rowId === insertBindings.get(row))
      if (draft) return <Button size="icon-xs" variant="ghost" aria-label="编辑完整行字段" title="编辑完整行字段" disabled={locked} onClick={event => { event.stopPropagation(); finishCell(); updateRowDraft(insertsRef.current.find(item => item.rowId === draft.rowId) ?? draft) }}><PencilSimple /></Button>
      const id = bindings.get(row)?.rowId ?? ""
      if (deleted.has(id)) return <Button size="icon-xs" variant="ghost" aria-label="撤销删除" title="撤销删除" disabled={locked} onClick={event => { event.stopPropagation(); const next = new Set(deletedRef.current); next.delete(id); updateDeleted(next) }}><ArrowCounterClockwise /></Button>
      return null
    },
    deleted: row => deleted.has(bindings.get(row)?.rowId ?? ""),
    restore: row => { const next = new Set(deletedRef.current); next.delete(bindings.get(row)?.rowId ?? ""); updateDeleted(next) },
    copyRow: row => { void addRow(row) },
    deleteRow: row => { void deleteRows([row]) },
    replaceSelection: rows => { if (rows.size <= 100) setSelection(new Set(rows)) },
    clearSelection: () => setSelection(new Set()),
    batch: () => { void openBatch() },
    canEdit: (name, source) => {
      if (source && deleted.has(bindings.get(source)?.rowId ?? "")) return false
      if (source && insertBindings.has(source) && edit) return Boolean(mysqlDraftColumn(edit, name)?.editable)
      return edit ? Boolean(edit.columns.find(column => column.name === name)?.editable) : true
    },
    exportSql: (kind, field) => { void openExport(kind, field) },
    select: (rows, checked) => {
      const next = new Set(selection)
      for (const row of rows) { if (checked) next.add(row); else next.delete(row) }
      if (next.size > 100) toast.info("每批最多选择 100 行。")
      else setSelection(next)
    },
    value: valueOf,
    rowId: row => insertBindings.get(row) ?? bindings.get(row)?.rowId,
    conflict: row => conflicts.has(bindings.get(row)?.rowId ?? ""),
    dirty: (row, name) => Object.hasOwn(drafts[bindings.get(row)?.rowId ?? ""] ?? {}, name),
    begin: (row, name, modal) => { void beginCell(row, name, modal) },
    finish: () => finishCell(),
    cell: (source, name, content) => {
      const row = bindings.get(source) ?? (insertBindings.has(source) ? { rowId: insertBindings.get(source)! } : undefined)
      if (!row || activeCell?.rowId !== row.rowId || activeCell.name !== name || activeCell.modal) return content
      return <Input ref={element => { inputRef.current = element }} className="mysql-inline-input" aria-label={"编辑 " + name} defaultValue={activeCell.value}
        onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false; activeRef.current.isDefault = false } }}
        onPaste={event => {
          const pasted = event.clipboardData.getData("text/plain")
          if (!/[\r\n]/u.test(pasted) || !activeRef.current) return
          event.preventDefault()
          const input = event.currentTarget, original = activeRef.current.value
          setCell({ ...activeRef.current, value: original.slice(0, input.selectionStart ?? 0) + pasted + original.slice(input.selectionEnd ?? original.length), isNull: false, isDefault: false, modal: true })
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
    pendingCount,
    status: <span title={error || notice || (pendingCount ? "当前表格全部待保存更改，共 " + cellCount + " 处字段" : "双击编辑 · Ctrl+C 复制 · 右键更多操作")} className={error ? "text-danger" : ""} role={error ? "alert" : "status"}>
      {pendingCount ? <span data-testid="mysql-edit-dirty-count" className="mysql-draft-counts shrink-0">
        {inserts.length > copiedCount ? <span className="text-success">新增 {inserts.length - copiedCount}</span> : null}
        {copiedCount ? <span className="text-info">复制 {copiedCount}</span> : null}
        {pendingRows.length ? <span className="text-warning">修改 {pendingRows.length}</span> : null}
        {deleted.size ? <span className="text-danger">删除 {deleted.size}</span> : null}
        <span className="sr-only">（{cellCount} 处字段）</span>
      </span> : null}
      <span data-testid="mysql-edit-message" className="min-w-0 flex-1"><OperationMessage error={Boolean(error || feedback?.error)} message={error || feedback?.error || (feedback?.busy && feedback.message ? feedback.message + " · " : "") + waiting || notice || feedback?.message || ""} /></span>
    </span>,
    footer: <div className="mysql-inline-actions">
      <Button size="xs" variant="ghost" disabled={Boolean(busy) || uncertain || (!pendingCount && !activeCell)} data-testid="mysql-edit-undo" aria-label="取消更改" onClick={() => { finishCell(true); updateDrafts({}); updateInserts([]); updateDeleted(new Set()); updateRowDraft(null); setSelection(new Set()); setError(""); setNotice("已取消全部未保存更改。"); }}><ArrowCounterClockwise />取消更改</Button>
      <Button size="xs" className="mysql-save-operation" aria-label={uncertain ? "检查保存状态" : "保存更改"} aria-busy={busy === "commit" || busy === "prepare" || busy === "check"} data-testid="mysql-edit-save" disabled={uncertain && plan ? Boolean(busy) : locked || (!pendingCount && !activeCell)} onClick={() => uncertain && plan ? void commit(plan, true) : void save()}>{busy === "commit" || busy === "prepare" || busy === "check" ? <OperationSpinner /> : uncertain ? <ArrowClockwise /> : <FloppyDisk />}{busy === "check" ? "核对中…" : uncertain ? "检查状态" : busy === "commit" || busy === "prepare" ? "保存中…" : "保存更改"}</Button>
    </div>,
  }
  const batchMetadata = edit?.columns.find(column => column.name === batchColumn)
  if (!visible && documentKey.startsWith("table:")) return null
  return <MysqlInlineEditingContext.Provider value={controller}>
    <div className="mysql-edit-container" data-testid={visible ? "mysql-data-editor" : undefined} ref={rootRef} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!exportSelection && !batch && !rowDraft && !deleteConfirmation && !activeRef.current?.modal) void save() }
    }}>
      {children}
      {rowDraft && edit ? <MysqlRowSheet key={rowDraft.rowId} api={api} scope={scope} edit={edit} draft={rowDraft} locked={locked} onChange={updateRowDraft} onStage={stageRow} onClose={() => { updateRowDraft(null) }} /> : null}
      <Dialog open={deleteConfirmation} onOpenChange={setDeleteConfirmation}><DialogContent><DialogHeader><DialogTitle>保存对 {edit?.table} 的更改？</DialogTitle><DialogDescription>本次新增 {inserts.length - copiedCount} 行、复制 {copiedCount} 行、修改 {plan?.counts?.update ?? pendingRows.length} 行、删除 {plan?.counts?.delete ?? deleted.size} 行。删除保存后无法通过此工作区撤销。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteConfirmation(false)}>继续编辑</Button><Button variant="destructive" data-testid="mysql-confirm-delete" onClick={() => { setDeleteConfirmation(false); if (plan) void commit(plan) }}>确认保存并删除</Button></DialogFooter></DialogContent></Dialog>
      {exportSelection ? <MysqlSqlExportDialog api={api} selection={exportSelection} onClose={() => setExportSelection(null)} /> : null}
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
        {activeCell?.modal ? <textarea ref={element => { inputRef.current = element }} className="mysql-edit-textarea" aria-label={"编辑 " + activeCell.name} defaultValue={activeCell.value} rows={12} onChange={event => { if (activeRef.current) { activeRef.current.value = event.target.value; activeRef.current.isNull = false; activeRef.current.isDefault = false } }} /> : null}
        <DialogFooter><Button variant="ghost" onClick={() => { if (activeCell) void copyMysqlText(activeRef.current?.value ?? "").then(() => toast.success("已复制"), () => toast.error("复制失败")) }}><Copy />复制</Button><Button variant="outline" disabled={!edit!.columns.find(column => column.name === activeCell?.name)?.nullable} onClick={() => { if (activeRef.current) { activeRef.current.isNull = true; activeRef.current.isDefault = false; } finishCell() }}>设为 NULL</Button>{inserts.some(row => row.rowId === activeCell?.rowId) ? <Button variant="outline" onClick={() => { if (activeRef.current) activeRef.current.isDefault = true; finishCell() }}>使用默认值</Button> : null}<Button variant="outline" onClick={() => finishCell(true)}>取消</Button><Button onClick={() => finishCell()}>暂存修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    </> : null}
    </div>
  </MysqlInlineEditingContext.Provider>
}
