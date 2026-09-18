import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, DownloadSimple, CaretDown, CaretRight, CaretUpDown, Eye, EyeSlash, File, FileCode, FileText, FileZip, FolderSimple, FolderOpen, Link, PencilSimple, SpinnerGap, TreeStructure, UploadSimple } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerDirectoryPage } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DirectoryBookmarks } from "./DirectoryBookmarks"
import { directoryBookmarksKey } from "./directory-bookmarks"
import { canDragWorkspacePath, type WorkspacePathDrag } from "./workspace-path-drag"
import { isWorkspacePathStale, parentRemotePath, serverEntryType, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

interface DirectoryState { readonly page?: ServerDirectoryPage; readonly loading: boolean; readonly loadedAt?: number; readonly error?: string; readonly metadataError?: string | undefined; readonly startCursor?: string; readonly history?: readonly string[] }
const DIRECTORY_TTL_MS = 30_000
const needsDirectoryRead = (state?: DirectoryState) => !state?.page || Date.now() - (state.loadedAt ?? 0) >= DIRECTORY_TTL_MS

type TreeRow = { readonly kind: "entry"; readonly entry: ServerDirectoryEntry; readonly depth: number; readonly cycle?: boolean }
  | { readonly kind: "loading" | "error" | "empty" | "more" | "limit" | "previous" | "cycle"; readonly directory: string; readonly depth: number; readonly message?: string }
interface ServerFileTreeProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly connected: boolean
  readonly visible: boolean
  readonly path: string
  readonly onPath: (path: string) => void
  readonly onPreview: (entry: ServerDirectoryEntry) => void
  readonly onDownload: (entry: ServerDirectoryEntry) => void
  readonly downloadBusy: boolean
  readonly onUpload: () => void
  readonly pathDrag: WorkspacePathDrag
  readonly invalidatedPath: Readonly<{ path: string; id: number }> | null
  readonly locateFile?: Readonly<{ path: string; id: number }> | null
  readonly refreshEpoch: number
  readonly refreshPaths: readonly string[]
}

export function ServerFileTree({ api, scope, connected, visible, path, onPath, onPreview, onUpload, onDownload, downloadBusy, pathDrag, refreshEpoch, refreshPaths, invalidatedPath, locateFile }: ServerFileTreeProps) {
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const [root, setRoot] = useState("/")
  const [draft, setDraft] = useState("/")
  const [editingPath, setEditingPath] = useState(false)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["/"]))
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState("/")
  const [reveal, setReveal] = useState<Readonly<{ path: string; id: number; openDirectory?: boolean }> | null>(null)
  const [revealError, setRevealError] = useState("")
  const revealSequenceRef = useRef(0)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 500 })
  const metadataRequestsRef = useRef(new Set<string>())
  const pendingOpenRef = useRef<{ path: string; previewFile: boolean } | null>(null)
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
      const snapshotId = cursor ? directoriesRef.current[directory]?.page?.snapshotId : undefined
      const page = unwrapWorkspaceResult(await api.serverWorkspaceListDirectory({ ...scope, path: directory, deferLinks: true, ...(snapshotId ? { snapshotId } : {}), ...(cursor ? { cursor } : {}) }))
      if (!mountedRef.current || requestsRef.current.get(directory) !== request) return
      setDirectories((current) => {
        const old = current[directory]
        const retained = { ...current }
        delete retained[directory]
        // 完整目录刷新后移除已删除子目录的缓存，避免旧内容再次出现。
        if (!cursor && !page.truncated && !page.nextCursor) {
          const children = new Set(page.entries.filter((item) => serverEntryType(item) === "directory" || (item.type === "symlink" && !item.linkTargetType)).map((item) => item.path))
          const prefix = directory.replace(/\/$/u, "") + "/"
          for (const cached of Object.keys(retained)) if (cached.startsWith(prefix) && !children.has(prefix + cached.slice(prefix.length).split("/")[0])) {
            delete retained[cached]
            requestsRef.current.delete(cached)
          }
        }
        if (old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) for (const cached of Object.keys(retained)) if (cached !== directory && cached.startsWith(directory.replace(/\/$/u, "") + "/")) delete retained[cached]
        if (cursor && old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) return { ...retained, [directory]: { loading: false, error: "链接目标已变化，请重新读取目录。" } }
        const next: Record<string, DirectoryState> = { ...retained, [directory]: { loading: false, loadedAt: cursor ? old?.loadedAt ?? Date.now() : Date.now(), startCursor: replace ? cursor ?? "0" : cursor ? old?.startCursor ?? "0" : "0", history: replace ? previous ? old?.history?.slice(0, -1) ?? [] : [...(old?.history ?? []), old?.startCursor ?? "0"] : cursor ? old?.history ?? [] : [], page: { ...page, entries: cursor && !replace ? [...(old?.page?.entries ?? []), ...page.entries].slice(0, 2000) : page.entries } } }
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
        if (failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_DIRECTORY_EXPIRED" && cursor) {
          await load(directory)
          return
        }
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
    if (!connected) return
    // 后台最多补齐两个目录页；根据快照合并，旧响应不能覆盖刷新或分页后的新数据。
    for (const [directory, state] of Object.entries(directories)) {
      const page = state.page
      if (!page?.snapshotId || state.loading || state.metadataError) continue
      const offsets = new Set(page.entries.flatMap((entry, index) => entry.type === "symlink" && !entry.linkTargetType ? [Number(state.startCursor ?? 0) + Math.floor(index / 200) * 200] : []))
      for (const offset of offsets) {
        const key = page.snapshotId + ":" + offset
        if (metadataRequestsRef.current.has(key) || metadataRequestsRef.current.size >= 2) continue
        metadataRequestsRef.current.add(key)
        void (async () => {
          try {
            const metadata = unwrapWorkspaceResult(await api.serverWorkspaceListDirectory({ ...scope, path: directory, snapshotId: page.snapshotId!, cursor: String(offset), deferLinks: true, resolveLinks: true }))
            if (!mountedRef.current) return
            setDirectories((current) => {
              const latest = current[directory]
              if (!latest?.page || latest.page.snapshotId !== metadata.snapshotId || latest.loading) return current
              const updates = new Map(metadata.entries.map((entry) => [entry.path, entry]))
              return { ...current, [directory]: { ...latest, page: { ...latest.page, entries: latest.page.entries.map((entry) => updates.get(entry.path) ?? entry) } } }
            })
          } catch (failure) {
            const latest = directoriesRef.current[directory]
            const expired = failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_DIRECTORY_EXPIRED"
            if (mountedRef.current && latest?.page?.snapshotId === page.snapshotId && !latest!.loading && (expired || isWorkspacePathStale(failure))) void load(directory)
            if (mountedRef.current) setDirectories((current) => !current[directory]?.page || current[directory]?.page?.snapshotId !== page.snapshotId ? current : { ...current, [directory]: { ...current[directory]!, metadataError: workspaceErrorMessage(failure) } })
          } finally {
            metadataRequestsRef.current.delete(key)
            // 释放队列槽后继续处理其余页，不使用轮询计时器。
            if (mountedRef.current) setDirectories((current) => ({ ...current }))
          }
        })()
      }
    }
  }, [api, connected, directories, scope, load])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; requestsRef.current.clear() }
  }, [])
  useEffect(() => {
    if (!connected) { requestsRef.current.clear(); setDirectories({}); return }
    if (needsDirectoryRead(directoriesRef.current[root]) && !requestsRef.current.has(root)) void load(root)
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
    pendingOpenRef.current = null
    revealSequenceRef.current += 1
    setReveal(null)
    setRevealError("")
    const normalized = next.trim()
    if (!normalized.startsWith("/") || normalized.includes("\0")) return
    setEditingPath(false)
    setRoot(normalized)
    setDraft(normalized)
    setExpanded((current) => new Set([...current, normalized]))
    // 导航复用短期缓存，过期后按需刷新，并保留每个浏览位置的滚动距离。
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
    if (normalized === root && needsDirectoryRead(directories[normalized]) && !requestsRef.current.has(normalized)) void load(normalized)
  }

  const toggle = (entry: ServerDirectoryEntry, previewFile = true) => {
    pendingOpenRef.current = null
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
      if (!expanded.has(entry.path) && needsDirectoryRead(directories[entry.path]) && !requestsRef.current.has(entry.path)) void load(entry.path)
      else setDirectories((current) => { const value = current[entry.path]; if (!value) return current; const next = { ...current }; delete next[entry.path]; return { ...next, [entry.path]: value } })
    } else if (previewFile && serverEntryType(entry) === "file") onPreview(entry)
  }

  useEffect(() => {
    if (!locateFile || !connected) return
    const directory = parentRemotePath(locateFile.path)
    navigate(directory)
    setSelected(locateFile.path)
    if (locateFile.path.split("/").some((part) => part.startsWith("."))) setShowHidden(true)
    setReveal({ path: locateFile.path, id: ++revealSequenceRef.current })
    void load(directory)
  }, [locateFile])

  const revealDirectory = (target: string, openDirectory = false) => {
    if (!connected) return
    revealSequenceRef.current += 1
    setReveal(null)
    if (openDirectory) {
      // 与后台的路径规范化保持一致，保留目录名称中的空格。
      const parts: string[] = []
      for (const part of target.split("/")) {
        if (part === "..") parts.pop()
        else if (part && part !== ".") parts.push(part)
      }
      target = "/" + parts.join("/")
    }
    if (target === "/") { navigate("/"); pendingScrollRef.current = 0; return }
    // 收藏从根目录展开完整路径；面包屑沿用当前浏览范围。
    const nextRoot = openDirectory ? "/" : target === root || !target.startsWith(root.replace(/\/$/u, "") + "/") ? parentRemotePath(target) : root
    const ancestors: string[] = []
    for (let current = parentRemotePath(target); current !== nextRoot && current !== "/"; current = parentRemotePath(current)) {
      ancestors.push(current)
      // 收藏祖先链与目标共用最多 32 个目录缓存，避免定位期间反复淘汰祖先。
      if (ancestors.length >= (openDirectory ? 31 : 64)) {
        setRevealError("目录层级过深，请输入更近的父目录路径。")
        return
      }
    }
    pendingOpenRef.current = null
    if (openDirectory) {
      // 将定位路径上的缓存移到最近使用位置；旧分页未含目标节点时从第一页重新定位。
      const chain = [nextRoot, ...[...ancestors].reverse(), target]
      setDirectories(current => {
        const next = { ...current }
        for (const [index, directory] of chain.entries()) {
          const state = current[directory]
          if (!state) continue
          delete next[directory]
          const child = chain[index + 1]
          if (child && state.startCursor && state.startCursor !== "0" && !state.page?.entries.some(item => item.path === child)) {
            requestsRef.current.delete(directory)
          } else next[directory] = state
        }
        return next
      })
    }
    const parent = parentRemotePath(target)
    const parentPage = directories[parent]
    if (!openDirectory && parentPage?.startCursor && parentPage.startCursor !== "0" && !parentPage.page?.entries.some((item) => item.path === target) && !requestsRef.current.has(parent)) void load(parent)
    pendingScrollRef.current = null
    setRoot(nextRoot)
    setExpanded((current) => new Set([...current, ...ancestors, nextRoot]))
    setSelected(target)
    setDraft(target)
    setEditingPath(false)
    setRevealError("")
    if (target.split("/").some((part) => part.startsWith("."))) setShowHidden(true)
    onPath(target)
    setReveal({ path: target, id: ++revealSequenceRef.current, openDirectory })
  }

  useEffect(() => {
    const pending = pendingOpenRef.current
    if (!pending) return
    const target = pending.path
    if (selected !== target) { pendingOpenRef.current = null; return }
    const entry = directories[parentRemotePath(target)]?.page?.entries.find((item) => item.path === target)
    if (!entry?.linkTargetType) return
    pendingOpenRef.current = null
    if (serverEntryType(entry) === "directory") {
      let ancestor = parentRemotePath(target)
      for (let depth = 0; depth < 64; depth += 1) {
        if ((directories[ancestor]?.page?.canonicalPath ?? ancestor) === entry.linkTarget) return
        if (ancestor === "/") break
        ancestor = parentRemotePath(ancestor)
      }
    }
    if (connected && ["directory", "file"].includes(serverEntryType(entry))) toggle(entry, pending.previewFile)
  }, [directories, connected, selected])

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
      else if (!entries.length && state.page.entries.length) result.push({ kind: "empty", directory, depth, message: "只有隐藏文件" })
      if (state?.page?.nextCursor) result.push({ kind: state.page.entries.length >= 2000 ? "limit" : "more", directory, depth })
      else if (state?.page?.truncated) result.push({ kind: "limit", directory, depth, message: "目录条目达到读取上限" })
    }
    append(root, 0)
    return result
  }, [directories, expanded, root, showHidden])

  const refreshVisibleDirectories = async (staleOnly = false) => {
    if (!connectedRef.current || refreshingRef.current) return
    const browserRoot = root
    const targets = [...new Set([root, path, ...rows.flatMap(row => row.kind === "entry" && !row.cycle && serverEntryType(row.entry) === "directory" && expanded.has(row.entry.path) ? [row.entry.path] : [])])]
      .filter(target => !staleOnly || needsDirectoryRead(directoriesRef.current[target]))
    if (!targets.length) return
    refreshingRef.current = true
    setRefreshing(true)
    const current = () => mountedRef.current && connectedRef.current && rootRef.current === browserRoot
    const refresh = async (target: string) => {
      if (current() && !requestsRef.current.has(target)) await load(target)
    }
    try {
      // 先刷新根目录，再以两个请求的并发补齐当前目录和可见展开分支。
      if (targets[0] === root) await refresh(targets.shift()!)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
        while (current() && next < targets.length) await refresh(targets[next++]!)
      }))
    } finally {
      refreshingRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }
  useEffect(() => {
    if (visible && connected) void refreshVisibleDirectories(true)
  }, [visible, connected])

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
      const entry = state.page.entries.find(item => item.path === child)
      if (entry?.type === "symlink" && !entry.linkTargetType) {
        if (state.metadataError) { setRevealError(state.metadataError); setReveal(null) }
        return
      }
      if (entry && (serverEntryType(entry) === "directory" || child === reveal.path)) continue
      if (state.page.nextCursor) { void load(directory, state.page.nextCursor, state.page.entries.length >= 2000); return }
      setRevealError("当前目录列表中未找到该项，请刷新后重试。")
      setReveal(null)
      return
    }
  }, [reveal, connected, directories, root, rows, load])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !reveal || !connected) return
    const index = rows.findIndex((row) => row.kind === "entry" && row.entry.path === reveal.path)
    if (index < 0) return
    if (reveal.openDirectory) {
      const row = rows[index]!
      if (row.kind !== "entry") return
      if (row.entry.type === "symlink" && !row.entry.linkTargetType) {
        const message = directories[parentRemotePath(reveal.path)]?.metadataError
        if (message) { setRevealError(message); setReveal(null) }
        return
      }
      if (row.cycle || serverEntryType(row.entry) !== "directory") {
        setRevealError(row.cycle ? "循环链接，无法打开收藏目录。" : "收藏路径已不是可打开的目录，请刷新后重试。")
        setReveal(null)
        return
      }
      setExpanded(current => new Set([...current, reveal.path]))
      if (needsDirectoryRead(directories[reveal.path]) && !requestsRef.current.has(reveal.path)) void load(reveal.path)
    }
    // 先滚动虚拟列表，再将焦点交给挂载后的目标行，保留目录上下文。
    element.scrollTop = Math.max(0, index * rowHeight - Math.min(rowHeight * 3, element.clientHeight / 4))
    setViewport({ scrollTop: element.scrollTop, height: element.clientHeight })
    const id = reveal.id
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mountedRef.current && revealSequenceRef.current === id) element.querySelector<HTMLButtonElement>('[data-tree-index="' + index + '"]')?.focus({ preventScroll: true })
    }))
    setReveal(null)
  }, [reveal, connected, rows, rowHeight, directories, load])

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
        <DirectoryBookmarks key={directoryBookmarksKey(scope)} scope={scope} path={path} connected={connected} visible={visible} onNavigate={target => revealDirectory(target, true)} />
        <Button size="icon-sm" variant="ghost" aria-label="收起所有目录" title="收起所有目录" onClick={() => { setExpanded(new Set()); if (scrollRef.current) scrollRef.current.scrollTop = 0 }}><CaretUpDown /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="显示隐藏文件" title={showHidden ? "隐藏点文件" : "显示隐藏文件"} aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye /> : <EyeSlash />}</Button>
        <WorkspaceIconButton action="refresh" label="刷新目录" disabled={!connected || refreshing} busy={refreshing} onClick={() => { void refreshVisibleDirectories() }} />
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
          const pending = entry.type === "symlink" && !entry.linkTargetType
          const metadataError = directories[parentRemotePath(entry.path)]?.metadataError
          const targetType = serverEntryType(entry)
          const isDirectory = targetType === "directory"
          const open = expanded.has(entry.path)
          const supported = !row.cycle && (isDirectory || targetType === "file")
          const activate = (previewFile: boolean) => {
            if (!connected) return
            if (pending) {
              pendingOpenRef.current = { path: entry.path, previewFile }
              revealSequenceRef.current += 1
              setReveal(null)
              setRevealError("")
              setSelected(entry.path)
              const directory = parentRemotePath(entry.path)
              setDirectories(current => ({ ...current, [directory]: { ...current[directory]!, metadataError: undefined } }))
            } else if (supported) toggle(entry, previewFile)
          }
          return <div key={`entry:${entry.path}`} data-tree-index={index} tabIndex={0} className={"server-tree-row" + (entry.type === "symlink" ? " server-tree-link" : "")} role="treeitem" aria-level={row.depth + 1} aria-selected={selected === entry.path} {...(isDirectory ? { "aria-expanded": open } : {})} aria-disabled={(!supported && !pending) || !connected} style={style} title={entry.type === "symlink" ? `${entry.path}${entry.linkTarget ? " → " + entry.linkTarget : ""}${row.cycle ? "（循环链接）" : pending ? metadataError ? "（链接信息读取失败，点击重试）" : "（正在读取链接信息）" : supported ? "" : "（目标不可用或不支持打开）"}` : entry.path} draggable={connected && (supported || pending) && canDragWorkspacePath(entry.path)} onDragStart={event => {
            if (!connected || !(supported || pending) || (event.target as Element).closest("button") || !pathDrag.begin(event.dataTransfer, entry.path)) { event.preventDefault(); return }
            pendingOpenRef.current = null
            revealSequenceRef.current += 1
            setReveal(null)
            setRevealError("")
            setSelected(entry.path)
          }} onDragEnd={() => pathDrag.clear()} onClick={event => {
            if (!(event.target as Element).closest("button")) activate(false)
          }} onDoubleClick={event => {
            if ((event.target as Element).closest("button") || isDirectory) return
            event.preventDefault()
            activate(true)
          }} onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if ((event.key === "Enter" || event.key === " ") && (supported || pending) && connected) { event.preventDefault(); activate(event.key === "Enter"); return }
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
            {entry.type === "symlink" ? <span className="server-tree-link-target" title={entry.linkTarget ?? (pending ? metadataError ?? "正在读取链接信息" : "链接目标无法解析")}>→ {entry.linkTarget ?? (pending ? metadataError ? "点击重试" : "读取中…" : "目标不可用")}{row.cycle ? " · 循环链接" : targetType === "special" ? " · 特殊文件" : ""}</span> : null}
            {entry.type === "file" ? <Button className="server-tree-download" size="icon-sm" variant="ghost" disabled={!connected || downloadBusy} aria-label={`下载 ${entry.name}`} title="下载文件" onClick={event => { event.stopPropagation(); onDownload(entry) }}><DownloadSimple size={15} /></Button> : null}
          </div>
        })}
      </div>
    </div>
    <div className="server-file-footer"><span className="server-file-current-path" title={path}>{path}</span></div>
  </section>
}
