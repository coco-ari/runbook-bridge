import { useEffect, useState } from "react"
import { CaretDown } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerMetricsSnapshot } from "@/bridge/ai-ops-v2"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { unwrapWorkspaceResult } from "./workspace-model"

const percent = (value: number | null | undefined) => value == null ? "--" : Math.round(value) + "%"
const capacity = (value: number) => {
  const unit = value >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2
  return (value / unit).toFixed(value / unit < 10 ? 1 : 0) + (unit === 1024 ** 3 ? " GiB" : " MiB")
}
const usage = (used: number, total: number) => capacity(used) + " / " + capacity(total)
const compactUsage = (used: number, total: number) => {
  const unit = total >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2
  const format = (value: number) => (value / unit).toFixed(value / unit < 10 ? 1 : 0)
  return format(used) + "/" + format(total) + (unit === 1024 ** 3 ? " GiB" : " MiB")
}
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString() : "尚未采样"

export function ServerMetrics({ api, scope, connected, visible }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly connected: boolean; readonly visible: boolean
}) {
  const [snapshot, setSnapshot] = useState<ServerMetricsSnapshot | null>(null)
  const [failed, setFailed] = useState({ system: false, disks: false })
  const [awake, setAwake] = useState(!document.hidden)
  const [now, setNow] = useState(Date.now)
  const [mount, setMount] = useState("/")
  const [diskOpen, setDiskOpen] = useState(false)

  useEffect(() => {
    type Kind = "system" | "disks"
    let disposed = false, generation = 0
    const timers: Partial<Record<Kind, ReturnType<typeof setTimeout>>> = {}
    const watchdogs: Partial<Record<Kind, ReturnType<typeof setTimeout>>> = {}
    const stop = () => {
      generation += 1
      for (const kind of ["system", "disks"] as const) {
        clearTimeout(timers[kind])
        clearTimeout(watchdogs[kind])
      }
      void api.serverWorkspaceStopMetrics(scope).catch(() => {})
    }
    const start = () => {
      stop()
      if (disposed) return
      const active = visible && connected && !document.hidden
      setAwake(!document.hidden)
      setDiskOpen(false)
      if (!active) return
      setSnapshot(null)
      setFailed({ system: false, disks: false })
      const run = generation
      const poll = async (kind: Kind) => {
        let retryAfterMs = kind === "system" ? 5000 : 30000
        setNow(Date.now())
        watchdogs[kind] = setTimeout(() => {
          if (!disposed && run === generation) { setFailed(current => ({ ...current, [kind]: true })); setNow(Date.now()) }
        }, 12000)
        try {
          const next = unwrapWorkspaceResult(await api.serverWorkspaceMetrics({ ...scope, kind }))
          if (disposed || run !== generation) return
          // 仅合并本次请求的指标，迟到的磁盘响应不能覆盖新的 CPU 或内存。
          setSnapshot(current => {
            const previous = current ?? { cpu: null, memory: null, disks: [], sampledAt: null, diskSampledAt: null, error: null, diskError: null, unsupported: false, disksTruncated: false }
            return kind === "system"
              ? { ...previous, cpu: next.cpu, memory: next.memory, sampledAt: next.sampledAt, error: next.error, unsupported: next.unsupported }
              : { ...previous, disks: next.disks, diskSampledAt: next.diskSampledAt, diskError: next.diskError, disksTruncated: next.disksTruncated, unsupported: previous.unsupported || next.unsupported }
          })
          setFailed(current => ({ ...current, [kind]: false }))
          if (next.unsupported) { stop(); return }
          if (Number.isFinite(next.retryAfterMs)) retryAfterMs = Math.max(50, Math.min(next.retryAfterMs, retryAfterMs))
        } catch {
          if (disposed || run !== generation) return
          setFailed(current => ({ ...current, [kind]: true }))
        } finally {
          if (!disposed && run === generation) { clearTimeout(watchdogs[kind]); setNow(Date.now()) }
        }
        // 以后台返回的剩余时间调度，并保留小量余量，避免计时偏差造成整轮空等。
        if (!disposed && run === generation) timers[kind] = setTimeout(() => { void poll(kind) }, retryAfterMs + 25)
      }
      void poll("system")
      void poll("disks")
    }
    start()
    document.addEventListener("visibilitychange", start)
    return () => { disposed = true; document.removeEventListener("visibilitychange", start); stop() }
  }, [api, scope, connected, visible])

  const paused = !connected || !visible || !awake
  const unsupported = Boolean(snapshot?.unsupported)
  const stale = !paused && (failed.system || Boolean(snapshot?.error) || Boolean(snapshot?.sampledAt && now - snapshot.sampledAt > 15000))
  const diskStale = !paused && (failed.disks || Boolean(snapshot?.diskError) || Boolean(snapshot?.diskSampledAt && now - snapshot.diskSampledAt > 45000))
  const disk = snapshot?.disks.find(item => item.mount === mount) ?? snapshot?.disks.find(item => item.mount === "/") ?? snapshot?.disks[0]
  const cpu = snapshot?.cpu, memory = snapshot?.memory
  const label = (value: number | null | undefined, old: boolean) => paused || unsupported ? "--" : (old && value != null ? "旧 " : "") + percent(value)
  const status = (old: boolean) => paused ? "已暂停" : unsupported ? "仅支持 Linux" : old ? "数据已过期" : null
  const tone = (value: number | null | undefined, old: boolean) => paused || unsupported || old || value == null ? "muted" : value >= 90 ? "danger" : value >= 80 ? "warning" : "normal"
  const cpuDetail = status(stale) ?? (snapshot && !cpu ? "暂不可用" : cpu?.percent == null ? "采样中" : (cpu.cores ? cpu.cores + " 核" : "CPU") + " · 5 秒")
  const memoryDetail = status(stale) ?? (memory ? usage(memory.used, memory.total) : snapshot ? "暂不可用" : "读取中")
  const diskDetail = status(diskStale) ?? (disk ? usage(disk.used, disk.total) : "读取中")

  return <div className="server-metrics" aria-label="服务器资源监控" data-testid="server-metrics" data-paused={paused || undefined}>
    <Tooltip><TooltipTrigger asChild>
      <div className="server-metric" tabIndex={0} data-metric="cpu" data-tone={tone(cpu?.percent, stale)} aria-label={"CPU " + label(cpu?.percent, stale) + "，" + cpuDetail}>
        <span className="server-metric-label">cpu</span><strong>{label(cpu?.percent, stale)}</strong>
      </div>
    </TooltipTrigger><TooltipContent side="bottom"><span>CPU · {cpu?.cores ? cpu.cores + " 核 · " : ""}{status(stale) ?? (cpu?.percent == null ? cpuDetail : "最近两次采样间的总使用率")}<br />更新于 {time(snapshot?.sampledAt)}</span></TooltipContent></Tooltip>
    <Tooltip><TooltipTrigger asChild>
      <div className="server-metric" tabIndex={0} data-metric="memory" data-tone={tone(memory?.percent, stale)} aria-label={"内存 " + label(memory?.percent, stale) + "，" + memoryDetail}>
        <span className="server-metric-label">mem</span><strong>{label(memory?.percent, stale)}</strong>
        <span className="server-metric-detail">{status(stale) ?? (memory ? compactUsage(memory.used, memory.total) : memoryDetail)}</span>
      </div>
    </TooltipTrigger><TooltipContent side="bottom"><span>内存 · {status(stale) ?? "总量减去可用内存"}<br />{memory ? <>已用 / 总量 {usage(memory.used, memory.total)}<br />可用 {capacity(memory.available)}<br /></> : null}更新于 {time(snapshot?.sampledAt)}</span></TooltipContent></Tooltip>
    <Popover open={diskOpen} onOpenChange={setDiskOpen}>
      <Tooltip><TooltipTrigger asChild><PopoverTrigger asChild>
        <button type="button" className="server-metric server-metric-disk" data-metric="disk" data-tone={tone(disk?.percent, diskStale)} aria-label={"磁盘 " + (disk?.mount ?? "/") + "，" + label(disk?.percent, diskStale) + "，" + diskDetail + "，查看本地磁盘"} disabled={unsupported || !snapshot?.disks.length}>
          <span className="server-metric-label server-metric-disk-label">disk:<span>{disk?.mount ?? "/"}</span></span><strong>{label(disk?.percent, diskStale)}</strong>
          <span className="server-metric-detail">{status(diskStale) ?? (disk ? compactUsage(disk.used, disk.total) : diskDetail)}</span>
          <CaretDown className="server-metric-caret" size={11} aria-hidden="true" />
        </button>
      </PopoverTrigger></TooltipTrigger><TooltipContent side="bottom"><span>{disk?.mount ?? "/"} · {status(diskStale) ?? (disk ? "可用 " + capacity(disk.available) : "读取中")}<br />{disk ? <>已用 / 总量 {usage(disk.used, disk.total)}<br /></> : null}点击查看本地磁盘 · 更新于 {time(snapshot?.diskSampledAt)}</span></TooltipContent></Tooltip>
      <PopoverContent align="center" className="server-metrics-disks" aria-label="本地磁盘用量">
        <PopoverTitle>本地磁盘</PopoverTitle>
        <p className="server-metrics-disk-time">{status(diskStale) ?? "每 30 秒更新"} · {time(snapshot?.diskSampledAt)}</p>
        <div className="server-metrics-disk-list">{snapshot?.disks.map(item =>
          <button key={item.mount} type="button" aria-pressed={item.mount === disk?.mount} onClick={() => { setMount(item.mount); setDiskOpen(false) }}>
            <span className="server-metrics-disk-path"><code>{item.mount}</code><strong>{percent(item.percent)}</strong></span>
            <span>{usage(item.used, item.total)} · 可用 {capacity(item.available)}</span>
          </button>)}</div>
        {snapshot?.disksTruncated ? <p className="server-metrics-disk-time">仅显示前 64 个本地挂载点。</p> : null}
      </PopoverContent>
    </Popover>
  </div>
}
