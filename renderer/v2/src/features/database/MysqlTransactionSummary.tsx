import { useEffect, useId, useMemo, useState } from "react"
import { CaretDown } from "@phosphor-icons/react"
import type { MysqlSqlMode, MysqlSqlTransaction, MysqlTransactionSummary } from "@/bridge/ai-ops-v2"
import { mysqlTransactionDuration, mysqlTransactionEntryLabel, mysqlTransactionTiming, mysqlTransactionSummaryText } from "./mysql-transaction-summary-model"

export function MysqlTransactionSummaryPanel({ summary, transaction, mode, busy }: {
  readonly summary: MysqlTransactionSummary
  readonly transaction: MysqlSqlTransaction
  readonly mode: MysqlSqlMode
  readonly busy: boolean
}) {
  const detailsId = useId()
  const anchor = useMemo(() => ({ receivedAt: performance.now() }), [summary.id, summary.serverNow])
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (transaction === "unknown") return
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [transaction])
  const timing = mysqlTransactionTiming(summary, anchor.receivedAt, Math.max(now, anchor.receivedAt), transaction)
  const unknown = transaction === "unknown"
  const text = mysqlTransactionSummaryText(summary, transaction, busy)
  return <details className="mysql-transaction-summary" data-testid="mysql-query-transaction-summary" data-idle-state={timing.idleState}>
    <summary aria-controls={detailsId} className="mysql-transaction-summary-toggle" data-testid="mysql-query-transaction-toggle">
      <span className="mysql-transaction-summary-heading"><span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" /><strong>{unknown ? "事务结果待核实" : mode === "manual" ? "事务未提交" : "事务执行中"}</strong></span>
      <span className="mysql-transaction-summary-counts" data-testid="mysql-query-transaction-counts" data-statement-count={summary.statementCount} data-write-count={summary.writeCount} data-affected-rows={summary.affectedRows}>
        {text.counts}
      </span>
      {!unknown ? <span aria-live="off" className="mysql-transaction-summary-time" data-testid="mysql-query-transaction-time" role="timer">
        已持续 {mysqlTransactionDuration(timing.elapsedMs)}
        <span>{timing.idleState === "paused" ? "执行中，空闲计时暂停" : timing.idleState === "confirming" ? "正在确认事务状态" : `空闲 ${mysqlTransactionDuration(timing.remainingMs ?? 0, true)} 后自动回滚`}</span>
      </span> : null}
      <CaretDown aria-hidden="true" className="mysql-transaction-summary-chevron" />
    </summary>
    <div className="mysql-transaction-summary-body" id={detailsId}>
      <p className="mysql-transaction-summary-description">{text.description}</p>
      {summary.entries.length ? <ol aria-label="本次事务操作摘要" className="mysql-transaction-summary-entries">{summary.entries.map(entry => {
        const label = mysqlTransactionEntryLabel(entry)
        return <li data-testid="mysql-query-transaction-entry" key={entry.sequence}><span className="text-muted-foreground">{entry.sequence}</span><strong>{label.kind}</strong><span className="mysql-transaction-summary-tables" title={label.tables}>{label.tables}</span><span>{entry.affectedRows === undefined ? "查询" : `${entry.affectedRows} 行次`}</span></li>
      })}</ol> : <p className="mysql-transaction-summary-empty">{text.empty}</p>}
      {summary.omittedCount > 0 ? <p className="mysql-transaction-summary-description">仅显示最近 {summary.entries.length} 条操作，另有 {summary.omittedCount} 条较早操作。上方统计包含全部操作。</p> : null}
    </div>
  </details>
}
