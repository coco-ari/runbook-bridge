import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, MysqlEditData, MysqlEditRow } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { copyMysqlText } from "./mysql-clipboard"
import { generateMysqlSql, type MysqlSqlKind } from "./mysql-sql-export"

export interface MysqlSqlExportSelection { data: MysqlEditData; rows: readonly MysqlEditRow[]; kind: MysqlSqlKind; field?: string | undefined }
export function MysqlSqlExportDialog({ api, selection, onClose }: { api: AiOpsV2Api; selection: MysqlSqlExportSelection; onClose: () => void }) {
  const { data, rows } = selection
  const [kind, setKind] = useState(selection.kind)
  const editable = data.columns.filter(column => column.editable && !column.primary && !column.generated)
  const [fields, setFields] = useState(() => new Set(selection.field && editable.some(column => column.name === selection.field) ? [selection.field] : editable.map(column => column.name)))
  const [saving, setSaving] = useState(false)
  const output = useMemo(() => {
    try { return { sql: generateMysqlSql(data, rows, kind, [...fields]), error: "" } }
    catch (failure) { return { sql: "", error: failure instanceof Error ? failure.message : "无法生成 SQL" } }
  }, [data, rows, kind, fields])
  async function saveFile() {
    if (!output.sql || saving) return
    setSaving(true)
    try {
      const fileName = "mysql-" + data.table.replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 70) + "-" + kind.toLowerCase() + ".sql"
      const response = await api.mysqlExportSave({ fileName, sql: output.sql })
      if (!response.ok) throw new Error(response.error.message)
      if (response.data.saved) toast.success("SQL 文件已保存")
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : "保存文件失败") }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent className="sm:max-w-3xl" data-testid="mysql-sql-export-dialog">
      <DialogHeader><DialogTitle>生成已选行 SQL</DialogTitle><DialogDescription>{data.database}.{data.table} · 已选 {rows.length} 行。生成内容可复制或保存为文件，不会执行。</DialogDescription></DialogHeader>
      <label className="flex items-center gap-3 text-xs">SQL 类型<SelectControl aria-label="SQL 生成类型" value={kind} onValueChange={value => setKind(value as MysqlSqlKind)}>{(["SELECT", "INSERT", "UPDATE", "DELETE"] as const).map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectControl></label>
      {kind === "UPDATE" ? <fieldset className="max-h-28 overflow-auto rounded border p-2"><legend className="px-1 text-xs">要赋值的字段</legend><div className="flex flex-wrap gap-3">{editable.map(column => <label key={column.name} className="flex items-center gap-1.5 text-xs"><Checkbox checked={fields.has(column.name)} onCheckedChange={checked => setFields(current => { const next = new Set(current); if (checked) next.add(column.name); else next.delete(column.name); return next })} />{column.name}</label>)}</div></fieldset> : null}
      <p className="text-xs text-muted-foreground">{kind === "INSERT" ? "包含当前查询中的非生成字段和原主键；插入已有主键可能产生冲突。" : kind === "UPDATE" ? "使用已保存的数据值生成赋值语句，以完整主键定位每行。" : kind === "DELETE" ? "每条删除语句仅定位一个完整主键。" : "按完整主键查询所选行，返回当前查询字段。"}</p>
      {output.error ? <p role="alert" className="text-sm text-danger">{output.error}</p> : null}
      <textarea aria-label="生成的 SQL" data-testid="mysql-sql-export-text" className="mysql-edit-textarea h-72" readOnly value={output.sql} spellCheck={false} />
      <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>关闭</Button><Button variant="outline" disabled={!output.sql || saving} onClick={() => void copyMysqlText(output.sql).then(() => toast.success("SQL 已复制"), () => toast.error("复制失败"))}>复制 SQL</Button><Button disabled={!output.sql || saving} onClick={() => void saveFile()}>{saving ? "保存中…" : "保存 .sql"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
