import type { WorkspaceLayout } from "./workspace-documents"
import { ArrowsLeftRight, ArrowsDownUp, Columns, Rows, Square } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const layouts = [
  { value: "single", label: "单栏", icon: Square },
  { value: "horizontal", label: "左右分屏", icon: Columns },
  { value: "vertical", label: "上下分屏", icon: Rows },
] as const

export function WorkspaceSplitMenu({ value, onChange, onSwap, disabled, splitDisabled }: {
  value: WorkspaceLayout
  onChange: (value: WorkspaceLayout) => void
  onSwap: () => void
  disabled: boolean
  splitDisabled: boolean
}) {
  const current = layouts.find(layout => layout.value === value) ?? layouts[0]
  const Icon = current.icon
  return <DropdownMenu>
    <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild>
      <Button type="button" size="icon-xs" variant="ghost" className="server-terminal-layout" aria-label="分屏布局" aria-description={`当前：${current.label}`} disabled={disabled}>
        <Icon aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger></TooltipTrigger><TooltipContent>工作区布局：{current.label}</TooltipContent></Tooltip>
    <DropdownMenuContent align="end" className="w-40">
      <DropdownMenuLabel>工作区布局</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={value => onChange(value as WorkspaceLayout)}>
        {layouts.map(layout => <DropdownMenuRadioItem key={layout.value} value={layout.value} disabled={layout.value !== "single" && splitDisabled}>
          <layout.icon aria-hidden="true" />{layout.label}
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {value !== "single" ? <><DropdownMenuSeparator /><DropdownMenuItem onSelect={onSwap}>
        {value === "horizontal" ? <ArrowsLeftRight aria-hidden="true" /> : <ArrowsDownUp aria-hidden="true" />}
        {value === "horizontal" ? "交换左右" : "交换上下"}
      </DropdownMenuItem></> : null}
    </DropdownMenuContent>
  </DropdownMenu>
}
