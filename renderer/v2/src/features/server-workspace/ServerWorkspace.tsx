import { WorkspaceBackButton, WorkspaceHeaderActions } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { CaretDown, CaretUp, CheckCircle, MapPin, SpinnerGap, TerminalWindow, UploadSimple, X } from "@phosphor-icons/react"
import { usePanelRef } from "react-resizable-panels"
import type { AiOpsV2Api, EnvironmentRuntime, PluginScope, ServerDirectoryEntry, ServerUploadJob, ServerUploadPreparation } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePluginConnection } from "@/features/connections/use-plugin-connection"
import { pluginDraftFromRecord, type PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { ServerFileTree } from "./ServerFileTree"
import { CopyUploadPath, ServerUploadDialog, UploadFileIcon } from "./ServerUploadDialog"
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
  const [uploadRevising, setUploadRevising] = useState(false)
  const [uploadNeedsReview, setUploadNeedsReview] = useState(false)
  const uploadActionRef = useRef(false)
  const [fileLocation, setFileLocation] = useState<Readonly<{ path: string; id: number }> | null>(null)
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

  const pickUpload = useCallback(async (targetPath = path) => {
    if (!connected || uploadPreparing) return
    setUploadPreparing(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspacePickUpload({ ...scope, path: targetPath }))
      if (mountedRef.current && result) { setPreparation(result); setOverwrite(false); setUploadNeedsReview(false) }
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
    finally { if (mountedRef.current) setUploadPreparing(false) }
  }, [api, connected, path, scope, uploadPreparing])

  const reviseUpload = async (target: string, names: readonly string[]) => {
    if (!preparation || uploadActionRef.current) return false
    uploadActionRef.current = true
    setUploadRevising(true); setUploadNeedsReview(true); setOverwrite(false); setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceReviseUpload({ ...scope, preparationId: preparation.preparationId, path: target, fileNames: names }))
      if (!mountedRef.current) return false
      setPreparation(result); setUploadNeedsReview(false)
      return true
    } catch (failure) {
      if (mountedRef.current) setUploadError(workspaceErrorMessage(failure))
      return false
    } finally {
      uploadActionRef.current = false
      if (mountedRef.current) setUploadRevising(false)
    }
  }

  const confirmUpload = async () => {
    if (!preparation || uploadActionRef.current || uploadNeedsReview) return
    uploadActionRef.current = true
    setUploadConfirming(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceConfirmUpload({ ...scope, preparationId: preparation.preparationId, overwrite }))
      if (!mountedRef.current) return
      setJobs((current) => [...current.filter((job) => !result.jobs.some((next) => next.jobId === job.jobId)), ...result.jobs])
      setPreparation(null)
      setTrayOpen(true)
    } catch (failure) { if (mountedRef.current) { setUploadError(workspaceErrorMessage(failure)); setUploadNeedsReview(true); setOverwrite(false) } }
    finally { uploadActionRef.current = false; if (mountedRef.current) setUploadConfirming(false) }
  }

  const cancelUpload = async (jobId: string) => {
    try {
      const job = unwrapWorkspaceResult(await api.serverWorkspaceCancelUpload({ ...scope, jobId }))
      if (mountedRef.current) setJobs((current) => current.map((item) => item.jobId === jobId ? job : item))
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
  }

  return <div className="server-workspace" hidden={!visible} data-testid="server-workspace" data-workspace-key={serverWorkspaceKey(scope)}>
    <header className="server-workspace-header">
      <WorkspaceBackButton label="返回服务器详情" testId="server-workspace-back" onClick={onBack} />
      <span className="h-5 w-px bg-border" />
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{entry.plugin.displayName}</h1><Badge variant={connected ? "success" : "outline"}>{connected ? "已连接" : "已断开"}</Badge></div><p className="truncate text-[11px] text-muted-foreground">{entry.projectName} / {entry.environmentName}<span className="server-workspace-identity"> · {sshIdentity}</span></p></div>
      <WorkspaceHeaderActions connected={connected} busy={Boolean(connection.state.operation)} onDisconnect={() => { void connection.disconnect() }} onClose={() => setCloseDialog(true)} prefix="server-workspace" closeLabel="关闭工作区" closeTitle="关闭工作区并结束终端" />
    </header>
    {!connected ? <div className="server-workspace-connection-notice" role="status">服务器连接已断开。返回详情连接后，请手动打开终端。<Button size="sm" variant="ghost" onClick={onBack}>返回详情</Button></div> : null}
    {connection.state.error ? <div role="alert" className="server-workspace-error">{connection.state.error.message}</div> : null}
    {uploadError && !preparation ? <div role="alert" className="server-workspace-error">{uploadError}<Button size="icon-sm" variant="ghost" aria-label="收起上传提示" onClick={() => setUploadError("")}><X /></Button></div> : null}
    <div className="server-workspace-body">
      <ResizablePanelGroup orientation="horizontal" id={`${panelId}-panels`}>
        <ResizablePanel id={`${panelId}-files`} defaultSize="320px" minSize="240px" maxSize="50%" collapsible collapsedSize={0} panelRef={treePanelRef}>
          <ServerFileTree api={api} scope={scope} connected={connected} path={path} onPath={setPath} onPreview={(file) => { void openPreview(file) }} onUpload={() => { void pickUpload() }} onInsertPath={(value) => setInsertion({ text: quoteRemotePath(value), id: Date.now() })} refreshEpoch={refreshEpoch} refreshPaths={refreshPaths} invalidatedPath={invalidatedPath} locateFile={fileLocation} />
        </ResizablePanel>
        <ResizableHandle className={maximized ? "hidden" : ""} aria-label="调整文件树宽度" />
        <ResizablePanel id={`${panelId}-console`} minSize="280px">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id={`${panelId}-preview`} defaultSize={0} minSize="160px" maxSize="60%" collapsible collapsedSize={0} panelRef={previewPanelRef}>
              <ServerFilePreviews api={api} scope={scope} connected={connected} request={previewRequest} onOpenChange={setPreviewOpen} onStale={invalidatePreviewPath} />
            </ResizablePanel>
            <ResizableHandle className={!previewOpen || maximized ? "hidden" : ""} aria-label="调整文件预览高度" />
            <ResizablePanel id={`${panelId}-terminal`} minSize="180px">
              <ServerTerminalTabs api={api} scope={scope} visible={visible} connected={connected} maximized={maximized} onMaximize={() => setMaximized((value) => !value)} insertion={insertion} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <section className="server-upload-tray" aria-label="文件上传任务">
      <div className="server-upload-tray-header"><button className="flex min-w-0 flex-1 items-center gap-2 text-xs" type="button" onClick={() => setTrayOpen((value) => !value)} aria-expanded={trayOpen}><UploadSimple size={15} />文件传输<span className={failedJobs.length ? "text-danger" : "text-muted-foreground"}>{activeJobs.length ? `${activeJobs.length} 项进行中` : jobs.length ? `${completedJobs.length} 项完成${failedJobs.length ? ` · ${failedJobs.length} 项失败` : ""}` : "暂无任务"}</span>{trayOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}</button><span className="server-upload-target truncate text-[11px] text-muted-foreground" title={`新上传目标：${path}`}>新上传目标 {path}</span><Button size="sm" variant="ghost" disabled={!connected || uploadPreparing} onClick={() => { void pickUpload() }}>{uploadPreparing ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}上传文件</Button></div>
      {trayOpen ? <div className="server-upload-list">{jobs.length ? jobs.map((job) => <div className="server-upload-row" key={job.jobId}>
        <div className="server-upload-task-icon"><UploadFileIcon name={job.name} /></div>
        <div className="min-w-0 flex-1"><div className="server-upload-task-heading"><strong title={job.name}>{job.name}</strong>{job.status === "completed" ? <CheckCircle className="text-success" size={14} /> : null}<span className={job.status === "error" ? "text-danger" : "text-muted-foreground"}>{UPLOAD_STATUS_LABELS[job.status]}</span></div><div className="server-upload-task-target"><span>上传到</span><code title={job.path}>{job.path}</code><CopyUploadPath path={job.path} label={`复制 ${job.name} 的上传路径`} /></div>{job.message ? <p className="text-xs text-danger">{job.message}</p> : null}</div>
        <div className="server-upload-progress"><div className="flex w-full justify-between gap-2"><span>{job.status === "verifying" ? "正在校验文件" : job.status === "completed" ? "上传完成" : job.status === "queued" ? "排队中" : job.status === "running" ? "正在传输" : "已停止"}</span><strong>{job.status === "completed" ? 100 : Math.min(100, Math.round(job.transferred / (job.bytes || 1) * 100))}%</strong></div><progress aria-label={`${job.name} 上传进度`} value={job.status === "completed" ? job.bytes || 1 : job.transferred} max={job.bytes || 1} /><span>{formatTransferBytes(job.transferred)} / {formatTransferBytes(job.bytes)}</span></div>
        <div className="server-upload-task-action">{ACTIVE_UPLOAD_STATUSES.has(job.status) ? <Button size="icon-sm" variant="ghost" aria-label={`取消上传 ${job.name}`} onClick={() => { void cancelUpload(job.jobId) }}><X /></Button> : job.status === "completed" ? <Button size="sm" variant="ghost" disabled={!connected} aria-label={`定位到 ${job.name}`} onClick={() => { setMaximized(false); setFileLocation({ path: job.path, id: Date.now() }) }}><MapPin size={14} />定位文件</Button> : null}</div>
      </div>) : <div className="px-4 py-6 text-center text-xs text-muted-foreground">选择目标目录，再上传本机文件。每项任务会保留自己的上传位置。</div>}</div> : null}
    </section>
    <footer className="server-workspace-footer"><span className="flex items-center gap-1.5"><TerminalWindow size={12} />SSH / SFTP</span><span>返回详情不会结束会话或上传</span></footer>
    <Dialog open={Boolean(preparation)} onOpenChange={(value) => { if (!value && !uploadActionRef.current) setPreparation(null) }}>
      {preparation ? <ServerUploadDialog api={api} scope={scope} preparation={preparation} serverName={entry.plugin.displayName} projectName={entry.projectName} environmentName={entry.environmentName} identity={sshIdentity} busy={uploadConfirming || uploadRevising} confirming={uploadConfirming} connected={connected} needsReview={uploadNeedsReview} overwrite={overwrite} error={uploadError} onOverwrite={setOverwrite} onRevise={reviseUpload} onConfirm={() => { void confirmUpload() }} onCancel={() => setPreparation(null)} onReselect={() => { const target = preparation.sourcePath ?? preparation.path; setPreparation(null); void pickUpload(target) }} /> : null}
    </Dialog>
    <Dialog open={closeDialog} onOpenChange={setCloseDialog}><DialogContent><DialogHeader><DialogTitle>关闭服务器工作区</DialogTitle><DialogDescription>{activeJobs.length ? "还有上传任务进行中。返回详情可以保留所有任务；请等上传结束或取消任务后再关闭工作区。" : "将结束这个工作区的终端会话并清除显示记录。服务器连接保持。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setCloseDialog(false); onBack() }}>返回详情并保留</Button><Button disabled={activeJobs.length > 0} onClick={onClose}>关闭工作区</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
