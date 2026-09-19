import { useEffect, useRef, useState } from "react"
import { CloudArrowUp, CloudArrowDown, ClockCounterClockwise, Copy, ArrowsClockwise } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import type { CloudConfigData, CloudConfigRequest, CloudProject } from "./cloud-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("")

export function CloudConfigPanel({ api, onChanged, onBusyChange }: { api: AiOpsV2Api; onChanged: () => void; onBusyChange: (busy: boolean) => void }) {
  const [status, setStatus] = useState<CloudConfigData>({})
  const [catalog, setCatalog] = useState<CloudConfigData>({})
  const [url, setUrl] = useState("")
  const [password, setPassword] = useState("")
  const [adminToken, setAdminToken] = useState("")
  const [remember, setRemember] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [direction, setDirection] = useState<"upload" | "download">("download")
  const [selected, setSelected] = useState<string[]>([])
  const [snapshotId, setSnapshotId] = useState("")
  const [plan, setPlan] = useState<CloudConfigData | null>(null)
  const [choices, setChoices] = useState<Record<string, "local" | "cloud">>({})
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const call = async (request: CloudConfigRequest) => {
    const result = await api.cloudConfig(request)
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); onBusyChange(true); setError(""); setNotice("")
    try { await operation() } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "云配置操作失败。") }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); onBusyChange(false) } }
  }
  useEffect(() => {
    mounted.current = true
    void run(async () => {
      const next = await call({ action: "status" })
      if (!mounted.current) return
      setStatus(next); setUrl(next.url ?? ""); setRemember(Boolean(next.remembered))
      if (next.unlocked) setCatalog(await call({ action: "catalog" }))
    })
    return () => { mounted.current = false }
  }, [api])
  const refresh = async () => {
    setStatus(await call({ action: "status" }))
    setCatalog(await call({ action: "catalog", snapshotId: snapshotId || null }))
  }
  const showPlan = (next: CloudConfigData) => {
    setPlan(next)
    setChoices(Object.fromEntries((next.rows ?? []).flatMap(row => row.suggested ? [[row.rowId, row.suggested]] : [])))
  }
  const bind = () => run(async () => {
    const next = await call(creating ? { action: "create", serviceUrl: url, adminToken, password, remember } : { action: "bind", url, password, remember })
    setStatus(next); setUrl(next.url ?? ""); setCreating(false); setPassword(""); setAdminToken(""); setShowPassword(false)
    setCatalog(await call({ action: "catalog" })); setPlan(null); setSelected([]); setSnapshotId("")
    setNotice("仓库已解锁。可以选择项目上传或下载。")
  })
  const projects: readonly CloudProject[] = direction === "upload" ? status.projects ?? [] : catalog.projects ?? []
  return <div className="space-y-5 text-sm" data-testid="cloud-config-panel" aria-busy={busy}>
      {error ? <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">{error}</div> : null}
      {notice ? <div role="status" className="rounded-lg border bg-muted/40 p-3 whitespace-pre-line">{notice}</div> : null}
      <fieldset disabled={busy} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 font-medium">{creating ? "创建仓库" : status.unlocked ? "已连接的仓库" : "连接云仓库"}</legend>
        <label className="grid gap-1.5 text-xs font-medium">{creating ? "云服务地址" : "仓库链接"}<Input id="cloud-url" readOnly={Boolean(status.unlocked && !creating)} autoComplete="off" value={url} onChange={e => { setUrl(e.target.value); setPlan(null) }} placeholder={creating ? "请输入云服务根地址" : "请输入完整的仓库链接"} /></label>
        {url.trim().toLowerCase().startsWith("http:") ? <p className="text-xs text-amber-700 dark:text-amber-400">HTTP 仅用于可信内网。配置内容仍加密，但仓库访问凭证会明文传输。</p> : null}
        {status.unlocked && !creating ? <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(status.url ?? ""); setNotice("已复制仓库链接。") })}><Copy />复制链接</Button>
          <span className="text-xs text-muted-foreground">{status.remembered ? "已在本机安全保存访问凭据" : "仅当前会话解锁"}</span>
          <Button size="sm" variant="ghost" onClick={() => void run(async () => { const next = await call({ action: "unbind" }); setStatus(next); setCatalog({}); setPlan(null); setUrl(""); setSelected([]) })}>解除绑定</Button>
        </div> : <>
          {creating ? <label className="grid gap-1.5 text-xs font-medium">部署管理员令牌<Input id="cloud-admin-token" type="password" autoComplete="off" value={adminToken} onChange={e => setAdminToken(e.target.value)} /></label> : null}
          <label className="grid gap-1.5 text-xs font-medium">仓库密码<Input id="cloud-password" type={showPassword ? "text" : "password"} autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 16 个字符" /></label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />显示密码</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />在本机记住</label>
            {creating ? <Button size="sm" variant="outline" onClick={() => { setPassword(randomPassword()); setShowPassword(true) }}>生成随机密码</Button> : null}
          </div>
          {creating ? <p className="text-xs text-muted-foreground">请保存仓库密码。服务端无法找回密码或解密配置。</p> : null}
          <div className="flex gap-2"><Button onClick={() => void bind()} disabled={!url || [...password].length < 16 || (creating && !adminToken)}>{creating ? "创建仓库" : "解锁仓库"}</Button><Button variant="ghost" onClick={() => { setCreating(!creating); setUrl(""); setPassword(creating ? "" : randomPassword()); setShowPassword(!creating); setAdminToken("") }}>{creating ? "使用已有仓库" : "创建新仓库"}</Button></div>
        </>}
      </fieldset>
      {status.unlocked ? <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={direction === "download" ? "default" : "outline"} disabled={busy} onClick={() => { setDirection("download"); setSelected([]); setPlan(null) }}><CloudArrowDown />下载项目</Button>
          <Button variant={direction === "upload" ? "default" : "outline"} disabled={busy} onClick={() => { setDirection("upload"); setSelected([]); setPlan(null) }}><CloudArrowUp />上传项目</Button>
          <Button size="icon" variant="ghost" aria-label="刷新云配置" disabled={busy} onClick={() => void run(async () => { await refresh(); setPlan(null); setSelected([]) })}><ArrowsClockwise /></Button>
        </div>
        {direction === "download" ? <label className="flex flex-wrap items-center gap-2 text-xs">云端版本<select aria-label="云端版本" className="max-w-full rounded-md border bg-background p-2" disabled={busy} value={snapshotId} onChange={e => { const id = e.target.value; setSnapshotId(id); setSelected([]); setPlan(null); void run(async () => setCatalog(await call({ action: "catalog", snapshotId: id || null }))) }}><option value="">最新版本</option>{(catalog.versions ?? []).map(v => <option key={v.snapshotId} value={v.snapshotId}>{new Date(v.createdAt).toLocaleString()} · {Math.ceil(v.bytes / 1024)} KiB</option>)}</select></label> : null}
        <div className="max-h-48 overflow-y-auto rounded-lg border divide-y">
          {projects.length ? projects.map(project => <label key={project.projectId} className="flex cursor-pointer items-start gap-3 p-3"><input className="mt-0.5" type="checkbox" disabled={busy} checked={selected.includes(project.projectId)} onChange={e => { setPlan(null); setSelected(current => e.target.checked ? [...current, project.projectId] : current.filter(id => id !== project.projectId)) }} /><span className="min-w-0"><span className="block font-medium">{project.name}</span><span className="text-xs text-muted-foreground">{(project.warnings ?? []).length ? `${project.warnings?.length} 项连接前检查，将在预览中列出` : "包含此项目的环境、插件、运维说明和已保存凭据"}</span></span></label>) : <p className="p-4 text-sm text-muted-foreground">{direction === "download" ? "仓库还没有项目，请先从本机上传。" : "本机还没有可上传项目。"}</p>}
        </div>
        <div className="flex items-center justify-between"><Button variant="ghost" size="sm" disabled={busy || !projects.length} onClick={() => { setSelected(selected.length === projects.length ? [] : projects.map(p => p.projectId)); setPlan(null) }}>{selected.length === projects.length && projects.length ? "取消全选" : "全选"}</Button><Button disabled={busy || !selected.length} onClick={() => void run(async () => showPlan(await call({ action: "prepare", direction, projectIds: selected, snapshotId: direction === "download" ? snapshotId || null : null })))}>预览{direction === "upload" ? "上传" : "下载"}（{selected.length}）</Button></div>
      </section> : null}
      {plan ? <section className="space-y-3 rounded-lg border p-4" aria-label="同步预览">
        <h3 className="font-medium">{plan.direction === "restore" ? "本地备份恢复预览" : "同步预览"}</h3>
        {(plan.rows ?? []).map(row => <div key={row.rowId} className="space-y-2 border-b pb-3 last:border-0">
          <div className="font-medium">{row.name}{row.conflict ? <span className="ml-2 text-xs text-amber-600">需要选择保留哪份配置</span> : null}</div>
          <p className="text-xs text-muted-foreground">插件新增 {row.diff.added}、修改 {row.diff.modified}、删除 {row.diff.removed}；环境新增 {row.diff.environmentsAdded}、删除 {row.diff.environmentsRemoved}{row.diff.credentialsChanged ? "；凭据有变更" : ""}{!row.diff.contentChanged ? "；内容一致" : ""}。</p>
          {row.diff.metadataChanged || row.diff.runbooksChanged || row.diff.questionsChanged ? <p className="text-xs text-muted-foreground">{row.diff.metadataChanged ? "项目或环境名称、顺序有变更；" : ""}运维说明变更 {row.diff.runbooksChanged ?? 0} 项；快捷提问变更 {row.diff.questionsChanged ?? 0} 项。</p> : null}
          {row.willDisconnect ? <p className="text-xs">采用{plan.direction === "restore" ? "备份" : "云端"}前会断开此项目的连接，并保存本机加密备份；完成后请手动连接。</p> : null}
          {row.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>)}
          <div className="flex gap-4 text-xs">{(["local", "cloud"] as const).map(choice => <label key={choice} className="flex items-center gap-2"><input type="radio" name={`cloud-choice-${row.rowId}`} disabled={busy} checked={choices[row.rowId] === choice} onChange={() => setChoices(current => ({ ...current, [row.rowId]: choice }))} />{choice === "local" ? (plan.direction === "upload" ? "采用本地并上传" : "保留本地") : (plan.direction === "upload" ? "保留云端" : plan.direction === "restore" ? "采用备份" : "采用云端")}</label>)}</div>
        </div>)}
        <Button disabled={busy || !(plan.rows ?? []).every(row => choices[row.rowId])} onClick={() => void run(async () => {
          const current = plan
          setPlan(null)
          const result = await call({ action: "confirm", planId: current.planId!, choices })
          const items = result.results ?? []
          setNotice(`已完成 ${items.filter(i => ["imported", "uploaded"].includes(i.status)).length} 个项目，保留 ${items.filter(i => i.status === "skipped").length} 个，失败 ${items.filter(i => i.status === "failed").length} 个。` + items.filter(i => i.error).map(i => `\n${i.error?.message}（${i.error?.code}）`).join("") + (result.syncStateWarning || items.some(i => i.syncStateWarning) ? "\n数据已完成，但同步关联保存失败，下次请核对预览。" : "") + (items.some(i => i.cleanupPending) ? "\n事务清理尚未完成，请重启应用完成恢复。" : ""))
          onChanged(); setStatus(await call({ action: "status" })); setSelected([])
          if (status.unlocked) setCatalog(await call({ action: "catalog", snapshotId: snapshotId || null }))
        })}>确认{plan.direction === "upload" ? "上传" : plan.direction === "restore" ? "恢复" : "导入"}</Button>
      </section> : null}
      {(status.backups ?? []).length ? <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">本地加密备份（{status.backups?.length}）</summary><div className="mt-3 max-h-40 space-y-2 overflow-y-auto">{status.backups?.map(backup => <div key={backup.backupId} className="flex items-center justify-between gap-3 text-xs"><span>{backup.name} · {new Date(backup.createdAt).toLocaleString()}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => showPlan(await call({ action: "prepareRestore", backupId: backup.backupId })))}><ClockCounterClockwise />预览恢复</Button></div>)}</div></details> : null}
      {busy ? <p role="status" className="text-xs text-muted-foreground">正在处理，请稍候…</p> : null}
  </div>
}
