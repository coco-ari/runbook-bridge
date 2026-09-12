import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowLeft, CaretDown, CaretUp, CheckCircle, FileText, LinkBreak, SpinnerGap, TerminalWindow, UploadSimple, X } from "@phosphor-icons/react"
import { usePanelRef } from "react-resizable-panels"
import type { AiOpsV2Api, EnvironmentRuntime, PluginScope, ServerDirectoryEntry, ServerUploadJob, ServerUploadPreparation } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePluginConnection } from "@/features/connections/use-plugin-connection"
import { pluginDraftFromRecord, type PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { ServerFileTree } from "./ServerFileTree"
import { ServerTerminalTabs } from "./ServerTerminalTabs"
import { ServerFilePreviews } from "./ServerFilePreviews"
import { formatTransferBytes, parentRemotePath, quoteRemotePath, serverEntryType, serverWorkspaceKey, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"
import "./server-workspace.css"

export interface ServerWorkspaceEntry {
  readonly plugin: PluginConfigurationRecord
  readonly projectName: string
  readonly environmentName: string
  readonly runtime: EnvironmentRuntime | null
}

const ACTIVE_UPLOAD_STATUSES = new Set(["queued", "running", "verifying"])
const UPLOAD_STATUS_LABELS: Record<ServerUploadJob["status"], string> = { queued: "等待上传", running: "正在上传", verifying: "正在校验", completed: "已完成", cancelled: "已取消", error: "上传失败" }

interface ServerWorkspaceProps {
  readonly api: AiOpsV2Api
  readonly entry: ServerWorkspaceEntry
  readonly visible: boolean
  readonly onBack: () => void
  readonly onClose: () => void
}

export function ServerWorkspace({ api, entry, visible, onBack, onClose }: ServerWorkspaceProps) {
  const panelId = useId()
  const scope = useMemo<PluginScope>(() => ({ projectId: entry.plugin.projectId, environmentId: entry.plugin.environmentId, pluginInstanceId: entry.plugin.pluginInstanceId }), [entry.plugin.projectId, entry.plugin.environmentId, entry.plugin.pluginInstanceId])
  const draft = useMemo(() => pluginDraftFromRecord(entry.plugin), [entry.plugin])
  const sshIdentity = draft.auth.username + "@" + draft.target.host + ":" + draft.target.port
  const [runtime, setRuntime] = useState(entry.runtime)
  const connection = usePluginConnection({ api, plugin: scope, runtime, onRuntime: setRuntime })
  const connected = connection.state.phase === "connected"
  const [path, setPath] = useState("/")
  const [comfortable, setComfortable] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [previewRequest, setPreviewRequest] = useState<Readonly<{ file: ServerDirectoryEntry; id: number }> | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [insertion, setInsertion] = useState<Readonly<{ text: string; id: number }> | null>(null)
  const [jobs, setJobs] = useState<readonly ServerUploadJob[]>([])
  const [trayOpen, setTrayOpen] = useState(false)
  const [uploadPreparing, setUploadPreparing] = useState(false)
  const [preparation, setPreparation] = useState<ServerUploadPreparation | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [uploadConfirming, setUploadConfirming] = useState(false)
  const [uploadError, setUploadError] = useState("")
  const [invalidatedPath, setInvalidatedPath] = useState<Readonly<{ path: string; id: number }> | null>(null)
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const [refreshPaths, setRefreshPaths] = useState<readonly string[]>([])
  const [closeDialog, setCloseDialog] = useState(false)
  const mountedRef = useRef(true)
  const previewGenerationRef = useRef(0)
  const jobsRef = useRef(jobs)
  const visibleRef = useRef(visible)
  const treePanelRef = usePanelRef()
  const previewPanelRef = usePanelRef()
  jobsRef.current = jobs
  visibleRef.current = visible
  const activeJobs = jobs.filter((job) => ACTIVE_UPLOAD_STATUSES.has(job.status))
  const completedJobs = jobs.filter((job) => job.status === "completed")
  const failedJobs = jobs.filter((job) => job.status === "error")

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; previewGenerationRef.current += 1 }
  }, [])
  useEffect(() => api.onEnvironmentStatus((next) => {
    if (next.projectId !== scope.projectId || next.environmentId !== scope.environmentId) return
    setRuntime((current) => !current || next.sequence >= current.sequence ? next : current)
  }), [api, scope])
  useEffect(() => {
    if (entry.runtime) setRuntime((current) => !current || entry.runtime!.sequence >= current.sequence ? entry.runtime : current)
  }, [entry.runtime])

  useEffect(() => {
    let disposed = false
    let timer = 0
    const poll = async () => {
      try {
        const result = unwrapWorkspaceResult(await api.serverWorkspaceUploads(scope))
        if (disposed) return
        const old = new Map(jobsRef.current.map((job) => [job.jobId, job.status]))
        const completed = result.jobs.filter((job) => job.status === "completed" && old.get(job.jobId) !== "completed")
        if (completed.length) { setRefreshPaths(completed.map((job) => parentRemotePath(job.path))); setRefreshEpoch((value) => value + 1) }
        const changed = JSON.stringify(result.jobs) !== JSON.stringify(jobsRef.current)
        if (changed) setJobs(result.jobs)
      } catch (failure) {
        if (!disposed && jobsRef.current.some((job) => ACTIVE_UPLOAD_STATUSES.has(job.status))) setUploadError(workspaceErrorMessage(failure))
      } finally {
        if (!disposed) timer = window.setTimeout(() => { void poll() }, jobsRef.current.some((job) => ACTIVE_UPLOAD_STATUSES.has(job.status)) ? 500 : visibleRef.current ? 1500 : 4000)
      }
    }
    void poll()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [api, scope])

  useEffect(() => {
    if (maximized) treePanelRef.current?.collapse()
    else treePanelRef.current?.expand()
    if (previewOpen && !maximized) {
      previewPanelRef.current?.expand()
      previewPanelRef.current?.resize("30%")
    } else previewPanelRef.current?.collapse()
  }, [maximized, previewOpen, previewPanelRef, treePanelRef])

  const openPreview = useCallback((file: ServerDirectoryEntry) => {
    if (!connected || serverEntryType(file) !== "file") return
    setMaximized(false)
    setPreviewRequest({ file, id: ++previewGenerationRef.current })
  }, [connected])
  const invalidatePreviewPath = useCallback((path: string) => setInvalidatedPath({ path, id: ++previewGenerationRef.current }), [])

  const pickUpload = useCallback(async () => {
    if (!connected || uploadPreparing) return
    setUploadPreparing(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspacePickUpload({ ...scope, path }))
      if (mountedRef.current && result) { setPreparation(result); setOverwrite(false) }
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
    finally { if (mountedRef.current) setUploadPreparing(false) }
  }, [api, connected, path, scope, uploadPreparing])

  const confirmUpload = async () => {
    if (!preparation || uploadConfirming) return
    setUploadConfirming(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceConfirmUpload({ ...scope, preparationId: preparation.preparationId, overwrite }))
      if (!mountedRef.current) return
      setJobs((current) => [...current.filter((job) => !result.jobs.some((next) => next.jobId === job.jobId)), ...result.jobs])
      setPreparation(null)
      setTrayOpen(true)
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
    finally { if (mountedRef.current) setUploadConfirming(false) }
  }

  const cancelUpload = async (jobId: string) => {
    try {
      const job = unwrapWorkspaceResult(await api.serverWorkspaceCancelUpload({ ...scope, jobId }))
      if (mountedRef.current) setJobs((current) => current.map((item) => item.jobId === jobId ? job : item))
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
  }

  return <div className={`server-workspace${comfortable ? " server-workspace-comfortable" : ""}`} hidden={!visible} data-testid="server-workspace" data-workspace-key={serverWorkspaceKey(scope)}>
    <header className="server-workspace-header">
      <Button size="sm" variant="ghost" data-testid="server-workspace-back" onClick={onBack} title="返回详情，终端和上传任务继续运行"><ArrowLeft />返回详情</Button>
      <span className="h-5 w-px bg-border" />
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{entry.plugin.displayName}</h1><Badge variant={connected ? "success" : "outline"}>{connected ? "已连接" : "已断开"}</Badge></div><p className="truncate text-[11px] text-muted-foreground">{entry.projectName} / {entry.environmentName}<span className="server-workspace-identity"> · {sshIdentity}</span></p></div>
      <Button size="sm" variant="ghost" className="server-workspace-density" aria-pressed={comfortable} onClick={() => setComfortable((value) => !value)}>{comfortable ? "舒适密度" : "紧凑密度"}</Button>
      <Button size="sm" variant="outline" disabled={!connected || Boolean(connection.state.operation)} onClick={() => { void connection.disconnect() }}><LinkBreak />断开连接</Button>
      <Button size="icon-sm" variant="ghost" aria-label="关闭工作区" title="关闭工作区并结束终端" onClick={() => setCloseDialog(true)}><X /></Button>
    </header>
    {!connected ? <div className="server-workspace-connection-notice" role="status">服务器连接已断开。返回详情连接后，请手动打开终端。<Button size="sm" variant="ghost" onClick={onBack}>返回详情</Button></div> : null}
    {connection.state.error ? <div role="alert" className="server-workspace-error">{connection.state.error.message}</div> : null}
    {uploadError && !preparation ? <div role="alert" className="server-workspace-error">{uploadError}<Button size="icon-sm" variant="ghost" aria-label="收起上传提示" onClick={() => setUploadError("")}><X /></Button></div> : null}
    <div className="server-workspace-body">
      <ResizablePanelGroup orientation="horizontal" id={`${panelId}-panels`}>
        <ResizablePanel id={`${panelId}-files`} defaultSize="320px" minSize="240px" maxSize="50%" collapsible collapsedSize={0} panelRef={treePanelRef}>
          <ServerFileTree api={api} scope={scope} connected={connected} comfortable={comfortable} path={path} onPath={setPath} onPreview={(file) => { void openPreview(file) }} onUpload={() => { void pickUpload() }} onInsertPath={(value) => setInsertion({ text: quoteRemotePath(value), id: Date.now() })} refreshEpoch={refreshEpoch} refreshPaths={refreshPaths} invalidatedPath={invalidatedPath} />
        </ResizablePanel>
        <ResizableHandle className={maximized ? "hidden" : ""} aria-label="调整文件树宽度" />
        <ResizablePanel id={`${panelId}-console`} minSize="280px">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id={`${panelId}-preview`} defaultSize={0} minSize="160px" maxSize="60%" collapsible collapsedSize={0} panelRef={previewPanelRef}>
              <ServerFilePreviews api={api} scope={scope} connected={connected} request={previewRequest} onOpenChange={setPreviewOpen} onStale={invalidatePreviewPath} />
            </ResizablePanel>
            <ResizableHandle className={!previewOpen || maximized ? "hidden" : ""} aria-label="调整文件预览高度" />
            <ResizablePanel id={`${panelId}-terminal`} minSize="180px">
              <ServerTerminalTabs api={api} scope={scope} visible={visible} connected={connected} comfortable={comfortable} maximized={maximized} onMaximize={() => setMaximized((value) => !value)} insertion={insertion} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <section className="server-upload-tray" aria-label="文件上传任务">
      <div className="server-upload-tray-header"><button className="flex min-w-0 flex-1 items-center gap-2 text-xs" type="button" onClick={() => setTrayOpen((value) => !value)} aria-expanded={trayOpen}><UploadSimple size={15} />文件传输<span className={failedJobs.length ? "text-danger" : "text-muted-foreground"}>{activeJobs.length ? `${activeJobs.length} 项进行中` : jobs.length ? `${completedJobs.length} 项完成${failedJobs.length ? ` · ${failedJobs.length} 项失败` : ""}` : "暂无任务"}</span>{trayOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}</button><span className="server-upload-target truncate text-[11px] text-muted-foreground" title={path}>上传到 {path}</span><Button size="sm" variant="ghost" disabled={!connected || uploadPreparing} onClick={() => { void pickUpload() }}>{uploadPreparing ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}上传文件</Button></div>
      {trayOpen ? <div className="server-upload-list">{jobs.length ? jobs.map((job) => <div className="server-upload-row" key={job.jobId}><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-xs font-medium" title={job.name}>{job.name}</span>{job.status === "completed" ? <CheckCircle className="text-success" size={13} /> : null}<span className={`shrink-0 text-[11px] ${job.status === "error" ? "text-danger" : "text-muted-foreground"}`}>{UPLOAD_STATUS_LABELS[job.status]}</span></div><p className="truncate text-[11px] text-muted-foreground" title={job.path}>{job.path}</p>{job.message ? <p className="text-xs text-danger">{job.message}</p> : null}</div><div className="server-upload-progress"><progress aria-label={`${job.name} 上传进度`} value={job.transferred} max={job.bytes || 1} /><span>{formatTransferBytes(job.transferred)} / {formatTransferBytes(job.bytes)}</span></div>{ACTIVE_UPLOAD_STATUSES.has(job.status) ? <Button size="icon-sm" variant="ghost" aria-label={`取消上传 ${job.name}`} onClick={() => { void cancelUpload(job.jobId) }}><X /></Button> : <span className="w-7 shrink-0" />}</div>) : <div className="px-4 py-6 text-center text-xs text-muted-foreground">选择目录后点击「上传文件」。上传进度会保留在这里。</div>}</div> : null}
    </section>
    <footer className="server-workspace-footer"><span className="flex items-center gap-1.5"><TerminalWindow size={12} />SSH / SFTP</span><span>返回详情不会结束会话或上传</span></footer>
    <Dialog open={Boolean(preparation)} onOpenChange={(value) => { if (!value && !uploadConfirming) setPreparation(null) }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!uploadConfirming} onInteractOutside={(event) => { if (uploadConfirming) event.preventDefault() }} onEscapeKeyDown={(event) => { if (uploadConfirming) event.preventDefault() }}>
        <DialogHeader><DialogTitle>上传 {preparation?.files.length ?? 0} 个文件</DialogTitle><DialogDescription>上传到所选目录。确认后切换目录不会改变本次目标。</DialogDescription></DialogHeader>
        <div className="rounded-md border bg-surface-inset p-3"><p className="mb-1 text-xs text-muted-foreground">{entry.plugin.displayName} · {entry.environmentName}</p><p className="break-all font-mono text-xs">{preparation?.path}</p>{preparation?.sourcePath && preparation.sourcePath !== preparation.path ? <p className="mt-1 break-all text-xs text-muted-foreground">由 {preparation.sourcePath} 解析，上传位置已固定。</p> : null}</div>
        <div className="max-h-52 overflow-auto divide-y">{preparation?.files.map((file) => <div key={file.remotePath} className="flex items-center gap-2 py-2 text-xs"><FileText size={15} /><span className="min-w-0 flex-1 break-all">{file.name}</span><span className="shrink-0 text-muted-foreground">{formatTransferBytes(file.bytes)}</span>{file.exists ? <Badge variant="warning">已存在</Badge> : null}</div>)}</div>
        {preparation?.files.some((file) => file.exists) ? <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={overwrite} disabled={uploadConfirming} onChange={(event) => setOverwrite(event.target.checked)} />覆盖上面标记为「已存在」的文件</label> : null}
        {uploadError ? <p className="text-xs text-danger" role="alert">{uploadError}</p> : null}
        <DialogFooter><Button variant="outline" disabled={uploadConfirming} onClick={() => setPreparation(null)}>取消</Button><Button disabled={!connected || uploadConfirming || Boolean(preparation?.files.some((file) => file.exists) && !overwrite)} onClick={() => { void confirmUpload() }}>{uploadConfirming ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}确认上传</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={closeDialog} onOpenChange={setCloseDialog}><DialogContent><DialogHeader><DialogTitle>关闭服务器工作区</DialogTitle><DialogDescription>{activeJobs.length ? "还有上传任务进行中。返回详情可以保留所有任务；请等上传结束或取消任务后再关闭工作区。" : "将结束这个工作区的终端会话并清除显示记录。服务器连接保持。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setCloseDialog(false); onBack() }}>返回详情并保留</Button><Button disabled={activeJobs.length > 0} onClick={onClose}>关闭工作区</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
