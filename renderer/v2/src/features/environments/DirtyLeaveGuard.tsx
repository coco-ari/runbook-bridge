import { useCallback, useEffect, useRef, useState } from "react"
import { Trash, Warning } from "@phosphor-icons/react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"

export interface DirtyScopeState {
  readonly agentAccessDirty: boolean
  readonly metadataDirty: boolean
  readonly pluginConfigurationDirty: boolean
  readonly runbookDirty: boolean
  readonly quickQuestionsDirty?: boolean
  readonly saveInFlight: boolean
}

export interface DirtyLeaveGuardOptions {
  readonly dirty: DirtyScopeState
  readonly onBlocked?: ((message: string) => void) | undefined
  readonly onLeaveApproved: () => void | Promise<void>
  readonly ownerKey: string
}

export interface DirtyLeaveGuardController {
  readonly busy: boolean
  readonly cancel: () => void
  readonly confirm: () => Promise<void>
  readonly open: boolean
  readonly requestLeave: () => Promise<boolean>
  readonly subject: string
}

interface PendingLeave {
  readonly resolve: (allowed: boolean) => void
}

export function dirtyLeaveSubject(dirty: DirtyScopeState): string {
  const runbook = dirty.runbookDirty
  const plugin =
    dirty.pluginConfigurationDirty || dirty.metadataDirty || dirty.agentAccessDirty
  return [
    runbook ? "运维说明" : null,
    plugin ? "插件配置" : null,
    dirty.quickQuestionsDirty ? "快捷提问" : null,
  ].filter(Boolean).join("和") || "当前内容"
}

export function useDirtyLeaveGuard({
  dirty,
  onBlocked,
  onLeaveApproved,
  ownerKey,
}: DirtyLeaveGuardOptions): DirtyLeaveGuardController {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [open, setOpen] = useState(false)
  const approvedRef = useRef(onLeaveApproved)
  const blockedRef = useRef(onBlocked)
  const dirtyRef = useRef(dirty)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)
  const pendingRef = useRef<PendingLeave | null>(null)

  useEffect(() => {
    approvedRef.current = onLeaveApproved
  }, [onLeaveApproved])

  useEffect(() => {
    blockedRef.current = onBlocked
  }, [onBlocked])

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      epochRef.current += 1
      pendingRef.current?.resolve(false)
      pendingRef.current = null
    }
  }, [])

  useEffect(() => {
    epochRef.current += 1
    pendingRef.current?.resolve(false)
    pendingRef.current = null
    busyRef.current = false
    setBusy(false)
    setOpen(false)
  }, [ownerKey])

  const safelyApprove = useCallback(async () => {
    try {
      await approvedRef.current()
      return true
    } catch {
      blockedRef.current?.("无法安全结束当前编辑会话。")
      return false
    }
  }, [])

  const requestLeave = useCallback(async () => {
    if (pendingRef.current || busyRef.current) return false
    if (dirtyRef.current.saveInFlight) {
      blockedRef.current?.("正在保存，请稍候。")
      return false
    }
    const hasDirtyState =
      dirtyRef.current.runbookDirty ||
      dirtyRef.current.pluginConfigurationDirty ||
      dirtyRef.current.metadataDirty ||
      dirtyRef.current.agentAccessDirty ||
      dirtyRef.current.quickQuestionsDirty
    if (!hasDirtyState) return safelyApprove()
    return new Promise<boolean>((resolve) => {
      pendingRef.current = { resolve }
      setOpen(true)
    })
  }, [safelyApprove])

  const cancel = useCallback(() => {
    if (busyRef.current) return
    setOpen(false)
    pendingRef.current?.resolve(false)
    pendingRef.current = null
  }, [])

  const confirm = useCallback(async () => {
    if (busyRef.current || !pendingRef.current) return
    const pending = pendingRef.current
    const epoch = ++epochRef.current
    busyRef.current = true
    setBusy(true)
    const allowed = await safelyApprove()
    if (!mountedRef.current || epochRef.current !== epoch) {
      pending.resolve(false)
      if (pendingRef.current === pending) pendingRef.current = null
      return
    }
    busyRef.current = false
    setBusy(false)
    setOpen(false)
    pending.resolve(allowed)
    if (pendingRef.current === pending) pendingRef.current = null
  }, [safelyApprove])

  return {
    busy,
    cancel,
    confirm,
    open,
    requestLeave,
    subject: dirtyLeaveSubject(dirty),
  }
}

export function DirtyLeaveAlertDialog({
  controller,
  onCloseAutoFocus,
}: {
  readonly controller: DirtyLeaveGuardController
  readonly onCloseAutoFocus?: React.ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"]
}) {
  const busyDialogRef = useBusyDialogFocus(controller.busy)
  return (
    <AlertDialog onOpenChange={(open) => { if (!open) controller.cancel() }} open={controller.open}>
      <AlertDialogContent
        ref={busyDialogRef}
        aria-busy={controller.busy || undefined}
        data-testid="dirty-leave-dialog"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (controller.busy) event.preventDefault() }}
      >
        <AlertDialogHeader>
          <AlertDialogMedia className="text-warning">
            <Warning aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
          <AlertDialogDescription>
            {controller.subject}尚未保存。继续后会放弃本地草稿，并安全结束当前编辑会话。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={controller.busy} onClick={controller.cancel}>
            返回编辑
          </AlertDialogCancel>
          <Button
            disabled={controller.busy}
            onClick={() => void controller.confirm()}
            type="button"
            variant="destructive"
          >
            <Trash aria-hidden="true" size={15} />
            {controller.busy ? "正在结束编辑" : "放弃更改"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
