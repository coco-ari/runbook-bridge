import type { MysqlSqlState, MysqlSqlTransaction, MysqlTransactionEntry, MysqlTransactionSummary } from "@/bridge/ai-ops-v2"

export interface MysqlTransactionTiming {
  readonly elapsedMs: number
  readonly remainingMs: number | null
  readonly idleState: "normal" | "soon" | "confirming" | "paused" | "unknown"
}

// 用主进程快照校时，再以单调时钟推进；系统时间调整不会触发客户端假回滚。
export function mysqlTransactionTiming(summary: MysqlTransactionSummary, receivedAt: number, monotonicNow: number, transaction: MysqlSqlTransaction): MysqlTransactionTiming {
  const sinceReceipt = Math.max(0, monotonicNow - receivedAt)
  const elapsedMs = Math.max(0, summary.serverNow - summary.startedAt + sinceReceipt)
  if (transaction === "unknown") return { elapsedMs, remainingMs: null, idleState: "unknown" }
  if (summary.idleExpiresAt === null) return { elapsedMs, remainingMs: null, idleState: "paused" }
  const remainingMs = Math.max(0, summary.idleExpiresAt - summary.serverNow - sinceReceipt)
  return { elapsedMs, remainingMs, idleState: remainingMs === 0 ? "confirming" : remainingMs < 60_000 ? "soon" : "normal" }
}

export function mysqlTransactionDuration(milliseconds: number, roundUp = false): string {
  const seconds = Math.max(0, (roundUp ? Math.ceil : Math.floor)(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}

const kinds: Readonly<Record<string, string>> = { insert: "INSERT", update: "UPDATE", delete: "DELETE", select: "SELECT", explain: "EXPLAIN", show: "SHOW", describe: "DESCRIBE" }
export function mysqlTransactionEntryLabel(entry: MysqlTransactionEntry) {
  const shown = entry.tables.join("、") || "当前数据库"
  return { kind: kinds[entry.kind.toLowerCase()] ?? "SQL", tables: (entry.tableCount ?? 0) > entry.tables.length ? `${shown} 等 ${entry.tableCount} 张表` : shown }
}

// 轮询只换摘要，不替换数据表引用和结果选择所依赖的执行计划。
export function withMysqlTransactionSummary(state: MysqlSqlState, summary: MysqlTransactionSummary | undefined): MysqlSqlState {
  const { transactionSummary: _previousSummary, ...execution } = state
  return { ...execution, ...(summary ? { transactionSummary: summary } : {}) }
}

export function mysqlTransactionSummaryText(summary: MysqlTransactionSummary, transaction: MysqlSqlTransaction, busy = false) {
  if (transaction === "unknown") return {
    counts: summary.writeCount > 0 ? `已返回 ${summary.writeCount} 条写入 · 累计影响 ${summary.affectedRows} 行次` : "暂无已确认写入 · 结果待核实",
    description: "仅包含已返回成功的操作，不含尚未应答的语句；实际写入与最终提交结果仍需核实。",
    empty: "尚无成功返回的操作记录，实际结果待核实。",
  }
  return {
    counts: summary.writeCount > 0 ? `待提交 ${summary.writeCount} 条写入 · 累计影响 ${summary.affectedRows} 行次` : busy ? "尚无已完成写入 · 正在等待执行结果" : `未发生写入 · 已执行 ${summary.statementCount} 条查询`,
    description: summary.writeCount > 0 ? "统计包含本次事务跨多次执行的操作；同一行被多次修改会累计计数，不代表不同数据行数。" : busy ? "下方仅列已返回成功的操作；当前执行仍在等待结果。" : "本事务仅有查询，没有待提交的数据更改。",
    empty: busy ? "尚无成功返回的操作记录，当前仍在执行。" : "事务已开始，尚未执行查询或写入。",
  }
}
