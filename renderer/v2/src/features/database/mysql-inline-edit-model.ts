import type { MysqlEditData, MysqlEditRow } from "@/bridge/ai-ops-v2"

export type MysqlDisplayedRow = Record<string, unknown>

// 只接受能够无损转换的主键，绝不能用行号、排序位置或已舍入的数字绑定更新目标。
export function mysqlEditRowKey(row: MysqlDisplayedRow, keys: readonly string[]): string | null {
  if (!keys.length) return null
  const values: string[] = []
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string") values.push(value)
    else if (typeof value === "number" && Number.isSafeInteger(value)) values.push(String(value))
    else return null
  }
  return JSON.stringify(values)
}

export function bindMysqlEditRows(rows: readonly MysqlDisplayedRow[], edit: MysqlEditData): Map<MysqlDisplayedRow, MysqlEditRow> {
  const keys = edit.columns.filter(column => column.primary).map(column => column.name)
  const captured = new Map(edit.rows.map(row => [mysqlEditRowKey(row.values, keys), row]))
  const counts = new Map<string, number>()
  for (const row of rows) { const key = mysqlEditRowKey(row, keys); if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1) }
  const bindings = new Map<MysqlDisplayedRow, MysqlEditRow>()
  for (const row of rows) {
    const key = mysqlEditRowKey(row, keys), target = key === null ? undefined : captured.get(key)
    if (key !== null && counts.get(key) === 1 && target) bindings.set(row, target)
  }
  return bindings
}

export function mysqlEditValueMatches(value: unknown, captured: string | null): boolean {
  if (value === null) return captured === null
  if (typeof value === "string") return value === captured
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value) === captured
  return false
}
