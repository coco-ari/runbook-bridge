import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, CaretDown, CaretRight, CaretUpDown, Eye, EyeSlash, File, FileCode, FileText, FileZip, FolderSimple, FolderOpen, Link, PencilSimple, SpinnerGap, TerminalWindow, TreeStructure, UploadSimple } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerDirectoryPage } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isWorkspacePathStale, parentRemotePath, serverEntryType, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

interface DirectoryState { readonly page?: ServerDirectoryPage; readonly loading: boolean; readonly error?: string; readonly startCursor?: string; readonly history?: readonly string[] }
type TreeRow = { readonly kind: "entry"; readonly entry: ServerDirectoryEntry; readonly depth: number; readonly cycle?: boolean }
  | { readonly kind: "loading" | "error" | "empty" | "more" | "limit" | "previous" | "cycle"; readonly directory: string; readonly depth: number; readonly message?: string }
interface ServerFileTreeProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly connected: boolean
  readonly path: string
  readonly onPath: (path: string) => void
  readonly onPreview: (entry: ServerDirectoryEntry) => void
  readonly onUpload: () => void
  readonly onInsertPath: (path: string) => void
  readonly invalidatedPath: Readonly<{ path: string; id: number }> | null
  readonly refreshEpoch: number
  readonly refreshPaths: readonly string[]
}

export function ServerFileTree({ api, scope, connected, path, onPath, onPreview, onUpload, onInsertPath, refreshEpoch, refreshPaths, invalidatedPath }: ServerFileTreeProps) {
  const [root, setRoot] = useState("/")
  const [draft, setDraft] = useState("/")
  const [editingPath, setEditingPath] = useState(false)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["/"]))
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState("/")
  const [reveal, setReveal] = useState<Readonly<{ path: string; id: number }> | null>(null)
  const [revealError, setRevealError] = useState("")
  const revealSequenceRef = useRef(0)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 500 })
  const requestsRef = useRef(new Map<string, number>())
  const requestSequenceRef = useRef(0)
  const mountedRef = useRef(true)
  const directoriesRef = useRef(directories)
  const scrollPositionsRef = useRef(new Map<string, number>())
  const pendingScrollRef = useRef<number | null>(null)
  directoriesRef.current = directories
  const rootRef = useRef(root)
  const scrollRef = useRef<HTMLDivElement>(null)
  rootRef.current = root
  const rowHeight = 32
  const breadcrumbs = path.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: "/" + parts.slice(0, index + 1).join("/") }))
  useEffect(() => { if (editingPath) { pathInputRef.current?.focus(); pathInputRef.current?.select() } }, [editingPath])

  const invalidate = useCallback((target: string) => {
    const affected = (value: string) => value === target || value.startsWith(target.replace(/\/$/u, "") + "/")
    for (const key of requestsRef.current.keys()) if (affected(key)) requestsRef.current.delete(key)
    setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !affected(key))))
  }, [])

  const load = useCallback(async (directory: string, cursor?: string, replace = false, previous = false, reconcile = true): Promise<void> => {
    if (!connected) return
    const request = ++requestSequenceRef.current
    requestsRef.current.set(directory, request)
    setDirectories((current) => ({ ...current, [directory]: { ...current[directory], loading: true, error: "" } }))
    try {
      const page = unwrapWorkspaceResult(await api.serverWorkspaceListDirectory({ ...scope, path: directory, ...(cursor ? { cursor } : {}) }))
      if (!mountedRef.current || requestsRef.current.get(directory) !== request) return
      setDirectories((current) => {
        const old = current[directory]
        const retained = { ...current }
        delete retained[directory]
        // 完整目录刷新后移除已删除子目录的缓存，避免旧内容再次出现。
        if (!cursor && !page.truncated && !page.nextCursor) {
          const children = new Set(page.entries.filter((item) => serverEntryType(item) === "directory").map((item) => item.path))
          const prefix = directory.replace(/\/$/u, "") + "/"
          for (const cached of Object.keys(retained)) if (cached.startsWith(prefix) && !children.has(prefix + cached.slice(prefix.length).split("/")[0])) {
            delete retained[cached]
            requestsRef.current.delete(cached)
          }
        }
        if (old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) for (const cached of Object.keys(retained)) if (cached !== directory && cached.startsWith(directory.replace(/\/$/u, "") + "/")) delete retained[cached]
        if (cursor && old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) return { ...retained, [directory]: { loading: false, error: "链接目标已变化，请重新读取目录。" } }
        const next: Record<string, DirectoryState> = { ...retained, [directory]: { loading: false, startCursor: replace ? cursor ?? "0" : cursor ? old?.startCursor ?? "0" : "0", history: replace ? previous ? old?.history?.slice(0, -1) ?? [] : [...(old?.history ?? []), old?.startCursor ?? "0"] : cursor ? old?.history ?? [] : [], page: { ...page, entries: cursor && !replace ? [...(old?.page?.entries ?? []), ...page.entries].slice(0, 2000) : page.entries } } }
        // 限制后台保留的目录与条目；虚拟列表只挂载视口附近的行。
        while (Object.keys(next).length > 32 || Object.values(next).reduce((sum, item) => sum + (item.page?.entries.length ?? 0), 0) > 5000) {
          const oldest = Object.keys(next).find((key) => key !== directory && key !== rootRef.current && !next[key]?.loading)
          if (!oldest) break
          delete next[oldest]
        }
        return next
      })
    } catch (failure) {
      if (mountedRef.current && requestsRef.current.get(directory) === request) {
        const stale = isWorkspacePathStale(failure)
        if (stale) invalidate(directory)
        setDirectories((current) => ({ ...current, [directory]: { ...current[directory], loading: false, error: workspaceErrorMessage(failure) } }))
        if (stale && reconcile && directory !== "/") await load(parentRemotePath(directory), undefined, false, false, false)
      }
    } finally {
      if (requestsRef.current.get(directory) === request) requestsRef.current.delete(directory)
    }
  }, [api, connected, scope, invalidate])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; requestsRef.current.clear() }
  }, [])
  useEffect(() => {
    if (!connected) { requestsRef.current.clear(); setDirectories({}); return }
    if (!directoriesRef.current[root]?.page && !requestsRef.current.has(root)) void load(root)
  }, [connected, load, root])
  useEffect(() => {
    if (!invalidatedPath || !connected) return
    invalidate(invalidatedPath.path)
    void load(parentRemotePath(invalidatedPath.path))
  }, [invalidatedPath, connected, invalidate, load])
  useEffect(() => { if (refreshEpoch) for (const target of new Set([path, ...refreshPaths])) void load(target) }, [refreshEpoch])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const navigate = (next: string) => {
    revealSequenceRef.current += 1
    setReveal(null)
    setRevealError("")
    const normalized = next.trim()
    if (!normalized.startsWith("/") || normalized.includes("\0")) return
    setEditingPath(false)
    setRoot(normalized)
    setDraft(normalized)
    setExpanded((current) => new Set([...current, normalized]))
    // 导航只读取尚未缓存的目录，同时保留每个浏览位置的滚动距离。
    scrollPositionsRef.current.set(root, scrollRef.current?.scrollTop ?? 0)
    while (scrollPositionsRef.current.size > 32) scrollPositionsRef.current.delete(scrollPositionsRef.current.keys().next().value!)
    pendingScrollRef.current = scrollPositionsRef.current.get(normalized) ?? 0
    setDirectories((current) => {
      if (!current[normalized]?.page) return current
      const next = { ...current }; delete next[normalized]
      return { ...next, [normalized]: current[normalized] }
    })
    setSelected(normalized)
    onPath(normalized)
    if (normalized === root && !directories[normalized]?.page && !requestsRef.current.has(normalized)) void load(normalized)
  }

  const toggle = (entry: ServerDirectoryEntry) => {
    revealSequenceRef.current += 1
    setReveal(null)
    setRevealError("")
    setSelected(entry.path)
    if (serverEntryType(entry) === "directory") {
      onPath(entry.path)
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      if (!directories[entry.path]?.page && !requestsRef.current.has(entry.path)) void load(entry.path)
      else setDirectories((current) => { const value = current[entry.path]; if (!value) return current; const next = { ...current }; delete next[entry.path]; return { ...next, [entry.path]: value } })
    } else if (serverEntryType(entry) === "file") onPreview(entry)
  }

  const revealDirectory = (target: string) => {
    if (!connected) return
    if (target === "/") { navigate("/"); pendingScrollRef.current = 0; return }
    // 面包屑定位目录节点；只有节点位于当前浏览根之外时才回到它的父级。
    const nextRoot = target === root || !target.startsWith(root.replace(/\/$/u, "") + "/") ? parentRemotePath(target) : root
    const ancestors: string[] = []
    for (let current = parentRemotePath(target); current !== nextRoot && current !== "/"; current = parentRemotePath(current)) ancestors.push(current)
    const parent = parentRemotePath(target)
    const parentPage = directories[parent]
    if (parentPage?.startCursor && parentPage.startCursor !== "0" && !parentPage.page?.entries.some((item) => item.path === target) && !requestsRef.current.has(parent)) void load(parent)
    pendingScrollRef.current = null
    setRoot(nextRoot)
    setExpanded((current) => new Set([...current, ...ancestors, nextRoot]))
    setSelected(target)
    setDraft(target)
    setEditingPath(false)
    setRevealError("")
    if (target.split("/").some((part) => part.startsWith("."))) setShowHidden(true)
    onPath(target)
    setReveal({ path: target, id: ++revealSequenceRef.current })
  }

  const rows = useMemo(() => {
    const result: TreeRow[] = []
    const visited = new Set<string>()
    const append = (directory: string, depth: number, ancestors = new Set<string>()) => {
      if (depth > 64 || visited.has(directory)) return
      visited.add(directory)
      const state = directories[directory]
      const canonical = state?.page?.canonicalPath ?? directory
      if (ancestors.has(canonical)) { result.push({ kind: "cycle", directory, depth, message: "循环链接，已停止展开" }); return }
      const branch = new Set(ancestors).add(canonical)
      if (state?.history?.length) result.push({ kind: "previous", directory, depth })
      const entries = (state?.page?.entries ?? []).filter((entry) => showHidden || !entry.name.startsWith("."))
      for (const entry of entries) {
        const target = entry.type === "symlink" ? entry.linkTarget : canonical.replace(/\/$/u, "") + "/" + entry.name
        const cycle = serverEntryType(entry) === "directory" && Boolean(target && branch.has(target))
        result.push({ kind: "entry", entry, depth, cycle })
        if (serverEntryType(entry) === "directory" && expanded.has(entry.path) && !cycle) append(entry.path, depth + 1, branch)
      }
      if (state?.loading) result.push({ kind: "loading", directory, depth })
      else if (state?.error) result.push({ kind: "error", directory, depth, message: state.error })
      else if (!state?.page) result.push({ kind: "more", directory, depth, message: "重新读取目录" })
      else if (!entries.length) result.push({ kind: "empty", directory, depth, message: state.page.entries.length ? "只有隐藏文件" : "空目录" })
      if (state?.page?.nextCursor) result.push({ kind: state.page.entries.length >= 2000 ? "limit" : "more", directory, depth })
      else if (state?.page?.truncated) result.push({ kind: "limit", directory, depth, message: "目录条目达到读取上限" })
    }
    append(root, 0)
    return result
  }, [directories, expanded, root, showHidden])

  useEffect(() => {
    if (!reveal || !connected || rows.some((row) => row.kind === "entry" && row.entry.path === reveal.path)) return
    const chain: string[] = []
    for (let current = parentRemotePath(reveal.path); ; current = parentRemotePath(current)) {
      chain.unshift(current)
      if (current === root || current === "/" || chain.length > 64) break
    }
    if (chain.length > 64) { setRevealError("目录层级过深，请输入更近的父目录路径。"); setReveal(null); return }
    const seen = new Set<string>()
    for (let index = 0; index < chain.length; index += 1) {
      const directory = chain[index]!
      const state = directories[directory]
      if (state?.loading || requestsRef.current.has(directory)) return
      if (state?.error) { setRevealError(state.error); setReveal(null); return }
      if (!state?.page) { void load(directory); return }
      const canonical = state.page.canonicalPath ?? directory
      if (seen.has(canonical)) { setRevealError("循环链接，无法继续定位。"); setReveal(null); return }
      seen.add(canonical)
      const child = chain[index + 1] ?? reveal.path
      if (state.page.entries.some((entry) => entry.path === child && serverEntryType(entry) === "directory")) continue
      if (state.page.nextCursor) { void load(directory, state.page.nextCursor, state.page.entries.length >= 2000); return }
      setRevealError("当前目录列表中未找到该目录，请刷新后重试。")
      setReveal(null)
      return
    }
  }, [reveal, connected, directories, root, rows, load])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !reveal || !connected) return
    const index = rows.findIndex((row) => row.kind === "entry" && row.entry.path === reveal.path)
    if (index < 0) return
    // 先滚动虚拟列表，再将焦点交给挂载后的目标行，保留目录上下文。
    element.scrollTop = Math.max(0, index * rowHeight - Math.min(rowHeight * 3, element.clientHeight / 4))
    setViewport({ scrollTop: element.scrollTop, height: element.clientHeight })
    const id = reveal.id
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mountedRef.current && revealSequenceRef.current === id) element.querySelector<HTMLButtonElement>('[data-tree-index="' + index + '"]')?.focus({ preventScroll: true })
    }))
    setReveal(null)
  }, [reveal, connected, rows, rowHeight])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element) {
      if (pendingScrollRef.current !== null && directories[root]?.page) { element.scrollTop = pendingScrollRef.current; pendingScrollRef.current = null }
      setViewport({ scrollTop: element.scrollTop, height: element.clientHeight })
    }
  }, [root, rows.length, rowHeight, directories])

  const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 8)
  const end = Math.min(rows.length, Math.ceil((viewport.scrollTop + viewport.height) / rowHeight) + 8)
  const focusRow = (index: number) => {
    const element = scrollRef.current
    if (!element) return
    const target = rows[index]
    if (!target || target.kind !== "entry") return
    if (index * rowHeight < element.scrollTop) element.scrollTop = index * rowHeight
    else if ((index + 1) * rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = (index + 1) * rowHeight - element.clientHeight
    setViewport({ scrollTop: element.scrollTop, height: element.clientHeight })
    requestAnimationFrame(() => requestAnimationFrame(() => element.querySelector<HTMLButtonElement>(`[data-tree-index="${index}"]`)?.focus()))
  }

  return <section className="server-file-tree" aria-label="服务器目录树">
    <div className="server-file-toolbar">
      <div className="server-file-heading"><TreeStructure size={19} weight="duotone" /><span>文件工作区</span></div>
      <div className="server-file-actions">
        <Button size="icon-sm" variant="ghost" aria-label="收起所有目录" title="收起所有目录" onClick={() => { setExpanded(new Set()); if (scrollRef.current) scrollRef.current.scrollTop = 0 }}><CaretUpDown /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="显示隐藏文件" title={showHidden ? "隐藏点文件" : "显示隐藏文件"} aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye /> : <EyeSlash />}</Button>
        <WorkspaceIconButton action="refresh" label="刷新目录" disabled={!connected} onClick={() => { void load(root); if (path !== root) void load(path) }} />
        <Button size="icon-sm" variant="ghost" title="上传文件" aria-label="上传文件" disabled={!connected} onClick={onUpload}><UploadSimple /></Button>
      </div>
    </div>
    <div className="server-file-navigation">
      <Button size="icon-sm" type="button" variant="ghost" aria-label="上级目录" title="上级目录" disabled={path === "/" || !connected} onClick={() => revealDirectory(parentRemotePath(path))}><ArrowUp /></Button>
      {editingPath ? <form className="server-path-editor" onSubmit={(event) => { event.preventDefault(); navigate(draft) }}>
        <Input ref={pathInputRef} aria-label="目录路径" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditingPath(false) } }} disabled={!connected} spellCheck={false} />
        <Button type="submit" size="sm" variant="ghost" disabled={!connected || !draft.startsWith("/")}>转到</Button>
      </form> : <>
        <nav className="server-path-breadcrumbs" aria-label="当前目录" title={path} onDoubleClick={() => { setDraft(path); setEditingPath(true) }}>
          <button type="button" disabled={!connected} onClick={() => revealDirectory("/")} aria-label="根目录">/</button>
          {breadcrumbs.map((item, index) => <span key={item.path}><CaretRight size={11} /><button type="button" disabled={!connected} aria-current={index === breadcrumbs.length - 1 ? "location" : undefined} title={`定位到 ${item.path}`} onClick={() => revealDirectory(item.path)}>{item.name}</button></span>)}
        </nav>
        <Button size="icon-sm" variant="ghost" aria-label="编辑目录路径" title="输入路径" disabled={!connected} onClick={() => { setDraft(path); setEditingPath(true) }}><PencilSimple /></Button>
      </>}
    </div>
    {revealError ? <div className="px-3 py-2 text-xs text-danger" role="status">{revealError}</div> : null}
    <div className="server-tree-scroll" ref={scrollRef} role="tree" aria-label="远程文件目录" onScroll={(event) => setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset
          const style = { position: "absolute" as const, top: index * rowHeight, left: 0, right: 0, height: rowHeight, paddingLeft: 12 + row.depth * 18 }
          if (row.kind !== "entry") {
            const state = directories[row.directory]
            return <div key={`status:${row.kind}:${row.directory}`} style={style} className="flex min-w-0 items-center gap-1 pr-2 text-xs text-muted-foreground">
              {row.kind === "previous" ? <Button size="sm" variant="ghost" disabled={!connected} onClick={() => { void load(row.directory, state?.history?.at(-1), true, true) }}>查看上一批</Button> : row.kind === "loading" ? <><SpinnerGap className="animate-spin" size={13} />读取中…</> : row.kind === "more" ? <Button size="sm" variant="ghost" disabled={!connected} onClick={() => { void load(row.directory, state?.page?.nextCursor ?? undefined) }}>{row.message ?? "加载更多"}</Button> : row.kind === "error" ? <><span className="truncate text-danger" title={row.message}>{row.message}</span><Button size="sm" variant="ghost" disabled={!connected} onClick={() => { void load(row.directory) }}>重试</Button></> : row.kind === "limit" ? state?.page?.nextCursor ? <Button size="sm" variant="ghost" disabled={!connected} title="替换当前批次，可返回上一批" onClick={() => { void load(row.directory, state.page?.nextCursor ?? undefined, true); if (scrollRef.current) scrollRef.current.scrollTop = 0 }}>查看下一批</Button> : <span title="服务器目录达到单次读取上限；可输入具体子目录路径继续浏览。">{row.message}</span> : <span>{row.message}</span>}
            </div>
          }
          const { entry } = row
          const targetType = serverEntryType(entry)
          const isDirectory = targetType === "directory"
          const open = expanded.has(entry.path)
          const supported = !row.cycle && (isDirectory || targetType === "file")
          return <button key={`entry:${entry.path}`} data-tree-index={index} type="button" className={"server-tree-row" + (entry.type === "symlink" ? " server-tree-link" : "")} role="treeitem" aria-level={row.depth + 1} aria-selected={selected === entry.path} {...(isDirectory ? { "aria-expanded": open } : {})} aria-disabled={!supported || !connected} style={style} title={entry.type === "symlink" ? `${entry.path}${entry.linkTarget ? " → " + entry.linkTarget : ""}${row.cycle ? "（循环链接）" : supported ? "" : "（目标不可用或不支持打开）"}` : entry.path} onClick={() => {
            if (!connected || !supported) return
            toggle(entry)
          }} onKeyDown={(event) => {
            if (event.key === "ArrowRight" && isDirectory && !open && supported && connected) { event.preventDefault(); toggle(entry) }
            if (event.key === "ArrowLeft" && isDirectory && open && supported && connected) { event.preventDefault(); toggle(entry) }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1
            let next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : index + direction
            while (next >= 0 && next < rows.length && rows[next]?.kind !== "entry") next += direction
            focusRow(next)
          }}>
            <span className="server-tree-chevron">{isDirectory ? open ? <CaretDown size={12} weight="fill" /> : <CaretRight size={12} weight="fill" /> : null}</span>
            <span className="server-tree-icon">{isDirectory ? open ? <FolderOpen className="server-icon-folder" size={21} weight="fill" /> : <FolderSimple className="server-icon-folder" size={21} weight="fill" /> : (entry.type === "symlink" && targetType !== "file") ? <Link className="server-icon-link" size={20} weight="bold" /> : /\.(zip|tar|gz|tgz|jar|7z)$/iu.test(entry.name) ? <FileZip className="server-icon-archive" size={20} weight="duotone" /> : /\.(conf|json|yml|yaml|xml|sh|js|ts|html|css)$/iu.test(entry.name) ? <FileCode className="server-icon-code" size={20} weight="duotone" /> : /\.(txt|log|md)$/iu.test(entry.name) ? <FileText className="server-icon-file" size={20} weight="duotone" /> : <File className="server-icon-file" size={20} weight="duotone" />}{entry.type === "symlink" && supported ? <Link className="server-tree-link-badge" size={11} weight="bold" /> : null}</span>
            <span className="server-tree-name">{entry.name}</span>
            {entry.type === "symlink" ? <span className="server-tree-link-target" title={entry.linkTarget ?? "链接目标无法解析"}>→ {entry.linkTarget ?? "目标不可用"}{row.cycle ? " · 循环链接" : targetType === "special" ? " · 特殊文件" : ""}</span> : null}
          </button>
        })}
      </div>
    </div>
    <div className="server-file-footer"><span className="server-file-current-path" title={path}>{path}</span><Button size="sm" variant="ghost" disabled={!connected} onClick={() => onInsertPath(path)} title="只填入带引号的路径，不执行命令"><TerminalWindow size={15} />填入终端</Button></div>
  </section>
}
