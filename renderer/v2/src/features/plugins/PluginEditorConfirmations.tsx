import { Key, ShieldWarning, Warning } from "@phosphor-icons/react"

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
import type { PluginEditorConfirmation } from "@/features/plugins/plugin-editor-model"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"

interface PluginEditorConfirmationsProps {
  readonly confirmation: PluginEditorConfirmation | null
  readonly busy: boolean
  readonly error: string | null
  readonly onCloseAutoFocus: React.ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"]
  readonly onAcceptEditImpact: () => void
  readonly onRejectEditImpact: () => void
  readonly onAcceptHostKey: () => void
  readonly onAcceptTlsFallback: () => void
  readonly onRejectHostKey: () => void
  readonly onAcceptCredentialReplacement: () => void
  readonly onRejectCredentialReplacement: () => void
}

export function PluginEditorConfirmations({
  confirmation,
  busy,
  error,
  onCloseAutoFocus,
  onAcceptEditImpact,
  onRejectEditImpact,
  onAcceptHostKey,
  onAcceptTlsFallback,
  onRejectHostKey,
  onAcceptCredentialReplacement,
  onRejectCredentialReplacement,
}: PluginEditorConfirmationsProps) {
  const busyDialogRef = useBusyDialogFocus(busy)
  const open = confirmation !== null
  const destructive = confirmation?.kind === "credential-replacement"
    || confirmation?.kind === "disable-tls"
  const Icon = confirmation?.kind === "host-key"
    ? Key
    : destructive
      ? Warning
      : ShieldWarning
  const accept = confirmation?.kind === "edit-impact"
    ? onAcceptEditImpact
    : confirmation?.kind === "host-key"
      ? onAcceptHostKey
      : confirmation?.kind === "disable-tls"
        ? onAcceptTlsFallback
      : onAcceptCredentialReplacement
  const reject = confirmation?.kind === "edit-impact"
    ? onRejectEditImpact
    : confirmation?.kind === "host-key"
      ? onRejectHostKey
      : onRejectCredentialReplacement

  return (
    <AlertDialog onOpenChange={(nextOpen) => { if (!nextOpen && !busy) reject() }} open={open}>
      <AlertDialogContent
        ref={busyDialogRef}
        aria-busy={busy || undefined}
        className="max-h-[calc(100dvh-2rem)] grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-lg"
        data-testid="plugin-editor-confirmation"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
      >
        <ScrollArea className="min-h-0 min-w-0" viewportClassName="h-auto max-h-[calc(100dvh-7rem)]">
          <div className="min-w-0 space-y-4 p-5 [overflow-wrap:anywhere]">
            <AlertDialogHeader className="min-w-0">
              <AlertDialogMedia className={destructive ? "text-danger" : "text-warning"}>
                <Icon aria-hidden="true" />
              </AlertDialogMedia>
              <AlertDialogTitle>{confirmation?.title ?? "确认操作"}</AlertDialogTitle>
              <AlertDialogDescription className="min-w-0">{confirmation?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {error ? (
              <Alert variant="destructive" role="alert">
                <Warning aria-hidden="true" />
                <AlertTitle>操作尚未完成</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </ScrollArea>
        <AlertDialogFooter className="mx-0 mb-0">
          <AlertDialogCancel disabled={busy} onClick={(event) => { event.preventDefault(); reject() }}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => { event.preventDefault(); accept() }}
            variant={destructive ? "destructive" : "default"}
          >
            {confirmation?.kind === "host-key"
              ? "信任此指纹"
              : confirmation?.kind === "disable-tls"
                ? "关闭 TLS 并重试"
              : destructive
                ? "强制替换"
                : "继续编辑"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
