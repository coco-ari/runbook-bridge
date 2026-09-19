import { ArrowRight, ArrowsClockwise, Check, CloudArrowDown, CloudArrowUp, FolderSimple, MagnifyingGlass, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { CloudProject, CloudVersion } from "./cloud-types"

interface CloudProjectPickerProps {
  readonly busy: boolean
  readonly loading: boolean
  readonly loadError: boolean
  readonly direction: "upload" | "download"
  readonly projects: readonly CloudProject[]
  readonly selected: readonly string[]
  readonly query: string
  readonly snapshotId: string
  readonly versions: readonly CloudVersion[]
  readonly onDirectionChange: (direction: "upload" | "download") => void
  readonly onQueryChange: (query: string) => void
  readonly onSelectionChange: (selected: string[]) => void
  readonly onSnapshotChange: (id: string) => void
  readonly onRefresh: () => void
  readonly onPreview: () => void
}

export function CloudProjectPicker({ busy, loading, loadError, direction, projects, selected, query, snapshotId, versions, onDirectionChange, onQueryChange, onSelectionChange, onSnapshotChange, onRefresh, onPreview }: CloudProjectPickerProps) {
  const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase()
  const visible = projects.filter(project => project.name.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery))
  const selectedIds = new Set(selected)
  const visibleIds = new Set(visible.map(project => project.projectId))
  const allVisibleSelected = visible.length > 0 && visible.every(project => selectedIds.has(project.projectId))
  const hiddenSelected = selected.filter(id => !visibleIds.has(id)).length
  const download = direction === "download"
  const toggleVisible = () => onSelectionChange(allVisibleSelected
    ? selected.filter(id => !visibleIds.has(id))
    : [...new Set([...selected, ...visible.map(project => project.projectId)])])
  const clearSearch = () => {
    onQueryChange("")
    requestAnimationFrame(() => document.getElementById("cloud-project-search")?.focus())
  }

  return <section className="space-y-4" aria-label="项目同步">
    <div className="grid grid-cols-2 gap-2 sm:gap-3" aria-label="同步方向">
      {(["download", "upload"] as const).map(value => {
        const active = direction === value
        const Icon = value === "download" ? CloudArrowDown : CloudArrowUp
        return <button key={value} type="button" disabled={busy} aria-pressed={active} aria-label={value === "download" ? "下载项目" : "上传项目"} data-testid={`cloud-direction-${value}`} onClick={() => { if (!active) onDirectionChange(value) }}
          className={cn("flex min-w-0 items-center gap-2 rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60 sm:gap-3 sm:p-4", active ? "border-primary/60 bg-primary/5 ring-1 ring-primary/15" : "hover:border-primary/30 hover:bg-surface-hover")}>
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg sm:size-10", active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}><Icon size={22} aria-hidden="true" /></span>
          <span className="min-w-0 flex-1 space-y-1"><span className="block font-medium">{value === "download" ? "下载项目" : "上传项目"}</span><span className="block text-xs text-muted-foreground">{value === "download" ? "云端 → 本机" : "本机 → 云端"}</span></span>
          <span className={cn("hidden size-5 shrink-0 place-items-center rounded-full border sm:grid", active ? "border-primary bg-primary text-primary-foreground" : "border-border")} aria-hidden="true">{active ? <Check size={12} weight="bold" /> : null}</span>
        </button>
      })}
    </div>

    <div className="relative rounded-xl border bg-card shadow-sm">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2"><h2 className="font-semibold outline-none" id="cloud-project-selection" tabIndex={-1}>选择{download ? "云端" : "本机"}项目</h2>{!loading && !loadError ? <Badge variant="outline">{projects.length}</Badge> : null}</div>
            <p className="text-xs leading-5 text-muted-foreground">{download ? "下载到当前电脑，预览后再确认导入。" : "保存到云仓库，供其他电脑下载使用。"}</p>
          </div>
          <div className="flex max-w-full items-center gap-2">
            {download ? <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">云端版本</span><select aria-label="云端版本" disabled={busy} value={snapshotId} onChange={e => onSnapshotChange(e.target.value)} className="h-8 min-w-0 max-w-52 rounded-md border bg-card px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <option value="">最新版本</option>{versions.map(version => <option key={version.snapshotId} value={version.snapshotId}>{new Date(version.createdAt).toLocaleString()} · {Math.ceil(version.bytes / 1024)} KiB</option>)}
            </select></label> : null}
            <Button size="icon-sm" variant="ghost" aria-label="刷新云配置" title="刷新项目列表" disabled={busy} onClick={onRefresh}><ArrowsClockwise aria-hidden="true" className={busy ? "motion-safe:animate-spin" : undefined} size={16} /></Button>
          </div>
        </div>
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" size={16} aria-hidden="true" />
          <Input id="cloud-project-search" data-testid="cloud-project-search" aria-label="搜索项目" aria-describedby="cloud-search-summary" className="h-9 pr-10 pl-9" placeholder="搜索项目名称…" disabled={busy || loadError} value={query} onChange={e => onQueryChange(e.target.value)} />
          {query ? <Button className="absolute top-0.5 right-1" variant="ghost" size="icon-sm" aria-label="清除搜索" disabled={busy} onClick={clearSearch}><X size={14} aria-hidden="true" /></Button> : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" id="cloud-search-summary" role="status">{loading ? "正在读取项目…" : loadError ? "未能获取项目列表" : normalizedQuery ? `找到 ${visible.length} 个项目，共 ${projects.length} 个` : `共 ${projects.length} 个项目`}</p>
          <Button size="xs" variant="ghost" className="h-6 text-xs" disabled={busy || loadError || !visible.length} onClick={toggleVisible}>{allVisibleSelected ? normalizedQuery ? "取消匹配选择" : "取消全选" : normalizedQuery ? "全选匹配项目" : "全选"}</Button>
        </div>
      </div>

      <div className="border-t" data-testid="cloud-project-list">
        {loading || loadError ? <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-5 text-center">
          {loading ? <SpinnerGap size={24} className="text-primary motion-safe:animate-spin" aria-hidden="true" /> : <WarningCircle size={24} className="text-warning" aria-hidden="true" />}
          <p className="font-medium">{loading ? "正在读取项目…" : "项目读取失败"}</p><p className="text-xs text-muted-foreground">{loading ? "正在获取所选云端版本，请稍候。" : "请检查仓库连接后重新读取，现有项目不会被修改。"}</p>
          {loadError ? <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}><ArrowsClockwise />重新读取</Button> : null}
        </div> : visible.length ? <div className="divide-y">{visible.map(project => {
          const checked = selectedIds.has(project.projectId)
          return <label key={project.projectId} data-testid="cloud-project-row" data-project-id={project.projectId} className={cn("flex cursor-pointer items-center gap-3 px-4 py-4 transition-colors focus-within:bg-primary/5 sm:px-5", checked ? "bg-primary/5" : "hover:bg-surface-hover", busy && "cursor-wait opacity-60")}>
            <input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={busy} checked={checked} onChange={e => onSelectionChange(e.target.checked ? [...selected, project.projectId] : selected.filter(id => id !== project.projectId))} />
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", checked ? "bg-primary/10 text-primary" : "bg-muted/80 text-muted-foreground")}><FolderSimple size={19} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1 space-y-1"><span className="block text-sm font-medium [overflow-wrap:anywhere]">{project.name}</span>{project.warnings?.length ? <span className="flex items-center gap-1 text-xs text-warning"><WarningCircle size={13} aria-hidden="true" />{project.warnings.length} 项连接前检查，预览时查看</span> : null}</span>
            {checked ? <Check size={16} className="shrink-0 text-primary" aria-hidden="true" /> : null}
          </label>
        })}</div> : <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">{normalizedQuery ? <MagnifyingGlass size={24} /> : download ? <CloudArrowDown size={24} /> : <FolderSimple size={24} />}</span>
          <div className="space-y-1.5"><p className="font-medium">{normalizedQuery ? "没有找到匹配项目" : download ? "云仓库还没有项目" : "本机还没有项目"}</p><p className="max-w-sm text-xs leading-5 text-muted-foreground">{normalizedQuery ? "换个关键词试试，已选择的项目仍会保留。" : download ? "先将本机项目上传到云仓库，再到其他电脑下载。" : "返回工作台创建项目后，就可以在这里上传。"}</p></div>
          {normalizedQuery ? <Button size="sm" variant="outline" onClick={clearSearch}>清除搜索</Button> : download ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onDirectionChange("upload")}>去上传项目<ArrowRight /></Button> : null}
        </div>}
      </div>

      <div className="z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-card/95 px-4 py-4 backdrop-blur-sm sm:sticky sm:bottom-0 sm:px-5">
        <div className="space-y-1" data-testid="cloud-selection-summary" role="status"><p className="text-sm">已选择 <strong className="font-semibold text-primary">{selected.length}</strong> 个项目{hiddenSelected ? <span className="text-xs text-muted-foreground">（{hiddenSelected} 个不在当前搜索结果中）</span> : null}</p><p className="text-xs text-muted-foreground">{selected.length ? "下一步查看变更，确认后才会同步。" : "勾选需要同步的项目后继续。"}</p></div>
        <Button className="ml-auto" disabled={busy || loadError || !selected.length} data-testid="cloud-preview" aria-label={`预览${download ? "下载" : "上传"}（${selected.length}）`} onClick={onPreview}>预览{download ? "下载" : "上传"}<ArrowRight aria-hidden="true" /></Button>
      </div>
    </div>
    <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"><FolderSimple size={14} className="mt-0.5 shrink-0" aria-hidden="true" />每个项目包含环境、插件、运维说明和已保存的凭据。</p>
  </section>
}
