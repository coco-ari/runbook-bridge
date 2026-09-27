import { useEffect, useRef, type ReactNode } from "react"
import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { WorkspaceTabBar } from "@/components/workspace/WorkspaceLayoutControls"

interface WorkspaceTabsProps {
  readonly id: string
  readonly label: string
  readonly items: readonly { id: string; label: string; title: string; icon?: ReactNode }[]
  readonly active: string | null
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onAdd?: () => void
  readonly addDisabled?: boolean
  readonly actions?: ReactNode
  readonly onRename?: (id: string) => void
  readonly onReorder?: (source: string, target: string) => void
}

export function WorkspaceTabs({ id, label, items, active, onSelect, onClose, onAdd, addDisabled, actions, onRename, onReorder }: WorkspaceTabsProps) {
  const dragging = useRef<string | null>(null)
  useEffect(() => { if (active) document.getElementById(id + "-tab-" + active)?.scrollIntoView({ block: "nearest", inline: "nearest" }) }, [id, active])
  return <WorkspaceTabBar className="server-tabs-toolbar">
    <div className="server-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => <div className="server-tab-item" key={item.id} data-active={active === item.id}
        draggable={Boolean(onReorder) && !item.id.startsWith("docker:")} onDragStart={event => { if (!onReorder || item.id.startsWith("docker:")) return; dragging.current = item.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-workspace-tab", item.id) }} onDragEnd={() => { dragging.current = null }} onDragOver={event => { if (dragging.current && !item.id.startsWith("docker:")) { event.preventDefault(); event.dataTransfer.dropEffect = "move" } }} onDrop={event => { if (!dragging.current || item.id.startsWith("docker:")) return; event.preventDefault(); onReorder?.(dragging.current, item.id); dragging.current = null }}>
        <button type="button" role="tab" id={id + "-tab-" + item.id} aria-controls={id + "-panel-" + item.id} aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1} title={item.title} aria-description={onRename && !item.id.startsWith("docker:") ? "双击或 F2 重命名，拖拽或 Alt+方向键排序" : undefined} onClick={() => onSelect(item.id)} onDoubleClick={() => { if (!item.id.startsWith("docker:")) onRename?.(item.id) }} onKeyDown={(event) => {
          if (event.key === "F2" && onRename && !item.id.startsWith("docker:")) { event.preventDefault(); onRename(item.id); return }
          if (event.altKey && onReorder && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const target = items[index + (event.key === "ArrowLeft" ? -1 : 1)]; if (target && !target.id.startsWith("docker:") && !item.id.startsWith("docker:")) onReorder(item.id, target.id); return }
          if (!["ArrowLeft", "ArrowRight", "Home", "End", "Delete"].includes(event.key)) return
          event.preventDefault()
          if (event.key === "Delete") { onClose(item.id); return }
          const next = items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]
          if (next) { onSelect(next.id); requestAnimationFrame(() => document.getElementById(id + "-tab-" + next.id)?.focus()) }
        }}>{item.icon}<span>{item.label}</span></button>
        <WorkspaceIconButton action="close" className="server-tab-close" label={"关闭" + item.title} title="关闭标签" onClick={() => onClose(item.id)} />
      </div>)}
    </div>
    {onAdd ? <WorkspaceIconButton action="add" className="server-tab-add" label="新增终端" title={addDisabled ? "需连接服务器；每个窗口最多 8 个终端会话" : "新增独立终端"} disabled={addDisabled} onClick={onAdd} /> : null}
    {actions}
  </WorkspaceTabBar>
}
