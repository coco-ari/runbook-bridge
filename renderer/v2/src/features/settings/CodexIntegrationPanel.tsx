import { useEffect, useRef, useState } from "react"
import { ArrowClockwise, CheckCircle, Copy, PlugsConnected, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api, CodexIntegrationStatus } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const labels = { available: "未配置", configured: "已配置", conflict: "需要处理", error: "检测失败" }

export function CodexIntegrationPanel({ api, onBusyChange }: {
  readonly api: AiOpsV2Api
  readonly onBusyChange: (busy: boolean) => void
}) {
  const [state, setState] = useState<CodexIntegrationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const inFlight = useRef(false)
  useEffect(() => {
    let cancelled = false
    inFlight.current = true
    setBusy(true)
    void api.codexIntegration({ action: "status" }).then(result => {
      if (cancelled) return
      if (result.ok) setState(result.data)
      else setError(result.error.message)
    }).catch(() => { if (!cancelled) setError("无法检测 Codex 配置，请重试。") })
      .finally(() => { if (!cancelled) { inFlight.current = false; setBusy(false) } })
    return () => { cancelled = true }
  }, [api])

  const run = async (action: "status" | "install" | "copy") => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); onBusyChange(true); setError(""); setNotice("")
    try {
      if (action === "copy") {
        const result = await api.codexIntegration({ action: "copy" })
        if (result.ok) setNotice("配置已复制。请合并到 Codex 配置文件，避免重复添加同名条目。")
        else setError(result.error.message)
        return
      }
      if (action === "install" && !state?.approvalId) return
      const result = await api.codexIntegration(action === "install"
        ? { action, approvalId: state!.approvalId! } : { action })
      if (result.ok) {
        setState(result.data)
        if (action === "install" && result.data.status === "configured") setNotice("接入配置已保存。请完全退出并重新打开 Codex。")
      } else {
        setError(result.error.message)
        if (action === "install") setState(previous => previous ? { ...previous, approvalId: null } : null)
      }
    } catch {
      setError("操作未完成，请重新检测 Codex 配置后再试。")
      setState(previous => previous ? { ...previous, approvalId: null } : null)
    } finally { inFlight.current = false; setBusy(false); onBusyChange(false) }
  }

  return <div className="max-w-2xl space-y-4" data-testid="codex-integration-panel" aria-busy={busy}>
    <section className="space-y-5 rounded-lg border bg-card p-5 sm:p-6" aria-labelledby="codex-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1"><h2 id="codex-title" className="text-section font-semibold">Codex</h2><p className="text-xs text-muted-foreground">通过 MCP 使用工作台中已连接的服务器、数据库和缓存。</p></div>
        <Badge variant="outline" data-testid="codex-status">{state ? labels[state.status] : error ? "检测失败" : "正在检测"}</Badge>
      </div>
      <p className="text-sm leading-6" role="status">{state?.message ?? (error ? "检测未完成，可重新检测。" : "正在读取本机 Codex 配置…")}</p>
      {state ? <div className="space-y-1 text-xs"><p className="text-muted-foreground">用户级配置文件</p><p className="break-all font-mono" data-testid="codex-config-path">{state.configPath}</p></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || state?.status !== "available" || !state.approvalId} data-testid="codex-install" onClick={() => void run("install")}>
          {busy ? <SpinnerGap className="animate-spin" /> : state?.status === "configured" ? <CheckCircle /> : <PlugsConnected />}{state?.status === "configured" ? "已完成配置" : "一键接入 Codex"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} data-testid="codex-refresh" onClick={() => void run("status")}><ArrowClockwise />重新检测</Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">点击接入会添加 agent-ops 配置，并在修改已有文件前创建备份。接入后请保持工作台运行，并连接需要使用的插件。</p>
    </section>
    {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="rounded-md border bg-card p-3 text-sm" data-testid="codex-notice">{notice}</p> : null}
    {state?.backupPath ? <p className="break-all text-xs leading-5 text-muted-foreground">原配置备份：{state.backupPath}</p> : null}
    <p className="text-xs leading-5 text-muted-foreground">仅管理当前系统用户的 Codex 配置。项目级配置可能覆盖此设置；WSL 或远程主机上的 Codex 需要在对应环境中单独配置。</p>
    {state ? <details className="rounded-lg border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">手动配置</summary>
      <div className="mt-4 space-y-3"><p className="text-xs leading-5 text-muted-foreground">将以下内容合并到上方配置文件；如果已有 agent-ops 条目，请先核对现有配置。</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-5" tabIndex={0} aria-label="Codex MCP 配置">{state.configSnippet}</pre>
        <Button size="sm" variant="outline" disabled={busy} data-testid="codex-copy" onClick={() => void run("copy")}><Copy />复制配置</Button>
      </div>
    </details> : null}
  </div>
}
