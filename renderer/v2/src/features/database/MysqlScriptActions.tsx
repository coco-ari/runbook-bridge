import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { MysqlQueryDocument } from "./use-mysql-query-documents"

export function MysqlScriptActions({ document, onRename, onSave, onImport, onRestore, canRestore, canCreate }: {
  document: MysqlQueryDocument | undefined
  onRename: (name: string) => void
  onSave: () => Promise<boolean>
  onImport: (name: string, sql: string) => void
  onRestore: () => void
  canRestore: boolean
  canCreate: boolean
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  return <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5" data-testid="mysql-script-actions">
    {document ? <>
      <Input key={document.id + document.name} className="h-7 w-40 text-xs" aria-label="SQL 脚本名称" defaultValue={document.name} maxLength={80}
        onBlur={event => onRename(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} />
      <span className="text-xs text-muted-foreground">{document.sql !== document.savedSql ? "未保存" : document.sql ? "已保存到文件" : "空白脚本"}</span>
      <Button size="xs" variant="outline" disabled={saving || !document.sql.trim()} data-testid="mysql-script-save" onClick={() => {
        setSaving(true)
        void onSave().then(saved => { if (saved) toast.success("SQL 脚本已保存") }).catch(error => toast.error(error instanceof Error ? error.message : "保存失败")).finally(() => setSaving(false))
      }}>{saving ? "保存中…" : "保存 .sql"}</Button>
    </> : null}
    <Button size="xs" variant="ghost" disabled={!canCreate} onClick={() => fileInput.current?.click()}>打开 .sql</Button>
    <input ref={fileInput} hidden type="file" accept=".sql,text/plain" data-testid="mysql-script-import" onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file) return
      if (file.size > 4 * 1024 * 1024) { toast.error("脚本不能超过 4 MiB"); return }
      void file.text().then(sql => onImport(file.name.replace(/\.sql$/i, ""), sql)).catch(() => toast.error("无法读取 SQL 文件"))
    }} />
    <Button size="xs" variant="ghost" disabled={!canRestore || !canCreate} data-testid="mysql-script-restore" onClick={onRestore}>恢复关闭的脚本</Button>
  </div>
}
