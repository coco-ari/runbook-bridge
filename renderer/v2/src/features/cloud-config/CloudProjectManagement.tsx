import { useState } from "react"
import { ClockCounterClockwise, DotsThree, SpinnerGap, Trash } from "@phosphor-icons/react"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useMenuHandoff } from "@/hooks/use-menu-handoff"
import { changeSummary, useCloudConfig } from "./CloudConfigProvider"
import type { CloudProjectHistory, CloudProjectOperation, CloudConfigRequest } from "./cloud-types"

export function CloudProjectMenu({ name, disabled, onHistory, onDelete }: { name: string; disabled: boolean; onHistory: () => void; onDelete: () => void }) {
  const handoff = useMenuHandoff(name)
  return <DropdownMenu onOpenChange={handoff.onOpenChange}><DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" disabled={disabled} aria-label={`管理${name}`} data-testid="cloud-project-menu"><DotsThree /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={handoff.onCloseAutoFocus}><DropdownMenuItem data-testid="cloud-project-history" onSelect={() => handoff.queueAction(onHistory)}><ClockCounterClockwise />版本记录</DropdownMenuItem><DropdownMenuItem variant="destructive" data-testid="cloud-project-delete" onSelect={() => handoff.queueAction(onDelete)}><Trash />删除云端项目</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>
}

export function useCloudProjectManagement() {
  const cloud = useCloudConfig()
  const [target, setTarget] = useState<{ repositoryId: string; projectId: string; name: string } | null>(null)
  const [history, setHistory] = useState<CloudProjectHistory | null>(null)
  const [operation, setOperation] = useState<CloudProjectOperation | null>(null)
  const openHistory = async (next: NonNullable<typeof target>) => {
    setTarget(next); setHistory(null)
    const result = await cloud.run({ action: "projectHistory", repositoryId: next.repositoryId, projectId: next.projectId })
    if (result?.projectHistory) setHistory(result.projectHistory)
  }
  const prepare = async (request: Extract<CloudConfigRequest, { action: "prepareProjectOperation" }>) => {
    const result = await cloud.run(request)
    if (result?.projectOperation) setOperation(result.projectOperation)
  }
  const confirm = async () => {
    if (!operation) return
    const result = await cloud.run({ action: "confirmProjectOperation", planId: operation.planId })
    setOperation(null)
    if (result && target) await openHistory(target)
  }
  const locked = cloud.busy || Boolean(operation)
  const overlays = <>
    <Sheet open={Boolean(target)} onOpenChange={open => { if (!open && !locked) { setTarget(null); setHistory(null) } }}>
      <SheetContent className="w-full sm:max-w-md" showCloseButton={!locked} data-testid="cloud-project-versions" onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onInteractOutside={event => { if (locked) event.preventDefault() }}>
        <SheetHeader className="pr-12"><SheetTitle>项目版本记录</SheetTitle><SheetDescription className="break-words [overflow-wrap:anywhere]">{history?.name ?? target?.name}</SheetDescription></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <p className="text-xs text-muted-foreground">保留最近 20 个版本；相同配置重复上传不新增记录。恢复会发布新版本，本地配置保持不变。</p>
          {cloud.error ? <p role="alert" className="text-xs text-destructive">{cloud.error}</p> : null}
          {!history ? cloud.busy ? <p className="flex items-center gap-2 text-xs"><SpinnerGap className="animate-spin" />正在读取版本…</p> : <Button size="sm" variant="outline" onClick={() => { if (target) void openHistory(target) }}>重新读取</Button> : <>
            <Button size="xs" variant="ghost" className="self-end" disabled={locked} onClick={() => { if (target) void openHistory(target) }}>刷新版本</Button>
            {history.versions.map(version => <Card size="sm" className="shrink-0" key={version.versionId} data-testid="cloud-project-version" data-version-id={version.versionId}>
              <CardHeader><CardTitle className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{new Date(version.createdAt).toLocaleString()}</span>{version.current ? <Badge variant="secondary">当前版本</Badge> : null}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs"><p className="break-words [overflow-wrap:anywhere]">{version.name}</p><p className="text-muted-foreground">{version.environmentCount} 个环境 · {version.pluginCount} 个插件 · <span className="font-mono">{version.hash.slice(0, 10)}</span></p><p className="text-muted-foreground">{changeSummary(version.diff)}</p></CardContent>
              {!history.deletedAt && !version.current ? <CardFooter className="justify-end"><Button size="xs" variant="outline" disabled={locked} data-testid="cloud-restore-version" onClick={() => void prepare({ action: "prepareProjectOperation", repositoryId: history.repositoryId, projectId: history.projectId, snapshotId: history.snapshotId, operation: "restoreVersion", versionId: version.versionId })}>恢复为最新版本</Button></CardFooter> : null}
            </Card>)}
          </>}
        </div>
      </SheetContent>
    </Sheet>
    <AlertDialog open={Boolean(operation)} onOpenChange={open => { if (!open && !cloud.busy) setOperation(null) }}>
      <AlertDialogContent data-testid="cloud-project-operation-confirmation" onEscapeKeyDown={event => { if (cloud.busy) event.preventDefault() }}>
        <AlertDialogHeader><AlertDialogTitle>{operation?.operation === "delete" ? "删除云端项目？" : operation?.operation === "restore" ? "恢复已删除项目？" : "恢复为最新版本？"}</AlertDialogTitle>
          <AlertDialogDescription className="break-words [overflow-wrap:anywhere]">{operation?.repositoryName} · {operation?.name}<br />{operation?.operation === "delete" ? "仅从此云仓库删除，本地副本保留。可在“已删除”中于 30 天内恢复。" : operation?.operation === "restore" ? "恢复到此云仓库，保留原项目标识。本地配置不会自动覆盖。" : `将 ${operation ? new Date(operation.createdAt).toLocaleString() : ""} 的“${operation?.versionName}”发布为新的云端版本。其他项目和本地配置保持不变。`}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={cloud.busy}>取消</AlertDialogCancel><Button variant={operation?.operation === "delete" ? "destructive" : "default"} disabled={cloud.busy} data-testid="cloud-confirm-project-operation" onClick={() => void confirm()}>{cloud.busy ? "处理中…" : operation?.operation === "delete" ? "删除云端项目" : "确认恢复"}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  return { openHistory, prepare, overlays, open: Boolean(target || operation) }
}
