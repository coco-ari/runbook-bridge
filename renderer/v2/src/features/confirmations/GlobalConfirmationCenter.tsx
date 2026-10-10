import { createContext, useContext, useRef } from "react"
import { ShieldWarning } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import type { ConfirmationCountSnapshot } from "./confirmation-count-model"
import type { ConfirmationEnvironment } from "./global-confirmation-model"

export const ConfirmationCenterContext = createContext<(ConfirmationCountSnapshot & { open: () => void }) | null>(null)

export function ConfirmationCenterButton() {
  const center = useContext(ConfirmationCenterContext)
  if (!center) return null
  const label = center.unavailable ? "待确认不可用" : center.loading ? "读取待确认" : "全局待确认"
  const description = center.count === null ? label : `全局 ${center.count} 项待确认操作`
  return <Button size="sm" variant="ghost" type="button" className="max-[1300px]:gap-1 max-[1300px]:px-2" data-testid="workspace-confirmation-center"
    aria-label={description} title={description + "，查看所有项目和环境"} onClick={center.open}>
    <ShieldWarning aria-hidden="true" className={center.unavailable || (center.count ?? 0) > 0 ? "text-warning" : undefined} />
    <span className="max-[1300px]:hidden">{label}</span>{center.count !== null && center.count > 0 ? <span className="text-warning tabular-nums">{center.count > 99 ? "99+" : center.count}</span> : null}
  </Button>
}

export function GlobalConfirmationCenter({ open, onOpenChange, groups, projects, loading, unavailable, onRetry, onNavigate }: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly groups: readonly ConfirmationEnvironment[]
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly loading: boolean
  readonly unavailable: boolean
  readonly onRetry: () => void
  readonly onNavigate: (scope: ConfirmationEnvironment) => void
}) {
  const pending = useRef<ConfirmationEnvironment | null>(null)
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-2xl" data-testid="global-confirmation-center" onCloseAutoFocus={event => {
      const scope = pending.current
      pending.current = null
      if (scope) { event.preventDefault(); requestAnimationFrame(() => onNavigate(scope)) }
    }}>
      <DialogHeader><DialogTitle>全局待确认</DialogTitle><DialogDescription>汇总所有项目和环境的待确认操作。选择环境后，在对应的操作确认页面核对并处理。</DialogDescription></DialogHeader>
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{loading ? "正在读取待确认操作…" : unavailable ? "待确认队列暂时不可用" : `${groups.reduce((sum, group) => sum + group.count, 0)} 项待确认 · ${groups.length} 个环境`}</p>
        <Button size="sm" variant="outline" disabled={loading} data-testid="global-confirmations-refresh" onClick={onRetry}>重新读取</Button>
      </div>
      <div className="max-h-[60dvh] space-y-2 overflow-y-auto">
        {!loading && !unavailable && groups.length === 0 ? <p className="p-4 text-sm text-muted-foreground">当前没有待确认操作。</p> : null}
        {!loading && !unavailable ? groups.map(group => {
          const project = projects.find(item => item.projectId === group.projectId)
          const environment = project?.environments.find(item => item.environmentId === group.environmentId)
          const available = Boolean(project && !project.isolated && environment)
          return <div key={JSON.stringify([group.projectId, group.environmentId])} className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border p-3" data-confirmation-project={group.projectId} data-confirmation-environment={group.environmentId}>
            <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{project?.name ?? group.projectId} / {environment?.name ?? group.environmentId}</p><p className="text-xs text-muted-foreground">{group.count} 项待确认{available ? "" : " · 环境已不存在或暂不可用"}</p></div>
            <Button size="sm" variant="outline" disabled={!available} data-testid="confirmation-environment-open" aria-label={`查看 ${project?.name ?? group.projectId} / ${environment?.name ?? group.environmentId} 的操作确认`} onClick={() => { pending.current = group; onOpenChange(false) }}>查看操作确认</Button>
          </div>
        }) : null}
      </div>
    </DialogContent>
  </Dialog>
}
