import { Empty, EmptyHeader, EmptyTitle, EmptyMedia, EmptyContent } from "@/components/ui/empty"
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { TerminalWindow } from "@phosphor-icons/react"
import type { DockerContainer } from "@/bridge/ai-ops-v2"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ServerTerminal, type ServerTerminalProps } from "./ServerTerminal"
import { WorkspaceTabs } from "./WorkspaceTabs"
import { Button } from "@/components/ui/button"
import { DockerIcon } from "./ServerResourceRail"
import { ServerDockerContainer } from "./ServerDockerContainer"
import { WorkspaceLayoutControls } from "@/components/workspace/WorkspaceLayoutControls"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface ContentProps {
  readonly maximized: boolean
  readonly onMaximize: () => void
  readonly layoutControls: string
  readonly onActiveSessionChange:(sessionId:string | null) => void
  readonly onActiveTerminalLabel:(label:string) => void
  readonly dockerTabs:readonly DockerContainer[]
  readonly activeDocker:string | null
  readonly onDockerSelect:(id:string | null) => void
  readonly onDockerClose:(id:string) => void
  readonly binding:string
  readonly preview:ReactNode
  readonly previewOpen:boolean
  readonly previewPanelRef:RefObject<PanelImperativeHandle | null>
}
export function ServerTerminalTabs({ onActiveSessionChange, onActiveTerminalLabel, dockerTabs, activeDocker, onDockerSelect, onDockerClose, binding, preview, previewOpen, previewPanelRef, maximized, onMaximize, layoutControls, ...props }: Omit<ServerTerminalProps, "tabId" | "onSessionChange"> & ContentProps) {
  const groupId = useId()
  const sequence = useRef(1)
  const [tabs, setTabs] = useState([{ id: "default", label: "终端 1", title: "终端 1" }])
  const [active, setActive] = useState("default")
  const [layout, setLayout] = useState("single")
  const [panes, setPanes] = useState<readonly string[]>(["default"])
  const [ratio, setRatio] = useState(50)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const select = (id: string) => {
    if (id.startsWith("docker:")) { onDockerSelect(id.slice(7)); return }
    setPanes(current => layout === "single" ? [id] : current.includes(id) ? current : current.map(value => value === active ? id : value))
    setActive(id); onDockerSelect(null)
  }
  const [sessions, setSessions] = useState<Record<string, string | null>>({})
  const onSessionChange = useCallback((tabId: string, sessionId: string | null) => {
    setSessions(current => {
      if (sessionId) return current[tabId] === sessionId ? current : { ...current, [tabId]: sessionId }
      if (!(tabId in current)) return current
      const next = { ...current }
      delete next[tabId]
      return next
    })
  }, [])
  useEffect(() => { onActiveSessionChange(sessions[active] ?? null); onActiveTerminalLabel(tabs.find(tab => tab.id === active)?.label ?? "") }, [active, sessions, tabs, onActiveSessionChange, onActiveTerminalLabel])
  useEffect(() => () => onActiveSessionChange(null), [onActiveSessionChange])
  const add = () => {
    if (!props.connected || tabs.length >= 8) return
    const id = crypto.randomUUID()
    const label = "终端 " + ++sequence.current
    setTabs(current => [...current, { id, label, title: label }])
    setPanes(current => layout === "single" ? [id] : current.map(value => value === active ? id : value))
    setActive(id)
    onDockerSelect(null)
  }
  const close = (id:string) => {
    if (id.startsWith("docker:")) { onDockerClose(id.slice(7)); return }
    const index = tabs.findIndex(tab => tab.id === id)
    const remaining = tabs.filter(tab => tab.id !== id)
    setTabs(remaining)
    const next = (remaining[index] ?? remaining[index - 1])?.id ?? ""
    const visible = panes.filter(value => value !== id)
    if (panes.includes(id)) {
      const replacement = remaining.find(tab => !visible.includes(tab.id))?.id
      if (replacement) visible.splice(panes.indexOf(id), 0, replacement)
      setPanes(visible)
      if (visible.length < 2) setLayout("single")
    }
    if (active === id) setActive(visible[0] ?? next)
  }
  const changeLayout = (value: string) => {
    const first = active || tabs[0]?.id
    if (!first) return
    if (value === "single") { setLayout(value); setPanes([first]); return }
    let other = panes.find(id => id !== first && tabs.some(tab => tab.id === id)) ?? tabs.find(tab => tab.id !== first)?.id
    if (!other) {
      if (!props.connected) return
      other = crypto.randomUUID(); const label = "终端 " + ++sequence.current
      setTabs(current => [...current, { id: other!, label, title: label }])
    }
    setLayout(value); setPanes([first, other]); setRatio(50); onDockerSelect(null)
  }
  const items = [
    ...tabs.map(tab => ({ ...tab, icon:<TerminalWindow size={14} aria-hidden="true" /> })),
    ...dockerTabs.map(item => ({ id:"docker:" + item.id, label:item.name, title:"容器 " + item.name, icon:<DockerIcon size={14} /> })),
  ]
  const selected = activeDocker ? "docker:" + activeDocker : active
  return <section className="server-terminal-tabs" aria-label="服务器终端标签">
    <WorkspaceTabs id={groupId} label="终端标签" items={items} active={selected} onSelect={select} onClose={close} onAdd={add} addDisabled={!props.connected || tabs.length >= 8}
      onRename={id => { setRenaming(id); setName(tabs.find(tab => tab.id === id)?.label ?? "") }} onReorder={(source, target) => setTabs(current => { const next = [...current]; const from = next.findIndex(tab => tab.id === source), to = next.findIndex(tab => tab.id === target); if (from < 0 || to < 0) return current; next.splice(to, 0, next.splice(from, 1)[0]!); return next })}
      actions={<><SelectControl aria-label="终端布局" value={layout} disabled={!tabs.length || activeDocker !== null} onValueChange={changeLayout} className="server-terminal-layout"><SelectItem value="single">单终端</SelectItem><SelectItem value="horizontal">左右分屏</SelectItem><SelectItem value="vertical">上下分屏</SelectItem></SelectControl><WorkspaceLayoutControls maximized={maximized} onToggle={onMaximize} testId="server-layout-toggle" controls={`${layoutControls} ${groupId}-preview`} /></>} />
    <div className="server-content-terminal" hidden={activeDocker !== null}>
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel id={groupId + "-preview"} defaultSize={0} minSize="220px" maxSize="65%" collapsible collapsedSize={0} panelRef={previewPanelRef}>{preview}</ResizablePanel>
        <ResizableHandle className={!previewOpen || maximized ? "hidden" : ""} aria-label="调整文件预览高度" />
        <ResizablePanel id={groupId + "-terminal"} minSize="180px">
          <div className="server-terminal-panes" data-layout={layout} style={layout === "single" ? {} : layout === "horizontal" ? { gridTemplateColumns: `${ratio}fr 5px ${100 - ratio}fr` } : { gridTemplateRows: `${ratio}fr 5px ${100 - ratio}fr` }}>
          {tabs.map(tab => <div key={tab.id} className="server-terminal-tab-panel" data-terminal-id={tab.id} data-input-active={active === tab.id} role="tabpanel" id={groupId + "-panel-" + tab.id} aria-labelledby={groupId + "-tab-" + tab.id} hidden={!panes.includes(tab.id)} style={{ gridArea: layout === "vertical" ? `${panes.indexOf(tab.id) * 2 + 1} / 1` : `1 / ${panes.indexOf(tab.id) * 2 + 1}` }} onFocusCapture={() => setActive(tab.id)} onPointerDownCapture={() => setActive(tab.id)}>
            {layout !== "single" ? <div className="server-terminal-pane-heading"><strong>{tab.label}</strong><span>{active === tab.id ? "当前输入" : "点击切换输入"}</span></div> : null}
            <ServerTerminal {...props} onSessionChange={onSessionChange} tabId={tab.id} focused={active === tab.id} visible={props.visible && activeDocker === null && panes.includes(tab.id)} />
          </div>)}
          {layout !== "single" ? <div className="server-terminal-splitter" style={{ gridArea: layout === "vertical" ? "2 / 1" : "1 / 2" }} role="separator" aria-label="调整终端分屏" aria-orientation={layout === "horizontal" ? "vertical" : "horizontal"} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0} onDoubleClick={() => setRatio(50)} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement!.getBoundingClientRect(); const fraction = layout === "horizontal" ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height; setRatio(Math.max(25, Math.min(75, fraction * 100))) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) { event.preventDefault(); setRatio(value => event.key === "Home" ? 50 : Math.max(25, Math.min(75, value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -5 : 5)))) } }} /> : null}
          {!tabs.length ? <Empty className="server-tabs-empty"><EmptyHeader><EmptyMedia variant="icon"><TerminalWindow /></EmptyMedia><EmptyTitle>所有终端已关闭</EmptyTitle></EmptyHeader><EmptyContent><Button variant="outline" disabled={!props.connected} onClick={add}>新增终端</Button></EmptyContent></Empty> : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    {dockerTabs.map(container => <div className="server-docker-tab-panel" role="tabpanel" id={groupId + "-panel-docker:" + container.id} aria-labelledby={groupId + "-tab-docker:" + container.id} key={container.id} hidden={activeDocker !== container.id}>
      <ServerDockerContainer api={props.api} scope={props.scope} container={container} connected={props.connected} visible={props.visible && activeDocker === container.id} binding={binding} />
    </div>)}
    <Dialog open={renaming !== null} onOpenChange={open => { if (!open) setRenaming(null) }}><DialogContent><DialogHeader><DialogTitle>重命名终端</DialogTitle><DialogDescription>名称仅用于当前工作区，便于区分日志、检查和部署终端。</DialogDescription></DialogHeader><form id={groupId + "-rename"} onSubmit={event => { event.preventDefault(); const label = name.trim(); if (!label) return; setTabs(current => current.map(tab => tab.id === renaming ? { ...tab, label, title: label } : tab)); setRenaming(null) }}><Input aria-label="终端名称" maxLength={40} value={name} onChange={event => setName(event.target.value)} autoFocus /></form><DialogFooter><Button variant="outline" onClick={() => setRenaming(null)}>取消</Button><Button type="submit" form={groupId + "-rename"} disabled={!name.trim()}>保存</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
