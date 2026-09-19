import { useEffect, type ReactNode } from "react"
import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"

interface WorkspaceTabsProps {
  readonly id: string
  readonly label: string
  readonly items: readonly { id: string; label: string; title: string; icon?: ReactNode }[]
  readonly active: string | null
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onAdd?: () => void
  readonly addDisabled?: boolean
}

export function WorkspaceTabs({ id, label, items, active, onSelect, onClose, onAdd, addDisabled }: WorkspaceTabsProps) {
  useEffect(() => { if (active) document.getElementById(id + "-tab-" + active)?.scrollIntoView({ block: "nearest", inline: "nearest" }) }, [id, active])
  return <div className="server-tabs-toolbar">
    <div className="server-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => <div className="server-tab-item" key={item.id} data-active={active === item.id}>
        <button type="button" role="tab" id={id + "-tab-" + item.id} aria-controls={id + "-panel-" + item.id} aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1} title={item.title} onClick={() => onSelect(item.id)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Delete"].includes(event.key)) return
          event.preventDefault()
          if (event.key === "Delete") { onClose(item.id); return }
          const next = items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]
          if (next) { onSelect(next.id); requestAnimationFrame(() => document.getElementById(id + "-tab-" + next.id)?.focus()) }
        }}>{item.icon}<span>{item.label}</span></button>
        <WorkspaceIconButton action="close" className="server-tab-close" label={"关闭" + item.title} title="关闭标签" onClick={() => onClose(item.id)} />
      </div>)}
    </div>
    {onAdd ? <WorkspaceIconButton action="add" className="server-tab-add" label="新增终端" title={addDisabled ? "每个工作区最多保留 8 个终端标签" : "新增独立终端"} disabled={addDisabled} onClick={onAdd} /> : null}
  </div>
}
