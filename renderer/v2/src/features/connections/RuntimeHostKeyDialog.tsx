import { Key, SpinnerGap, XCircle } from "@phosphor-icons/react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { ConnectionState } from "@/features/connections/connection-model"
import { HostKeyChallengeDescription } from "@/features/connections/HostKeyChallengeDescription"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

// A reservation precedes React's portal commit, so simultaneous runtime
// responses cannot both observe an empty DOM and open two security dialogs.
class RuntimeHostKeyModalCoordinator {
  private readonly waiting = new Map<symbol, () => void>()
  private reserved: symbol | null = null
  private observer: MutationObserver | null = null

  private drain = () => {
    if (this.reserved !== null || this.waiting.size === 0) return
    const visibleModal = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
      .some((element) => element.getClientRects().length > 0)
    // Closed portals remain occupied through their exit animation/focus cleanup.
    if (visibleModal) return
    const next = this.waiting.entries().next().value
    if (!next) return
    this.reserved = next[0]
    next[1]()
  }

  acquire(onGranted: () => void): () => void {
    const token = Symbol("runtime-host-key-modal")
    this.waiting.set(token, onGranted)
    if (!this.observer) {
      this.observer = new MutationObserver(this.drain)
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["role", "data-state", "class", "style", "hidden"],
      })
    }
    this.drain()
    return () => {
      this.waiting.delete(token)
      if (this.reserved === token) this.reserved = null
      if (this.waiting.size === 0) {
        this.observer?.disconnect()
        this.observer = null
      } else {
        this.drain()
      }
    }
  }
}

const runtimeHostKeyModals = new RuntimeHostKeyModalCoordinator()

export interface RuntimeHostKeyDialogProps {
  readonly state: ConnectionState
  readonly onReject: () => void
  readonly onTrust: () => Promise<void>
  readonly returnFocusRef: RefObject<HTMLElement | null>
  readonly testId: string
  readonly showPlugin?: boolean
}

export function RuntimeHostKeyDialog({
  state,
  onReject,
  onTrust,
  returnFocusRef,
  testId,
  showPlugin = false,
}: RuntimeHostKeyDialogProps) {
  const challengeKey = state.challenge ? `${state.ownerKey}\u0000${state.challenge.challengeId}` : null
  const presentationRequest = useMemo(() => challengeKey === null ? null : { challengeKey }, [challengeKey])
  const [grantedRequest, setGrantedRequest] = useState<typeof presentationRequest>(null)
  const trustPendingRef = useRef<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [unexpectedErrorKey, setUnexpectedErrorKey] = useState<string | null>(null)
  const busy = state.operation !== null || (challengeKey !== null && pendingKey === challengeKey)
  const errorMessage = state.error?.message
    ?? (challengeKey !== null && unexpectedErrorKey === challengeKey
      ? "服务器指纹尚未确认，请检查连接状态后重试。"
      : null)

  useEffect(() => {
    if (!presentationRequest) return
    return runtimeHostKeyModals.acquire(() => setGrantedRequest(presentationRequest))
  }, [presentationRequest])

  const open = presentationRequest !== null && grantedRequest === presentationRequest

  useLayoutEffect(() => {
    if (open && busy) focusWorkspaceElement(dialogRef.current)
  }, [busy, open])

  const isPending = () => state.operation !== null
    || (challengeKey !== null && trustPendingRef.current === challengeKey)

  async function trust() {
    if (!challengeKey || isPending()) return
    // Disabled focused buttons lose Chromium focus. Hold the dialog's own
    // focus scope before starting the asynchronous trust operation.
    focusWorkspaceElement(dialogRef.current)
    trustPendingRef.current = challengeKey
    setPendingKey(challengeKey)
    setUnexpectedErrorKey(null)
    try {
      await onTrust()
    } catch {
      if (trustPendingRef.current === challengeKey) setUnexpectedErrorKey(challengeKey)
    } finally {
      if (trustPendingRef.current === challengeKey) {
        trustPendingRef.current = null
        setPendingKey(null)
      }
    }
  }

  return (
    <AlertDialog
      onOpenChange={(open) => { if (!open && !isPending()) onReject() }}
      open={open}
    >
      <AlertDialogContent
        ref={dialogRef}
        aria-busy={busy || undefined}
        className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 data-open:zoom-in-100 data-closed:zoom-out-100 data-[size=default]:sm:max-w-lg"
        data-testid={testId}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const trigger = returnFocusRef.current
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!focusWorkspaceElement(trigger)) focusWorkspaceElement(document.getElementById("detail-main"))
          }))
        }}
        onEscapeKeyDown={(event) => { if (isPending()) event.preventDefault() }}
      >
        <ScrollArea
          className="min-h-0"
          data-testid={`${testId}-scroll`}
          viewportClassName="h-auto max-h-[calc(100dvh-7rem)]"
        >
          <div className="space-y-4 p-5">
            <AlertDialogHeader>
              <AlertDialogMedia className="text-warning"><Key aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>确认服务器指纹</AlertDialogTitle>
              <HostKeyChallengeDescription challenge={state.challenge} showPlugin={showPlugin} />
            </AlertDialogHeader>
            {errorMessage ? (
              <Alert data-testid={`${testId}-error`} variant="destructive">
                <XCircle aria-hidden="true" />
                <AlertTitle>服务器指纹尚未确认</AlertTitle>
                <AlertDescription className="break-words">{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </ScrollArea>
        <AlertDialogFooter className="mx-0 mb-0">
          <AlertDialogCancel disabled={busy}>不信任</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={(event) => {
            event.preventDefault()
            void trust()
          }}>
            {busy ? <SpinnerGap aria-hidden="true" className="animate-spin" /> : null}
            {busy ? "确认中" : "信任并继续"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
