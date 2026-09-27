import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CaretDown, CaretUp, FileText, Pause, Play, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerFilePreview } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ServerFileEditor } from "./ServerFileEditor"
import { ServerFilePath } from "./ServerFilePath"
import { workspaceReadQueue } from "./workspace-read-queue"
import { filePreviewMatches, mergeFilePreview } from "./file-preview-model"
import { formatTransferBytes, isWorkspacePathStale, parentRemotePath, serverWorkspaceKey, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

interface PreviewTab { id: string; path: string; name: string; loading: boolean; mode: "head" | "tail"; following: boolean; clipped: boolean; update: string; data?: ServerFilePreview | undefined; error?: string | undefined; editing?: boolean; dirty?: boolean; busy?: boolean }
export interface FileDocuments {
  readonly items: readonly { id: string; label: string; title: string; path: string; dirty: boolean; content: ReactNode }[]
  readonly activation: { id: string; revision: number } | null
  readonly close: (id: string) => void
  readonly setVisible: (ids: readonly string[]) => void
  readonly notice: string
}
interface ServerFilePreviewsProps {
  api: AiOpsV2Api
  scope: PluginScope
  connected: boolean
  visible: boolean
  request: Readonly<{ file: ServerDirectoryEntry; id: number }> | null
  children: (files: FileDocuments) => ReactNode
  onStale: (path: string) => void
  targetLabel: string
  onEditState: (state: { dirty: boolean; busy: boolean }) => void
  onSaved: (path: string) => void
  onLocate: (path: string) => void
}

function PreviewText({ tab, onPause }: { tab: PreviewTab; onPause: () => void }) {
  const scroll = useRef<HTMLPreElement>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const content = tab.data?.content ?? ""
  const binary = content.includes("\0")
  const matches = useMemo(() => binary ? [] : filePreviewMatches(content, query), [content, query, binary])
  const index = matches.length ? selected % matches.length : 0
  const move = (direction: number) => setSelected(value => (value + direction + matches.length) % Math.max(1, matches.length))
  useLayoutEffect(() => { if (tab.following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [content, tab.following])
  useEffect(() => { if (query && !tab.following) scroll.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" }) }, [query, index, content, tab.following])
  const pieces = []
  let from = 0
  for (const [number, at] of matches.entries()) { pieces.push(content.slice(from, at), <mark key={at} data-selected={number === index}>{content.slice(at, at + query.length)}</mark>); from = at + query.length }
  pieces.push(content.slice(from))
  return <>
    <div className="server-preview-search"><Input aria-label="搜索已加载文件内容" title="区分大小写；Enter 下一处，Shift+Enter 上一处" placeholder="搜索已加载文本…" maxLength={256} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); onPause() }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1) } if (event.key === "Escape") setQuery("") }} /><span>{query ? `${matches.length ? index + 1 : 0} / ${matches.length}${matches.length === 1000 ? "+" : ""}` : "区分大小写"}</span><Button size="icon-sm" variant="ghost" aria-label="上一处文件匹配" disabled={!matches.length} onClick={() => move(-1)}><CaretUp /></Button><Button size="icon-sm" variant="ghost" aria-label="下一处文件匹配" disabled={!matches.length} onClick={() => move(1)}><CaretDown /></Button></div>
    <pre ref={scroll} tabIndex={0} aria-label="文件内容" className="server-preview-content" onScroll={event => { const node = event.currentTarget; if (tab.following && node.scrollHeight - node.scrollTop - node.clientHeight > 28) onPause() }}>{binary ? "此文件包含二进制内容，无法进行文本预览。" : pieces}</pre>
  </>
}

export function ServerFilePreviews({ api, scope, connected, visible, request, children, onStale, targetLabel, onEditState, onSaved, onLocate }: ServerFilePreviewsProps) {
  const [tabs, setTabs] = useState<readonly PreviewTab[]>([])
  const [activation, setActivation] = useState<FileDocuments["activation"]>(null)
  const activate = useCallback((id: string) => setActivation(previous => ({ id, revision: (previous?.revision ?? 0) + 1 })), [])
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([])
  const visibleIdsRef = useRef(visibleIds)
  const setVisible = useCallback((ids: readonly string[]) => {
    visibleIdsRef.current = ids
    setVisibleIds(previous => previous.join("|") === ids.join("|") ? previous : ids)
  }, [])
  const [notice, setNotice] = useState("")
  const [closing, setClosing] = useState<string | null>(null)
  const [foreground, setForeground] = useState(document.visibilityState === "visible")
  const tabsRef = useRef(tabs)
  const requests = useRef(new Map<string, number>())
  const sequence = useRef(0)
  const mounted = useRef(true)
  const connectedRef = useRef(connected), visibleRef = useRef(visible && foreground)
  connectedRef.current = connected; visibleRef.current = visible && foreground
  const readQueue = useMemo(() => workspaceReadQueue(api), [api])
  const readOwner = useRef({}).current
  const update = useCallback((change: (tabs: readonly PreviewTab[]) => readonly PreviewTab[]) => { const next = change(tabsRef.current); tabsRef.current = next; if (mounted.current) setTabs(next) }, [])
  useEffect(() => { const changed = () => setForeground(document.visibilityState === "visible"); document.addEventListener("visibilitychange", changed); return () => document.removeEventListener("visibilitychange", changed) }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current.clear(); readQueue.cancel(readOwner) } }, [readQueue, readOwner])
  const anyDirty = tabs.some(tab => tab.dirty), anyBusy = tabs.some(tab => tab.busy)
  useEffect(() => { onEditState({ dirty: anyDirty, busy: anyBusy }) }, [anyDirty, anyBusy, onEditState])
  const editState = useCallback((path: string, dirty: boolean, busy: boolean) => update(current => current.map(tab => tab.path === path && (tab.dirty !== dirty || tab.busy !== busy) ? { ...tab, dirty, busy } : tab)), [update])
  const read = useCallback(async (file: Pick<ServerDirectoryEntry, "path" | "name">, action: "head" | "tail" | "more" | "follow" = "head", following = false) => {
    if (!connectedRef.current) return
    const existing = tabsRef.current.find(tab => tab.path === file.path)
    if (existing && action !== "follow") activate(existing.id)
    if (existing?.editing) return
    if (requests.current.has(file.path)) return
    if (!existing && tabsRef.current.length >= 12) { setNotice("最多同时查看 12 个文件，请先关闭不需要的标签。"); return }
    const generation = ++sequence.current, id = existing?.id ?? "file-" + generation
    requests.current.set(file.path, generation); setNotice("")
    if (!existing) activate(id)
    update(current => existing ? current.map(tab => tab.id === id ? { ...tab, loading: true, error: undefined, following, mode: action === "head" ? "head" : action === "tail" || action === "follow" ? "tail" : tab.mode } : tab) : [...current, { id, path: file.path, name: file.name, loading: true, mode: action === "head" ? "head" : "tail", following, clipped: false, update: "" }])
    try {
      const position = action === "follow" && existing?.data?.followToken ? { followToken: existing.data.followToken } : action === "more" && existing?.data?.nextCursor ? { cursor: existing.data.nextCursor } : action === "tail" || action === "follow" ? { tail: true } : {}
      const result = await readQueue.run(readOwner, file.path, () => api.serverWorkspaceReadFile({ ...scope, path: file.path, ...position }),
        () => mounted.current && connectedRef.current && requests.current.get(file.path) === generation && (action !== "follow" || visibleRef.current && visibleIdsRef.current.includes(id)), { kind: "file", resource: serverWorkspaceKey(scope) })
      if (result === undefined || requests.current.get(file.path) !== generation || action === "follow" && (!visibleRef.current || !visibleIdsRef.current.includes(id))) return
      const page = unwrapWorkspaceResult(result)
      const merged = mergeFilePreview(existing?.data, page, action === "more" || action === "follow" && Boolean(position.followToken))
      update(current => current.map(tab => tab.id === id ? { ...tab, ...merged, clipped: merged.clipped || (action === "more" || action === "follow") && !page.reset && tab.clipped, following: tab.following && !page.content.includes("\0"), loading: false,
        update: page.reset ? page.resetReason === "limit" ? "新增内容超过单次上限，已跳到最新末尾。" : "文件已截断或衔接内容变化，已重新读取末尾。" : action === "follow" && page.content ? `新增 ${page.content.split("\n").length - 1} 行` : action !== "follow" ? "" : tab.update } : tab))
    } catch (failure) {
      if (failure instanceof Error && "code" in failure && failure.code === "WORKSPACE_READ_PAUSED") return
      if (mounted.current && requests.current.get(file.path) === generation) {
        update(current => current.map(tab => tab.id === id ? { ...tab, loading: false, following: false, error: workspaceErrorMessage(failure) } : tab))
        if (isWorkspacePathStale(failure)) onStale(file.path)
      }
    } finally {
      if (requests.current.get(file.path) === generation) { requests.current.delete(file.path); update(current => current.map(tab => tab.id === id ? { ...tab, loading: false } : tab)) }
    }
  }, [api, scope, onStale, readQueue, readOwner, update, activate])
  useEffect(() => { if (request) void read(request.file) }, [request])
  useEffect(() => {
    if (connected && visible && foreground) return
    requests.current.clear(); readQueue.cancel(readOwner)
    update(current => current.map(tab => ({ ...tab, loading: false, ...(!connected ? {following: false, error: "服务器连接已断开；内容已保留，重连后可重新跟随。"} : {}) })))
  }, [connected, visible, foreground, readQueue, readOwner, update])
  useEffect(() => {
    if (!connected || !visible || !foreground) return
    const timer = window.setInterval(() => { for (const tab of tabsRef.current) { if (visibleIdsRef.current.includes(tab.id) && tab.following && !tab.loading) void read(tab, "follow", true) } }, 3000)
    return () => window.clearInterval(timer)
  }, [connected, visible, foreground, read])
  const pause = (id: string) => {
    const tab = tabsRef.current.find(item => item.id === id)
    if (!tab?.following) return
    requests.current.delete(tab.path); readQueue.cancel(readOwner, tab.path)
    update(current => current.map(item => item.id === id ? {...item, following: false, loading: false} : item))
  }
  const close = (id: string, discard = false) => {
    const index = tabsRef.current.findIndex(tab => tab.id === id), closed = tabsRef.current[index]
    if (closed?.busy) { setNotice("文件正在读取或保存，请稍候再关闭。"); return }
    if (closed?.dirty && !discard) { setClosing(id); return }
    setClosing(null)
    if (closed) { requests.current.delete(closed.path); readQueue.cancel(readOwner, closed.path) }
    const remaining = tabsRef.current.filter(tab => tab.id !== id); update(() => remaining); setNotice("")
  }
  return <>
    {children({ activation, close, setVisible, notice, items: tabs.map(tab => ({
      id: tab.id, title: tab.path, path: tab.path, dirty: Boolean(tab.dirty),
      label: tab.name + (tabs.filter(other => other.name === tab.name).length > 1 ? " · " + parentRemotePath(tab.path) : ""),
      content: <section className="server-file-preview" aria-label={"文件预览：" + tab.path}>
      {tab.editing ? <ServerFileEditor api={api} scope={scope} path={tab.path} connected={connected} targetLabel={targetLabel} onState={editState} onSaved={onSaved} onLocate={onLocate} onExit={() => { update(current => current.map(item => item.id === tab.id ? { ...item, editing: false, dirty: false, busy: false } : item)); void read(tab) }} /> : <>
      <div className="server-workspace-toolbar server-preview-toolbar"><div className="flex min-w-0 items-center gap-2"><FileText size={16} /><ServerFilePath path={tab.path} connected={connected} onLocate={onLocate} /><span className="shrink-0 text-xs text-muted-foreground">只读</span></div><div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" disabled={!connected || tab.loading || !tab.data || tab.data.size > 1048576 || Boolean(tab.data.content.includes("\0"))} title="编辑完整 UTF-8 文本文件，最大 1 MiB" onClick={() => { pause(tab.id); requests.current.delete(tab.path); readQueue.cancel(readOwner, tab.path); update(current => current.map(item => item.id === tab.id ? { ...item, editing: true, busy: true, following: false, loading: false } : item)) }}>编辑</Button>
        <Button size="sm" variant="ghost" disabled={!connected || tab.loading} aria-pressed={tab.mode === "head"} onClick={() => { void read(tab, "head") }}>头部</Button><Button size="sm" variant="ghost" disabled={!connected || tab.loading} aria-pressed={tab.mode === "tail"} onClick={() => { void read(tab, "tail") }}>末尾</Button>
        <Button size="sm" variant="ghost" disabled={!connected || tab.loading && !tab.following || Boolean(tab.data?.content.includes("\0"))} aria-pressed={tab.following} onClick={() => { if (tab.following) pause(tab.id); else void read(tab, "tail", true) }}>{tab.following ? <Pause /> : <Play />}{tab.following ? "暂停" : "跟随"}</Button>
        <WorkspaceIconButton action="refresh" label="刷新文件预览" disabled={!connected} busy={tab.loading} onClick={() => { void read(tab, tab.mode) }} /><WorkspaceIconButton action="close" label="关闭文件预览" onClick={() => close(tab.id)} />
      </div></div>
      {tab.loading && !tab.data ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><SpinnerGap className="animate-spin" />正在读取文件…</div> : null}
      {tab.error ? <div className="server-workspace-error" role="alert">{tab.error}</div> : null}
      {tab.data ? <><PreviewText tab={tab} onPause={() => pause(tab.id)} /><div className="server-preview-footer"><span>{formatTransferBytes(tab.data.size)} · {tab.mode === "tail" ? "末尾" : "头部"}{tab.following ? visible && foreground && visibleIds.includes(tab.id) ? " · 跟随中" : " · 隐藏期间暂停跟随" : ""}{tab.clipped ? " · 仅保留最近 5000 行 / 256K 字符" : ""}{tab.data.startByte > 0 && !tab.clipped ? " · 前面还有内容" : ""}{tab.update ? " · " + tab.update : ""}</span>{tab.data.nextCursor && !tab.following ? <Button size="sm" variant="ghost" disabled={!connected || tab.loading} onClick={() => { void read(tab, "more") }}>继续读取</Button> : null}</div></> : null}
      </>}
      </section>,
    })) })}
    <Dialog open={Boolean(closing)} onOpenChange={value => { if (!value) setClosing(null) }}><DialogContent><DialogHeader><DialogTitle>放弃草稿并关闭文件？</DialogTitle><DialogDescription>未保存内容和会话内的恢复版本会清除。若保存结果待核实，远端可能已经更新，关闭不会撤销已保存内容。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setClosing(null)}>保留草稿</Button><Button variant="destructive" onClick={() => { if (closing) close(closing, true) }}>放弃并关闭</Button></DialogFooter></DialogContent></Dialog>
  </>
}
