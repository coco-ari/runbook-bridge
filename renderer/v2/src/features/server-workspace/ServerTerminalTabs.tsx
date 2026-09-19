import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ServerTerminal, type ServerTerminalProps } from "./ServerTerminal"
import { WorkspaceTabs } from "./WorkspaceTabs"
import { Button } from "@/components/ui/button"

export function ServerTerminalTabs({ onActiveSessionChange, ...props }: Omit<ServerTerminalProps, "tabId" | "onSessionChange"> & { onActiveSessionChange: (sessionId: string | null) => void }) {
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
  useEffect(() => { onActiveSessionChange(sessions[active] ?? null) }, [active, sessions, onActiveSessionChange])
  useEffect(() => () => onActiveSessionChange(null), [onActiveSessionChange])
  const add = () => {
    if (!props.connected || tabs.length >= 8) return
    const id = crypto.randomUUID()
    const label = "终端 " + ++sequence.current
    setTabs((current) => [...current, { id, label, title: label }])
    setActive(id)
  }
  const close = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    if (active === id) setActive((remaining[index] ?? remaining[index - 1])?.id ?? "")
  }
  return <section className="server-terminal-tabs" aria-label="服务器终端标签">
    <WorkspaceTabs id={groupId} label="终端标签" items={tabs} active={active} onSelect={setActive} onClose={close} onAdd={add} addDisabled={!props.connected || tabs.length >= 8} />
    {tabs.map((tab) => <div key={tab.id} className="server-terminal-tab-panel" role="tabpanel" id={groupId + "-panel-" + tab.id} aria-labelledby={groupId + "-tab-" + tab.id} hidden={active !== tab.id}>
      <ServerTerminal {...props} onSessionChange={onSessionChange} tabId={tab.id} visible={props.visible && active === tab.id} />
    </div>)}
    {!tabs.length ? <div className="server-tabs-empty"><p>所有终端已关闭</p><Button variant="outline" disabled={!props.connected} onClick={add}>新增终端</Button></div> : null}
  </section>
}
