import { useEffect, useRef, useState } from "react"
import { Trash, Warning } from "@phosphor-icons/react"

import type { AiOpsV2Api, PluginRecord, PublicError } from "@/bridge/ai-ops-v2"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import {
  normalizePluginDeleteOutcome,
  type PluginDeleteOutcome,
} from "@/features/plugins/plugin-editor-model"

interface PluginDeleteDialogProps {
  readonly api: AiOpsV2Api
  readonly open: boolean
  readonly plugin: PluginRecord
  readonly dependents: readonly PluginRecord[]
  readonly onOpenChange: (open: boolean) => void
  readonly onDeleted: (outcome: PluginDeleteOutcome) => void
}

function publicError(error: unknown): PublicError {
  return error instanceof Error
    ? { code: "PLUGIN_DELETE_FAILED", message: error.message }
    : { code: "PLUGIN_DELETE_FAILED", message: "插件删除失败。" }
}

export function PluginDeleteDialog({
  api,
  open,
  plugin,
  dependents,
  onOpenChange,
  onDeleted,
}: PluginDeleteDialogProps) {
  const [busy, setBusy] = useState(false)
  const busyDialogRef = useBusyDialogFocus(busy)
  const [error, setError] = useState<PublicError | null>(null)
  const generationRef = useRef(0)
  const deleteInFlightRef = useRef(false)
  const ownerKey = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`
  const blocked = plugin.pluginType === "server" && dependents.length > 0

  useEffect(() => {
    generationRef.current += 1
    setBusy(false)
    setError(null)
  }, [open, ownerKey])

  const remove = async () => {
    if (deleteInFlightRef.current || blocked) return
    deleteInFlightRef.current = true
    const generation = ++generationRef.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.deletePlugin({
        projectId: plugin.projectId,
        environmentId: plugin.environmentId,
        pluginInstanceId: plugin.pluginInstanceId,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (generationRef.current !== generation) return
      onDeleted(normalizePluginDeleteOutcome(result.data, plugin.pluginInstanceId))
      onOpenChange(false)
    } catch (deleteError) {
      if (generationRef.current === generation) setError(publicError(deleteError))
    } finally {
      deleteInFlightRef.current = false
      if (generationRef.current === generation) setBusy(false)
    }
  }

  return (
    <AlertDialog onOpenChange={(nextOpen) => {
      if (!busy) onOpenChange(nextOpen)
    }} open={open}>
      <AlertDialogContent
        ref={busyDialogRef}
        aria-busy={busy || undefined}
        data-testid="plugin-delete-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => {
            const target = document.querySelector<HTMLElement>('[aria-label="当前范围更多操作"]')
              ?? document.getElementById("detail-main")
            focusWorkspaceElement(target)
          })
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogMedia className="text-danger">
            {blocked ? <Warning /> : <Trash />}
          </AlertDialogMedia>
          <AlertDialogTitle>{blocked ? "暂时不能删除" : `删除“${plugin.displayName}”？`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {blocked ? (
                <>
                  <p>{dependents.length} 个插件仍复用此 Server 隧道。请先修改它们的连接路径。</p>
                  <ScrollArea className="max-h-32 rounded-lg border border-border/70 bg-surface-inset" viewportClassName="h-auto max-h-32">
                    <ItemGroup className="gap-0">
                      {dependents.map((item) => (
                        <Item
                          className="rounded-none border-0 border-b border-border/60 last:border-b-0"
                          key={item.pluginInstanceId}
                          size="xs"
                        >
                          <ItemContent>
                            <ItemTitle className="line-clamp-none break-words">{item.displayName}</ItemTitle>
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemGroup>
                  </ScrollArea>
                </>
              ) : (
                <p>连接配置将被删除。本机凭据按现有应用策略保留，不会在此界面显示或复制。</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <Warning aria-hidden="true" />
            <AlertTitle>删除插件失败</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || blocked}
            onClick={(event) => {
              event.preventDefault()
              void remove()
            }}
            variant="destructive"
          >
            {busy ? "删除中" : "删除插件"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
