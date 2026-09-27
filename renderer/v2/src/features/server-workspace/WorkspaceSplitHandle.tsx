import type { WorkspaceLayout } from "./workspace-documents"

export function WorkspaceSplitHandle({ layout, ratio, onChange }: { layout: WorkspaceLayout; ratio: number; onChange: (ratio: number) => void }) {
  const clamp = (value: number) => Math.max(25, Math.min(75, value))
  return <div className="server-terminal-splitter" style={{ gridArea: layout === "vertical" ? "2 / 1" : "1 / 2" }} role="separator" aria-label="调整工作区分屏" aria-orientation={layout === "horizontal" ? "vertical" : "horizontal"} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0}
    onDoubleClick={() => onChange(50)}
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      const box = event.currentTarget.parentElement!.getBoundingClientRect()
      const fraction = layout === "horizontal" ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height
      onChange(clamp(fraction * 100))
    }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onKeyDown={event => {
      const keys = layout === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
      if (!keys.includes(event.key) && event.key !== "Home") return
      event.preventDefault()
      onChange(event.key === "Home" ? 50 : clamp(ratio + (event.key === keys[0] ? -5 : 5)))
    }} />
}
