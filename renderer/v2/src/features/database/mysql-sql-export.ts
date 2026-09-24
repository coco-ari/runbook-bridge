import type { MysqlEditColumn, MysqlEditData, MysqlEditRow } from "@/bridge/ai-ops-v2"

export type MysqlSqlKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE"
const numeric = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "year"])
const text = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set", "json", "date", "datetime", "timestamp", "time"])
const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`"

export function mysqlSqlLiteral(column: MysqlEditColumn, value: string | null | undefined): string {
  if (value === undefined) throw new Error("缺少字段 " + column.name + " 的完整值。")
  if (value === null) return "NULL"
  if (numeric.has(column.dataType)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) throw new Error("字段 " + column.name + " 的数字格式无法可靠导出。")
    return value
  }
  if (!text.has(column.dataType)) throw new Error("字段 " + column.name + " 的类型暂不支持 SQL 导出。")
  // 特殊字符用 UTF-8 十六进制表达式，避免反斜杠转义模式改变原值。
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) {
    const hex = [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, "0")).join("")
    return "CONVERT(X'" + hex + "' USING utf8mb4)"
  }
  return "'" + value.replaceAll("'", "''") + "'"
}

export function generateMysqlSql(data: MysqlEditData, rows: readonly MysqlEditRow[], kind: MysqlSqlKind, updateFields?: readonly string[]): string {
  if (!["SELECT", "INSERT", "UPDATE", "DELETE"].includes(kind)) throw new Error("不支持的 SQL 类型。")
  if (!rows.length || rows.length > 100) throw new Error("请选择 1 到 100 行数据。")
  if (!data.database || !data.table) throw new Error("无法确认数据来源。请重新查询。")
  const keys = data.columns.filter(column => column.primary)
  if (!keys.length) throw new Error("生成 SQL 需要完整主键。")
  if (new Set(rows.map(row => row.rowId)).size !== rows.length) throw new Error("选择中出现重复行。")
  const known = new Map(data.rows.map(row => [row.rowId, row]))
  const signatures = new Set<string>()
  for (const row of rows) {
    if (known.get(row.rowId) !== row) throw new Error("选中行不属于当前数据快照。")
    if (keys.some(column => row.values[column.name] === null || row.values[column.name] === undefined)) throw new Error("选中行缺少完整主键。")
    const key = JSON.stringify(keys.map(column => row.values[column.name]))
    if (signatures.has(key)) throw new Error("选择中出现重复主键。")
    signatures.add(key)
  }
  const table = quote(data.database) + "." + quote(data.table)
  const where = (row: MysqlEditRow) => keys.map(column => quote(column.source) + " = " + mysqlSqlLiteral(column, row.values[column.name])).join(" AND ")
  let sql: string
  if (kind === "SELECT") sql = "SELECT " + data.columns.map(column => quote(column.source)).join(", ") + "\nFROM " + table + "\nWHERE " + rows.map(row => "(" + where(row) + ")").join("\n   OR ") + ";"
  else if (kind === "DELETE") sql = rows.map(row => "DELETE FROM " + table + " WHERE " + where(row) + ";").join("\n")
  else {
    if (kind === "INSERT" && !data.insertMissingColumns) throw new Error("缺少 INSERT 字段完整性信息，请重新查询。")
    if (kind === "INSERT" && data.insertMissingColumns?.length) throw new Error("查询未包含 INSERT 必填字段：" + data.insertMissingColumns.join("、") + "。请查询完整行后导出。")
    const columns = kind === "INSERT" ? data.columns.filter(column => !column.generated) : data.columns.filter(column => column.editable && !column.primary && !column.generated && (!updateFields || updateFields.includes(column.name)))
    if (!columns.length) throw new Error("请选择至少一个可生成的字段。")
    if (kind === "UPDATE" && updateFields?.some(name => !columns.some(column => column.name === name))) throw new Error("UPDATE 包含主键、生成列或不可修改的字段。")
    sql = kind === "INSERT"
      ? "INSERT INTO " + table + " (" + columns.map(column => quote(column.source)).join(", ") + ") VALUES\n" + rows.map(row => "(" + columns.map(column => mysqlSqlLiteral(column, row.values[column.name])).join(", ") + ")").join(",\n") + ";"
      : rows.map(row => "UPDATE " + table + " SET " + columns.map(column => quote(column.source) + " = " + mysqlSqlLiteral(column, row.values[column.name])).join(", ") + " WHERE " + where(row) + ";").join("\n")
  }
  const output = "-- 根据已选 " + rows.length + " 行生成，仅包含当前查询字段；未执行。\n" + sql + "\n"
  if (new TextEncoder().encode(output).byteLength > 4 * 1024 * 1024) throw new Error("生成内容超过 4 MB，请减少选中行数。")
  return output
}
