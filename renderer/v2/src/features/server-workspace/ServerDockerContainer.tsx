import { useState } from "react"
import type { DockerContainer, DockerContainerDetails, DockerLogs, DockerStats } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useDockerRead } from "./use-docker-read"
import type { DockerViewProps } from "./ServerDockerTree"

type View = "inspect" | "logs" | "stats"
export function ServerDockerContainer({ container, ...props }: DockerViewProps & { readonly container:DockerContainer }) {
  const { api, scope, connected, visible, binding } = props
  const [view, setView] = useState<View>("inspect")
  const [lines, setLines] = useState(200)
  const [range, setRange] = useState("all")
  const [since, setSince] = useState<string>()
  const [search, setSearch] = useState("")
  const [copyError, setCopyError] = useState("")
  const [copied, setCopied] = useState(false)
  const detail = useDockerRead<DockerContainerDetails>({ api, scope, query:{ kind:"inspect", containerId:container.id }, enabled:visible && connected && view === "inspect", binding })
  const logs = useDockerRead<DockerLogs>({ api, scope, query:{ kind:"logs", containerId:container.id, lines, ...(since ? { since } : {}) }, enabled:visible && connected && view === "logs", binding })
  const stats = useDockerRead<DockerStats>({ api, scope, query:{ kind:"stats", containerId:container.id }, enabled:visible && connected && view === "stats", binding, interval:5000 })
  const result = view === "inspect" ? detail : view === "logs" ? logs : stats
  const logLines = logs.data?.content.split("\n") ?? []
  const displayedLines = search ? logLines.filter(line => line.toLowerCase().includes(search.toLowerCase())) : logLines
  const copy = async () => {
    setCopyError(""); setCopied(false)
    try { await navigator.clipboard.writeText(logs.data?.content ?? ""); setCopied(true) }
    catch { setCopyError("复制失败，请选中日志后复制。") }
  }
  const refresh = () => {
    setCopied(false)
    if (view === "logs" && range !== "all") setSince(new Date(Date.now() - Number(range) * 60000).toISOString())
    else result.refresh()
  }
  return <section className="server-docker-detail" aria-label={"容器 " + container.name}>
    <div className="server-docker-context">
      <div className="server-docker-views" aria-label="容器内容">
        {([["inspect", "概览"], ["logs", "日志"], ["stats", "资源"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
      </div>
      <span className="server-docker-id" title={container.id}>{container.id.slice(0, 12)}</span>
      {view === "logs" ? <><select aria-label="日志时间范围" value={range} onChange={event => { setRange(event.target.value); setSince(event.target.value === "all" ? undefined : new Date(Date.now() - Number(event.target.value) * 60000).toISOString()); setCopied(false) }}><option value="all">最近记录</option><option value="15">最近 15 分钟</option><option value="60">最近 1 小时</option><option value="1440">最近 24 小时</option></select>
        <select aria-label="日志行数" value={lines} onChange={event => { setLines(Number(event.target.value)); setCopied(false) }}>{[200, 500, 2000].map(value => <option key={value} value={value}>{value} 行</option>)}</select>
        <Button size="sm" variant="ghost" disabled={!logs.data} onClick={() => { void copy() }}>{copied ? "已复制" : "复制"}</Button></> : null}
      <WorkspaceIconButton action="refresh" label="刷新容器内容" disabled={!connected || result.busy} busy={result.busy} onClick={refresh} />
    </div>
    {!connected ? <p className="server-docker-message">服务器已断开，重新连接后读取。</p> : null}
    {result.error ? <p className="server-docker-message text-danger" role="alert">{result.error}{result.data ? " 下方保留上次结果。" : ""}</p> : null}
    {result.busy && !result.data ? <p className="server-docker-message">正在读取…</p> : null}
    <div className="server-docker-scroll" hidden={view !== "inspect"}>
      {detail.data ? <dl className="server-docker-overview">
        {([["名称", detail.data.name], ["状态", detail.data.state], ["镜像", detail.data.image], ["健康检查", detail.data.health ?? "未配置"], ["重启次数", detail.data.restartCount], ["退出码", detail.data.exitCode], ["启动时间", detail.data.startedAt], ["结束时间", detail.data.finishedAt], ["端口", JSON.stringify(detail.data.ports, null, 2)], ["挂载", detail.data.mounts.map(item => item.Type + " · " + item.Source + " → " + item.Destination + (item.RW ? "（读写）" : "（只读）")).join("\n") || "无"]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl> : null}
    </div>
    <div className="server-docker-log-panel" hidden={view !== "logs"}>
      <div className="server-docker-log-search"><Input aria-label="搜索已加载日志" placeholder="搜索已加载日志" value={search} onChange={event => setSearch(event.target.value)} />{search ? <span>{displayedLines.length} 行匹配</span> : null}</div>
      {logs.data?.truncated ? <p className="server-docker-message text-warning" role="status">日志已截断；请缩短时间范围或调整行数，不能据此判断没有其他记录。</p> : null}
      {copyError ? <p className="server-docker-message text-danger" role="alert">{copyError}</p> : null}
      <pre className="server-docker-logs" tabIndex={0} aria-label="容器日志">{logs.data ? displayedLines.join("\n") || (search ? "已加载日志中没有匹配项。" : "当前读取范围内没有日志。") : ""}</pre>
    </div>
    <div className="server-docker-scroll" hidden={view !== "stats"}>
      {stats.data ? stats.data.available ? <dl className="server-docker-overview">
        {([["CPU", stats.data.cpu], ["内存", stats.data.memory], ["内存占比", stats.data.memoryPercent], ["网络收发", stats.data.network], ["磁盘读写", stats.data.block], ["进程数", stats.data.pids]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl> : <p className="server-docker-message">容器未运行，暂无资源数据。</p> : null}
    </div>
    <footer className="server-docker-sampled">{result.data ? "采集于 " + new Date(result.data.sampledAt).toLocaleString() : "尚未采集"}{view === "stats" ? " · 可见时每 5 秒采样" : view === "logs" ? " · 手动刷新" : ""}</footer>
  </section>
}
