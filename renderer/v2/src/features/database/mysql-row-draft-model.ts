import type { MysqlEditData } from "@/bridge/ai-ops-v2"
import type { MysqlDisplayedRow } from "./mysql-inline-edit-model"

export interface MysqlInsertDraft {
  rowId: string
  values: Record<string, string | null>
  copied?: boolean
  afterRowId?: string | undefined
}
export interface MysqlDraftGridRow { row: MysqlDisplayedRow; rowId: string; afterRowId?: string | undefined }
export interface MysqlGridRow { row: MysqlDisplayedRow; index: number }

// 草稿始终保留在当前视图；源行不可见时放在结果末尾，不参与结果筛选或排序。
export function mergeMysqlDraftRows(rows: readonly MysqlGridRow[], drafts: readonly MysqlDraftGridRow[], rowId: (row: MysqlDisplayedRow) => string | undefined, resultCount: number): MysqlGridRow[] {
  const output: MysqlGridRow[] = [], visited = new Set<string>()
  const append = (draft: MysqlDraftGridRow, index: number) => {
    if (visited.has(draft.rowId)) return
    visited.add(draft.rowId)
    output.push({ row: draft.row, index: resultCount + index })
    drafts.forEach((child, childIndex) => { if (child.afterRowId === draft.rowId) append(child, childIndex) })
  }
  for (const row of rows) {
    output.push(row)
    const id = rowId(row.row)
    drafts.forEach((draft, index) => { if (id && draft.afterRowId === id) append(draft, index) })
  }
  drafts.forEach(append)
  return output
}

export function mysqlDraftColumn(edit: MysqlEditData, name: string) {
  const source = edit.columns.find(column => column.name === name)?.source ?? name
  return edit.insertColumns?.find(column => column.name === source)
}

export function mysqlDraftPlaceholder(draft: MysqlInsertDraft, edit: MysqlEditData, name: string): string | null {
  const column = mysqlDraftColumn(edit, name)
  if (!column) return "未查询字段"
  if (column.generated || column.autoIncrement) return "自动生成"
  if (Object.hasOwn(draft.values, column.name)) return null
  if (column.required) return "待填写"
  return "默认：" + (column.defaultValue ?? "NULL")
}
