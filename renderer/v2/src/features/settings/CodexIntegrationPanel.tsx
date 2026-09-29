import { useEffect, useRef, useState } from "react"
import { ArrowClockwise, CaretRight, CheckCircle, Copy, PlugsConnected, SpinnerGap, WarningCircle } from "@phosphor-icons/react"
import type { AiOpsV2Api, CodexIntegrationStatus } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const labels = { available: "尚未配置", configured: "已配置", outdated: "配置需要更新", conflict: "需要手动处理", error: "暂时无法检测" }

export function CodexIntegrationPanel({ api, onBusyChange }: {
  readonly api: AiOpsV2Api
  readonly onBusyChange: (busy: boolean) => void
}) {
  const [state, setState] = useState<CodexIntegrationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<"status" | "install" | "copy" | null>("status")
  const statusHeadingRef = useRef<HTMLHeadingElement>(null)
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let cancelled = false
    inFlight.current = true
    setBusy(true)
    void api.codexIntegration({ action: "status" }).then(result => {
      if (cancelled) return
      if (result.ok) setState(result.data)
      else setError(result.error.message)
    }).catch(() => { if (!cancelled) setError("无法检测 Codex 配置，请重试。") })
      .finally(() => { if (!cancelled) { inFlight.current = false; setBusy(false); setPendingAction(null) } })
    return () => { cancelled = true }
  }, [api])

  const run = async (action: "status" | "install" | "copy") => {
    if (inFlight.current) return
    inFlight.current = true
    setPendingAction(action); setBusy(true); if (action === "install") onBusyChange(true); setError(""); setNotice("")
    try {
      if (action === "copy") {
        const result = await api.codexIntegration({ action: "copy" })
        if (!mounted.current) return
        if (result.ok) setNotice("配置已复制。请合并到 Codex 配置文件，避免重复添加同名条目。")
        else setError(result.error.message)
        return
      }
      if (action === "install" && !state?.approvalId) return
      const result = await api.codexIntegration(action === "install"
        ? { action, approvalId: state!.approvalId! } : { action })
      if (!mounted.current) return
      if (result.ok) {
        setState(result.data)
        if (action === "install" && result.data.status === "configured") {
          setNotice("配置已保存。请完全退出并重新打开 Codex，让新配置生效。")
          setAdvancedOpen(false)
          requestAnimationFrame(() => statusHeadingRef.current?.focus())
        }
      } else {
        setError(result.error.message)
        if (action === "install") setState(previous => previous ? { ...previous, approvalId: null } : null)
      }
    } catch {
      if (!mounted.current) return
      setError("操作未完成，请重新检测 Codex 配置后再试。")
      setState(previous => previous ? { ...previous, approvalId: null } : null)
    } finally { inFlight.current = false; if (mounted.current) { setBusy(false); setPendingAction(null); if (action === "install") onBusyChange(false) } }
  }

  const configured = state?.status === "configured"
  const canInstall = state?.status === "available" || state?.status === "outdated"
  const needsAttention = state?.status === "outdated" || state?.status === "conflict" || state?.status === "error" || Boolean(error)
  const title = state ? labels[state.status] : error ? "暂时无法检测" : "正在检测配置"
  const description = configured ? "本机已完成 Codex 接入，无需重复配置。"
    : state?.status === "available" ? "配置一次，即可让 Codex 使用工作台中已连接的资源。"
    : state?.status === "outdated" ? "已有配置与当前工作台不一致，更新后可使用当前应用。"
    : state?.message ?? (error ? "请重新检测，或在高级设置中查看手动配置方式。" : "正在检查本机是否已经配置，请稍候。")
  const openAdvanced = () => {
    setAdvancedOpen(true)
    requestAnimationFrame(() => advancedRef.current?.querySelector("summary")?.focus())
  }

  return <div className="max-w-2xl space-y-5" data-testid="codex-integration-panel" aria-busy={busy}>
    <section className={cn("overflow-hidden rounded-lg border bg-card", configured && "border-success/30")} aria-labelledby="codex-title">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="codex-title" className="text-base font-semibold">Codex</h2>
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} data-testid="codex-refresh" onClick={() => void run("status")}>
            {busy && pendingAction === "status" ? <SpinnerGap className="animate-spin motion-reduce:animate-none" /> : <ArrowClockwise />}重新检测
          </Button>
        </div>
        <div className="mt-5 flex items-start gap-4" role="status" aria-atomic="true" data-testid="codex-status-summary">
          <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", configured && "bg-success/10 text-success", needsAttention && !configured && "bg-warning/10 text-warning")}>
            {configured ? <CheckCircle size={32} weight="fill" className="text-success" aria-hidden="true" /> : !state && !error ? <SpinnerGap size={28} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : needsAttention ? <WarningCircle size={28} className="text-warning" aria-hidden="true" /> : <PlugsConnected size={28} aria-hidden="true" />}
          </div>
          <div className="min-w-0 space-y-2">
            <h3 ref={statusHeadingRef} tabIndex={-1} className={cn("text-2xl leading-8 font-semibold tracking-tight outline-none", configured && "text-success")} data-testid="codex-status">{title}</h3>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        {canInstall ? <div className="mt-5 space-y-2 sm:pl-16">
          <Button disabled={busy || !state?.approvalId} data-testid="codex-install" onClick={() => void run("install")}>
            {busy && pendingAction === "install" ? <SpinnerGap className="animate-spin motion-reduce:animate-none" /> : <PlugsConnected />}
            {pendingAction === "install" ? "正在配置…" : state?.status === "outdated" ? "更新配置" : "一键接入 Codex"}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">自动备份已有配置，保留其他接入和工具限制。</p>
        </div> : state?.status === "conflict" || state?.status === "error" || (!state && error) ? <div className="mt-5 sm:pl-16">
          <Button variant="outline" onClick={openAdvanced} data-testid="codex-help">查看处理方式<CaretRight /></Button>
        </div> : null}
        {error ? <p role="alert" className="mt-4 text-sm leading-6 text-destructive">{error}</p> : null}
        {notice ? <p role="status" className="mt-4 rounded-md bg-success/10 p-3 text-sm leading-6" data-testid="codex-notice">{notice}</p> : null}
      </div>
      {configured ? <div className="space-y-4 border-t p-5 sm:p-6" data-testid="codex-next-steps">
        <h3 className="text-sm font-medium">接下来怎么用</h3>
        <ol className="space-y-4">
          <li className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground" aria-hidden="true">1</span><div className="space-y-1"><p className="text-sm font-medium">在工作台连接需要使用的资源</p><p className="text-xs leading-5 text-muted-foreground">选择项目和环境，连接服务器、数据库或缓存，并保持工作台运行。</p></div></li>
          <li className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground" aria-hidden="true">2</span><div className="space-y-1"><p className="text-sm font-medium">打开 Codex，直接提问</p><p className="text-xs leading-5 text-muted-foreground">例如：“查看当前环境有哪些可用资源。”</p></div></li>
        </ol>
        <p className="text-xs leading-5 text-muted-foreground">刚完成或更新配置？完全退出并重新打开 Codex 后生效。</p>
      </div> : null}
    </section>

    <details ref={advancedRef} open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)} className="group border-t pt-3" data-testid="codex-advanced">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <CaretRight size={14} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />高级设置<span className="ml-auto text-xs">配置详情与手动接入</span>
      </summary>
      <div className="space-y-5 pt-4">
        {configured ? <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1"><h3 className="text-sm font-medium">重新配置</h3><p className="text-xs leading-5 text-muted-foreground">仅在更换安装位置或需要修复接入时使用。</p></div>
          <Button size="sm" variant="outline" disabled={busy || !state?.approvalId} data-testid="codex-install" onClick={() => void run("install")}><ArrowClockwise />重新配置</Button>
        </div> : null}
        {state ? <div className="space-y-1 text-xs"><p className="text-muted-foreground">本机配置文件</p><p className="break-all font-mono leading-5" data-testid="codex-config-path">{state.configPath}</p></div> : null}
        {state?.backupPath ? <p data-testid="codex-backup" className="break-all text-xs leading-5 text-muted-foreground">原配置备份：{state.backupPath}</p> : null}
        <p className="text-xs leading-5 text-muted-foreground">此页检查本机的接入配置，实际连接情况请在 Codex 中查看。项目级配置可能覆盖此设置；WSL 或远程主机需单独配置。</p>
        {state ? <details className="rounded-md border p-4" data-testid="codex-manual">
          <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60">手动配置</summary>
          <div className="mt-4 space-y-3"><p className="text-xs leading-5 text-muted-foreground">将以下内容合并到上方文件；已有 agent-ops 条目时，请先核对，避免重复添加。</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-5" tabIndex={0} aria-label="Codex MCP 配置">{state.configSnippet}</pre>
            <Button size="sm" variant="outline" disabled={busy} data-testid="codex-copy" onClick={() => void run("copy")}><Copy />复制配置</Button>
          </div>
        </details> : null}
      </div>
    </details>
  </div>
}
