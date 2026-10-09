import { useEffect, useRef, useState } from "react"
import { ArrowClockwise, DownloadSimple, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SelectControl, SelectItem } from "@/components/ui/select"
import type { SoftwareUpdateRequest, SoftwareUpdateState } from "./software-update-types"

const labels: Record<SoftwareUpdateState["phase"], string> = {
  idle: "尚未检查更新", "no-source": "尚未连接云仓库", "source-required": "请选择更新来源",
  unsupported: "当前运行方式不支持在线更新", checking: "正在检查更新…", current: "已是最新版本",
  available: "发现新版本", downloading: "正在下载更新…", downloaded: "更新已下载", installing: "正在准备重启更新…", error: "更新暂未完成",
}

function formatTime(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN")
}

export function SoftwareUpdatePanel({ api }: { readonly api: AiOpsV2Api }) {
  const [state, setState] = useState<SoftwareUpdateState | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<SoftwareUpdateRequest["action"] | null>(null)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const mounted = useRef(false)
  const actionInFlight = useRef<SoftwareUpdateRequest["action"] | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    mounted.current = true
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const started = generation.current
      try {
        const result = await api.softwareUpdate({ action: "status" })
        if (!active || started !== generation.current) return
        if (result.ok) setState(result.data)
        else setError(result.error.message)
      } catch { if (active && started === generation.current) setError("暂时无法读取更新状态，请重试。") }
      finally { if (active) timer = setTimeout(() => { void poll() }, 1000) }
    }
    void poll()
    return () => { active = false; mounted.current = false; clearTimeout(timer) }
  }, [api])

  const run = async (request: SoftwareUpdateRequest) => {
    if (actionInFlight.current && request.action !== "cancel") return
    const current = ++generation.current
    actionInFlight.current = request.action
    setPending(request.action); setError("")
    try {
      const result = await api.softwareUpdate(request)
      if (!mounted.current || current !== generation.current) return
      if (result.ok) setState(result.data)
      else setError(result.error.message)
    } catch { if (mounted.current && current === generation.current) setError("更新操作未完成，请检查网络后重试。") }
    finally {
      if (current === generation.current) {
        generation.current += 1
        actionInFlight.current = null
        if (mounted.current) setPending(null)
      }
    }
  }

  const phase = state?.phase
  const working = phase === "checking" || phase === "downloading" || phase === "installing"
  const blocked = Boolean(pending) || working
  const selectedSource = state?.source
  const canCheck = Boolean(state?.supported && selectedSource) && !blocked
  const percent = state?.progress ? Math.min(100, Math.max(0, state.progress.percent)) : null
  const visibleError = error || state?.error?.message

  return <section className="max-w-xl space-y-4 rounded-lg border bg-card p-5 sm:p-6" aria-labelledby="software-update-title" data-testid="software-update-panel">
    <div className="space-y-1"><h2 id="software-update-title" className="text-section font-medium">软件更新</h2><p className="text-xs leading-5 text-muted-foreground">通过已连接的云仓库检查和下载新版本，安装前由你确认重启。</p></div>
    {state?.sources.length ? <div className="space-y-2">
      <label htmlFor="software-update-source" className="text-xs text-muted-foreground">更新来源</label>
      <SelectControl id="software-update-source" data-testid="software-update-source" className="w-full" value={selectedSource?.repositoryId ?? ""} placeholder="选择一个云仓库" disabled={blocked} onValueChange={repositoryId => { void run({ action: "source", repositoryId }) }}>
        {state.sources.map(source => <SelectItem key={source.repositoryId} value={source.repositoryId}>{source.name}</SelectItem>)}
      </SelectControl>
      {selectedSource ? <p className="break-all text-xs text-muted-foreground" data-testid="software-update-origin">{selectedSource.origin}</p> : <p className="text-xs leading-5 text-muted-foreground">已连接多个云仓库，请指定一个软件更新来源。</p>}
    </div> : null}
    <div className="space-y-2" role="status" aria-atomic="true">
      <p className="flex items-center gap-2 text-sm font-medium" data-testid="software-update-status">{working || !state && !error ? <SpinnerGap className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}{state ? labels[state.phase] : error ? "无法读取更新状态" : "正在读取更新状态…"}</p>
      {state?.availableVersion ? <p className="text-xs text-muted-foreground" data-testid="software-update-version">{state.currentVersion} → {state.availableVersion}</p> : null}
      {phase === "no-source" ? <p className="text-xs leading-5 text-muted-foreground">请先在“云同步”中连接云仓库，再回来检查软件更新。</p> : null}
      {phase === "unsupported" ? <p className="text-xs leading-5 text-muted-foreground">当前仅支持 Windows 正式安装版。</p> : null}
      {phase === "downloading" ? <div className="space-y-2" data-testid="software-update-progress"><Progress value={percent} aria-label="更新下载进度" /><p className="text-xs text-muted-foreground">{percent === null ? "正在准备下载…" : `已下载 ${Math.floor(percent)}%`} · 可以返回工作台，下载会继续。</p></div> : null}
      {phase === "downloaded" ? <p className="text-xs leading-5 text-muted-foreground">安装包已就绪。请保存工作内容，再重启完成更新。</p> : null}
    </div>
    {visibleError ? <p role="alert" className="text-xs leading-5 text-destructive" data-testid="software-update-error">{visibleError}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant={phase === "available" || phase === "downloaded" ? "outline" : "default"} size="sm" disabled={!canCheck} data-testid="software-update-check" onClick={() => { void run({ action: "check" }) }}><ArrowClockwise />检查更新</Button>
      {phase === "available" ? <Button size="sm" disabled={blocked} data-testid="software-update-download" onClick={() => { void run({ action: "download" }) }}><DownloadSimple />下载更新</Button> : null}
      {phase === "downloading" ? <Button variant="outline" size="sm" disabled={pending === "cancel"} data-testid="software-update-cancel" onClick={() => { void run({ action: "cancel" }) }}>{pending === "cancel" ? "正在取消…" : "取消下载"}</Button> : null}
      {phase === "downloaded" ? <Button size="sm" disabled={blocked} data-testid="software-update-install" onClick={() => setConfirmInstall(true)}><ArrowClockwise />重启并更新</Button> : null}
    </div>
    {state?.checkedAt ? <p className="text-xs text-muted-foreground">上次检查：{formatTime(state.checkedAt)}</p> : null}
    {state?.releaseNotes ? <details className="border-t pt-3" data-testid="software-update-notes"><summary className="cursor-pointer rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60">版本说明{state.releaseDate ? ` · ${formatTime(state.releaseDate)}` : ""}</summary><p className="mt-3 max-h-64 overflow-y-auto break-words whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{state.releaseNotes}</p></details> : null}
    <AlertDialog open={confirmInstall} onOpenChange={setConfirmInstall}>
      <AlertDialogContent data-testid="software-update-confirm"><AlertDialogHeader><AlertDialogTitle>重启并更新到 {state?.availableVersion}？</AlertDialogTitle><AlertDialogDescription>更新将关闭当前工作区和连接，保留本机项目配置与已保存凭据。请先保存工作内容并结束 SQL 事务和文件传输；仍有活动任务时会阻止安装。更新后重新打开 Agent 客户端以恢复接入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel data-testid="software-update-install-cancel">稍后再说</AlertDialogCancel><AlertDialogAction data-testid="software-update-install-confirm" disabled={phase !== "downloaded" || blocked} onClick={() => { void run({ action: "install" }) }}>确认重启更新</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>
}
