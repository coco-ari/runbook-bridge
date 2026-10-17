import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Trash, Warning } from "@phosphor-icons/react"
import type { AiOpsV2Api, MysqlPluginGroupData, PluginRecord, PublicError } from "@/bridge/ai-ops-v2"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

export function MysqlConnectionDeleteDialog({ api, plugin, onClose, onDeleted, restoreFocusRef }: {
  readonly api: AiOpsV2Api
  readonly plugin: PluginRecord
  readonly onClose: () => void
  readonly onDeleted: (outcome: { readonly pluginInstanceIds: readonly string[]; readonly runtimeWarning: boolean; readonly persistenceWarning: boolean }) => void
  readonly restoreFocusRef: RefObject<HTMLElement | null>
}) {
  const [group, setGroup] = useState<MysqlPluginGroupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PublicError | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const dialogRef = useBusyDialogFocus(busy)
  const { projectId, environmentId, pluginInstanceId } = plugin
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setGroup(null)
    setError(null)
    try {
      const result = await api.describeMysqlPluginGroup({projectId, environmentId, pluginInstanceId})
      if (current !== generation.current) return
      if (result.ok) setGroup(result.data)
      else setError(result.error)
    } catch {
      if (current === generation.current) setError({code:"MYSQL_GROUP_READ_FAILED",message:"无法读取数据库组，请重试。"})
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [api, projectId, environmentId, pluginInstanceId])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])

  const remove = async () => {
    if (!group || loading || inFlight.current) return
    const current = generation.current
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await api.deleteMysqlConnection({projectId, environmentId, pluginInstanceId,
        expectedConnectionId:group.id, expectedRevision:group.revision,
        expectedMembers:group.members.map(({pluginInstanceId,revision}) => ({pluginInstanceId,revision})),
      })
      if (current !== generation.current) return
      if (!result.ok) {
        setError(result.error)
        if (result.error.code === "CONFIG_REVISION_CONFLICT") setGroup(null)
        return
      }
      onDeleted({pluginInstanceIds:group.members.map(item => item.pluginInstanceId),
        runtimeWarning:Boolean(result.data.runtimeWarning), persistenceWarning:Boolean(result.data.persistenceWarning)})
      onClose()
    } catch {
      if (current === generation.current) setError({code:"MYSQL_GROUP_DELETE_FAILED",message:"数据库组删除失败，请重新读取状态后重试。"})
    } finally {
      inFlight.current = false
      if (current === generation.current) setBusy(false)
    }
  }

  return <AlertDialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <AlertDialogContent ref={dialogRef} data-testid="mysql-connection-delete-dialog" aria-busy={busy || loading || undefined}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
      onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => {
        if (!focusWorkspaceElement(restoreFocusRef.current)) focusWorkspaceElement(document.getElementById("detail-main"))
      }) }}>
      <AlertDialogHeader>
        <AlertDialogMedia className="text-danger"><Trash /></AlertDialogMedia>
        <AlertDialogTitle>删除“{group?.name ?? plugin.mysqlConnectionName ?? plugin.displayName}”整组连接？</AlertDialogTitle>
        <AlertDialogDescription asChild><div className="space-y-2">
          {loading ? <p>正在读取数据库组…</p> : group ? <>
            <p>将删除共享连接及以下 {group.members.length} 个数据库插件，并断开它们的连接。</p>
            <ScrollArea className="max-h-40 rounded-md border border-border bg-surface-inset" viewportClassName="h-auto max-h-40">
              <ul className="space-y-2 p-3" data-testid="mysql-delete-members">{group.members.map(item => <li key={item.pluginInstanceId} className="break-words">
                <span className="block text-foreground">{item.displayName}</span>
                <span className="font-mono text-xs">{item.database}</span>
              </li>)}</ul>
            </ScrollArea>
            <p>仅删除客户端配置，MySQL 中的数据库和表数据不会删除。本机凭据按现有应用策略保留。</p>
          </> : null}
        </div></AlertDialogDescription>
      </AlertDialogHeader>
      {error ? <Alert variant="destructive"><Warning aria-hidden="true" /><AlertTitle>操作未完成</AlertTitle><AlertDescription>
        <p>{error.message}</p><Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => void load()}>重新读取</Button>
      </AlertDescription></Alert> : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy || loading || !group} onClick={event => { event.preventDefault(); void remove() }}>
          {busy ? "删除中" : "删除整组"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
