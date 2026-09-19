import type { ReactNode } from "react"
import { CaretDown, CaretUp } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { WorkspaceIconButton } from "./WorkspaceControls"
import "./workspace-layout-controls.css"

export function WorkspaceTabBar({ children, className = "" }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={`workspace-tab-bar ${className}`} data-workspace-tabbar>{children}</div>
}

export function WorkspaceLayoutControls({ maximized, onToggle, testId, controls, children }: {
  readonly maximized: boolean
  readonly onToggle: () => void
  readonly testId: string
  readonly controls: string
  readonly children?: ReactNode
}) {
  return <div className="workspace-layout-controls" role="group" aria-label="工作区布局">
    {children}
    <WorkspaceIconButton action={maximized ? "restore" : "maximize"} label={maximized ? "恢复分栏" : "最大化工作区"}
      data-testid={testId} data-workspace-layout-toggle aria-expanded={!maximized} aria-controls={controls} onClick={onToggle} />
  </div>
}

export function WorkspacePanelToggle({ collapsed, label, onToggle, disabled, testId, controls }: {
  readonly collapsed: boolean
  readonly label: string
  readonly onToggle: () => void
  readonly disabled?: boolean
  readonly testId: string
  readonly controls: string
}) {
  const actionLabel = `${collapsed ? "展开" : "收起"} ${label}`
  return <Button size="icon-sm" variant="ghost" type="button" aria-label={actionLabel} title={actionLabel}
    aria-expanded={!collapsed} aria-controls={controls} data-testid={testId} disabled={disabled} onClick={onToggle}>
    {collapsed ? <CaretDown aria-hidden="true" /> : <CaretUp aria-hidden="true" />}
  </Button>
}
