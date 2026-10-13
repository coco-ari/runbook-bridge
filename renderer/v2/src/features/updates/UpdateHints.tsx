import { ArrowRight, Cloud, DownloadSimple, WarningCircle } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { updateAction, useUpdates } from "./UpdateCenter"

export function ProjectUpdateIndicator({ projectId, repositoryId, remoteId }: { readonly projectId: string; readonly repositoryId?: string; readonly remoteId?: string }) {
  const updates = useUpdates()
  const notice = updates?.items.find(item => item.type === "cloud" && (item.localProjectId === projectId || item.repositoryId === repositoryId && item.projectId === remoteId))
  if (!notice) return null
  const label = notice.kind === "conflict" ? "云端与本地都有修改，需要比较" : "有尚未完成的云端更新"
  return <span role="img" aria-label={label} title={label} className={cn("size-1.5 shrink-0 rounded-full", notice.kind === "conflict" ? "bg-warning" : "bg-muted-foreground")} data-testid="project-update-indicator" />
}

export function ProjectUpdateBanner({ projectId }: { readonly projectId?: string }) {
  const updates = useUpdates()
  const notices = updates?.items.filter(item => item.type === "cloud" && item.localProjectId === projectId) ?? []
  if (!projectId || !notices.length || !updates) return null
  return <div className="shrink-0 space-y-2 border-b px-3 py-2.5" data-testid="project-update-banner">{notices.map(item => <div key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    {item.kind === "conflict" ? <WarningCircle className="shrink-0 text-warning" /> : <Cloud className="shrink-0 text-muted-foreground" />}
    <span className="min-w-0 flex-1">{item.kind === "conflict" ? "本地与云端都有修改" : item.kind === "deleted" ? "云端已删除，本地仍保留" : "云端有新配置"}</span>
    <Button size="xs" variant={item.kind === "deleted" ? "outline" : "default"} disabled={updates.busy} onClick={() => updates.view(item)} data-testid="project-update-view">{updateAction(item)}</Button>
  </div>)}</div>
}

export function SoftwareUpdateHint({ compact = false }: { readonly compact?: boolean }) {
  const updates = useUpdates()
  const item = updates?.items.find(item => item.type === "software")
  if (!item || !updates) return null
  return <div className="shrink-0 border-t border-sidebar-border px-2 py-2" data-testid="software-update-hint">
    <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-left" disabled={updates.busy} onClick={() => updates.view(item)} title={item.title}>
      <DownloadSimple className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 whitespace-normal text-xs leading-4">{item.kind === "downloaded" ? "新版本已就绪" : "新版本可用"}{!compact ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{updateAction(item)}</span> : null}</span>{!compact ? <ArrowRight className="shrink-0 text-muted-foreground" /> : null}
    </Button>
  </div>
}
