import type { MysqlDraftGridRow } from "./mysql-row-draft-model"
import type { MysqlSqlKind } from "./mysql-sql-export"
import { createContext, useContext, type ReactNode } from "react"
import type { MysqlDisplayedRow } from "./mysql-inline-edit-model"

export interface MysqlInlineEditing {
  replaceSelection: (rows: ReadonlySet<MysqlDisplayedRow>) => void
  clearSelection: () => void
  batch: () => void
  canEdit: (name: string, row?: MysqlDisplayedRow) => boolean
  exportSql: (kind: MysqlSqlKind, field?: string) => void
  locked: boolean
  selection: ReadonlySet<MysqlDisplayedRow>
  select: (rows: readonly MysqlDisplayedRow[], checked: boolean) => void
  value: (row: MysqlDisplayedRow, name: string, fallback: unknown) => unknown
  rowId: (row: MysqlDisplayedRow) => string | undefined
  conflict: (row: MysqlDisplayedRow) => boolean
  dirty: (row: MysqlDisplayedRow, name: string) => boolean
  cell: (row: MysqlDisplayedRow, name: string, content: ReactNode) => ReactNode
  begin: (row: MysqlDisplayedRow, name: string, modal?: boolean) => void
  finish: () => void
  toolbar?: ReactNode
  pendingRows?: readonly MysqlDraftGridRow[]
  rowState?: (row: MysqlDisplayedRow) => "insert" | "copy" | "update" | "delete" | null
  rowActions?: (row: MysqlDisplayedRow) => ReactNode
  placeholder?: (row: MysqlDisplayedRow, name: string) => string | null
  fullRow?: (row: MysqlDisplayedRow) => void
  deleted?: (row: MysqlDisplayedRow) => boolean
  restore?: (row: MysqlDisplayedRow) => void
  copyRow?: (row: MysqlDisplayedRow) => void
  deleteRow?: (row: MysqlDisplayedRow) => void
  footer: ReactNode
  pendingCount: number
  status: ReactNode
}
export const MysqlInlineEditingContext = createContext<MysqlInlineEditing | null>(null)
export const useMysqlInlineEditing = () => useContext(MysqlInlineEditingContext)
