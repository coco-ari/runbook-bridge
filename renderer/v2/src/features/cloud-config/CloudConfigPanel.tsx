import { useEffect, useState } from "react"
import { ArrowClockwise, ClockCounterClockwise, Copy, DownloadSimple, LinkBreak, Plus, SpinnerGap, WarningCircle } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useCloudConfig } from "./CloudConfigProvider"
import { CloudProjectActions, CloudProjectIcon, cloudStatusLabels } from "./CloudProjectActions"
import type { CloudConfigData } from "./cloud-types"

const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("")

export function CloudConfigPanel({ onBusyChange }: { api: AiOpsV2Api; onChanged: () => void; onBusyChange: (busy: boolean) => void }) {
  const cloud = useCloudConfig()
  const repositories = cloud.data.repositories ?? []
  const [repositoryId, setRepositoryId] = useState("")
  const repository = repositories.find(repo => repo.repositoryId === repositoryId) ?? repositories[0]
  const [view, setView] = useState<"projects" | "repository" | "backups">("projects")
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [password, setPassword] = useState("")
  const [adminToken, setAdminToken] = useState("")
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [query, setQuery] = useState("")
  const [history, setHistory] = useState<CloudConfigData | null>(null)
  const [snapshotId, setSnapshotId] = useState("")
  const projects = (cloud.data.cloudProjects ?? []).filter(p => p.repositoryId === repository?.repositoryId)
  const visible = projects.filter(p => p.name.normalize("NFKC").toLowerCase().includes(query.normalize("NFKC").toLowerCase().trim()))
  useEffect(() => { onBusyChange(cloud.busy); return () => onBusyChange(false) }, [cloud.busy, onBusyChange])
  const changeRepository = (id: string) => { setRepositoryId(id); setQuery(""); setHistory(null); setSnapshotId("") }
  const beginBind = (existing = false) => {
    setView("projects"); setAdding(true); setCreating(false); setName(existing ? repository?.name ?? "" : ""); setUrl(existing ? repository?.url ?? "" : "")
    setPassword(""); setAdminToken(""); setShowPassword(false)
  }
  const bind = async () => {
    const common = { password, remember, ...(name.trim() ? { name: name.trim() } : {}) }
    const result = await cloud.run(creating ? { action: "create", serviceUrl: url, adminToken, ...common } : { action: "bind", url, ...common })
    if (result) { setAdding(false); setPassword(""); setAdminToken(""); setShowPassword(false); changeRepository(result.repositoryId ?? ""); setView("projects") }
  }
  const showAll = (show: boolean) => { if (repository) void cloud.run({ action: "visibility", repositoryId: repository.repositoryId, projectIds: projects.map(p => p.projectId), visible: show }) }
  if (cloud.loading) return <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><SpinnerGap className="animate-spin" />正在读取云配置…</div>
  return <div className="@container/cloud-config flex min-h-0 flex-1 flex-col gap-3 text-sm" data-testid="cloud-config-panel" aria-busy={cloud.busy}>
    {cloud.error ? <p role="alert" className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><WarningCircle className="shrink-0" />{cloud.error}</p> : null}
    {(adding || !repositories.length) && view !== "backups" ? <div className="min-h-0 flex-1 overflow-y-auto">
      <Card size="sm" className="max-w-xl"><CardHeader><CardTitle>{creating ? "创建云仓库" : "关联云仓库"}</CardTitle><CardAction><Button size="xs" variant="ghost" data-testid="cloud-view-backups" onClick={() => setView("backups")}>本机备份</Button></CardAction></CardHeader><CardContent>
        <form onSubmit={event => { event.preventDefault(); void bind() }}>
          <fieldset disabled={cloud.busy} className="grid gap-4">
            <label className="grid gap-1.5 text-xs">仓库名称<Input id="cloud-name" value={name} maxLength={80} placeholder="可选，例如工作仓库" onChange={event => setName(event.target.value)} /></label>
            <label className="grid gap-1.5 text-xs">{creating ? "云服务地址" : "仓库链接"}<Input id="cloud-url" autoComplete="off" required value={url} onChange={event => setUrl(event.target.value)} /></label>
            {url.toLowerCase().startsWith("http:") ? <p className="text-xs text-warning">HTTP 仅用于可信内网。配置内容仍加密，但仓库访问凭证会明文传输。</p> : null}
            {creating ? <label className="grid gap-1.5 text-xs">部署管理员令牌<Input id="cloud-admin-token" type="password" autoComplete="off" required value={adminToken} onChange={event => setAdminToken(event.target.value)} /></label> : null}
            <label className="grid gap-1.5 text-xs">仓库密码<Input id="cloud-password" type={showPassword ? "text" : "password"} autoComplete="off" minLength={16} required value={password} placeholder="至少 16 个字符" onChange={event => setPassword(event.target.value)} /></label>
            <div className="flex flex-wrap gap-4 text-xs"><label className="flex items-center gap-2"><Checkbox checked={remember} onCheckedChange={checked => setRemember(checked === true)} />在本机记住</label><label className="flex items-center gap-2"><Checkbox checked={showPassword} onCheckedChange={checked => setShowPassword(checked === true)} />显示密码</label></div>
            {creating ? <p className="text-xs text-muted-foreground">请保存仓库密码，服务端无法找回。<Button type="button" size="xs" variant="ghost" onClick={() => { setPassword(randomPassword()); setShowPassword(true) }}>生成随机密码</Button></p> : null}
            <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={!url.trim() || password.length < 16 || (creating && !adminToken)}>{creating ? "创建仓库" : "关联仓库"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setCreating(!creating); setUrl(""); setPassword(creating ? "" : randomPassword()); setAdminToken("") }}>{creating ? "使用已有仓库" : "创建新仓库"}</Button>{repositories.length ? <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setPassword(""); setAdminToken("") }}>取消</Button> : null}</div>
          </fieldset>
        </form>
      </CardContent></Card>
    </div> : <>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {repository ? <SelectControl value={repository.repositoryId ?? ""} onValueChange={changeRepository} aria-label="选择云仓库" disabled={cloud.busy} size="sm" className="max-w-full min-w-40"><>{repositories.map(repo => <SelectItem key={repo.repositoryId} value={repo.repositoryId}>{repo.name}</SelectItem>)}</></SelectControl> : null}
        <Button size="xs" variant="outline" disabled={cloud.busy} data-testid="cloud-add-repository" onClick={() => beginBind()}><Plus />关联仓库</Button>
        <div className="ml-auto flex gap-1" aria-label="云配置栏目">{([["projects", "项目"], ["repository", "仓库设置"], ["backups", "本机备份"]] as const).map(([key, label]) => <Button key={key} size="xs" variant={view === key ? "secondary" : "ghost"} disabled={cloud.busy} aria-current={view === key ? "page" : undefined} data-testid={`cloud-view-${key}`} onClick={() => setView(key)}>{label}</Button>)}</div>
      </div>
      {repository?.error ? <p role="alert" className="shrink-0 text-xs text-warning">{repository.error.message} 当前显示上次读取的项目。</p> : null}
      {repository && !repository.unlocked ? <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><span>仓库尚未解锁</span><Button size="xs" variant="outline" disabled={cloud.busy} onClick={() => beginBind(true)}>解锁仓库</Button></div> : null}
      {view === "projects" ? <>
        <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="cloud-project-toolbar">
          <Input id="cloud-project-search" aria-label="搜索项目" placeholder="搜索项目" className="h-8 min-w-28 flex-1 text-xs" value={query} onChange={event => setQuery(event.target.value)} />
          <Button size="xs" variant="ghost" disabled={cloud.busy || !projects.length} onClick={() => showAll(true)}>全部显示</Button><Button size="xs" variant="ghost" disabled={cloud.busy || !projects.length} onClick={() => showAll(false)}>全部隐藏</Button>
          <Button size="xs" variant="outline" disabled={cloud.busy || cloud.checking} data-testid="cloud-check" onClick={() => void cloud.check(repository?.repositoryId)}><ArrowClockwise className={cloud.checking ? "animate-spin" : undefined} />检测更新</Button>
          <Button size="xs" disabled={cloud.busy || !repository?.unlocked} data-testid="cloud-update-all" onClick={() => { if (repository) void cloud.run({ action: "sync", repositoryId: repository.repositoryId, direction: "download" }) }}><DownloadSimple />更新整个仓库</Button>
        </div>
        <p className="shrink-0 text-xs text-muted-foreground">{projects.length} 个项目 · {projects.filter(p => p.visible).length} 个显示{cloud.checking ? " · 正在检测…" : repository?.checkedAt ? ` · 检测于 ${new Date(repository.checkedAt).toLocaleTimeString()}` : " · 尚未检测"}</p>
        <div className="min-h-0 flex-1 overflow-y-auto p-0.5" data-testid="cloud-project-list">
          <div className="grid grid-cols-1 gap-3 @xl/cloud-config:grid-cols-2 @4xl/cloud-config:grid-cols-3">{visible.map(project => <Card key={project.projectId} size="sm" role="article" aria-label={project.name} data-testid="cloud-project-card" data-project-id={project.projectId}>
            <CardHeader><CardTitle className="flex min-w-0 items-start gap-2"><CloudProjectIcon status={project.syncStatus} /><span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]" title={project.name}>{project.name}</span></CardTitle><CardAction><Switch aria-label={`显示${project.name}`} checked={project.visible} disabled={cloud.busy} onCheckedChange={show => void cloud.run({ action: "visibility", repositoryId: project.repositoryId, projectIds: [project.projectId], visible: show })} /></CardAction></CardHeader>
            <CardContent className="flex-1 space-y-2"><p className="text-xs text-muted-foreground">{project.environmentCount} 个环境 · {project.pluginCount} 个插件</p><Badge variant={project.syncStatus === "modified" ? "warning" : project.syncStatus === "behind" ? "info" : "outline"}>{cloudStatusLabels[project.syncStatus]}</Badge></CardContent>
            <CardFooter className="flex-wrap justify-between gap-2"><span className="min-w-0 truncate text-xs text-muted-foreground">{repository?.name}</span><CloudProjectActions linked={project} elsewhere={false} /></CardFooter>
          </Card>)}</div>
          {!visible.length ? <p className="p-8 text-center text-xs text-muted-foreground">{query ? "没有匹配的项目" : repository?.error ? "项目读取失败，请重新检测" : cloud.checking || !repository?.checkedAt ? "等待读取仓库项目" : "云仓库暂无项目，可从工作台项目详情上传"}</p> : null}
        </div>
      </> : view === "repository" ? <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-0.5">
        <Card size="sm"><CardHeader><CardTitle>仓库设置</CardTitle></CardHeader><CardContent className="space-y-4">
          <label className="grid gap-2 text-xs">仓库链接<Input id="cloud-url" readOnly value={repository?.url ?? ""} /></label>
          <div className="flex flex-wrap items-center gap-2"><Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(repository?.url ?? "")}><Copy />复制链接</Button><Badge variant="outline">{repository?.remembered ? "已在本机记住" : "仅本次会话"}</Badge></div>
          <label className="flex flex-wrap items-center gap-3 text-xs">定时检测<SelectControl value={String(cloud.data.checkIntervalMinutes ?? 15)} onValueChange={value => void cloud.run({ action: "preferences", checkIntervalMinutes: Number(value) })} disabled={cloud.busy} size="sm" aria-label="定时检测间隔">{[0,5,15,30,60].map(value => <SelectItem key={value} value={String(value)}>{value ? `每 ${value} 分钟` : "关闭"}</SelectItem>)}</SelectControl></label>
          <p className="text-xs text-muted-foreground">定时检测只更新图标状态。点击“更新”后才写入本机配置。</p>
          <Button size="xs" variant="ghost" className="text-destructive" disabled={cloud.busy} onClick={() => { if (repository) void cloud.run({ action: "unbind", repositoryId: repository.repositoryId }) }}><LinkBreak />解除绑定</Button><p className="text-xs text-muted-foreground">解除绑定后，已下载项目保留在本地仓库。</p>
        </CardContent></Card>
        <Card size="sm"><CardHeader><CardTitle>历史版本</CardTitle></CardHeader><CardContent className="space-y-3"><Button size="xs" variant="outline" disabled={cloud.busy || !repository?.unlocked} onClick={async () => { if (repository) setHistory(await cloud.run({ action: "catalog", repositoryId: repository.repositoryId })) }}><ClockCounterClockwise />查看版本</Button>
          {history ? <SelectControl value={snapshotId} placeholder="选择历史版本" size="sm" aria-label="历史版本" disabled={cloud.busy} onValueChange={async value => { setSnapshotId(value); if (repository) { const next = await cloud.run({ action: "catalog", repositoryId: repository.repositoryId, snapshotId: value }); if (next) setHistory(next) } }}>{history.versions?.map(version => <SelectItem key={version.snapshotId} value={version.snapshotId}>{new Date(version.createdAt).toLocaleString()}</SelectItem>)}</SelectControl> : null}
          {snapshotId ? history?.projects?.map(project => <div className="flex items-center justify-between gap-2" key={project.projectId}><span className="min-w-0 break-words text-xs">{project.name}</span><Button size="xs" variant="outline" disabled={cloud.busy} onClick={() => { if (repository) void cloud.run({ action: "prepare", repositoryId: repository.repositoryId, direction: "download", projectIds: [project.projectId], snapshotId }) }}>恢复此版本</Button></div>) : null}
        </CardContent></Card>
      </div> : <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-0.5">{cloud.data.backups?.map(backup => <Card key={backup.backupId} size="sm"><CardContent className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-medium">{backup.name}</p><p className="text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</p></div><Button size="xs" variant="outline" disabled={cloud.busy} onClick={() => void cloud.run({ action: "prepareRestore", backupId: backup.backupId })}>恢复备份</Button></CardContent></Card>)}{!cloud.data.backups?.length ? <p className="p-8 text-center text-xs text-muted-foreground">暂无本机备份，覆盖项目配置前会自动保存。</p> : null}</div>}
    </>}
  </div>
}
