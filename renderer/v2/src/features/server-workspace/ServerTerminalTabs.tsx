import { useEffect, useId, useRef, useState } from "react"
import { ServerTerminal, type ServerTerminalProps } from "./ServerTerminal"
import { WorkspaceTabs } from "./WorkspaceTabs"
import { Button } from "@/components/ui/button"

export function ServerTerminalTabs(props: Omit<ServerTerminalProps, "tabId">) {
  const groupId = useId()
  const sequence = useRef(1)
  const [tabs, setTabs] = useState([{ id: "default", label: "终端 1", title: "终端 1" }])
  const [active, setActive] = useState("default")
  const [routedInsertion, setRoutedInsertion] = useState<{ tabId: string; value: ServerTerminalProps["insertion"] } | null>(null)
  useEffect(() => { if (props.insertion) setRoutedInsertion({ tabId: active, value: props.insertion }) }, [props.insertion])
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
      <ServerTerminal {...props} tabId={tab.id} visible={props.visible && active === tab.id} insertion={routedInsertion?.tabId === tab.id ? routedInsertion.value : null} />
    </div>)}
    {!tabs.length ? <div className="server-tabs-empty"><p>所有终端已关闭</p><Button variant="outline" disabled={!props.connected} onClick={add}>新增终端</Button></div> : null}
  </section>
}
