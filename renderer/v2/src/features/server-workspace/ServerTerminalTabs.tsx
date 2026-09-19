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
    setActive(id)
    onDockerSelect(null)
  }
  const close = (id:string) => {
    if (id.startsWith("docker:")) { onDockerClose(id.slice(7)); return }
    const index = tabs.findIndex(tab => tab.id === id)
    const remaining = tabs.filter(tab => tab.id !== id)
    setTabs(remaining)
    if (active === id) setActive((remaining[index] ?? remaining[index - 1])?.id ?? "")
  }
  const items = [
    ...tabs.map(tab => ({ ...tab, icon:<TerminalWindow size={14} aria-hidden="true" /> })),
    ...dockerTabs.map(item => ({ id:"docker:" + item.id, label:item.name, title:"容器 " + item.name, icon:<DockerIcon size={14} /> })),
  ]
  const selected = activeDocker ? "docker:" + activeDocker : active
  return <section className="server-terminal-tabs" aria-label="服务器终端标签">
    <WorkspaceTabs id={groupId} label="终端标签" items={items} active={selected} onSelect={id => { if (id.startsWith("docker:")) onDockerSelect(id.slice(7)); else { setActive(id); onDockerSelect(null) } }} onClose={close} onAdd={add} addDisabled={!props.connected || tabs.length >= 8}
      actions={<WorkspaceLayoutControls maximized={maximized} onToggle={onMaximize} testId="server-layout-toggle" controls={`${layoutControls} ${groupId}-preview`} />} />
    <div className="server-content-terminal" hidden={activeDocker !== null}>
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel id={groupId + "-preview"} defaultSize={0} minSize="160px" maxSize="60%" collapsible collapsedSize={0} panelRef={previewPanelRef}>{preview}</ResizablePanel>
        <ResizableHandle className={!previewOpen || maximized ? "hidden" : ""} aria-label="调整文件预览高度" />
        <ResizablePanel id={groupId + "-terminal"} minSize="180px">
          {tabs.map(tab => <div key={tab.id} className="server-terminal-tab-panel" role="tabpanel" id={groupId + "-panel-" + tab.id} aria-labelledby={groupId + "-tab-" + tab.id} hidden={active !== tab.id}>
            <ServerTerminal {...props} onSessionChange={onSessionChange} tabId={tab.id} visible={props.visible && activeDocker === null && active === tab.id} />
          </div>)}
          {!tabs.length ? <div className="server-tabs-empty"><p>所有终端已关闭</p><Button variant="outline" disabled={!props.connected} onClick={add}>新增终端</Button></div> : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    {dockerTabs.map(container => <div className="server-docker-tab-panel" role="tabpanel" id={groupId + "-panel-docker:" + container.id} aria-labelledby={groupId + "-tab-docker:" + container.id} key={container.id} hidden={activeDocker !== container.id}>
      <ServerDockerContainer api={props.api} scope={props.scope} container={container} connected={props.connected} visible={props.visible && activeDocker === container.id} binding={binding} />
    </div>)}
  </section>
}
