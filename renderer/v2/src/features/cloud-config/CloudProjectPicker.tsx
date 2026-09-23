import { Checkbox } from "@/components/ui/checkbox"
import { SelectControl, SelectItem } from "@/components/ui/select"
import { useEffect, useRef, useState } from "react"
import { ArrowRight, ArrowsClockwise, CloudArrowDown, CloudArrowUp, FolderSimple, MagnifyingGlass, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react"
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
  const [selectedOnly, setSelectedOnly] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase()
  const selectedIds = new Set(selected)
  const visible = projects.filter(project => (!selectedOnly || selectedIds.has(project.projectId)) && project.name.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery))
  const visibleIds = new Set(visible.map(project => project.projectId))
  const allVisibleSelected = visible.length > 0 && visible.every(project => selectedIds.has(project.projectId))
  const hiddenSelected = selected.filter(id => !visibleIds.has(id)).length
  const download = direction === "download"
  const filtered = Boolean(normalizedQuery || selectedOnly)
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }) }, [query, selectedOnly, direction, snapshotId])
  useEffect(() => { setSelectedOnly(false) }, [direction, snapshotId])
  const toggleVisible = () => onSelectionChange(allVisibleSelected
    ? selected.filter(id => !visibleIds.has(id))
    : [...new Set([...selected, ...visible.map(project => project.projectId)])])
  const clearSearch = () => {
    onQueryChange("")
    requestAnimationFrame(() => document.getElementById("cloud-project-search")?.focus())
  }

  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card" aria-label="项目同步">
    <div className="shrink-0 space-y-3 border-b p-3 sm:px-4" data-testid="cloud-project-toolbar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg bg-muted p-1" aria-label="同步方向">
          {(["download", "upload"] as const).map(value => {
            const active = direction === value
            const Icon = value === "download" ? CloudArrowDown : CloudArrowUp
            return <Button key={value} size="sm" variant="ghost" disabled={busy} aria-pressed={active} aria-label={value === "download" ? "下载项目" : "上传项目"} data-testid={"cloud-direction-" + value}
              className={cn("h-8 rounded-md px-3", active && "bg-card text-primary shadow-sm hover:bg-card")}
              onClick={() => { if (!active) onDirectionChange(value) }}><Icon size={17} aria-hidden="true" />{value === "download" ? "下载项目" : "上传项目"}</Button>
          })}
        </div>
        <div className="flex max-w-full items-center gap-1">
          {download ? <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">云端版本</span><SelectControl aria-label="云端版本" disabled={busy} value={snapshotId || "latest"} onValueChange={value => onSnapshotChange(value === "latest" ? "" : value)} className="h-8 min-w-0 max-w-28 rounded-md border bg-card px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:max-w-44">
            <SelectItem value="latest">最新版本</SelectItem>{versions.map(version => <SelectItem key={version.snapshotId} value={version.snapshotId}>{new Date(version.createdAt).toLocaleString()} · {Math.ceil(version.bytes / 1024)} KiB</SelectItem>)}
          </SelectControl></label> : <span className="text-xs text-muted-foreground">本机 → 云端</span>}
          <Button size="icon-sm" variant="ghost" aria-label="刷新云配置" title="刷新项目列表" disabled={busy} onClick={onRefresh}><ArrowsClockwise aria-hidden="true" className={busy ? "motion-safe:animate-spin" : undefined} size={16} /></Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" size={16} aria-hidden="true" />
          <Input id="cloud-project-search" data-testid="cloud-project-search" aria-label="搜索项目" aria-describedby="cloud-search-summary" className="h-8 pr-9 pl-9" placeholder="搜索项目名称…" disabled={busy || loadError} value={query} onChange={e => onQueryChange(e.target.value)} />
          {query ? <Button className="absolute top-0 right-1" variant="ghost" size="icon-sm" aria-label="清除搜索" disabled={busy} onClick={clearSearch}><X size={14} aria-hidden="true" /></Button> : null}
        </div>
        <Button size="sm" variant={selectedOnly ? "secondary" : "outline"} className="h-8 shrink-0 text-xs" aria-pressed={selectedOnly} disabled={busy} data-testid="cloud-selected-only" onClick={() => setSelectedOnly(value => !value)}>仅看已选{selected.length ? "（" + selected.length + "）" : ""}</Button>
      </div>
    </div>

    <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h2 className="text-xs font-medium outline-none" id="cloud-project-selection" tabIndex={-1}>{download ? "云端项目" : "本机项目"}</h2>
        <p className="text-xs text-muted-foreground" id="cloud-search-summary" role="status">{loading ? "正在读取…" : loadError ? "读取失败" : filtered ? visible.length + " / " + projects.length + " 个" : "共 " + projects.length + " 个"}</p>
      </div>
      <Button size="xs" variant="ghost" className="h-6 shrink-0 text-xs" disabled={busy || loadError || !visible.length} onClick={toggleVisible}>{allVisibleSelected ? filtered ? "取消匹配选择" : "取消全选" : filtered ? "全选匹配项目" : "全选"}</Button>
    </div>

    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" data-testid="cloud-project-list" role="region" aria-label={download ? "云端项目列表" : "本机项目列表"} tabIndex={0}>
      {loading || loadError ? <div className="flex min-h-full flex-col items-center justify-center gap-3 p-5 text-center">
        {loading ? <SpinnerGap size={24} className="text-primary motion-safe:animate-spin" aria-hidden="true" /> : <WarningCircle size={24} className="text-warning" aria-hidden="true" />}
        <p className="font-medium">{loading ? "正在读取项目…" : "项目读取失败"}</p><p className="text-xs text-muted-foreground">{loading ? "正在获取所选云端版本，请稍候。" : "请检查仓库连接后重新读取，现有项目不会被修改。"}</p>
        {loadError ? <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}><ArrowsClockwise />重新读取</Button> : null}
      </div> : visible.length ? <div className="divide-y">{visible.map(project => {
        const checked = selectedIds.has(project.projectId)
        return <label key={project.projectId} data-testid="cloud-project-row" data-project-id={project.projectId} className={cn("flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2.5 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/50 sm:px-4", checked ? "bg-primary/5" : "hover:bg-muted/40", busy && "cursor-wait opacity-60")}>
          <Checkbox   disabled={busy} checked={checked} onCheckedChange={value => onSelectionChange(value === true ? [...selected, project.projectId] : selected.filter(id => id !== project.projectId))} />
          <FolderSimple size={17} className={cn("shrink-0", checked ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block text-sm [overflow-wrap:anywhere]">{project.name}</span>{project.warnings?.length ? <span className="mt-0.5 flex items-center gap-1 text-xs text-warning"><WarningCircle size={13} aria-hidden="true" />{project.warnings.length} 项连接前检查，预览时查看</span> : null}</span>
        </label>
      })}</div> : <div className="flex min-h-full flex-col items-center justify-center gap-3 px-5 py-6 text-center">
        <MagnifyingGlass size={24} className="text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1.5"><p className="font-medium">{normalizedQuery ? "没有找到匹配项目" : selectedOnly ? "还没有选择项目" : download ? "云仓库还没有项目" : "本机还没有项目"}</p><p className="max-w-sm text-xs leading-5 text-muted-foreground">{normalizedQuery ? "换个关键词试试，已选择的项目仍会保留。" : selectedOnly ? "切回全部项目，勾选需要同步的内容。" : download ? "先将本机项目上传，再到其他电脑下载。" : "返回工作台创建项目后，就可以在这里上传。"}</p></div>
        {normalizedQuery ? <Button size="sm" variant="outline" onClick={clearSearch}>清除搜索</Button> : selectedOnly ? <Button size="sm" variant="outline" onClick={() => setSelectedOnly(false)}>查看全部项目</Button> : download ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onDirectionChange("upload")}>去上传项目<ArrowRight /></Button> : null}
      </div>}
    </div>

    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t bg-card px-3 py-3 sm:px-4" data-testid="cloud-project-actions">
      <div className="min-w-0 space-y-1" data-testid="cloud-selection-summary" role="status">
        <div className="flex flex-wrap items-center gap-x-2"><p className="text-sm">已选 <strong className="font-semibold text-primary">{selected.length}</strong> 个项目</p>{selected.length ? <Button size="xs" variant="ghost" className="h-6 text-xs text-muted-foreground" disabled={busy} onClick={() => onSelectionChange([])}>清空选择</Button> : null}</div>
        <p className="text-xs text-muted-foreground">{hiddenSelected ? hiddenSelected + " 个已选项目不在当前筛选中" : download ? "云端 → 本机 · 下一步预览变更" : "本机 → 云端 · 下一步预览变更"}</p>
      </div>
      <Button className="ml-auto shrink-0" disabled={busy || loadError || !selected.length} data-testid="cloud-preview" aria-label={"预览" + (download ? "下载" : "上传") + "（" + selected.length + "）"} onClick={onPreview}>预览{download ? "下载" : "上传"}<ArrowRight aria-hidden="true" /></Button>
    </footer>
  </section>
}
