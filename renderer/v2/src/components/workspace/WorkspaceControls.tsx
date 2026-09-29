import { WorkspaceSwitcherButton, WorkspaceConfigureButton } from "@/features/plugins/WorkspaceNavigation"
import type { ComponentProps } from "react"
import { ArrowClockwise, ArrowLeft, ArrowsIn, ArrowsOut, LinkBreak, Plus, X } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { SettingsButton } from "@/features/settings/SettingsButton"

type IconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & {
  readonly action: "refresh" | "close" | "add" | "maximize" | "restore"
  readonly label: string
  readonly busy?: boolean
}
const icons = { refresh: ArrowClockwise, close: X, add: Plus, maximize: ArrowsOut, restore: ArrowsIn }

export function WorkspaceIconButton({ action, label, busy = false, title, disabled, ...props }: IconButtonProps) {
  const Icon = icons[action]
  return <Button size="icon-xs" variant="ghost" type="button" {...props} disabled={disabled || busy} aria-label={label} title={title ?? label}><Icon aria-hidden="true" className={busy && action === "refresh" ? "motion-safe:animate-spin" : undefined} /></Button>
}

export function WorkspaceBackButton({ onClick, testId, label }: { readonly onClick: () => void; readonly testId: string; readonly label: string }) {
  return <Button size="sm" variant="ghost" type="button" data-testid={testId} aria-label={label} title="返回详情并保留工作区" onClick={onClick}><ArrowLeft aria-hidden="true" />返回详情</Button>
}

export function WorkspaceHeaderActions({ connected, busy, reconnecting, awaitingConfirmation, canCancel = false, cancelling = false, onCancel, disabled = false, onDisconnect, onReconnect, onClose, prefix, closeLabel, closeTitle }: {
  readonly canCancel?: boolean; readonly cancelling?: boolean; readonly onCancel?: () => void
  readonly connected: boolean; readonly busy: boolean; readonly reconnecting: boolean; readonly awaitingConfirmation: boolean; readonly disabled?: boolean
  readonly onDisconnect: () => void; readonly onReconnect: () => void; readonly onClose: () => void
  readonly prefix: string; readonly closeLabel: string; readonly closeTitle: string
}) {
  const cancelAvailable = canCancel && !cancelling && !busy && Boolean(onCancel)
  const label = cancelling ? "取消中…" : cancelAvailable ? "取消连接" : busy ? "断开中…" : awaitingConfirmation ? "等待确认" : reconnecting ? "连接中…" : connected ? "断开连接" : prefix === "server-workspace" ? "重新连接服务器" : "重新连接"
  const Icon = connected || busy ? LinkBreak : ArrowClockwise
  return <>
    <WorkspaceSwitcherButton />
    <WorkspaceConfigureButton />
    <SettingsButton />
    <Button data-testid={prefix + (connected || busy ? "-disconnect" : "-reconnect")} size="sm" variant="outline" type="button" aria-label={label} aria-description={label} disabled={cancelling || busy || (!cancelAvailable && (reconnecting || awaitingConfirmation || (connected && disabled)))} onClick={cancelAvailable ? onCancel : connected ? onDisconnect : onReconnect}><Icon aria-hidden="true" />{label}</Button>
    <WorkspaceIconButton action="close" data-testid={prefix + "-close"} label={closeLabel} title={closeTitle} onClick={onClose} />
  </>
}
