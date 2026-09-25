import { useState } from "react"
import type { AiOpsV2Api, MysqlEditData, PluginScope } from "@/bridge/ai-ops-v2"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SelectControl, SelectItem } from "@/components/ui/select"

import type { MysqlInsertDraft } from "./mysql-row-draft-model"
export function MysqlRowSheet({ api, scope, edit, draft, locked, onChange, onStage, onClose }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly edit: MysqlEditData; readonly draft: MysqlInsertDraft
  readonly locked: boolean; readonly onChange: (draft: MysqlInsertDraft) => void; readonly onStage: () => void; readonly onClose: () => void
}) {
  const [search, setSearch] = useState("")
  const [error, setError] = useState("")
  const [errorColumn, setErrorColumn] = useState("")
  const [busy, setBusy] = useState(false)
  const columns = edit.insertColumns ?? []
  function change(name: string, value: string | null | undefined) {
    const values = { ...draft.values }
    if (value === undefined) delete values[name]; else values[name] = value
    onChange({ ...draft, values }); setError(""); setErrorColumn("")
  }
  async function stage() {
    setBusy(true); setError("")
    try {
      const response = await api.mysqlEditPrepare({ ...scope, editId: edit.editId, changes: [{ kind: "insert", rowId: draft.rowId, values: draft.values }] })
      if (!response.ok) {
        const column = (response.error.details as {column?: string} | undefined)?.column ?? ""
        setErrorColumn(column); setSearch("")
        setTimeout(() => document.querySelector<HTMLElement>('[data-insert-field="' + CSS.escape(column) + '"] textarea')?.focus(), 0)
        throw new Error(response.error.message)
      }
      onStage()
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法暂存新增行") }
    finally { setBusy(false) }
  }
  return <Sheet open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <SheetContent overlayClassName="supports-backdrop-filter:backdrop-blur-none bg-black/20 dark:bg-black/25" className="mysql-row-sheet" onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => { const input = document.querySelector<HTMLTextAreaElement>('[data-testid="mysql-row-sheet"] [data-insert-field] textarea:not(:disabled)'); input?.focus(); if (draft.copied) input?.select() }) }} onInteractOutside={event => event.preventDefault()} data-testid="mysql-row-sheet">
      <SheetHeader><SheetTitle>{draft.copied ? "复制为新行" : "添加行"}</SheetTitle><SheetDescription>修改应用到当前草稿，点击表格底部“保存更改”才会写入 {edit.table}。</SheetDescription></SheetHeader>
      <div className="px-4"><Input placeholder="搜索字段…" aria-label="搜索新增字段" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="mysql-row-fields">
        {columns.filter(column => !column.generated && !column.autoIncrement && column.name.toLowerCase().includes(search.toLowerCase())).map(column => {
          const mode = !Object.hasOwn(draft.values, column.name) ? "default" : draft.values[column.name] === null ? "null" : "value"
          return <div className="mysql-row-field" key={column.name} data-insert-field={column.name}>
            <div className="flex flex-wrap items-center gap-2"><label htmlFor={"insert-" + column.name} className="font-medium">{column.name}{column.required ? " *" : ""}</label><span className="text-muted-foreground">{column.type}{column.primary ? " · 主键" : column.unique ? " · 唯一" : ""}</span></div>
            {draft.copied && column.unique ? <p className="text-warning">请检查此值，避免与已有记录重复。</p> : null}
            <SelectControl aria-label={column.name + " 值方式"} value={mode} disabled={locked || busy || !column.editable} onValueChange={value => change(column.name, value === "default" ? undefined : value === "null" ? null : "")}>
              <SelectItem value="default">{column.required ? "待填写" : "使用默认值"}</SelectItem><SelectItem value="value">填写值（可为空字符串）</SelectItem>{column.nullable ? <SelectItem value="null">NULL</SelectItem> : null}
            </SelectControl>
            {mode === "value" || column.required ? <textarea id={"insert-" + column.name} className="mysql-edit-textarea" aria-label={"新增字段 " + column.name} aria-invalid={errorColumn === column.name} disabled={locked || busy || !column.editable || mode === "null"} value={draft.values[column.name] ?? ""} onChange={event => change(column.name,event.target.value)} maxLength={65536} rows={column.dataType === "json" ? 5 : 2} /> : <p className="text-muted-foreground">{mode === "null" ? "保存为 NULL" : "默认：" + (column.defaultValue ?? "NULL")}</p>}
            {!column.editable ? <p className="text-muted-foreground">{column.reason ?? "此字段类型暂不支持填写"}</p> : null}
            {errorColumn === column.name ? <p role="alert" className="text-danger">{error}</p> : null}
          </div>
        })}
        <details><summary className="cursor-pointer text-muted-foreground">自动生成字段（无需填写）</summary>{columns.filter(column => column.generated || column.autoIncrement).map(column => <p key={column.name}>{column.name} · {column.autoIncrement ? "自增" : "数据库计算"}</p>)}</details>
      </div>
      <SheetFooter>{error && !errorColumn ? <p role="alert" className="text-sm text-danger">{error}</p> : null}<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button disabled={locked || busy} onClick={() => void stage()} data-testid="mysql-stage-insert">{busy ? "正在校验…" : "应用到草稿"}</Button></div></SheetFooter>
    </SheetContent>
  </Sheet>
}
