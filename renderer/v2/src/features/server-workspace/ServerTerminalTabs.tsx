import { Empty, EmptyHeader, EmptyTitle, EmptyMedia, EmptyContent } from "@/components/ui/empty"
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { FileText, TerminalWindow } from "@phosphor-icons/react"
import type { DockerContainer } from "@/bridge/ai-ops-v2"
import { ServerTerminal, type ServerTerminalProps } from "./ServerTerminal"
import { WorkspaceTabs } from "./WorkspaceTabs"
import { Button } from "@/components/ui/button"
import { DockerIcon } from "./ServerResourceRail"
import { ServerDockerContainer } from "./ServerDockerContainer"
import type { FileDocuments } from "./ServerFilePreviews"
import { WorkspaceLayoutControls } from "@/components/workspace/WorkspaceLayoutControls"
import { WorkspaceSplitMenu } from "./WorkspaceSplitMenu"
import { WorkspaceSplitHandle } from "./WorkspaceSplitHandle"
import { reconcileDocuments, selectDocument, swapDocumentPanes, type DocumentView, type WorkspaceLayout } from "./workspace-documents"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface ContentProps {
  readonly maximized: boolean
  readonly onMaximize: () => void
  readonly layoutControls: string
  readonly onActiveSessionChange: (sessionId: string | null) => void
  readonly onActiveTerminalLabel: (label: string) => void
  readonly onActiveFileChange: (path: string | null) => void
  readonly dockerTabs: readonly DockerContainer[]
  readonly activeDocker: string | null
  readonly onDockerSelect: (id: string | null) => void
  readonly onDockerClose: (id: string) => void
  readonly binding: string
  readonly files: FileDocuments
}

export function ServerTerminalTabs({ onActiveSessionChange, onActiveTerminalLabel, onActiveFileChange, dockerTabs, activeDocker, onDockerSelect, onDockerClose, binding, files, maximized, onMaximize, layoutControls, ...props }: Omit<ServerTerminalProps, "tabId" | "onSessionChange"> & ContentProps) {
  const groupId = useId()
  const sequence = useRef(1)
  const [tabs, setTabs] = useState([{ id: "default", label: "终端 1", title: "终端 1" }])
  const [view, setView] = useState<DocumentView>({ active: "default", panes: ["default"], layout: "single" })
  const [order, setOrder] = useState<readonly string[]>(["default"])
  const [lastTerminal, setLastTerminal] = useState("default")
  const [ratio, setRatio] = useState(50)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [sessions, setSessions] = useState<Record<string, string | null>>({})
  const documents = [
    ...tabs.map(tab => ({ ...tab, kind: "terminal" as const, dirty: false, renamable: true, icon: <TerminalWindow size={14} aria-hidden="true" /> })),
    ...files.items.map(file => ({ ...file, kind: "file" as const, renamable: false, icon: <FileText size={14} aria-hidden="true" /> })),
    ...dockerTabs.map(item => ({ id: "docker:" + item.id, label: item.name, title: "容器 " + item.name, kind: "docker" as const, dirty: false, renamable: false, icon: <DockerIcon size={14} /> })),
  ]
  const ids = [...order.filter(id => documents.some(item => item.id === id)), ...documents.map(item => item.id).filter(id => !order.includes(id))]
  const items = ids.map(id => documents.find(item => item.id === id)!)
  const idsKey = ids.join("|")
  const previousIds = useRef(ids)
  useEffect(() => {
    const previous = previousIds.current
    setView(current => reconcileDocuments(current, ids, previous))
    previousIds.current = ids
    setOrder(current => current.join("|") === idsKey ? current : ids)
  }, [idsKey])

  const select = useCallback((id: string) => {
    setView(current => selectDocument(current, id))
    onDockerSelect(id.startsWith("docker:") ? id.slice(7) : null)
  }, [onDockerSelect])
  useEffect(() => { if (files.activation) select(files.activation.id) }, [files.activation, select])
  useEffect(() => { if (activeDocker) setView(current => selectDocument(current, "docker:" + activeDocker)) }, [activeDocker])
  useEffect(() => { onDockerSelect(view.active?.startsWith("docker:") ? view.active.slice(7) : null) }, [view.active, onDockerSelect])
  const visibleFiles = files.items.filter(file => view.panes.includes(file.id)).map(file => file.id).join("|")
  useLayoutEffect(() => { files.setVisible(visibleFiles ? visibleFiles.split("|") : []) }, [visibleFiles, files.setVisible])
  const activeFilePath = files.items.find(file => file.id === view.active)?.path ?? null
  useLayoutEffect(() => { onActiveFileChange(activeFilePath) }, [activeFilePath, onActiveFileChange])
  const activeTerminal = tabs.find(tab => tab.id === view.active)
  useEffect(() => { if (activeTerminal) setLastTerminal(activeTerminal.id) }, [activeTerminal?.id])
  const terminal = activeTerminal ?? tabs.find(tab => tab.id === lastTerminal) ?? tabs[0]
  const onSessionChange = useCallback((tabId: string, sessionId: string | null) => {
    setSessions(current => {
      if (sessionId) return current[tabId] === sessionId ? current : { ...current, [tabId]: sessionId }
      if (!(tabId in current)) return current
      const next = { ...current }; delete next[tabId]; return next
    })
  }, [])
  useEffect(() => { onActiveSessionChange(terminal ? sessions[terminal.id] ?? null : null); onActiveTerminalLabel(terminal?.label ?? "") }, [terminal, sessions, onActiveSessionChange, onActiveTerminalLabel])
  useEffect(() => () => onActiveSessionChange(null), [onActiveSessionChange])

  const createTerminal = () => {
    const id = crypto.randomUUID(), label = "终端 " + ++sequence.current
    setTabs(current => [...current, { id, label, title: label }])
    return id
  }
  const add = () => { if (props.connected && tabs.length < 8) select(createTerminal()) }
  const close = (id: string) => {
    const item = documents.find(document => document.id === id)
    if (item?.kind === "file") files.close(id)
    else if (item?.kind === "docker") onDockerClose(id.slice(7))
    else setTabs(current => current.filter(tab => tab.id !== id))
  }
  const changeLayout = (layout: WorkspaceLayout) => {
    const first = view.active ?? ids[0]
    if (!first) return
    if (layout === "single") { setView({ active: first, panes: [first], layout }); return }
    // 已分屏时保留左右/上下顺序；首次分屏优先配对文件与终端。
    if (view.panes.length === 2) { setView(current => ({ ...current, layout })); setRatio(50); return }
    const kind = documents.find(item => item.id === first)?.kind
    const preferred = kind === "file" ? terminal?.id : kind === "terminal" ? files.items.at(-1)?.id : undefined
    let other = preferred ?? ids.find(id => id !== first)
    if (!other && props.connected && tabs.length < 8) other = createTerminal()
    if (!other || other === first) return
    setView({ active: first, panes: [first, other], layout }); setRatio(50)
  }
  const reorder = (source: string, target: string) => {
    const next = [...ids], from = next.indexOf(source), to = next.indexOf(target)
    if (from < 0 || to < 0) return
    next.splice(to, 0, next.splice(from, 1)[0]!); setOrder(next)
  }
  return <section className="server-terminal-tabs" aria-label="服务器工作区标签">
    <WorkspaceTabs id={groupId} label="工作区标签" items={items} active={view.active} visibleIds={view.panes} onSelect={select} onClose={close} onAdd={add} addDisabled={!props.connected || tabs.length >= 8}
      onRename={id => { setRenaming(id); setName(tabs.find(tab => tab.id === id)?.label ?? "") }} onReorder={reorder}
      actions={<WorkspaceLayoutControls maximized={maximized} onToggle={onMaximize} testId="server-layout-toggle" controls={layoutControls}>
        <WorkspaceSplitMenu value={view.layout} onChange={changeLayout} onSwap={() => setView(swapDocumentPanes)} disabled={!ids.length} splitDisabled={ids.length < 2 && (!props.connected || tabs.length >= 8)} />
      </WorkspaceLayoutControls>} />
    {files.notice ? <div className="server-workspace-error" role="status">{files.notice}</div> : null}
    <div className="server-terminal-panes server-document-panes" data-layout={view.layout} style={view.layout === "single" ? {} : view.layout === "horizontal" ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 5px minmax(0, ${100 - ratio}fr)` } : { gridTemplateRows: `minmax(0, ${ratio}fr) 5px minmax(0, ${100 - ratio}fr)` }}>
      {items.map(item => {
        const shown = view.panes.includes(item.id), focused = view.active === item.id
        const index = view.panes.indexOf(item.id)
        return <div key={item.id} className={`server-document-panel ${item.kind === "terminal" ? "server-terminal-tab-panel server-content-terminal" : item.kind === "file" ? "server-preview-tab-panel" : "server-docker-tab-panel"}`} data-document-kind={item.kind} data-terminal-id={item.kind === "terminal" ? item.id : undefined} data-input-active={focused} role="tabpanel" id={groupId + "-panel-" + item.id} aria-labelledby={groupId + "-tab-" + item.id} hidden={!shown}
          style={shown ? { gridArea: view.layout === "vertical" ? `${index * 2 + 1} / 1` : `1 / ${index * 2 + 1}` } : undefined}
          onFocusCapture={() => { if (shown && !focused) select(item.id) }} onPointerDownCapture={() => { if (shown && !focused) select(item.id) }}>
          {view.layout !== "single" ? <div className="server-terminal-pane-heading">{item.icon}<strong>{item.label}</strong><span>{focused ? "当前窗格" : "点击切换"}</span></div> : null}
          {item.kind === "terminal" ? <ServerTerminal {...props} onSessionChange={onSessionChange} tabId={item.id} focused={focused} visible={props.visible && shown} />
            : item.kind === "file" ? files.items.find(file => file.id === item.id)?.content
            : <ServerDockerContainer api={props.api} scope={props.scope} container={dockerTabs.find(container => "docker:" + container.id === item.id)!} connected={props.connected} visible={props.visible && shown} binding={binding} />}
        </div>
      })}
      {view.layout !== "single" ? <WorkspaceSplitHandle layout={view.layout} ratio={ratio} onChange={setRatio} /> : null}
      {!items.length ? <Empty className="server-tabs-empty"><EmptyHeader><EmptyMedia variant="icon"><TerminalWindow /></EmptyMedia><EmptyTitle>暂无打开的标签</EmptyTitle></EmptyHeader><EmptyContent><p>打开文件或新增终端开始操作。</p><Button variant="outline" disabled={!props.connected} onClick={add}>新增终端</Button></EmptyContent></Empty> : null}
    </div>
    <Dialog open={renaming !== null} onOpenChange={open => { if (!open) setRenaming(null) }}><DialogContent><DialogHeader><DialogTitle>重命名终端</DialogTitle><DialogDescription>名称仅用于当前工作区，便于区分日志、检查和部署终端。</DialogDescription></DialogHeader><form id={groupId + "-rename"} onSubmit={event => { event.preventDefault(); const label = name.trim(); if (!label) return; setTabs(current => current.map(tab => tab.id === renaming ? { ...tab, label, title: label } : tab)); setRenaming(null) }}><Input aria-label="终端名称" maxLength={40} value={name} onChange={event => setName(event.target.value)} autoFocus /></form><DialogFooter><Button variant="outline" onClick={() => setRenaming(null)}>取消</Button><Button type="submit" form={groupId + "-rename"} disabled={!name.trim()}>保存</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
