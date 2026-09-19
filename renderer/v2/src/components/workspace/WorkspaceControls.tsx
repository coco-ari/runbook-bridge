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
  return <Button size="icon-sm" variant="ghost" type="button" {...props} disabled={disabled || busy} aria-label={label} title={title ?? label}><Icon aria-hidden="true" className={busy && action === "refresh" ? "motion-safe:animate-spin" : undefined} /></Button>
}

export function WorkspaceBackButton({ onClick, testId, label }: { readonly onClick: () => void; readonly testId: string; readonly label: string }) {
  return <Button size="sm" variant="ghost" type="button" data-testid={testId} aria-label={label} title="返回详情并保留工作区" onClick={onClick}><ArrowLeft aria-hidden="true" />返回详情</Button>
}

export function WorkspaceHeaderActions({ connected, busy, onDisconnect, onClose, prefix, closeLabel, closeTitle }: {
  readonly connected: boolean; readonly busy: boolean
  readonly onDisconnect: () => void; readonly onClose: () => void
  readonly prefix: string; readonly closeLabel: string; readonly closeTitle: string
}) {
  return <>
    <SettingsButton />
    <Button data-testid={prefix + "-disconnect"} size="sm" variant="outline" type="button" title="断开连接" disabled={!connected || busy} onClick={onDisconnect}><LinkBreak aria-hidden="true" />{busy ? "断开中…" : "断开连接"}</Button>
    <WorkspaceIconButton action="close" data-testid={prefix + "-close"} label={closeLabel} title={closeTitle} onClick={onClose} />
  </>
}
