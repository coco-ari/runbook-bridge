import { CaretDown, Cloud, DownloadSimple, UploadSimple } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useCloudConfig } from "./CloudConfigProvider"
import type { CloudLinkedProject, CloudSyncStatus } from "./cloud-types"

export const cloudStatusLabels: Record<CloudSyncStatus, string> = {
  synced: "已同步", behind: "云端有更新", modified: "本地有修改", remote: "尚未下载", unknown: "尚未检测", locked: "仓库未解锁", error: "检测失败",
}
export function CloudProjectIcon({ status }: { status: CloudSyncStatus }) {
  return <Cloud aria-label={cloudStatusLabels[status]} data-cloud-status={status} className={cn("size-3.5 shrink-0", status === "behind" ? "text-primary" : status === "modified" ? "text-warning" : status === "error" ? "text-destructive" : "text-muted-foreground")} />
}
export function CloudProjectActions({ projectId, linked, elsewhere = true }: { projectId?: string; linked?: CloudLinkedProject; elsewhere?: boolean }) {
  const cloud = useCloudConfig()
  const connection = linked ?? cloud.data.cloudProjects?.find(item => item.localId === projectId)
  const localId = connection?.localId ?? projectId
  const repository = cloud.data.repositories?.find(repo => repo.repositoryId === connection?.repositoryId)
  return <div className="flex shrink-0 flex-wrap items-center gap-1.5" data-testid="cloud-project-actions" data-cloud-project={connection?.projectId ?? projectId}>
    <Button size="xs" variant="outline" disabled={cloud.busy || !connection || !repository?.unlocked || connection.syncStatus === "synced"} data-testid="cloud-project-update" onClick={() => { if (connection) void cloud.run({ action: "sync", repositoryId: connection.repositoryId, direction: "download", projectId: connection.projectId }) }}><DownloadSimple />更新</Button>
    <Button size="xs" variant="outline" disabled={cloud.busy || !localId || (Boolean(connection) && !repository?.unlocked)} data-testid="cloud-project-upload" onClick={() => { if (localId) cloud.upload(localId, connection?.repositoryId) }}><UploadSimple />上传</Button>
    {elsewhere && connection && localId && (cloud.data.repositories ?? []).some(repo => repo.repositoryId !== connection.repositoryId && repo.unlocked) ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" disabled={cloud.busy} aria-label="上传到其他仓库"><CaretDown /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuLabel>创建独立项目副本</DropdownMenuLabel>{cloud.data.repositories?.filter(repo => repo.repositoryId !== connection.repositoryId && repo.unlocked).map(repo => <DropdownMenuItem key={repo.repositoryId} onSelect={() => cloud.upload(localId, repo.repositoryId)}>上传到 {repo.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu> : null}
  </div>
}
