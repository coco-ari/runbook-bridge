import { ArrowClockwise, ShieldWarning } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import type { useConfirmationCount } from "./use-confirmation-count"
import { activeConfirmationMessages, type ConfirmationMessage } from "./confirmation-message-model"
import { redactConfirmationText as safeText } from "./confirmation-presentation-model"
import { capabilityLabel } from "@/lib/operation-copy"

export type MessageConfirmations = ReturnType<typeof useConfirmationCount>

export function confirmationTarget(item: ConfirmationMessage, projects: readonly WorkspaceProjectReadModel[]) {
  const project = projects.find(project => project.projectId === item.projectId)
  const environment = project?.environments.find(environment => environment.environmentId === item.environmentId)
  return { project, environment, available: Boolean(project && !project.isolated && environment) }
}

export function ConfirmationMessages({ confirmations, projects, onReview }: {
  readonly confirmations: MessageConfirmations
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly onReview: (item: ConfirmationMessage) => void
}) {
  const items = activeConfirmationMessages(confirmations.items)
  if (!items.length && !confirmations.loading && !confirmations.unavailable) return null
  return <section className="py-2" aria-label="操作确认" data-testid="message-confirmations">
    <div className="flex items-center justify-between gap-2 py-1">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-warning"><ShieldWarning className="size-4" aria-hidden="true" />操作确认{items.length ? ` · ${items.length}` : ""}</h3>
      <Button size="icon-xs" variant="ghost" disabled={confirmations.loading} aria-label="重新读取待确认操作" title="重新读取" data-testid="global-confirmations-refresh" onClick={confirmations.retry}><ArrowClockwise /></Button>
    </div>
    {confirmations.loading ? <p role="status" className="py-3 text-xs text-muted-foreground">正在读取待确认操作…</p> : confirmations.unavailable ? <p role="alert" className="py-3 text-xs text-destructive">待确认队列暂时不可用，请重新读取。</p> : <div className="divide-y divide-border/60">
      {items.map(item => {
        const { project, environment, available } = confirmationTarget(item, projects)
        const pluginName = environment?.resourcePreview.find(plugin => plugin.pluginInstanceId === item.pluginInstanceId)?.displayName
        const dangerous = item.riskLevel === "critical" || item.riskLevel === "destructive"
        return <article key={item.requestId} className="space-y-2 py-3" data-confirmation-message={item.requestId} data-confirmation-project={item.projectId} data-confirmation-environment={item.environmentId}>
          <div className="flex items-start justify-between gap-2"><h4 className="min-w-0 break-words text-sm font-semibold">{capabilityLabel(item.capability)}</h4>{dangerous ? <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">{item.riskLevel === "critical" ? "高风险" : "破坏性变更"}</span> : null}</div>
          <p className="break-words text-xs text-muted-foreground">{project?.name ?? safeText(item.projectNameSnapshot, item.projectId)} / {environment?.name ?? safeText(item.environmentNameSnapshot, item.environmentId)} · {pluginName ?? safeText(item.pluginNameSnapshot, "目标插件")}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{available ? `${Math.max(1, Math.ceil((item.expiresAt - Date.now()) / 1000))} 秒后过期` : "环境已不存在或暂不可用"}</span>
            <Button size="xs" variant="outline" className="border-warning/25 bg-warning/10 text-warning hover:bg-warning/15" disabled={!available} data-testid="confirmation-message-review" onClick={() => onReview(item)}>查看并确认</Button>
          </div>
        </article>
      })}
    </div>}
  </section>
}
