import { SelectControl, SelectItem } from "@/components/ui/select"
import { useMemo, useState } from "react"
import type { AiOpsV2Api, DockerContainer, DockerContainerPage, PluginScope } from "@/bridge/ai-ops-v2"
import { Input } from "@/components/ui/input"
import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { DockerIcon } from "./ServerResourceRail"
import { useDockerRead } from "./use-docker-read"

export interface DockerViewProps {
  readonly api:AiOpsV2Api
  readonly scope:PluginScope
  readonly connected:boolean
  readonly visible:boolean
  readonly binding:string
}

export function ServerDockerTree({ api, scope, connected, visible, binding, onOpen, selected }: DockerViewProps & {
  readonly onOpen:(container:DockerContainer) => void; readonly selected:string | null
}) {
  const [search, setSearch] = useState("")
  const [state, setState] = useState("all")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const { data, error, busy, refresh } = useDockerRead<DockerContainerPage>({ api, scope, query:{ kind:"list", limit:200 }, enabled:visible && connected, binding })
  const groups = useMemo(() => {
    const result = new Map<string, DockerContainer[]>()
    const needle = search.toLowerCase().trim()
    for (const item of data?.items ?? []) {
      if (state === "running" && item.state !== "running" || state === "stopped" && item.state === "running") continue
      if (needle && ![item.name, item.id, item.image, item.project, item.service].some(value => value.toLowerCase().includes(needle))) continue
      const key = item.project || ""
      if (!result.has(key)) result.set(key, [])
      result.get(key)!.push(item)
    }
    return [...result].sort(([a], [b]) => a ? b ? a.localeCompare(b) : -1 : 1)
  }, [data, search, state])
  return <section className="server-docker-tree" aria-label="Docker 容器列表">
    <div className="server-docker-list-toolbar"><span>Docker <span className="text-muted-foreground">{data?.total ?? ""}</span></span><WorkspaceIconButton action="refresh" label="刷新容器列表" disabled={!connected || busy} busy={busy} onClick={refresh} /></div>
    <div className="server-docker-filter"><Input aria-label="搜索容器" value={search} placeholder="搜索容器、镜像或 Compose" onChange={event => setSearch(event.target.value)} />
      <SelectControl aria-label="容器状态筛选" value={state} onValueChange={setState}><SelectItem value="all">全部状态</SelectItem><SelectItem value="running">运行中</SelectItem><SelectItem value="stopped">未运行</SelectItem></SelectControl>
    </div>
    {!connected ? <p className="server-docker-message">请先连接服务器。</p> : null}
    {error ? <p className="server-docker-message text-danger" role="alert">{error}{data ? " 当前列表为上次读取结果。" : ""}</p> : null}
    {data?.truncated ? <p className="server-docker-message text-warning" role="status">列表达到读取上限，可能还有其他容器。</p> : null}
    {busy && !data ? <p className="server-docker-message">正在检测 Docker 并读取容器…</p> : null}
    <div className="server-docker-list">
      {groups.map(([project, items]) => <div key={project}>
        <button type="button" className="server-docker-group" aria-expanded={!collapsed.has(project)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(project)) next.delete(project); else next.add(project); return next })}>{collapsed.has(project) ? "▸" : "▾"} {project ? "Compose · " + project : "独立容器"} <span>{items.length}</span></button>
        {!collapsed.has(project) ? items.map(item => <button key={item.id} type="button" className="server-docker-container" aria-label={"打开容器 " + item.name} aria-pressed={selected === item.id} disabled={!connected} onClick={() => onOpen(item)} title={item.name + "\n" + item.status + "\n" + item.image}>
          <DockerIcon size={18} /><span className="server-docker-container-text"><strong>{item.name}</strong><small>{item.service || item.image}</small></span><span className="server-docker-state" data-running={item.state === "running"}>{item.state === "running" ? "运行中" : item.state}</span>
        </button>) : null}
      </div>)}
      {data && !groups.length ? <p className="server-docker-message">{search || state !== "all" ? "当前筛选没有匹配容器。" : "当前没有容器。"}</p> : null}
    </div>
    {data ? <div className="server-docker-list-footer">采集于 {new Date(data.sampledAt).toLocaleTimeString()}</div> : null}
  </section>
}
