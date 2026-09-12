import type { MysqlTableSummary } from "@/bridge/ai-ops-v2"

export const MYSQL_TABLE_DRAG_TYPE = "application/x-runbook-mysql-table"
export const MYSQL_BROWSE_PAGE_SIZE = 20
export const MYSQL_BROWSE_MAX_ROWS = 1000
export const MYSQL_BROWSE_MAX_BYTES = 4 * 1024 * 1024
export type MysqlSort = Readonly<{ column: string; direction: "asc" | "desc" }>
export const quoteMysqlIdentifier = (name: string) => `\`${name.replaceAll("`", "``")}\``
export const mysqlSelectSnippet = (table: string) => `SELECT *\nFROM ${quoteMysqlIdentifier(table)}\nLIMIT 20`

interface SqlToken { text: string; name: string; start: number; end: number; identifier: boolean; ignored: boolean }
function sqlTokens(sql: string): SqlToken[] {
  const pattern = /--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|\\.|[^'\\])*(?:'|$)|"(?:""|\\.|[^"\\])*(?:"|$)|`(?:``|[^`])*(?:`|$)|[\p{L}_$][\p{L}\p{N}_$]*|\s+|./gu
  return [...sql.matchAll(pattern)].map(match => ({ text: match[0], name: match[0].startsWith("`") ? match[0].slice(1).replace(/`$/, "").replaceAll("``", "`") : match[0], start: match.index, end: match.index + match[0].length, identifier: /^[`\p{L}_$]/u.test(match[0]), ignored: /^(?:\s|--|#|\/\*|'|")/.test(match[0]) }))
}
const RESERVED = new Set("WHERE JOIN LEFT RIGHT INNER OUTER CROSS ON USING GROUP ORDER HAVING LIMIT OFFSET UNION AS SET FOR AND OR".split(" "))
export interface MysqlCompletionContext { readonly table: string | null; readonly prefix: string; readonly start: number; readonly end: number; readonly kind: "column" | "table" }

export function mysqlCompletionContext(sql: string, caret: number, tables: readonly MysqlTableSummary[]): MysqlCompletionContext | null {
  const all = sqlTokens(sql)
  const atCaret = all.find(token => token.start < caret && token.end >= caret)
  if (atCaret?.ignored && !/^\s/.test(atCaret.text)) return null
  const tokens = all.filter(token => !token.ignored)
  const before = tokens.filter(token => token.start < caret)
  const last = before.at(-1)
  const partial = last?.identifier && last.end >= caret ? last : null
  const previous = partial ? before.at(-2) : last
  const start = partial?.start ?? caret
  const prefix = partial ? sql.slice(start, caret).replace(/^`/, "").replace(/`$/, "").replaceAll("``", "`") : ""
  const end = partial?.end ?? caret
  if (previous?.text !== ".") {
    return previous && ["FROM", "JOIN"].includes(previous.name.toUpperCase()) ? { table: null, prefix, start, end, kind: "table" } : null
  }
  const qualifier = before.at(partial ? -3 : -2)?.name.toLowerCase()
  if (!qualifier) return null
  const known = new Map(tables.filter(table => table.queryable).map(table => [table.name.toLowerCase(), table.name]))
  const aliases = new Map<string, string>()
  for (let i = 0; i < tokens.length; i++) {
    if (!["FROM", "JOIN"].includes(tokens[i]!.name.toUpperCase())) continue
    const source = tokens[i + 1]
    if (!source?.identifier || tokens[i + 2]?.text === ".") continue
    const table = known.get(source.name.toLowerCase())
    if (!table) continue
    let alias = tokens[i + 2]
    if (alias?.name.toUpperCase() === "AS") alias = tokens[i + 3]
    if (alias?.identifier && !RESERVED.has(alias.name.toUpperCase())) aliases.set(alias.name.toLowerCase(), table)
  }
  const table = aliases.get(qualifier) ?? known.get(qualifier)
  return table ? { table, prefix, start, end, kind: "column" } : null
}

export interface MysqlSqlDiagnostic { readonly kind: "valid" | "error"; readonly message: string; readonly line?: number; readonly column?: number }
let parserPromise: Promise<InstanceType<typeof import("node-sql-parser/build/mysql.js").Parser>> | null = null
export async function mysqlSqlDiagnostic(sql: string): Promise<MysqlSqlDiagnostic | null> {
  if (!sql.trim()) return null
  if (new TextEncoder().encode(sql).length > 65536) return { kind: "error", message: "SQL 超过 64 KB，请缩小查询。" }
  parserPromise ??= import("node-sql-parser/build/mysql.js").then(module => new (module.Parser ?? module.default.Parser)())
  const parser = await parserPromise
  try {
    const ast = parser.astify(sql, { database: "MySQL" })
    if (Array.isArray(ast) || ast.type !== "select") return { kind: "error", message: "仅支持单条 SELECT 查询。" }
    return { kind: "valid", message: "基础语法通过" }
  } catch (error) {
    const position = (error as { location?: { start?: { line?: number; column?: number } } }).location?.start
    return { kind: "error", message: position?.line ? `第 ${position.line} 行、第 ${position.column ?? 1} 列附近语法不完整或有误。` : "SQL 语法不完整或有误。", ...(position?.line ? { line: position.line, column: position.column ?? 1 } : {}) }
  }
}

export function compareMysqlCells(a: unknown, b: unknown, numeric: boolean): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (numeric) {
    // DECIMAL 和 BIGINT 常以字符串返回，按十进制位比较，避免转为 Number 后丢失精度。
    const decimal = (value: unknown) => /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value))
    const left = decimal(a), right = decimal(b)
    if (left && right) {
      const li = left[2]!.replace(/^0+/, "") || "0", ri = right[2]!.replace(/^0+/, "") || "0"
      const lf = left[3] ?? "", rf = right[3] ?? ""
      const ln = left[1] === "-" && /[1-9]/.test(li + lf), rn = right[1] === "-" && /[1-9]/.test(ri + rf)
      if (ln !== rn) return ln ? -1 : 1
      const digits = Math.max(lf.length, rf.length)
      const cmp = li.length - ri.length || li.localeCompare(ri) || lf.padEnd(digits, "0").localeCompare(rf.padEnd(digits, "0"))
      return ln ? -cmp : cmp
    }
    const difference = Number(a) - Number(b)
    if (Number.isFinite(difference)) return difference
  }
  return String(a).localeCompare(String(b), "zh-CN", { numeric: true })
}
