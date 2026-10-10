import { useState } from "react"
import { ArrowClockwise, DownloadSimple, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SelectControl, SelectItem } from "@/components/ui/select"
import type { SoftwareUpdateState } from "./software-update-types"

import { useSoftwareUpdate } from "./use-software-update"
import { SoftwareUpdateConfirmation } from "./SoftwareUpdateConfirmation"

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
  const { state, error, pending, run } = useSoftwareUpdate(api)
  const [confirmInstall, setConfirmInstall] = useState(false)

  const phase = state?.phase
  const working = phase === "checking" || phase === "downloading" || phase === "installing"
  const blocked = Boolean(pending) || working
  const selectedSource = state?.source
  const canCheck = Boolean(state?.supported && selectedSource) && !blocked
  const percent = state?.progress ? Math.min(100, Math.max(0, state.progress.percent)) : null
  const visibleError = error || state?.error?.message

  return <section className="max-w-2xl space-y-4 rounded-lg border bg-card p-4" aria-labelledby="software-update-title" data-testid="software-update-panel">
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
      <Button variant="outline" size="sm" disabled={!canCheck} data-testid="software-update-check" onClick={() => { void run({ action: "check" }) }}><ArrowClockwise />检查更新</Button>
      {phase === "available" ? <Button size="sm" disabled={blocked} data-testid="software-update-download" onClick={() => { void run({ action: "download" }) }}><DownloadSimple />下载新版本</Button> : null}
      {phase === "downloading" ? <Button variant="outline" size="sm" disabled={pending === "cancel"} data-testid="software-update-cancel" onClick={() => { void run({ action: "cancel" }) }}>{pending === "cancel" ? "正在取消…" : "取消下载"}</Button> : null}
      {phase === "downloaded" ? <Button size="sm" disabled={blocked} data-testid="software-update-install" onClick={() => setConfirmInstall(true)}><ArrowClockwise />立即更新</Button> : null}
    </div>
    {state?.checkedAt ? <p className="text-xs text-muted-foreground">上次检查：{formatTime(state.checkedAt)}</p> : null}
    {state?.releaseNotes ? <details className="border-t pt-3" data-testid="software-update-notes"><summary className="cursor-pointer rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60">版本说明{state.releaseDate ? ` · ${formatTime(state.releaseDate)}` : ""}</summary><p className="mt-3 max-h-64 overflow-y-auto break-words whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{state.releaseNotes}</p></details> : null}
    <SoftwareUpdateConfirmation open={confirmInstall} onOpenChange={setConfirmInstall} version={state?.availableVersion ?? null} disabled={phase !== "downloaded" || blocked} onInstall={() => { void run({ action: "install" }) }} />
  </section>
}
