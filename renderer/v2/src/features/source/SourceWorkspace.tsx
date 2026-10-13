import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowClockwise, Code, Folder, CaretRight, CaretDown, X } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { SourceManifest, SourceFile, SourceStatus, SourceSearch, SourceResults, SourceRequest } from "@/bridge/ai-ops-v2"
import type { PluginWorkspaceProps } from "../plugins/workspace-registry"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SourceCodeView, type SourceViewState } from "./SourceCodeView"
import { WorkspaceSwitcherButton, useWorkspaceNavigationActions } from "../plugins/WorkspaceNavigation"
import { usePluginConnection } from "../connections/use-plugin-connection"
import "./source-workspace.css"

interface TreeNode { name: string; path: string; file: boolean; children: TreeNode[] }
function sourceTree(manifest: SourceManifest | null): TreeNode[] {
  const root: TreeNode = { name: "", path: "", file: false, children: [] }, nodes = new Map([["", root]])
  for (const file of manifest?.files ?? []) {
    const parts = file.path.split("/"); let parent = root
    for (let i = 0; i < parts.length; i++) {
      const full = parts.slice(0, i + 1).join("/"); let node = nodes.get(full)
      if (!node) { node = { name: parts[i]!, path: full, file: i === parts.length - 1, children: [] }; nodes.set(full, node); parent.children.push(node) }
      parent = node
    }
  }
  return root.children
}
function TreeEntry({ node, openFile, level = 0, selected }: { readonly node: TreeNode; readonly openFile: (path: string) => void; readonly level?: number; readonly selected: string }) {
  const [expanded, setExpanded] = useState(level === 0)
  return <li><button type="button" className="source-tree-entry" style={{ paddingLeft: 10 + level * 16 }} title={node.path} aria-current={node.file && selected === node.path ? "page" : undefined} aria-expanded={node.file ? undefined : expanded} onClick={() => node.file ? openFile(node.path) : setExpanded(!expanded)}>
    {node.file ? <Code size={16} /> : expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}{!node.file && <Folder size={16} />}<span>{node.name}</span></button>
    {!node.file && expanded && <ul>{node.children.map(child => <TreeEntry key={child.path} node={child} openFile={openFile} selected={selected} level={level + 1} />)}</ul>}</li>
}
interface FileTab extends SourceFile { view: SourceViewState; line?: number }
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`
export function SourceWorkspace({ api, entry, visible, onBack, onClose }: PluginWorkspaceProps) {
  const [status, setStatus] = useState<SourceStatus | null>(null), [manifest, setManifest] = useState<SourceManifest | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null), [tabs, setTabs] = useState<FileTab[]>([]), [active, setActive] = useState("")
  const [query, setQuery] = useState(""), [content, setContent] = useState(false), [matches, setMatches] = useState<SourceSearch | null>(null)
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [searching, setSearching] = useState(false)
  const mounted = useRef(true), selectedSnapshot = useRef(snapshotId), sequence = useRef(0), searchSequence = useRef(0)
  useWorkspaceNavigationActions({ close: onClose, navigate: (action, reason) => { if (reason === "configure" && status?.update) { toast.info("请先完成或取消源码更新"); return }; action() } })
  selectedSnapshot.current = snapshotId
  const connection = usePluginConnection({ api, plugin: entry.plugin, runtime: entry.runtime })
  const invoke = useCallback(async <K extends keyof SourceResults>(operation: K, extra: Omit<SourceRequest<K>, "operation" | "projectId" | "environmentId" | "pluginInstanceId" | "expectedRevision"> = {}) => {
    const result = await api.sourceWorkspace({ ...entry.scope, expectedRevision: entry.plugin.revision, operation, ...extra })
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }, [api, entry.scope.projectId, entry.scope.environmentId, entry.scope.pluginInstanceId, entry.plugin.revision])
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current
    try { const result = await invoke("status"); if (mounted.current && ticket === sequence.current) { setStatus(result); setSnapshotId(previous => previous ?? result.local?.snapshotId ?? null) } }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "读取源码状态失败") }
  }, [invoke])
  useEffect(() => {
    mounted.current = true; void refresh()
    const off = api.onSourceChanged(change => { if (change.projectId === entry.scope.projectId && change.environmentId === entry.scope.environmentId && change.pluginInstanceId === entry.scope.pluginInstanceId) void refresh() })
    return () => { mounted.current = false; off(); void invoke("release").catch(() => {}) }
  }, [api, invoke, refresh, entry.scope.projectId, entry.scope.environmentId, entry.scope.pluginInstanceId])
  useEffect(() => { if (visible) void refresh() }, [visible, entry.connected, refresh])
  useEffect(() => {
    let cancelled = false
    setManifest(null); setTabs([]); setActive(""); setMatches(null)
    if (snapshotId) void invoke("manifest", { snapshotId }).then(value => { if (!cancelled) setManifest(value) }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [invoke, snapshotId])
  async function action(name: string, operation: () => Promise<unknown>) {
    if (busy) return
    setBusy(name); setError("")
    try { await operation() } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "操作失败") }
    finally { if (mounted.current) { setBusy(""); void refresh() } }
  }
  async function openFile(filename: string, line?: number) {
    if (!snapshotId) return
    const existing = tabs.find(tab => tab.path === filename)
    if (existing) { setActive(filename); if (line) setTabs(items => items.map(tab => tab.path === filename ? { ...tab, line } : tab)); return }
    if (tabs.length >= 12) { toast.error("最多同时打开 12 个文件，请先关闭部分标签。"); return }
    const requested = snapshotId
    try {
      const file = await invoke("read", { snapshotId: requested, path: filename })
      if (!mounted.current || selectedSnapshot.current !== requested) return
      setTabs(items => items.some(tab => tab.path === filename) || items.length >= 12 ? items : [...items, { ...file, view: {}, ...(line ? { line } : {}) }]); setActive(filename); setError("")
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "读取文件失败") }
  }
  async function searchFiles() {
    if (!snapshotId || !query.trim()) return
    const ticket = ++searchSequence.current, requested = snapshotId
    setSearching(true)
    try { const result = await invoke("search", { snapshotId, query, content }); if (mounted.current && ticket === searchSequence.current && selectedSnapshot.current === requested) setMatches(result) }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "搜索失败") }
    finally { if (mounted.current && ticket === searchSequence.current) setSearching(false) }
  }
  const tree = useMemo(() => sourceTree(manifest), [manifest]), currentTab = tabs.find(tab => tab.path === active)
  const remote = status?.remote?.snapshot, updating = Boolean(status?.update) || busy === "update"
  return <section className="source-workspace absolute inset-0 z-40 bg-background" hidden={!visible} inert={!visible} data-testid="source-workspace">
    <header className="source-header"><Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="返回插件详情" data-testid="source-workspace-back"><ArrowLeft /></Button><div className="source-heading"><h2>{entry.plugin.displayName}</h2><p>{entry.projectName} / {entry.environmentName} · 源码工作区</p></div><span className="source-readonly">只读</span><WorkspaceSwitcherButton labelLayout="compact" /><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭源码工作区"><X /></Button></header>
    <div className="source-version-bar"><div><span>正在浏览 </span><strong>{manifest?.revision.slice(0, 12) ?? "尚未下载"}</strong>{manifest && <span> · {manifest.fileCount} 个文件 · {bytes(manifest.totalBytes)}</span>}<span className="ml-4">远端 {remote?.revision.slice(0, 12) ?? "尚未发布"}</span></div>
      <div className="flex flex-wrap gap-2">{!status?.connected && <Button size="sm" variant="outline" onClick={() => void connection.connect()}>连接服务</Button>}<Button size="sm" variant="outline" disabled={!status?.connected || Boolean(busy)} onClick={() => void action("check", () => invoke("check"))}><ArrowClockwise />检查版本</Button>
        {updating ? <Button size="sm" variant="outline" onClick={() => void invoke("cancel").catch(e => setError(e.message))}>取消更新</Button> : <Button size="sm" disabled={!status?.connected || !remote || Boolean(busy) || remote.snapshotId === status?.local?.snapshotId} data-testid="source-update" onClick={() => void action("update", async () => {
          const result = await invoke("update", { snapshotId: remote!.snapshotId }); if (!mounted.current) return; setSnapshotId(result.snapshotId); toast.success(`源码已更新，下载 ${result.downloadedFiles} 个文件，${bytes(result.downloadedBytes)}`)
        })}>{status?.local ? "更新源码" : "下载源码"}</Button>}
        <Button size="sm" variant="ghost" disabled={!snapshotId} onClick={() => void action("open", () => invoke("open-directory", { snapshotId: snapshotId! }))}>打开目录</Button>
        <Button size="sm" variant="ghost" disabled={updating || Boolean(busy)} onClick={() => void action("cleanup", async () => { const result = await invoke("cleanup"); toast.success(`已清理 ${result.removed} 个未使用版本`) })}>清理旧版本</Button></div>
    </div>
    {status?.local && snapshotId !== status.local.snapshotId && <div className="source-notice">本地已有新版本，此工作区仍在浏览原版本。<Button variant="link" size="sm" onClick={() => setSnapshotId(status.local!.snapshotId)}>切换到当前版本</Button></div>}
    {updating && <div className="source-notice" role="status">{status?.update?.phase === "verify" ? `正在校验 ${status.update.completedFiles ?? 0} / ${status.update.totalFiles ?? 0} 个文件` : `正在下载 ${bytes(status?.update?.downloadedBytes ?? 0)}${status?.update?.totalBytes ? " / " + bytes(status.update.totalBytes) : ""}`}，完成后切换版本。</div>}
    {(error || status?.remote?.error) && <div className="source-notice text-destructive" role="alert">{error || status?.remote?.error}</div>}
    <div className="source-body"><aside className="source-sidebar"><form className="source-search" onSubmit={e => { e.preventDefault(); void searchFiles() }}><Input aria-label="搜索源码" value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) setMatches(null) }} placeholder="搜索文件或内容" maxLength={200} /><div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={content} onChange={e => setContent(e.target.checked)} />全文搜索</label><Button size="xs" variant="outline" disabled={!manifest || searching || !query.trim()}>{searching ? "搜索中…" : "搜索"}</Button></div></form>
      <nav className="source-tree" aria-label="源码文件">{matches ? <><p className="p-2 text-xs text-muted-foreground">{matches.results.length} 条结果{matches.truncated ? "（已达到结果或扫描限制）" : ""}<Button size="xs" variant="link" onClick={() => setMatches(null)}>返回目录</Button></p>{matches.results.map((result, index) => <button className="source-match" key={index} onClick={() => void openFile(result.path, result.line)}><span>{result.path}{result.line ? `:${result.line}` : ""}</span>{result.preview && <small>{result.preview}</small>}</button>)}</> : manifest ? <ul>{tree.map(node => <TreeEntry key={node.path} node={node} selected={active} openFile={file => void openFile(file)} />)}</ul> : <p className="p-4 text-sm text-muted-foreground">下载后显示目录</p>}</nav>
    </aside><main className="source-document"><div className="source-tabs" role="tablist" aria-label="打开的源码文件">{tabs.map(tab => <div className="source-tab" key={tab.path} data-active={tab.path === active}><button role="tab" aria-selected={tab.path === active} title={tab.path} onClick={() => setActive(tab.path)}>{tab.path.split("/").pop()}</button><button aria-label={`关闭 ${tab.path}`} onClick={() => { const rest = tabs.filter(item => item.path !== tab.path); setTabs(rest); if (active === tab.path) setActive(rest.at(-1)?.path ?? "") }}><X size={12} /></button></div>)}</div>
      {currentTab ? <><div className="source-file-heading">{currentTab.path}<span>{bytes(currentTab.size)}</span></div><div className="min-h-0 flex-1">{currentTab.binary ? <div className="source-empty">二进制或非 UTF-8 文件，无法文本预览。可打开目录查看。</div> : <SourceCodeView key={currentTab.path} text={currentTab.text ?? ""} filename={currentTab.path} line={currentTab.line} saved={currentTab.view} />}</div></> : <div className="source-empty"><Code size={36} /><p>{manifest ? "从左侧打开文件，或搜索源码内容" : "连接源码服务后，选择下载已发布版本"}</p><small>源码不包含 Git 历史；更新只传输发生变化的文件。</small></div>}
    </main></div>
  </section>
}
