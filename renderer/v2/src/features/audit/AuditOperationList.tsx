import { CaretRight, Robot, User, Gear } from "@phosphor-icons/react"
import { Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import { auditResultLabel, auditResultVariant, publicErrorLabel } from "@/lib/operation-copy"
import { actorLabels, auditDay, auditTime, categoryLabels, durationLabel, type AuditDisplayEntry } from "./audit-display"

export function AuditOperationList({ entries }: { readonly entries: readonly AuditDisplayEntry[] }) {
  return (
    <div aria-label="操作记录" data-audit-layout="operations" className="divide-y divide-border/70">
      {entries.map((entry, index) => {
        const Icon = entry.actor === "agent" ? Robot : entry.actor === "user" ? User : Gear
        const events = entry.timeline.length ? entry.timeline : [entry]
        return (
          <Fragment key={entry.auditId}>
            {index === 0 || auditDay(entries[index - 1]?.time ?? null) !== auditDay(entry.time) ? (
              <div className="bg-surface-inset px-3 py-2 text-xs font-medium text-muted-foreground">{auditDay(entry.time)}</div>
            ) : null}
            <details className="group px-3 py-3 [content-visibility:auto] [contain-intrinsic-size:auto_92px]" data-audit-operation={entry.auditId}>
              <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring @lg/audit:grid-cols-[5rem_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
                <time className="col-span-2 text-xs tabular-nums text-muted-foreground @lg/audit:col-span-1 @lg/audit:row-span-3" dateTime={entry.time ?? undefined}>{auditTime(entry.time)}</time>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Icon aria-hidden="true" size={14} />{actorLabels[entry.actor]}</span>
                  <span className="min-w-0 break-words">{entry.title}</span>
                </div>
                <div className="flex items-center gap-2 self-start"><Badge data-audit-result variant={auditResultVariant(entry.result)}>{auditResultLabel(entry.result)}</Badge><CaretRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" /></div>
                <div className="col-span-2 min-w-0 text-xs text-muted-foreground @lg/audit:col-span-1 @lg/audit:col-start-2">
                  <span>{entry.pluginName}</span>
                  {entry.target ? <span className="mt-0.5 block truncate text-left font-mono" dir="rtl" title={entry.target}><bdi dir="ltr">{entry.target}</bdi></span> : null}
                </div>
                <div className="col-span-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground @lg/audit:col-start-2">
                  <span>{categoryLabels[entry.category]}</span>
                  {entry.exitCode !== null ? <span>退出码 {entry.exitCode}</span> : null}
                  {entry.rowCount !== null ? <span>返回 {entry.rowCount} 行{entry.truncated ? "（已截断）" : ""}</span> : null}
                  {entry.durationMs !== null ? <span>耗时 {durationLabel(entry.durationMs)}</span> : null}
                  {entry.approval ? <span>{entry.approval === "approved" ? "用户已批准" : "用户已拒绝"}</span> : null}
                  {entry.errorCode ? <span className="text-danger">{entry.errorSummary || publicErrorLabel(entry.errorCode)}</span> : null}
                </div>
              </summary>
              <div className="mt-3 space-y-3 rounded-md border border-border/70 bg-surface-inset p-3 text-xs @lg/audit:ml-20" data-audit-detail>
                {entry.target ? <div><span className="text-muted-foreground">操作目标</span><p className="mt-1 select-text break-all font-mono">{entry.target}</p></div> : null}
                <ol aria-label="操作过程" className="space-y-2 border-l border-border pl-3">
                  {events.map((event, eventIndex) => <li key={`${event.auditId}:${eventIndex}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <time className="tabular-nums text-muted-foreground" dateTime={event.time ?? undefined}>{event.time ? new Date(event.time).toLocaleString("zh-CN", {hour12:false}) : "时间未记录"}</time>
                    <span className="font-medium">{actorLabels[event.actor]}</span><span>{event.phase || event.title}</span>
                    {event.pluginName !== entry.pluginName ? <span className="text-muted-foreground">{event.pluginName}</span> : null}
                    {event.errorCode ? <span className="text-danger">{event.errorSummary || publicErrorLabel(event.errorCode)} <code className="break-all">{event.errorCode}</code></span> : null}
                  </li>)}
                </ol>
                {entry.timelineTruncated ? <p className="text-muted-foreground">共 {entry.eventCount} 个过程事件；显示首次事件及最近 63 个事件。</p> : null}
                {entry.result === "unknown" ? <p className="text-muted-foreground">没有足够的记录确认最终结果。</p> : null}
              </div>
            </details>
          </Fragment>
        )
      })}
    </div>
  )
}
