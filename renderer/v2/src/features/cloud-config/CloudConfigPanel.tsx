import { useEffect, useRef, useState } from "react"
import { CaretDown, CheckCircle, ClockCounterClockwise, Cloud, Copy, Info, LinkBreak, LockKey, ShieldCheck, SpinnerGap, WarningCircle } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CloudProjectPicker } from "./CloudProjectPicker"
import { CloudSyncPreview } from "./CloudSyncPreview"
import type { CloudConfigData, CloudConfigRequest, CloudProject } from "./cloud-types"

const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("")

function repositoryHost(url: string) {
  try { return new URL(url).host } catch { return "云配置仓库" }
}

function HttpNotice({ url }: { readonly url: string }) {
  return url.trim().toLowerCase().startsWith("http:") ? <p className="flex items-start gap-2 text-xs leading-5 text-warning">
    <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
    <span>HTTP 仅用于可信内网。配置内容仍加密，但仓库访问凭证会明文传输。</span>
  </p> : null
}

export function CloudConfigPanel({ api, onChanged, onBusyChange }: { api: AiOpsV2Api; onChanged: () => void; onBusyChange: (busy: boolean) => void }) {
  const [status, setStatus] = useState<CloudConfigData>({})
  const [catalog, setCatalog] = useState<CloudConfigData>({})
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading")
  const [url, setUrl] = useState("")
  const [password, setPassword] = useState("")
  const [adminToken, setAdminToken] = useState("")
  const [remember, setRemember] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [busy, setBusy] = useState(true)
  const [busyLabel, setBusyLabel] = useState("正在加载云仓库…")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [direction, setDirection] = useState<"upload" | "download">("download")
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [snapshotId, setSnapshotId] = useState("")
  const [plan, setPlan] = useState<CloudConfigData | null>(null)
  const [choices, setChoices] = useState<Record<string, "local" | "cloud">>({})
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const backupReturnFocusRef = useRef<HTMLButtonElement | null>(null)

  const call = async (request: CloudConfigRequest) => {
    const result = await api.cloudConfig(request)
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }
  const run = async (operation: () => Promise<void>, label = "正在处理，请稍候…") => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); onBusyChange(true); setBusyLabel(label); setError(""); setNotice("")
    try { await operation() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "云配置操作失败。") }
    finally {
      busyRef.current = false
      if (mounted.current) { setBusy(false); onBusyChange(false) }
    }
  }
  const loadCatalog = async (id = "") => {
    setCatalogState("loading")
    try {
      const next = await call({ action: "catalog", snapshotId: id || null })
      if (mounted.current) { setCatalog(next); setCatalogState("ready") }
    } catch (cause) { if (mounted.current) setCatalogState("error"); throw cause }
  }
  useEffect(() => {
    mounted.current = true
    void run(async () => {
      try {
        const next = await call({ action: "status" })
        if (!mounted.current) return
        setStatus(next); setUrl(next.url ?? ""); setRemember(Boolean(next.remembered))
        if (next.unlocked) await loadCatalog()
      } finally { if (mounted.current) setInitializing(false) }
    }, "正在加载云仓库…")
    return () => { mounted.current = false }
  }, [api])

  const clearPlan = () => { setPlan(null); setChoices({}) }
  const resetSelection = () => { clearPlan(); setSelected([]); setQuery("") }
  const showPlan = (next: CloudConfigData) => {
    setPlan(next)
    setChoices(Object.fromEntries((next.rows ?? []).flatMap(row => row.suggested ? [[row.rowId, row.suggested]] : [])))
  }
  const returnToSelection = () => {
    const restoring = plan?.direction === "restore"
    clearPlan()
    requestAnimationFrame(() => {
      if (restoring) {
        const backups = document.querySelector<HTMLDetailsElement>('[data-testid="cloud-backups"]')
        if (backups) backups.open = true
        const target = backupReturnFocusRef.current
        if (target?.isConnected) target.focus()
        else backups?.querySelector("summary")?.focus()
      } else document.getElementById("cloud-project-selection")?.focus()
    })
  }
  const changeDirection = (next: "upload" | "download") => {
    setDirection(next); resetSelection(); setNotice(""); setError("")
  }
  const refresh = () => {
    resetSelection()
    void run(async () => {
      const next = await call({ action: "status" })
      setStatus(next); setUrl(next.url ?? "")
      if (next.unlocked) await loadCatalog(snapshotId)
      else { setCatalog({}); setCatalogState("ready") }
    }, "正在刷新项目列表…")
  }
  const changeSnapshot = (id: string) => {
    setSnapshotId(id); resetSelection(); setCatalog(current => ({ ...current, projects: [] }))
    void run(async () => loadCatalog(id), "正在读取所选版本…")
  }
  const bind = () => run(async () => {
    const next = await call(creating ? { action: "create", serviceUrl: url, adminToken, password, remember } : { action: "bind", url, password, remember })
    setStatus(next); setUrl(next.url ?? ""); setCreating(false); setPassword(""); setAdminToken(""); setShowPassword(false)
    resetSelection(); setSnapshotId(""); await loadCatalog()
    setNotice("仓库已解锁。选择要上传或下载的项目，即可开始同步。")
  }, creating ? "正在创建云仓库…" : "正在解锁云仓库…")
  const unbind = () => run(async () => {
    const next = await call({ action: "unbind" })
    setStatus(next); setCatalog({}); setUrl(""); resetSelection(); setSnapshotId("")
    setPassword(""); setAdminToken(""); setShowPassword(false); setRemember(false)
    setNotice("已解除本机绑定，云端项目仍会保留。")
  })
  const confirm = () => {
    if (!plan) return
    const current = plan
    void run(async () => {
      // Confirmations are single-use, including failed attempts. A retry needs a new preview.
      clearPlan()
      const result = await call({ action: "confirm", planId: current.planId!, choices })
      const items = result.results ?? []
      setNotice("已完成 " + items.filter(i => ["imported", "uploaded"].includes(i.status)).length + " 个项目，保留 " + items.filter(i => i.status === "skipped").length + " 个，失败 " + items.filter(i => i.status === "failed").length + " 个。"
        + items.filter(i => i.error).map(i => "\n" + i.error?.message + "（" + i.error?.code + "）").join("")
        + (result.syncStateWarning || items.some(i => i.syncStateWarning) ? "\n数据已完成，但同步关联保存失败，下次请核对预览。" : "")
        + (items.some(i => i.cleanupPending) ? "\n事务清理尚未完成，请重启应用完成恢复。" : ""))
      onChanged(); setSelected([]); setQuery("")
      const next = await call({ action: "status" })
      setStatus(next)
      if (next.unlocked) await loadCatalog(snapshotId)
    }, current.direction === "upload" ? "正在上传项目…" : current.direction === "restore" ? "正在恢复本地备份…" : "正在导入项目…")
  }
  const projects: readonly CloudProject[] = direction === "upload" ? status.projects ?? [] : catalog.projects ?? []

  return <div className="space-y-5 text-sm" data-testid="cloud-config-panel" aria-busy={busy}>
    {error ? <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive"><WarningCircle className="mt-0.5 shrink-0" size={18} aria-hidden="true" /><p className="min-w-0 break-words leading-6">{error}</p></div> : null}
    {notice ? <div role="status" className="flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/5 p-4"><Info className="mt-0.5 shrink-0 text-primary" size={18} aria-hidden="true" /><p className="min-w-0 break-words whitespace-pre-line text-xs leading-6">{notice}</p></div> : null}

    <fieldset disabled={busy} className="min-w-0 rounded-xl border bg-card shadow-sm" aria-label="云仓库">
      {initializing ? <div className="flex items-center gap-3 p-5 text-muted-foreground"><SpinnerGap className="motion-safe:animate-spin" size={20} aria-hidden="true" /><span>正在加载云仓库…</span></div>
        : status.unlocked ? <>
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-success/10 text-success"><Cloud size={24} weight="duotone" aria-hidden="true" /></span>
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">云配置仓库</h2><Badge variant="success"><CheckCircle size={12} aria-hidden="true" />已解锁</Badge></div>
                <p className="break-all text-xs text-muted-foreground" data-testid="cloud-repository-host">{repositoryHost(url)}<span className="mx-2 text-border" aria-hidden="true">·</span>{status.remembered ? "已在本机记住" : "仅本次会话"}</p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(status.url ?? ""); setNotice("已复制仓库链接。") })}><Copy size={15} aria-hidden="true" />复制链接</Button>
          </div>
          <div className="space-y-3 border-t px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck size={15} aria-hidden="true" />配置与凭据均加密保存</p>
              <details className="group min-w-0 open:basis-full" data-testid="cloud-repository-details">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">仓库设置<CaretDown className="transition-transform group-open:rotate-180" size={12} aria-hidden="true" /></summary>
                <div className="mt-3 space-y-3 rounded-lg bg-muted/40 p-3">
                  <label className="grid gap-2 text-xs font-medium">仓库链接<Input id="cloud-url" readOnly autoComplete="off" value={url} /></label>
                  <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">解除绑定只移除本机访问，不会删除云端项目。</p><Button size="sm" variant="ghost" className="text-destructive" onClick={() => void unbind()}><LinkBreak size={15} aria-hidden="true" />解除绑定</Button></div>
                </div>
              </details>
            </div>
            <HttpNotice url={url} />
          </div>
        </> : <div className="space-y-5 p-5 sm:p-6">
          <div className="flex items-start gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><LockKey size={22} aria-hidden="true" /></span><div className="space-y-1.5"><h2 className="font-semibold">{creating ? "创建云仓库" : "连接云仓库"}</h2><p className="text-xs leading-5 text-muted-foreground">{creating ? "创建一个属于你的加密仓库，用于多台电脑同步。" : "输入仓库链接和密码，将项目配置带到这台电脑。"}</p></div></div>
          <div className="grid gap-4">
            <label className="grid gap-2 text-xs font-medium">{creating ? "云服务地址" : "仓库链接"}<Input id="cloud-url" autoComplete="off" value={url} onChange={e => { setUrl(e.target.value); clearPlan() }} placeholder={creating ? "请输入云服务根地址" : "粘贴完整的仓库链接"} /></label>
            <HttpNotice url={url} />
            {creating ? <label className="grid gap-2 text-xs font-medium">部署管理员令牌<Input id="cloud-admin-token" type="password" autoComplete="off" value={adminToken} onChange={e => setAdminToken(e.target.value)} /></label> : null}
            <label className="grid gap-2 text-xs font-medium">仓库密码<Input id="cloud-password" type={showPassword ? "text" : "password"} autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 16 个字符" /></label>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <label className="flex items-center gap-2 text-xs"><input className="size-3.5 accent-primary" type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />显示密码</label>
              <label className="flex items-center gap-2 text-xs"><input className="size-3.5 accent-primary" type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />在本机记住</label>
              {creating ? <Button size="sm" variant="outline" onClick={() => { setPassword(randomPassword()); setShowPassword(true) }}>生成随机密码</Button> : null}
            </div>
          </div>
          {creating ? <p className="rounded-lg bg-warning/5 p-3 text-xs leading-5 text-warning">请妥善保存仓库密码。服务端无法找回密码或解密配置。</p> : null}
          <div className="flex flex-wrap gap-2 border-t pt-4"><Button onClick={() => void bind()} disabled={!url.trim() || [...password].length < 16 || (creating && !adminToken)}>{creating ? "创建仓库" : "解锁仓库"}</Button><Button variant="ghost" onClick={() => { setCreating(!creating); setUrl(""); setPassword(creating ? "" : randomPassword()); setShowPassword(!creating); setAdminToken(""); setError(""); setNotice("") }}>{creating ? "使用已有仓库" : "创建新仓库"}</Button></div>
        </div>}
    </fieldset>

    {busy ? <p role="status" className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><SpinnerGap className="motion-safe:animate-spin" size={16} aria-hidden="true" />{busyLabel}</p> : null}

    {plan ? <CloudSyncPreview plan={plan} choices={choices} busy={busy} onChoice={(rowId, choice) => setChoices(current => ({ ...current, [rowId]: choice }))} onBack={returnToSelection} onConfirm={confirm} />
      : status.unlocked ? <CloudProjectPicker
        busy={busy} loading={direction === "download" && catalogState === "loading"} loadError={direction === "download" && catalogState === "error"} direction={direction} projects={projects} selected={selected} query={query} snapshotId={snapshotId} versions={catalog.versions ?? []}
        onDirectionChange={changeDirection} onQueryChange={setQuery} onSelectionChange={next => { clearPlan(); setSelected(next) }} onSnapshotChange={changeSnapshot} onRefresh={refresh}
        onPreview={() => void run(async () => showPlan(await call({ action: "prepare", direction, projectIds: selected, snapshotId: direction === "download" ? snapshotId || null : null })), "正在生成同步预览…")}
      /> : null}

    {(status.backups ?? []).length ? <details className="group rounded-xl border bg-card" data-testid="cloud-backups">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"><ClockCounterClockwise size={19} aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">本地加密备份（{status.backups?.length}）</span><span className="mt-1 block text-xs text-muted-foreground">导入前自动保存，可预览并恢复之前的配置。</span></span><CaretDown className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" size={14} aria-hidden="true" /></summary>
      <div className="divide-y border-t">{status.backups?.map(backup => <div key={backup.backupId} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0 space-y-1"><p className="break-words text-sm font-medium">{backup.name}</p><p className="text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={event => { backupReturnFocusRef.current = event.currentTarget; void run(async () => showPlan(await call({ action: "prepareRestore", backupId: backup.backupId })), "正在生成恢复预览…") }}><ClockCounterClockwise size={14} aria-hidden="true" />预览恢复</Button></div>)}</div>
    </details> : null}
  </div>
}
