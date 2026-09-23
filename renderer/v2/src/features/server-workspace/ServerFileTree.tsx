import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { ArrowUp, Crosshair, DownloadSimple, CaretDown, CaretRight, CaretUpDown, Eye, EyeSlash, File, FileCode, FileText, FileZip, FolderSimple, FolderOpen, Link, PencilSimple, SpinnerGap, UploadSimple } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerDirectoryPage } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ServerFileMenu } from "./ServerFileMenu"
import { DirectoryBookmarks } from "./DirectoryBookmarks"
import { directoryBookmarksKey } from "./directory-bookmarks"
import { workspaceReadQueue } from "./workspace-read-queue"
import { createDirectoryReader } from "./directory-read-controller"
import { canDragWorkspacePath, type WorkspacePathDrag } from "./workspace-path-drag"
import { displayServerDirectoryEntries, isWorkspacePathStale, parentRemotePath, serverEntryType, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"
import { normalizeWorkspaceLocation, workspaceLocationAncestors } from "./workspace-location"

interface DirectoryState { readonly page?: ServerDirectoryPage; readonly loading: boolean; readonly readRequest?: number; readonly loadedAt?: number; readonly resumeRead?: boolean; readonly error?: string; readonly metadataError?: string | undefined; readonly startCursor?: string; readonly history?: readonly string[] }
interface DirectoryReadResult { readonly page: ServerDirectoryPage; readonly request: number }
interface DirectoryRefreshPreparation { readonly parents: readonly string[]; readonly pages: Promise<readonly DirectoryReadResult[] | undefined>; readonly current: () => boolean }
const DIRECTORY_TTL_MS = 30_000
const needsDirectoryRead = (state?: DirectoryState) => !state?.page || Date.now() - (state.loadedAt ?? 0) >= DIRECTORY_TTL_MS

type TreeRow = { readonly kind: "entry"; readonly entry: ServerDirectoryEntry; readonly depth: number; readonly cycle?: boolean }
  | { readonly kind: "loading" | "error" | "empty" | "more" | "limit" | "previous" | "cycle"; readonly directory: string; readonly depth: number; readonly message?: string }
interface ServerFileTreeProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly connected: boolean
  readonly serverLabel: string
  readonly visible: boolean
  readonly path: string
  readonly onPath: (path: string) => void
  readonly onPreview: (entry: ServerDirectoryEntry) => void
  readonly onDownload: (entry: ServerDirectoryEntry) => void
  readonly downloadBusy: boolean
  readonly onUpload: () => void
  readonly onUploadFiles: (path: string, files: readonly File[]) => void
  readonly onPasteFiles: (path: string) => void
  readonly uploadBlocked: boolean
  readonly pathDrag: WorkspacePathDrag
  readonly invalidatedPath: Readonly<{ path: string; id: number }> | null
  readonly locateFile?: Readonly<{ path: string; id: number }> | null
  readonly terminalSessionId: string | null
  readonly terminalLabel?: string
  readonly refreshEpoch: number
  readonly refreshPaths: readonly string[]
}

export function ServerFileTree({ api, scope, connected, serverLabel, visible, path, onPath, onPreview, onUpload, onUploadFiles, onPasteFiles, uploadBlocked, onDownload, downloadBusy, pathDrag, refreshEpoch, refreshPaths, invalidatedPath, locateFile, terminalSessionId, terminalLabel }: ServerFileTreeProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const canReceiveFiles = connected && visible && !uploadBlocked
  const pasteShortcut = /Mac/iu.test(navigator.platform) ? "⌘V" : "Ctrl+V"
  const useNativeFileClipboard = /Win/iu.test(navigator.platform)
  const hasFiles = (data: DataTransfer) => data.types.includes("Files") && !data.types.includes("application/x-runbook-workspace-path")
  const uploadTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest("input, textarea, [contenteditable=true]")) return null
    const row = target.closest<HTMLElement>("[data-upload-path]")
    return row ? row.dataset.uploadPath || null : path
  }
  const receiveDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const target = canReceiveFiles ? uploadTarget(event.target) : null
    event.dataTransfer.dropEffect = target ? "copy" : "none"
    setDropTarget(target)
  }
  useEffect(() => {
    setDropTarget(null)
    if (!visible) return
    const clear = () => setDropTarget(null)
    // 阻止外部文件在窗口中触发默认导航，具体上传只由文件树落点接收。
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
    }
    window.addEventListener("dragover", preventFileNavigation)
    window.addEventListener("drop", preventFileNavigation)
    window.addEventListener("dragend", clear)
    window.addEventListener("blur", clear)
    return () => {
      window.removeEventListener("dragover", preventFileNavigation)
      window.removeEventListener("drop", preventFileNavigation)
      window.removeEventListener("dragend", clear)
      window.removeEventListener("blur", clear)
    }
  }, [connected, visible, uploadBlocked])
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const refreshGenerationRef = useRef(0)
  const pendingVisibilityRefreshRef = useRef(false)
  const [refreshResumeEpoch, setRefreshResumeEpoch] = useState(0)
  const root = "/"
  const [draft, setDraft] = useState("/")
  const [editingPath, setEditingPath] = useState(false)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["/"]))
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState("/")
  const [reveal, setReveal] = useState<Readonly<{ path: string; id: number; expectDirectory?: boolean; terminalSessionId?: string }> | null>(null)
  const [revealError, setRevealError] = useState("")
  const revealSequenceRef = useRef(0)
  const revealLoadedRef = useRef(new Set<string>())
  const revealOriginRef = useRef<{ directories: Record<string, DirectoryState>; expanded: ReadonlySet<string>; scrollTop: number; requestSequence: number } | null>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 500 })
  const metadataRequestsRef = useRef(new Set<string>())
  const pendingOpenRef = useRef<{ path: string; previewFile: boolean } | null>(null)
  const requestsRef = useRef(new Map<string, number>())
  const readQueue = useMemo(() => workspaceReadQueue(api), [api])
  const readOwner = useRef({}).current
  const directoryReader = useMemo(() => createDirectoryReader(api, scope), [api, scope])
  const visibleDirectoriesRef = useRef<ReadonlySet<string>>(new Set([root]))
  const requestSequenceRef = useRef(0)
  const mountedRef = useRef(true)
  const directoriesRef = useRef(directories)
  const pendingScrollRef = useRef<number | null>(null)
  const [locatingTerminal, setLocatingTerminal] = useState(false)
  const terminalRequestRef = useRef(0)
  const terminalSessionRef = useRef(terminalSessionId)
  terminalSessionRef.current = terminalSessionId
  useEffect(() => { terminalRequestRef.current += 1; setLocatingTerminal(false) }, [terminalSessionId, connected, visible])
  directoriesRef.current = directories
  const rootRef = useRef(root)
  const pathRef = useRef(path)
  pathRef.current = path
  const scrollRef = useRef<HTMLDivElement>(null)
  rootRef.current = root
  const rowHeight = 32
  const breadcrumbs = path.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: "/" + parts.slice(0, index + 1).join("/") }))
  useEffect(() => { if (editingPath) { pathInputRef.current?.focus(); pathInputRef.current?.select() } }, [editingPath])

  const cancelPendingReveal = () => {
    const origin = revealOriginRef.current
    if (origin) {
      const cancelled = new Set<string>()
      for (const [directory, request] of requestsRef.current) if (request > origin.requestSequence) {
        requestsRef.current.delete(directory)
        cancelled.add(directory)
      }
      if (cancelled.size) setDirectories(current => Object.fromEntries(Object.entries(current).map(([directory, state]) => [directory, cancelled.has(directory) ? { ...state, loading: false } : state])))
    }
    setReveal(null)
    revealOriginRef.current = null
  }

  const invalidate = useCallback((target: string) => {
    const affected = (value: string) => value === target || value.startsWith(target.replace(/\/$/u, "") + "/")
    for (const key of requestsRef.current.keys()) if (affected(key)) requestsRef.current.delete(key)
    setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !affected(key))))
  }, [])

  const cancelQueuedDirectoryReads = useCallback((target?: string) => {
    directoryReader.cancel(directory => target ? directory === target || directory.startsWith(target.replace(/\/$/u, "") + "/") : directory !== root)
    readQueue.cancel(readOwner, key => {
      if (!key.startsWith("read:") && !key.startsWith("links:")) return false
      const directory = key.slice(key.indexOf(":") + 1)
      return target ? directory === target || directory.startsWith(target.replace(/\/$/u, "") + "/") : directory !== root
    })
  }, [readQueue, readOwner, root, directoryReader])

  const load = useCallback(async (directory: string, cursor?: string, replace = false, previous = false, reconcile = true, options: { preparation?: DirectoryRefreshPreparation; background?: boolean } = {}): Promise<DirectoryReadResult | undefined> => {
    const { preparation, background = false } = options
    if (!mountedRef.current || !connectedRef.current) return
    if (!visibleRef.current) {
      // 隐藏后的错误恢复和定位只标记过期，返回目录树时再读取。
      requestsRef.current.delete(directory)
      setDirectories(current => current[directory]?.loadedAt === 0 && !current[directory]?.loading ? current : { ...current, [directory]: { ...current[directory], loading: false, loadedAt: 0 } })
      return
    }
    const request = ++requestSequenceRef.current
    requestsRef.current.set(directory, request)
    setDirectories((current) => ({ ...current, [directory]: { ...current[directory], loading: true, readRequest: request, resumeRead: false, error: "" } }))
    let refreshedParents: readonly DirectoryReadResult[] | undefined
    const preparedIsCurrent = () => !preparation || (preparation.current() && refreshedParents?.length === preparation.parents.length && preparation.parents.every((parent, index) => {
      const page = refreshedParents![index]!.page
      const child = preparation.parents[index + 1] ?? directory
      // 快照编号对兼容读取可选；父页仍由请求代次、当前状态和目录类型绑定。
      return page.path === parent && page.canonicalPath === parent && page.entries.some(entry => entry.path === child && entry.type === "directory")
    }))
    const preparedPagesAreCurrent = (current: Record<string, DirectoryState>) => !preparation || Boolean(refreshedParents?.every(({ page, request: parentRequest }) => {
      const state = current[page.path]
      return state?.readRequest === parentRequest && !state.loading && state.loadedAt !== 0 && !state.error && state.page?.snapshotId === page.snapshotId
    }))
    const waitForParents = async () => {
      if (preparation) refreshedParents = await preparation.pages
      return preparedIsCurrent()
    }
    const discardPrepared = () => setDirectories(current => current[directory]?.readRequest !== request ? current : { ...current, [directory]: { ...current[directory], loading: false, loadedAt: 0 } })
    try {
      const snapshotId = cursor ? directoriesRef.current[directory]?.page?.snapshotId : undefined
      const result = await readQueue.run(readOwner, "read:" + directory,
        () => directoryReader.read({ path: directory, deferLinks: true, ...(snapshotId ? { snapshotId } : {}), ...(cursor ? { cursor } : {}) }),
        () => mountedRef.current && connectedRef.current && visibleRef.current && requestsRef.current.get(directory) === request && (!preparation || preparation.current()), { background })
      if (result === undefined) {
        if (mountedRef.current && requestsRef.current.get(directory) === request) setDirectories(current => ({ ...current, [directory]: { ...current[directory], loading: false, loadedAt: 0, resumeRead: !preparation } }))
        return
      }
      const page = unwrapWorkspaceResult(result)
      // 预备读取先释放共享名额，再等全部祖先结果；未验证分支和已改向的目录不发布。
      if (!await waitForParents() || (preparation && page.canonicalPath !== directory)) { discardPrepared(); return }
      if (!mountedRef.current || requestsRef.current.get(directory) !== request) return
      setDirectories((current) => {
        const old = current[directory]
        // 祖先与子结果可能在同一批 React 更新中提交，必须在更新函数内复核。
        if (old?.readRequest !== request) return current
        if (preparation && (!preparedIsCurrent() || !preparedPagesAreCurrent(current))) return { ...current, [directory]: { ...old, loading: false, loadedAt: 0 } }
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
        if (old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) for (const cached of Object.keys(retained)) if (cached !== directory && cached.startsWith(directory.replace(/\/$/u, "") + "/")) {
          delete retained[cached]
          requestsRef.current.delete(cached)
        }
        if (cursor && old?.page?.canonicalPath && old.page.canonicalPath !== page.canonicalPath) return { ...retained, [directory]: { loading: false, error: "链接目标已变化，请重新读取目录。" } }
        const next: Record<string, DirectoryState> = { ...retained, [directory]: { loading: false, readRequest: request, loadedAt: cursor ? old?.loadedAt ?? Date.now() : Date.now(), startCursor: replace ? cursor ?? "0" : cursor ? old?.startCursor ?? "0" : "0", history: replace ? previous ? old?.history?.slice(0, -1) ?? [] : [...(old?.history ?? []), old?.startCursor ?? "0"] : cursor ? old?.history ?? [] : [], page: { ...page, entries: cursor && !replace ? [...(old?.page?.entries ?? []), ...page.entries].slice(0, 2000) : page.entries } } }
        // 限制后台保留的目录与条目；虚拟列表只挂载视口附近的行。
        while (Object.keys(next).length > 32 || Object.values(next).reduce((sum, item) => sum + (item.page?.entries.length ?? 0), 0) > 5000) {
          const oldest = Object.keys(next).find((key) => key !== directory && key !== rootRef.current && !next[key]?.loading)
          if (!oldest) break
          delete next[oldest]
        }
        return next
      })
      return { page, request }
    } catch (failure) {
      if (failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_READ_CANCELLED") {
        if (mountedRef.current && requestsRef.current.get(directory) === request) setDirectories(current => ({ ...current, [directory]: { ...current[directory], loading: false, loadedAt: 0, resumeRead: !preparation } }))
        return
      }
      if (!await waitForParents()) { discardPrepared(); return }
      if (mountedRef.current && requestsRef.current.get(directory) === request) {
        if (failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_DIRECTORY_EXPIRED" && cursor) {
          await load(directory)
          return
        }
        const stale = isWorkspacePathStale(failure)
        if (stale) invalidate(directory)
        setDirectories((current) => {
          if (preparation && (!preparedIsCurrent() || !preparedPagesAreCurrent(current) || (current[directory]?.readRequest !== undefined && current[directory]?.readRequest !== request))) return current
          return { ...current, [directory]: { ...current[directory], loading: false, error: workspaceErrorMessage(failure) } }
        })
        if (stale && reconcile && directory !== "/") await load(parentRemotePath(directory), undefined, false, false, false)
      }
    } finally {
      if (requestsRef.current.get(directory) === request) requestsRef.current.delete(directory)
    }
  }, [api, connected, scope, invalidate, readQueue, readOwner, directoryReader])

  useEffect(() => {
    if (!connected || !visible) return
    // 后台最多补齐两个目录页；根据快照合并，旧响应不能覆盖刷新或分页后的新数据。
    for (const [directory, state] of Object.entries(directories)) {
      const page = state.page
      if (!visibleDirectoriesRef.current.has(directory) || !page?.snapshotId || state.loading || state.loadedAt === 0 || state.metadataError) continue
      const offsets = new Set(page.entries.flatMap((entry, index) => entry.type === "symlink" && !entry.linkTargetType ? [Number(state.startCursor ?? 0) + Math.floor(index / 200) * 200] : []))
      for (const offset of offsets) {
        const key = page.snapshotId + ":" + offset
        if (metadataRequestsRef.current.has(key) || metadataRequestsRef.current.size >= 2) continue
        metadataRequestsRef.current.add(key)
        void (async () => {
          try {
            const result = await readQueue.run(readOwner, "links:" + directory,
              () => directoryReader.read({ path: directory, snapshotId: page.snapshotId!, cursor: String(offset), deferLinks: true, resolveLinks: true }),
              () => mountedRef.current && connectedRef.current && visibleRef.current && visibleDirectoriesRef.current.has(directory) && directoriesRef.current[directory]?.page?.snapshotId === page.snapshotId && !directoriesRef.current[directory]?.loading && directoriesRef.current[directory]?.loadedAt !== 0, { background: true })
            if (result === undefined) return
            const metadata = unwrapWorkspaceResult(result)
            if (!mountedRef.current) return
            setDirectories((current) => {
              const latest = current[directory]
              if (!latest?.page || latest.page.snapshotId !== metadata.snapshotId || latest.loading) return current
              const updates = new Map(metadata.entries.map((entry) => [entry.path, entry]))
              return { ...current, [directory]: { ...latest, page: { ...latest.page, entries: latest.page.entries.map((entry) => updates.get(entry.path) ?? entry) } } }
            })
          } catch (failure) {
            if (failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_READ_CANCELLED") {
              if (mountedRef.current) setDirectories(current => current[directory]?.page?.snapshotId !== page.snapshotId || current[directory]?.loading ? current : { ...current, [directory]: { ...current[directory]!, loadedAt: 0, resumeRead: true } })
              return
            }
            const latest = directoriesRef.current[directory]
            const expired = failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_DIRECTORY_EXPIRED"
            const stale = expired || isWorkspacePathStale(failure)
            if (mountedRef.current && visibleRef.current && connectedRef.current && visibleDirectoriesRef.current.has(directory) && latest?.page?.snapshotId === page.snapshotId && !latest!.loading && stale) void load(directory)
            if (mountedRef.current) setDirectories((current) => !current[directory]?.page || current[directory]?.page?.snapshotId !== page.snapshotId ? current : { ...current, [directory]: { ...current[directory]!, ...(stale ? { loadedAt: 0 } : {}), metadataError: workspaceErrorMessage(failure) } })
          } finally {
            metadataRequestsRef.current.delete(key)
            // 释放队列槽后继续处理其余页，不使用轮询计时器。
            if (mountedRef.current) setDirectories((current) => ({ ...current }))
          }
        })()
      }
    }
  }, [api, connected, visible, directories, expanded, scope, load, readQueue, readOwner, directoryReader])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; requestsRef.current.clear(); readQueue.cancel(readOwner); directoryReader.cancel() }
  }, [readQueue, readOwner, directoryReader])
  useEffect(() => { if (!visible || !connected) { readQueue.cancel(readOwner); directoryReader.cancel() } }, [visible, connected, readQueue, readOwner, directoryReader])
  useEffect(() => {
    if (!connected) { requestsRef.current.clear(); revealSequenceRef.current += 1; cancelPendingReveal(); setDirectories({}); return }
    if (needsDirectoryRead(directoriesRef.current[root]) && !requestsRef.current.has(root)) void load(root)
  }, [connected, load, root])
  useEffect(() => {
    if (!invalidatedPath || !connected) return
    invalidate(invalidatedPath.path)
    void load(parentRemotePath(invalidatedPath.path))
  }, [invalidatedPath, connected, invalidate, load])
  useEffect(() => {
    if (!refreshEpoch || !connected) return
    const targets = new Set([path, ...refreshPaths])
    if (visibleRef.current) { for (const target of targets) void load(target); return }
    // 隐藏期间累积过期目录；旧读取不能把上传完成前的内容重新标记为最新。
    for (const target of targets) requestsRef.current.delete(target)
    setDirectories(current => {
      const next = { ...current }
      for (const target of targets) if (next[target]) next[target] = { ...next[target], loadedAt: 0, loading: false }
      return next
    })
  }, [refreshEpoch])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toggle = (entry: ServerDirectoryEntry, previewFile = true) => {
    pendingOpenRef.current = null
    revealSequenceRef.current += 1
    cancelPendingReveal()
    setRevealError("")
    setSelected(entry.path)
    if (serverEntryType(entry) === "directory") {
      onPath(entry.path)
      if (expanded.has(entry.path)) cancelQueuedDirectoryReads(entry.path)
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
    revealPath(locateFile.path)
    void load(parentRemotePath(locateFile.path))
  }, [locateFile])

  const beginPathEditing = () => {
    revealSequenceRef.current += 1
    cancelPendingReveal()
    pendingOpenRef.current = null
    setRevealError("")
    setDraft(path)
    setEditingPath(true)
  }

  const revealPath = (target: string, expectDirectory = false, sourceSessionId?: string) => {
    if (!connected) return
    revealSequenceRef.current += 1
    cancelPendingReveal()
    let ancestors: string[]
    try {
      target = normalizeWorkspaceLocation(target)
      ancestors = workspaceLocationAncestors(target)
    } catch (failure) {
      setRevealError(workspaceErrorMessage(failure))
      return
    }
    pendingOpenRef.current = null
    setRevealError("")
    setDraft(target)
    setEditingPath(false)
    if (target === "/") {
      setSelected("/")
      onPath("/")
      pendingScrollRef.current = 0
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      return
    }
    // 所有定位都从根目录保留完整祖先链；旧分页未含目标时从第一页查找。
    revealOriginRef.current = { directories: directoriesRef.current, expanded, scrollTop: scrollRef.current?.scrollTop ?? 0, requestSequence: requestSequenceRef.current }
    revealLoadedRef.current.clear()
    const chain = [...ancestors, target]
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
    pendingScrollRef.current = null
    setExpanded(current => new Set([...current, ...ancestors]))
    if (target.split("/").some(part => part.startsWith("."))) setShowHidden(true)
    setReveal({ path: target, id: revealSequenceRef.current, expectDirectory, ...(sourceSessionId ? { terminalSessionId: sourceSessionId } : {}) })
  }

  const failReveal = (message: string) => {
    const origin = revealOriginRef.current
    cancelPendingReveal()
    setRevealError(message)
    if (origin) {
      setDirectories(Object.fromEntries(Object.entries(origin.directories).map(([directory, state]) => [directory, { ...state, loading: requestsRef.current.has(directory) }])))
      setExpanded(origin.expanded)
      pendingScrollRef.current = origin.scrollTop
    }
  }

  useEffect(() => {
    if (reveal?.terminalSessionId && (!visible || reveal.terminalSessionId !== terminalSessionId)) {
      revealSequenceRef.current += 1
      failReveal("")
    }
  }, [reveal, visible, terminalSessionId])

  const locateTerminalDirectory = async () => {
    if (!connected || !terminalSessionId || locatingTerminal) return
    const request = ++terminalRequestRef.current
    const navigation = revealSequenceRef.current
    setLocatingTerminal(true)
    setRevealError("")
    const current = () => mountedRef.current && connectedRef.current && terminalRequestRef.current === request && terminalSessionRef.current === terminalSessionId && revealSequenceRef.current === navigation
    try {
      const result = unwrapWorkspaceResult(await api.serverTerminalWorkingDirectory({ ...scope, sessionId: terminalSessionId }))
      if (current()) revealPath(result.path, true, terminalSessionId)
    } catch (failure) {
      if (current()) setRevealError(workspaceErrorMessage(failure))
    } finally {
      if (mountedRef.current && terminalRequestRef.current === request) setLocatingTerminal(false)
    }
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
      // 只排序展示副本，让已解析的目录链接归入文件夹组，保留原始分页位置供元数据请求使用。
      const entries = displayServerDirectoryEntries(state?.page?.entries, showHidden)
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

  visibleDirectoriesRef.current = useMemo(() => new Set([root, ...rows.flatMap(row => row.kind === "entry" && !row.cycle && serverEntryType(row.entry) === "directory" && expanded.has(row.entry.path) ? [row.entry.path] : [])]), [root, rows, expanded])
  const refreshTargetsRef = visibleDirectoriesRef

  useEffect(() => {
    if (!visible || !connected) return
    // 只恢复队列撤销的读取，普通读取失败仍由用户决定何时重试。
    for (const directory of visibleDirectoriesRef.current) {
      const state = directories[directory]
      if (state?.resumeRead && !state.loading && !requestsRef.current.has(directory)) void load(directory)
    }
  }, [visible, connected, directories, expanded, load])

  const refreshVisibleDirectories = async (staleOnly = false) => {
    if (!connectedRef.current || !visibleRef.current) return
    if (refreshingRef.current) {
      if (staleOnly) pendingVisibilityRefreshRef.current = true
      return
    }
    const browserRoot = root
    const generation = refreshGenerationRef.current
    const targets = [...refreshTargetsRef.current].filter(target => !staleOnly || needsDirectoryRead(directoriesRef.current[target]))
    if (!targets.length) return
    refreshingRef.current = true
    setRefreshing(true)
    const current = () => mountedRef.current && connectedRef.current && visibleRef.current && refreshGenerationRef.current === generation && rootRef.current === browserRoot
    const selectedDirectory = pathRef.current
    const parents: string[] = []
    for (let parent = parentRemotePath(selectedDirectory); selectedDirectory !== root; parent = parentRemotePath(parent)) {
      parents.unshift(parent)
      if (parent === root || parent === "/" || parents.length > 64) break
    }
    const prepareSelected = targets[0] === root && selectedDirectory !== root && parents[0] === root && parents.length <= 64
      && targets.includes(selectedDirectory) && !requestsRef.current.has(selectedDirectory)
      && directoriesRef.current[selectedDirectory]?.page?.canonicalPath === selectedDirectory
      && parents.every((parent, index) => {
        const page = directoriesRef.current[parent]?.page
        const child = parents[index + 1] ?? selectedDirectory
        return targets.includes(parent) && !requestsRef.current.has(parent) && page?.canonicalPath === parent && Boolean(page.snapshotId)
          && page.entries.some(entry => entry.path === child && entry.type === "directory")
      })
    const refreshed = new Map<string, DirectoryReadResult | undefined>()
    let releasePrepared: ((pages: readonly DirectoryReadResult[] | undefined) => void) | undefined
    const parentPages = prepareSelected ? new Promise<readonly DirectoryReadResult[] | undefined>(resolve => { releasePrepared = resolve }) : undefined
    const refresh = async (target: string) => {
      let page: DirectoryReadResult | undefined
      // 刷新其他分支时让出排队优先级；当前目录和祖先仍优先完成验证。
      if (current() && refreshTargetsRef.current.has(target) && !requestsRef.current.has(target)) page = await load(target, undefined, false, false, true, { background: target !== root && target !== pathRef.current && !parents.includes(target) })
      if (prepareSelected && parents.includes(target)) {
        refreshed.set(target, page)
        if (!page) releasePrepared?.(undefined)
        else if (refreshed.size === parents.length) releasePrepared?.(parents.map(parent => refreshed.get(parent)!))
      }
      return page
    }
    let prepared: Promise<DirectoryReadResult | undefined> | undefined
    try {
      if (targets[0] === root) {
        const rootPage = refresh(targets.shift()!)
        if (parentPages) {
          targets.splice(targets.indexOf(selectedDirectory), 1)
          prepared = load(selectedDirectory, undefined, false, false, false, { preparation: { parents, pages: parentPages, current: () => current() && pathRef.current === selectedDirectory && refreshTargetsRef.current.has(selectedDirectory) } })
        }
        await rootPage
      }
      let next = 0
      // 祖先仍由原有两个执行位刷新；只有整条普通目录链都确认后才发布预备结果。
      await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
        while (current() && next < targets.length) await refresh(targets[next++]!)
      }))
    } finally {
      // 隐藏或收起可跳过尚未刷新祖先，必须解除发布等待并保留过期状态。
      releasePrepared?.(undefined)
      await prepared
      refreshingRef.current = false
      if (mountedRef.current) setRefreshing(false)
      const resume = pendingVisibilityRefreshRef.current
      pendingVisibilityRefreshRef.current = false
      if (resume && mountedRef.current && visibleRef.current && connectedRef.current) setRefreshResumeEpoch(value => value + 1)
    }
  }
  useEffect(() => {
    // 隐藏后停止补发；快速返回时等在途请求收尾，再按最新分支补齐过期数据。
    if (!visible || !connected) { refreshGenerationRef.current += 1; pendingVisibilityRefreshRef.current = false; return }
    void refreshVisibleDirectories(true)
  }, [visible, connected, refreshResumeEpoch])

  useEffect(() => {
    if (!reveal || !connected || !visible || (reveal.terminalSessionId && reveal.terminalSessionId !== terminalSessionId) || rows.some((row) => row.kind === "entry" && row.entry.path === reveal.path)) return
    const chain: string[] = []
    for (let current = parentRemotePath(reveal.path); ; current = parentRemotePath(current)) {
      chain.unshift(current)
      if (current === root || current === "/" || chain.length > 64) break
    }
    if (chain.length > 64) { failReveal("路径层级超过目录树定位上限。"); return }
    const seen = new Set<string>()
    for (let index = 0; index < chain.length; index += 1) {
      const directory = chain[index]!
      const state = directories[directory]
      if (state?.loading || requestsRef.current.has(directory)) return
      if (state?.error) { failReveal(state.error); return }
      if (!state?.page) {
        if (revealLoadedRef.current.has(directory)) { failReveal("目录树已达到缓存上限，无法继续定位。"); return }
        void load(directory)
        return
      }
      revealLoadedRef.current.add(directory)
      const canonical = state.page.canonicalPath ?? directory
      if (seen.has(canonical)) { failReveal("循环链接，无法继续定位。"); return }
      seen.add(canonical)
      const child = chain[index + 1] ?? reveal.path
      const entry = state.page.entries.find(item => item.path === child)
      if (entry?.type === "symlink" && !entry.linkTargetType) {
        if (state.metadataError) { failReveal(state.metadataError) }
        return
      }
      if (entry && (serverEntryType(entry) === "directory" || child === reveal.path)) continue
      if (state.page.nextCursor) { void load(directory, state.page.nextCursor, state.page.entries.length >= 2000); return }
      failReveal("当前目录列表中未找到该项，请刷新后重试。")
      return
    }
  }, [reveal, connected, visible, terminalSessionId, directories, root, rows, load])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !reveal || !connected || !visible || (reveal.terminalSessionId && reveal.terminalSessionId !== terminalSessionId)) return
    const index = rows.findIndex((row) => row.kind === "entry" && row.entry.path === reveal.path)
    if (index < 0) return
    const row = rows[index]!
    if (row.kind !== "entry") return
    if (row.entry.type === "symlink" && !row.entry.linkTargetType) {
      const message = directories[parentRemotePath(reveal.path)]?.metadataError
      if (message) { failReveal(message) }
      return
    }
    const isDirectory = serverEntryType(row.entry) === "directory"
    if (row.cycle || (reveal.expectDirectory && !isDirectory)) {
      failReveal(row.cycle ? "循环链接，无法继续定位。" : "该路径已不是可打开的目录，请刷新后重试。")
      return
    }
    setSelected(reveal.path)
    onPath(isDirectory ? reveal.path : parentRemotePath(reveal.path))
    if (isDirectory) {
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
    revealOriginRef.current = null
  }, [reveal, connected, visible, terminalSessionId, rows, rowHeight, directories, load])

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

  return <section className="server-file-tree" aria-label="服务器目录树" onKeyDownCapture={event => {
    if (!useNativeFileClipboard || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "v") return
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target) || !event.target.closest(".server-tree-scroll")) return
    const target = uploadTarget(event.target)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (canReceiveFiles && !event.repeat) onPasteFiles(target)
  }} onPaste={event => {
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return
    const target = uploadTarget(event.target)
    if (!target) return
    const nativeFiles = useNativeFileClipboard && event.nativeEvent.isTrusted
    if (!nativeFiles && !hasFiles(event.clipboardData)) return
    event.preventDefault()
    event.stopPropagation()
    if (canReceiveFiles) {
      if (nativeFiles) onPasteFiles(target)
      else onUploadFiles(target, Array.from(event.clipboardData.files))
    }
  }}>
    <div className="server-file-toolbar">
      <div className="server-file-actions">
        <DirectoryBookmarks key={directoryBookmarksKey(scope)} scope={scope} path={path} connected={connected} visible={visible} onNavigate={target => revealPath(target, true)} />
        <Button size="icon-sm" variant="ghost" aria-label="收起所有目录" title="收起所有目录" onClick={() => { revealSequenceRef.current += 1; cancelPendingReveal(); cancelQueuedDirectoryReads(); setExpanded(new Set()); if (scrollRef.current) scrollRef.current.scrollTop = 0 }}><CaretUpDown /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="显示隐藏文件" title={showHidden ? "隐藏点文件" : "显示隐藏文件"} aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye /> : <EyeSlash />}</Button>
        <Button size="icon-sm" variant="ghost" aria-label="定位终端当前目录" title={terminalLabel ? "定位 " + terminalLabel + " 的工作目录" : "定位当前终端的工作目录"} disabled={!connected || !terminalSessionId || locatingTerminal} onClick={() => { void locateTerminalDirectory() }}>{locatingTerminal ? <SpinnerGap className="animate-spin" /> : <Crosshair />}</Button>
        <WorkspaceIconButton action="refresh" label="刷新目录" disabled={!connected || refreshing} busy={refreshing} onClick={() => { void refreshVisibleDirectories() }} />
        <Button size="icon-sm" variant="ghost" title={`上传文件，也可选择目录后按 ${pasteShortcut} 或拖入本地文件`} aria-label="上传文件" disabled={!canReceiveFiles} onClick={onUpload}><UploadSimple /></Button>
      </div>
    </div>
    <div className="server-file-navigation">
      <Button size="icon-sm" type="button" variant="ghost" aria-label="上级目录" title="上级目录" disabled={path === "/" || !connected} onClick={() => revealPath(parentRemotePath(path))}><ArrowUp /></Button>
      {editingPath ? <form className="server-path-editor" onSubmit={(event) => { event.preventDefault(); revealPath(draft) }}>
        <Input ref={pathInputRef} aria-label="目录路径" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditingPath(false) } }} disabled={!connected} spellCheck={false} />
        <Button type="submit" size="sm" variant="ghost" disabled={!connected || !draft.startsWith("/")}>转到</Button>
      </form> : <>
        <nav className="server-path-breadcrumbs" aria-label="当前目录" title={path} onClick={event => { if (connected && event.target === event.currentTarget) { beginPathEditing() } }} onDoubleClick={event => { if (connected && !(event.target as Element).closest("button")) { beginPathEditing() } }}>
          <button type="button" disabled={!connected} onClick={() => revealPath("/")} aria-label="根目录">/</button>
          {breadcrumbs.map((item, index) => <span key={item.path}><CaretRight size={11} /><button type="button" disabled={!connected} aria-current={index === breadcrumbs.length - 1 ? "location" : undefined} title={`定位到 ${item.path}`} onClick={() => revealPath(item.path)}>{item.name}</button></span>)}
        </nav>
        <Button size="icon-sm" variant="ghost" aria-label="编辑目录路径" title="输入路径" disabled={!connected} onClick={() => { beginPathEditing() }}><PencilSimple /></Button>
      </>}
    </div>
    {revealError ? <div className="px-3 py-2 text-xs text-danger" role="status">{revealError}</div> : null}
    <ServerFileMenu api={api} scope={scope} serverLabel={serverLabel} connected={connected} visible={visible} downloadBusy={downloadBusy} onDownload={onDownload}
      resolveTarget={element => {
        const rowElement = element.closest<HTMLElement>("[data-tree-index]")
        const row = rowElement ? rows[Number(rowElement.dataset.treeIndex)] : null
        const entry = row?.kind === "entry" ? row.entry : null
        return { entry, directory: entry ? serverEntryType(entry) === "directory" ? entry.path : parentRemotePath(entry.path) : element.closest<HTMLElement>("[data-upload-path]")?.dataset.uploadPath || path }
      }}
      onSelect={entry => { pendingOpenRef.current = null; setSelected(entry.path) }}
      onRefresh={target => { void load(target) }}
      onChanged={result => {
        if (result.kind === "delete") {
          pendingOpenRef.current = null
          invalidate(result.path)
          invalidate(result.parentPath)
          setExpanded(current => new Set([...current].filter(value => value !== result.path && !value.startsWith(result.path + "/"))))
          revealPath(result.parentPath)
          return
        }
        if (result.kind === "rename") {
          invalidate(result.path)
          setExpanded(current => new Set([...current].filter(value => value !== result.path && !value.startsWith(result.path + "/"))))
        }
        invalidate(result.parentPath)
        const nextPath = result.kind === "rename" && (path === result.path || path.startsWith(result.path + "/")) ? result.destinationPath + path.slice(result.path.length) : result.destinationPath
        revealPath(nextPath)
      }}>
    <div className="server-tree-scroll" ref={scrollRef} role="tree" tabIndex={0} aria-label="远程文件目录" aria-description={`选择目录后按 ${pasteShortcut} 粘贴文件，或拖入本地文件上传`} data-upload-over={dropTarget !== null || undefined}
      onDragEnter={receiveDrag} onDragOver={receiveDrag} onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null)
      }} onDrop={event => {
        setDropTarget(null)
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        const target = uploadTarget(event.target)
        if (canReceiveFiles && target) onUploadFiles(target, Array.from(event.dataTransfer.files))
      }} onClick={event => {
        if (!(event.target as Element).closest("[data-tree-index], button")) event.currentTarget.focus()
      }} onScroll={(event) => setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset
          const style = { position: "absolute" as const, top: index * rowHeight, left: 0, right: 0, height: rowHeight, paddingLeft: 12 + row.depth * 18 }
          if (row.kind !== "entry") {
            const state = directories[row.directory]
            return <div key={`status:${row.kind}:${row.directory}`} data-upload-path={row.kind === "error" || row.kind === "cycle" ? "" : row.directory} style={style} className="flex min-w-0 items-center gap-1 pr-2 text-xs text-muted-foreground">
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
              cancelPendingReveal()
              setRevealError("")
              setSelected(entry.path)
              const directory = parentRemotePath(entry.path)
              setDirectories(current => ({ ...current, [directory]: { ...current[directory]!, metadataError: undefined } }))
            } else if (supported) toggle(entry, previewFile)
          }
          return <div key={`entry:${entry.path}`} data-tree-index={index} data-upload-path={supported ? isDirectory ? entry.path : parentRemotePath(entry.path) : ""} data-upload-over={dropTarget === entry.path && isDirectory || undefined} tabIndex={0} className={"server-tree-row" + (entry.type === "symlink" ? " server-tree-link" : "")} role="treeitem" aria-level={row.depth + 1} aria-selected={selected === entry.path} {...(isDirectory ? { "aria-expanded": open } : {})} aria-disabled={(!supported && !pending) || !connected} style={style} title={entry.type === "symlink" ? `${entry.path}${entry.linkTarget ? " → " + entry.linkTarget : ""}${row.cycle ? "（循环链接）" : pending ? metadataError ? "（链接信息读取失败，点击重试）" : "（正在读取链接信息）" : supported ? "" : "（目标不可用或不支持打开）"}` : entry.path} draggable={connected && (supported || pending) && canDragWorkspacePath(entry.path)} onDragStart={event => {
            if (!connected || !(supported || pending) || (event.target as Element).closest("button") || !pathDrag.begin(event.dataTransfer, entry.path)) { event.preventDefault(); return }
            pendingOpenRef.current = null
            revealSequenceRef.current += 1
            cancelPendingReveal()
            setRevealError("")
            setSelected(entry.path)
          }} onDragEnd={() => pathDrag.clear()} onClick={event => {
            if (!(event.target as Element).closest("button")) { event.currentTarget.focus(); activate(false) }
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
    </ServerFileMenu>
    {dropTarget !== null ? <div className="server-upload-drop-hint" role="status"><UploadSimple size={16} /><span>松开后确认上传到 <strong>{dropTarget}</strong></span></div> : null}
  </section>
}
