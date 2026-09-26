import { useState, type ReactNode } from "react"
import { ArrowClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react"
import type { MysqlSqlResult, MysqlSqlState } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { MysqlTransactionSummaryPanel } from "./MysqlTransactionSummary"
import { DiagnosticDetails } from "@/features/connections/DiagnosticDetails"

const effects = { none: "", committed: "已提交", pending: "未提交", rolledBack: "已回滚", unknown: "结果待核实" } as const
export function MysqlSqlExecutionResults({ state, lineOffset, loading, onCheck, renderResult }: {
  readonly state: MysqlSqlState
  readonly lineOffset: number
  readonly loading: boolean
  readonly onCheck: () => void
  readonly renderResult: (result: MysqlSqlResult) => ReactNode
}) {
  const [selected, setSelected] = useState<{ planId: string | undefined; index: number } | null>(null)
  const result = (selected?.planId === state.plan?.planId ? state.results.find(item => item.index === selected?.index) : null) ?? state.results.find(item => item.status === "error") ?? state.results[0]
  const uncertain = state.status === "unknown" || state.transaction === "unknown"
  return <>
    {state.transaction === "active" && !uncertain ? <div data-testid="mysql-query-transaction-active" className="shrink-0">{state.transactionSummary ? <MysqlTransactionSummaryPanel key={state.transactionSummary.id} summary={state.transactionSummary} busy={loading} transaction={state.transaction} mode={state.mode} /> : <div className="mysql-sql-transaction-message" role="status"><span className="size-2 shrink-0 rounded-full bg-warning" /><strong>事务未提交</strong><span>当前标签独立持有事务。完成后请提交或回滚。</span></div>}</div> : null}
    {uncertain ? <div className="mysql-sql-transaction-message is-warning" data-testid="mysql-query-uncertain" role="alert"><WarningCircle /><div><strong>执行结果待核实</strong><p>服务器可能已经完成写入。请核对状态和数据，勿重复执行。</p></div><Button size="sm" variant="outline" disabled={loading} onClick={onCheck}>核对状态</Button></div> : null}
    {uncertain && state.transactionSummary ? <MysqlTransactionSummaryPanel key={state.transactionSummary.id} summary={state.transactionSummary} busy={loading} transaction="unknown" mode={state.mode} /> : null}
    {state.message && (state.status === "cancelled" || state.status === "error" || state.message.includes("操作记录")) ? <p className="mysql-sql-progress" role="status">{state.message}</p> : null}
    {state.results.length ? <div aria-label="SQL 执行结果列表" className="mysql-sql-result-list" data-testid="mysql-query-statements">
      {state.results.map(item => <button aria-pressed={item.index === result?.index} className="mysql-sql-result-item" data-testid="mysql-query-statement-result" data-statement-index={item.index} key={item.index} onClick={() => setSelected({ planId: state.plan?.planId, index: item.index })} type="button">
        {item.status === "success" ? <CheckCircle aria-hidden="true" className="text-success" /> : item.status === "error" ? <WarningCircle aria-hidden="true" className="text-danger" /> : <span className="size-3 rounded-full border border-muted-foreground" />}
        <strong>第 {item.index} 条 · {item.kind.toUpperCase()}</strong><span>行 {item.line + lineOffset}</span><span>{item.status === "skipped" ? "已跳过" : item.status === "error" ? "失败" : item.data ? `${item.data.rowCount} 行结果` : item.kind === "commit" ? "事务已提交" : item.kind === "rollback" ? "事务已回滚" : item.kind === "begin" ? "事务已开始" : `影响 ${item.affectedRows ?? 0} 行`}</span><span>{Math.round(item.durationMs)} ms</span>{effects[item.transactionEffect] ? <span>{effects[item.transactionEffect]}</span> : null}{item.warningCount ? <span>{item.warningCount} 条警告</span> : null}
      </button>)}
    </div> : null}
    {loading ? <div className="mysql-sql-progress" role="status"><ArrowClockwise className="size-3 motion-safe:animate-spin" />正在执行… 已完成 {state.results.filter(item => item.status !== "skipped").length} / {state.plan?.statementCount ?? "待确认"} 条</div> : null}
    {result?.error ? <div className="mysql-sql-result-error" data-testid="mysql-query-statement-error" role="alert"><strong>第 {result.index} 条，行 {result.line + lineOffset}：{result.error.message}</strong><DiagnosticDetails error={result.error} domain="operation" /></div> : null}
    {result?.data ? renderResult(result) : state.results.length && !loading ? <div className="mysql-sql-execution-summary" data-testid="mysql-query-execution-summary"><p>{state.message || (state.status === "cancelled" ? "执行已停止。" : state.status === "error" ? "执行失败，后续语句已停止。" : state.transaction === "active" ? "语句执行完成，更改尚未提交。" : "执行完成。")}</p><p className="text-muted-foreground">{state.mode === "autocommit" ? "逐条提交：成功提交的语句已生效，不会随之后的失败撤销。" : state.mode === "manual" ? "手动事务：请根据上方状态提交或回滚。" : "整批事务：写入成功后统一提交，失败时回滚本批写入。"}</p></div> : null}
  </>
}
