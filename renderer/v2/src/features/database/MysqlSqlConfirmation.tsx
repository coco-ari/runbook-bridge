import { EnvironmentTypeBadge } from "@/features/environments/EnvironmentTypeBadge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import type { MysqlQueryDocument } from "./use-mysql-query-documents"
export function MysqlSqlConfirmation({ document, database, target, onCancel, onConfirm }: {
  readonly document: MysqlQueryDocument | undefined
  readonly database: string
  readonly target: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  const plan = document?.execution?.plan
  return <Dialog open={Boolean(document?.confirmation && plan)} onOpenChange={open => { if (!open) onCancel() }}><DialogContent className="max-h-[min(720px,calc(100dvh-3rem))] overflow-y-auto" data-testid="mysql-query-confirm-dialog">
    <DialogHeader><DialogTitle>确认执行 SQL</DialogTitle><DialogDescription>以下语句将修改当前数据库。确认仅用于本次执行；修改脚本后需要重新校验。</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-center gap-2 text-sm"><EnvironmentTypeBadge /><span className="break-all">{target}</span><strong className="break-all font-mono">{database}</strong><span className="text-muted-foreground">{plan?.statementCount} 条语句 · {plan?.writeCount} 条写入</span></div>
    {plan?.dangerous ? <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm" role="alert">包含没有 WHERE 条件的更新或删除，可能影响整张表。请确认目标和范围。</p> : null}
    <p className="text-sm text-muted-foreground">{document?.mode === "atomic" ? "整批事务：全部成功后提交，任一失败则回滚本批写入。" : document?.mode === "manual" ? "手动事务：执行后仍需提交；回滚可撤销未提交的更改。" : "逐条提交：每条成功立即生效，遇错停止，之前成功的写入保留。"}</p>
    <div className="max-h-32 overflow-y-auto rounded-md border p-2 text-xs">{plan?.statements.filter(item => !["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(item.kind.toUpperCase())).map(item => <p className="py-1" key={item.index}>第 {item.index} 条 · 行 {item.line + (document?.result.lineOffset ?? 0)} · {item.kind.toUpperCase()} · {item.tables.join("、") || "当前事务"}</p>)}</div>
    <pre className="max-h-56 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5" data-testid="mysql-query-confirm-sql">{document?.result.executedSql}</pre>
    <DialogFooter><Button variant="outline" onClick={onCancel}>取消</Button><Button data-testid="mysql-query-confirm-execute" variant={plan?.dangerous ? "destructive" : "default"} onClick={onConfirm}>确认执行</Button></DialogFooter>
  </DialogContent></Dialog>
}
