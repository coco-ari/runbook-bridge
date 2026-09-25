import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"

export const MYSQL_COLUMN_MIN_WIDTH = 72
export const MYSQL_COLUMN_MAX_WIDTH = 1200
export type MysqlWidthCache = Map<string, readonly number[]>
export type MysqlWidthColumns = MysqlQueryResult["columns"]

export function mysqlColumnSignature(columns: MysqlWidthColumns): string {
  return JSON.stringify(columns.map(column => [column.name, column.table, column.type]))
}
export function clampMysqlColumnWidth(width: number): number {
  return Math.round(Math.max(MYSQL_COLUMN_MIN_WIDTH, Math.min(MYSQL_COLUMN_MAX_WIDTH, width)))
}
export function readMysqlColumnWidths(raw: string | null, count: number): readonly number[] | null {
  try {
    const widths: unknown = JSON.parse(raw ?? "null")
    return Array.isArray(widths) && widths.length === count && widths.every(width => typeof width === "number" && Number.isFinite(width) && width >= MYSQL_COLUMN_MIN_WIDTH && width <= MYSQL_COLUMN_MAX_WIDTH) ? widths : null
  } catch { return null }
}
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (value === "") return "（空字符串）"
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}
export function estimateMysqlTextWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + (char.codePointAt(0)! > 255 ? 12 : 7.25), 0)
}
export function autoMysqlColumnWidths(columns: MysqlWidthColumns, rows: MysqlQueryResult["rows"], measure = estimateMysqlTextWidth, maxWidth = 280): readonly number[] {
  // 只采样已加载的前一百行，并限制长文本测量量；不查询数据库，也不保存单元格内容。
  return columns.map(column => {
    let width = measure(column.name.slice(0, 256)) + 40
    for (const row of rows.slice(0, 100)) {
      for (const line of cellText(row[column.name]).slice(0, 512).split(/\r?\n/u)) width = Math.max(width, measure(line) + 16)
    }
    return clampMysqlColumnWidth(Math.min(maxWidth, Math.ceil(width / 8) * 8))
  })
}
