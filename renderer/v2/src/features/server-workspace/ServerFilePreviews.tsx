import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { FileText, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerFilePreview } from "@/bridge/ai-ops-v2"
import { WorkspaceTabs } from "./WorkspaceTabs"
import { workspaceReadQueue } from "./workspace-read-queue"
import { formatTransferBytes, isWorkspacePathStale, parentRemotePath, serverWorkspaceKey, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

interface PreviewTab { id: string; path: string; name: string; loading: boolean; data?: ServerFilePreview | undefined; error?: string | undefined }
interface ServerFilePreviewsProps {
  api: AiOpsV2Api
  scope: PluginScope
  connected: boolean
  request: Readonly<{ file: ServerDirectoryEntry; id: number }> | null
  onOpenChange: (open: boolean) => void
  onStale: (path: string) => void
}

export function ServerFilePreviews({ api, scope, connected, request, onOpenChange, onStale }: ServerFilePreviewsProps) {
  const groupId = useId()
  const [tabs, setTabs] = useState<readonly PreviewTab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const tabsRef = useRef(tabs)
  const requests = useRef(new Map<string, number>())
  const sequence = useRef(0)
  const mounted = useRef(true)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const readQueue = useMemo(() => workspaceReadQueue(api), [api])
  const readOwner = useRef({}).current
  tabsRef.current = tabs
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current.clear(); readQueue.cancel(readOwner) } }, [readQueue, readOwner])
  useEffect(() => { onOpenChange(tabs.length > 0) }, [tabs.length, onOpenChange])
  const read = useCallback(async (file: Pick<ServerDirectoryEntry, "path" | "name">) => {
    if (!connected) return
    const existing = tabsRef.current.find((tab) => tab.path === file.path)
    if (requests.current.has(file.path)) { if (existing) setActive(existing.id); return }
    if (!existing && tabsRef.current.length >= 12) { setNotice("最多同时查看 12 个文件，请先关闭不需要的标签。"); return }
    const generation = ++sequence.current
    const id = existing?.id ?? "file-" + generation
    requests.current.set(file.path, generation)
    setNotice("")
    setActive(id)
    setTabs((current) => existing ? current.map((tab) => tab.id === id ? { ...tab, loading: true, error: undefined } : tab) : [...current, { id, path: file.path, name: file.name, loading: true }])
    try {
      const result = await readQueue.run(readOwner, file.path,
        () => api.serverWorkspaceReadFile({ ...scope, path: file.path }),
        () => mounted.current && connectedRef.current && requests.current.get(file.path) === generation, { kind: "file", resource: serverWorkspaceKey(scope) })
      if (result === undefined) return
      const data = unwrapWorkspaceResult(result)
      if (mounted.current && requests.current.get(file.path) === generation) setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, data, loading: false } : tab))
    } catch (failure) {
      if (mounted.current && requests.current.get(file.path) === generation) {
        setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, data: undefined, loading: false, error: workspaceErrorMessage(failure) } : tab))
        if (isWorkspacePathStale(failure)) onStale(file.path)
      }
    } finally { if (requests.current.get(file.path) === generation) requests.current.delete(file.path) }
  }, [api, scope, connected, onStale, readQueue, readOwner])
  useEffect(() => { if (request) void read(request.file) }, [request])
  useEffect(() => {
    if (!connected) { requests.current.clear(); readQueue.cancel(readOwner); setTabs((current) => current.map((tab) => tab.loading ? { ...tab, loading: false, error: "服务器连接已断开。" } : tab)) }
  }, [connected, readQueue, readOwner])
  const close = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    const closed = tabs[index]
    if (closed) { requests.current.delete(closed.path); readQueue.cancel(readOwner, closed.path) }
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    setNotice("")
    if (active === id) setActive((remaining[index] ?? remaining[index - 1])?.id ?? null)
  }
  return <section className="server-file-preview" aria-label="文件预览">
    <WorkspaceTabs id={groupId} label="文件标签" items={tabs.map((tab) => ({ id: tab.id, title: tab.path, label: tab.name + (tabs.filter((other) => other.name === tab.name).length > 1 ? " · " + parentRemotePath(tab.path) : "") }))} active={active} onSelect={setActive} onClose={close} />
    {notice ? <div className="server-workspace-error" role="status">{notice}</div> : null}
    {tabs.map((tab) => <div key={tab.id} className="server-preview-tab-panel" role="tabpanel" id={groupId + "-panel-" + tab.id} aria-labelledby={groupId + "-tab-" + tab.id} hidden={active !== tab.id}>
      <div className="server-workspace-toolbar"><div className="flex min-w-0 items-center gap-2"><FileText size={16} /><span className="truncate font-mono text-xs" title={tab.path}>{tab.path}</span><span className="shrink-0 text-[11px] text-muted-foreground">只读</span></div><div className="flex shrink-0 items-center gap-1"><WorkspaceIconButton action="refresh" label="刷新文件预览" disabled={!connected} busy={tab.loading} onClick={() => { void read(tab) }} /><WorkspaceIconButton action="close" label="关闭文件预览" onClick={() => close(tab.id)} /></div></div>
      {tab.loading ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><SpinnerGap className="animate-spin" />正在读取文件…</div> : tab.error ? <div className="server-workspace-error" role="alert">{tab.error}</div> : tab.data ? <><pre className="server-preview-content">{tab.data.content.includes("\0") ? "此文件包含二进制内容，无法进行文本预览。" : tab.data.content}</pre><div className="server-preview-footer">{formatTransferBytes(tab.data.size)}{tab.data.truncated ? " · 仅预览前 256 KB" : " · UTF-8"}</div></> : null}
    </div>)}
  </section>
}
