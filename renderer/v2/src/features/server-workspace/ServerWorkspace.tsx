import { WorkspaceBackButton, WorkspaceHeaderActions } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { CaretDown, CaretUp, CheckCircle, MapPin, Pause, SpinnerGap, Trash, TerminalWindow, UploadSimple, X } from "@phosphor-icons/react"
import { usePanelRef } from "react-resizable-panels"
import type { AiOpsV2Api, EnvironmentRuntime, PluginScope, ServerDirectoryEntry, ServerUploadJob, ServerUploadReview } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePluginConnection } from "@/features/connections/use-plugin-connection"
import { pluginDraftFromRecord, type PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { ServerFileTree } from "./ServerFileTree"
import { ServerMetrics } from "./ServerMetrics"
import { createWorkspacePathDrag } from "./workspace-path-drag"
import { CopyUploadPath, ServerUploadDialog, UploadFileIcon } from "./ServerUploadDialog"
import { ServerTerminalTabs } from "./ServerTerminalTabs"
import { ServerConnectionNotice } from "./ServerConnectionNotice"
import { terminalConnection } from "./terminal-recovery"
import { RuntimeHostKeyDialog } from "@/features/connections/RuntimeHostKeyDialog"
import { ServerFilePreviews } from "./ServerFilePreviews"
import { formatTransferBytes, formatTransferEta, parentRemotePath, serverEntryType, serverWorkspaceKey, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"
import "./server-workspace.css"

export interface ServerWorkspaceEntry {
  readonly plugin: PluginConfigurationRecord
  readonly projectName: string
  readonly environmentName: string
  readonly runtime: EnvironmentRuntime | null
}

const ACTIVE_UPLOAD_STATUSES = new Set(["queued", "running", "verifying", "pausing"])
const UPLOAD_STATUS_LABELS: Record<ServerUploadJob["status"], string> = { queued: "等待传输", running: "正在传输", verifying: "正在校验", completed: "已完成", cancelled: "已取消", error: "传输失败", interrupted: "已中断", pausing: "正在暂停", paused: "已暂停" }

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
  const terminalState = terminalConnection(connection.state.runtime, scope.pluginInstanceId, connection.state.phase)
  const connected = connection.state.phase === "connected"
  const reconnectFocusRef = useRef<HTMLElement | null>(null)
  const [path, setPath] = useState("/")
  const [maximized, setMaximized] = useState(false)
  const [previewRequest, setPreviewRequest] = useState<Readonly<{ file: ServerDirectoryEntry; id: number }> | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const pathDrag = useMemo(() => createWorkspacePathDrag(), [scope])
  useEffect(() => {
    if (!connected || !visible) pathDrag.clear()
    return () => pathDrag.clear()
  }, [pathDrag, connected, visible])
  const [jobs, setJobs] = useState<readonly ServerUploadJob[]>([])
  const [trayOpen, setTrayOpen] = useState(false)
  const [uploadPreparing, setUploadPreparing] = useState(false)
  const [preparation, setPreparation] = useState<ServerUploadReview | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [uploadConfirming, setUploadConfirming] = useState(false)
  const [resumingJobId, setResumingJobId] = useState<string | null>(null)
  const [uploadRevising, setUploadRevising] = useState<"removing" | "checking" | null>(null)
  const [uploadNeedsReview, setUploadNeedsReview] = useState(false)
  const uploadActionRef = useRef(false)
  const uploadPickerRef = useRef(false)
  const uploadSelectionVersion = useRef(0)
  const preparationRef = useRef(preparation)
  preparationRef.current = preparation
  const [fileLocation, setFileLocation] = useState<Readonly<{ path: string; id: number }> | null>(null)
  const [uploadError, setUploadError] = useState("")
  const [uploadJobError, setUploadJobError] = useState("")
  const [uploadPollError, setUploadPollError] = useState("")
  const [invalidatedPath, setInvalidatedPath] = useState<Readonly<{ path: string; id: number }> | null>(null)
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const [refreshPaths, setRefreshPaths] = useState<readonly string[]>([])
  const [closeDialog, setCloseDialog] = useState(false)
  const mountedRef = useRef(true)
  const previewGenerationRef = useRef(0)
  const jobsRef = useRef(jobs)
  const jobsVersion = useRef(0)
  const removedJobIds = useRef(new Set<string>())
  const [downloadPicking, setDownloadPicking] = useState(false)
  const downloadPickerRef = useRef(false)
  const visibleRef = useRef(visible)
  const treePanelRef = usePanelRef()
  const previewPanelRef = usePanelRef()
  jobsRef.current = jobs
  visibleRef.current = visible
  const activeJobs = jobs.filter((job) => ACTIVE_UPLOAD_STATUSES.has(job.status))
  const completedJobs = jobs.filter((job) => job.status === "completed")
  const interruptedJobs = jobs.filter((job) => job.status === "interrupted" || job.status === "paused")
  const failedJobs = jobs.filter((job) => job.status === "error")

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false; previewGenerationRef.current += 1; uploadSelectionVersion.current += 1
      const current = preparationRef.current
      if (current) void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: current.reviewId }).catch(() => undefined)
    }
  }, [api, scope])
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
        const version = jobsVersion.current
        const result = unwrapWorkspaceResult(await api.serverWorkspaceUploads(scope))
        if (disposed || version !== jobsVersion.current) return
        const old = new Map(jobsRef.current.map((job) => [job.jobId, job.status]))
        const completed = result.jobs.filter((job) => job.direction !== "download" && job.status === "completed" && old.get(job.jobId) !== "completed")
        if (completed.length) { setRefreshPaths(completed.map((job) => parentRemotePath(job.path))); setRefreshEpoch((value) => value + 1) }
        const changed = JSON.stringify(result.jobs) !== JSON.stringify(jobsRef.current)
        if (changed) setJobs(result.jobs.filter(job => !removedJobIds.current.has(job.jobId)))
        setUploadPollError("")
      } catch (failure) {
        if (!disposed && jobsRef.current.some((job) => ACTIVE_UPLOAD_STATUSES.has(job.status))) setUploadPollError(workspaceErrorMessage(failure))
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

  useEffect(() => {
    if (!preparation || preparation.status === "error") return
    const reviewId = preparation.reviewId
    const version = uploadSelectionVersion.current
    let disposed = false
    let timer = 0
    const poll = async () => {
      try {
        const next = unwrapWorkspaceResult(await api.serverWorkspaceReadUploadReview({ ...scope, reviewId }))
        if (disposed || version !== uploadSelectionVersion.current) return
        setPreparation(next)
        if (next.status === "error") { setUploadError(next.error?.message ?? "文件检查失败，请重试。"); setUploadNeedsReview(true); setOverwrite(false) }
      } catch (failure) {
        if (!disposed && version === uploadSelectionVersion.current) {
          setUploadError(workspaceErrorMessage(failure)); setUploadNeedsReview(true); setOverwrite(false)
          setPreparation(current => current?.reviewId === reviewId ? { ...current, status: "error", preparationId: null } : current)
        }
      } finally {
        if (!disposed && version === uploadSelectionVersion.current) timer = window.setTimeout(() => { void poll() }, preparationRef.current?.status === "checking" ? 300 : 1500)
      }
    }
    void poll()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [api, scope, preparation?.reviewId, preparation?.status])

  const cancelPreparation = () => {
    uploadSelectionVersion.current += 1
    const current = preparationRef.current
    preparationRef.current = null
    setPreparation(null)
    setUploadError("")
    if (current) void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: current.reviewId }).catch(() => undefined)
  }

  const pickUpload = useCallback(async (targetPath = path) => {
    if (!connected || uploadPickerRef.current || uploadActionRef.current) return
    uploadPickerRef.current = true
    const version = ++uploadSelectionVersion.current
    setUploadPreparing(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspacePickUpload({ ...scope, path: targetPath }))
      if (mountedRef.current && version === uploadSelectionVersion.current && result) { setPreparation(result); setOverwrite(false); setUploadNeedsReview(false) }
      else if (result) void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: result.reviewId }).catch(() => undefined)
    } catch (failure) { if (mountedRef.current) setUploadError(workspaceErrorMessage(failure)) }
    finally { uploadPickerRef.current = false; if (mountedRef.current) setUploadPreparing(false) }
  }, [api, connected, path, scope, uploadPreparing])

  const reviseUpload = async (names: readonly string[]) => {
    if (!preparation || uploadActionRef.current) return false
    uploadActionRef.current = true
    const version = ++uploadSelectionVersion.current
    setUploadRevising(names.length < preparation.files.length ? "removing" : "checking"); setUploadNeedsReview(true); setOverwrite(false); setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceReviseUpload({ ...scope, reviewId: preparation.reviewId, fileNames: names }))
      if (!mountedRef.current || version !== uploadSelectionVersion.current) {
        if (result) void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: result.reviewId }).catch(() => undefined)
        return false
      }
      setPreparation(result); setUploadNeedsReview(false)
      return true
    } catch (failure) {
      if (mountedRef.current) setUploadError(workspaceErrorMessage(failure))
      return false
    } finally {
      uploadActionRef.current = false
      if (mountedRef.current) setUploadRevising(null)
    }
  }

  const confirmUpload = async () => {
    if (!preparation || preparation.status !== "ready" || !preparation.preparationId || uploadActionRef.current || uploadNeedsReview) return
    uploadActionRef.current = true
    setUploadConfirming(true)
    setUploadError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceConfirmUpload({ ...scope, preparationId: preparation.preparationId, overwrite }))
      void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: preparation.reviewId }).catch(() => undefined)
      if (!mountedRef.current) return
      uploadSelectionVersion.current += 1
      jobsVersion.current += 1
      setJobs((current) => [...current.filter((job) => !result.jobs.some((next) => next.jobId === job.jobId)), ...result.jobs])
      setPreparation(null)
      setTrayOpen(true)
    } catch (failure) { if (mountedRef.current) { setUploadError(workspaceErrorMessage(failure)); setUploadNeedsReview(true); setOverwrite(false) } }
    finally { uploadActionRef.current = false; if (mountedRef.current) setUploadConfirming(false) }
  }

  const resumeUpload = async (job: ServerUploadJob) => {
    if (!connected || uploadActionRef.current || uploadPickerRef.current || preparation) return
    uploadActionRef.current = true
    const version = ++uploadSelectionVersion.current
    setResumingJobId(job.jobId)
    setUploadJobError("")
    let automaticReview: ServerUploadReview | null = null
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspacePrepareUploadResume({ ...scope, jobId: job.jobId }))
      if (!mountedRef.current || version !== uploadSelectionVersion.current) {
        void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: result.reviewId }).catch(() => undefined)
        return
      }
      if (job.status === "paused") {
        automaticReview = result
        if (result.status !== "ready" || !result.preparationId || result.resume?.jobId !== job.jobId) throw new Error("任务状态已变化，请重新点击继续。")
        // 暂停只延续原任务；新的一次性确认仍绑定原文件、覆盖范围和检查点。
        const resumed = unwrapWorkspaceResult(await api.serverWorkspaceConfirmUpload({
          ...scope, preparationId: result.preparationId, overwrite: result.files.some(file => file.exists === true),
        }))
        if (mountedRef.current && version === uploadSelectionVersion.current) {
          jobsVersion.current += 1
          setJobs(current => [...current.filter(item => !resumed.jobs.some(next => next.jobId === item.jobId)), ...resumed.jobs])
          setTrayOpen(true)
        }
      } else {
        setPreparation(result); setOverwrite(false); setUploadNeedsReview(false); setUploadError("")
      }
    } catch (failure) { if (mountedRef.current) setUploadJobError(workspaceErrorMessage(failure)) }
    finally {
      if (automaticReview) void api.serverWorkspaceCancelUploadReview({ ...scope, reviewId: automaticReview.reviewId }).catch(() => undefined)
      uploadActionRef.current = false
      if (mountedRef.current) setResumingJobId(null)
    }
  }

  const downloadFile = async (file: ServerDirectoryEntry) => {
    if (!connected || downloadPickerRef.current) return
    downloadPickerRef.current = true
    setDownloadPicking(true)
    setUploadJobError("")
    try {
      const job = unwrapWorkspaceResult(await api.serverWorkspaceDownload({ ...scope, path: file.path }))
      if (job && mountedRef.current) {
        jobsVersion.current += 1
        setJobs(current => [...current.filter(item => item.jobId !== job.jobId), job])
        setTrayOpen(true)
      }
    } catch (failure) { if (mountedRef.current) setUploadJobError(workspaceErrorMessage(failure)) }
    finally { downloadPickerRef.current = false; if (mountedRef.current) setDownloadPicking(false) }
  }

  const clearTransfers = async (jobId?: string) => {
    jobsVersion.current += 1
    setUploadJobError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceClearTransfers({ ...scope, ...(jobId ? { jobId } : {}) }))
      jobsVersion.current += 1
      for (const id of result.removedIds) removedJobIds.current.add(id)
      if (mountedRef.current) setJobs(current => current.filter(job => !removedJobIds.current.has(job.jobId)))
    } catch (failure) { if (mountedRef.current) setUploadJobError(workspaceErrorMessage(failure)) }
  }

  const pauseUpload = async (jobId: string) => {
    jobsVersion.current += 1
    setUploadJobError("")
    try {
      const job = unwrapWorkspaceResult(await api.serverWorkspacePauseUpload({ ...scope, jobId }))
      jobsVersion.current += 1
      if (mountedRef.current) setJobs(current => current.map(item => item.jobId === jobId ? job : item))
    } catch (failure) { if (mountedRef.current) setUploadJobError(workspaceErrorMessage(failure)) }
  }

  const cancelUpload = async (jobId: string) => {
    setUploadJobError("")
    try {
      const job = unwrapWorkspaceResult(await api.serverWorkspaceCancelUpload({ ...scope, jobId }))
      jobsVersion.current += 1
      if (mountedRef.current) setJobs((current) => current.map((item) => item.jobId === jobId ? job : item))
    } catch (failure) { if (mountedRef.current) setUploadJobError(workspaceErrorMessage(failure)) }
  }

  return <div className="server-workspace" hidden={!visible} data-testid="server-workspace" data-workspace-key={serverWorkspaceKey(scope)}>
    <header className="server-workspace-header">
      <WorkspaceBackButton label="返回服务器详情" testId="server-workspace-back" onClick={onBack} />
      <span className="h-5 w-px bg-border" />
      <div className="server-workspace-heading"><div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{entry.plugin.displayName}</h1><Badge variant={connected ? "success" : "outline"}>{connected ? "已连接" : terminalState.phase === "waiting" || terminalState.phase === "connecting" ? "正在重连" : terminalState.phase === "action-required" ? "需要处理" : "已断开"}</Badge></div><p className="truncate text-[11px] text-muted-foreground">{entry.projectName} / {entry.environmentName}<span className="server-workspace-identity"> · {sshIdentity}</span></p></div>
      <ServerMetrics api={api} scope={scope} connected={connected} visible={visible} />
      <WorkspaceHeaderActions connected={connected} busy={Boolean(connection.state.operation)} onDisconnect={() => { void connection.disconnect() }} onClose={() => setCloseDialog(true)} prefix="server-workspace" closeLabel="关闭工作区" closeTitle="关闭工作区并结束终端" />
    </header>
    <ServerConnectionNotice connection={terminalState} busy={Boolean(connection.state.operation)} error={connection.state.error?.message ?? ""} onSettings={onBack} onRetry={() => {
      reconnectFocusRef.current = document.activeElement as HTMLElement | null
      void connection.retry()
    }} />
    <RuntimeHostKeyDialog state={connection.state} onReject={connection.rejectHostKey} onTrust={connection.trustHostKey} returnFocusRef={reconnectFocusRef} testId="workspace-host-key-confirmation" />
    {uploadError && !preparation ? <div role="alert" className="server-workspace-error">{uploadError}<Button size="icon-sm" variant="ghost" aria-label="收起上传提示" onClick={() => setUploadError("")}><X /></Button></div> : null}
    {uploadJobError ? <div role="alert" className="server-workspace-error" data-testid="upload-job-error">{uploadJobError}<Button size="icon-sm" variant="ghost" aria-label="收起传输提示" onClick={() => setUploadJobError("")}><X /></Button></div> : null}
    {uploadPollError ? <div role="alert" className="server-workspace-error" data-testid="upload-poll-error">{uploadPollError}<Button size="icon-sm" variant="ghost" aria-label="收起传输状态提示" onClick={() => setUploadPollError("")}><X /></Button></div> : null}
    <div className="server-workspace-body">
      <ResizablePanelGroup orientation="horizontal" id={`${panelId}-panels`}>
        <ResizablePanel id={`${panelId}-files`} defaultSize="320px" minSize="240px" maxSize="50%" collapsible collapsedSize={0} panelRef={treePanelRef}>
          <ServerFileTree api={api} scope={scope} connected={connected} visible={visible} path={path} onPath={setPath} onPreview={(file) => { void openPreview(file) }} onUpload={() => { void pickUpload() }} onDownload={file => { void downloadFile(file) }} downloadBusy={downloadPicking} pathDrag={pathDrag} refreshEpoch={refreshEpoch} refreshPaths={refreshPaths} invalidatedPath={invalidatedPath} locateFile={fileLocation} />
        </ResizablePanel>
        <ResizableHandle className={maximized ? "hidden" : ""} aria-label="调整文件树宽度" />
        <ResizablePanel id={`${panelId}-console`} minSize="280px">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id={`${panelId}-preview`} defaultSize={0} minSize="160px" maxSize="60%" collapsible collapsedSize={0} panelRef={previewPanelRef}>
              <ServerFilePreviews api={api} scope={scope} connected={connected} request={previewRequest} onOpenChange={setPreviewOpen} onStale={invalidatePreviewPath} />
            </ResizablePanel>
            <ResizableHandle className={!previewOpen || maximized ? "hidden" : ""} aria-label="调整文件预览高度" />
            <ResizablePanel id={`${panelId}-terminal`} minSize="180px">
              <ServerTerminalTabs api={api} scope={scope} visible={visible} connected={connected} connection={terminalState} maximized={maximized} onMaximize={() => setMaximized((value) => !value)} pathDrag={pathDrag} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <section className="server-upload-tray" aria-label="文件传输任务">
      <div className="server-upload-tray-header"><button className="flex min-w-0 flex-1 items-center gap-2 text-xs" type="button" onClick={() => setTrayOpen((value) => !value)} aria-expanded={trayOpen}><UploadSimple size={15} />文件传输<span className={failedJobs.length ? "text-danger" : "text-muted-foreground"}>{activeJobs.length ? `${activeJobs.length} 项进行中` : jobs.length ? `${completedJobs.length} 项完成${failedJobs.length ? ` · ${failedJobs.length} 项失败` : ""}` : "暂无任务"}{interruptedJobs.length ? ` · ${interruptedJobs.length} 项可继续` : ""}</span>{trayOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}</button>{jobs.some(job => job.canRemove) ? <Button size="sm" variant="ghost" onClick={() => { void clearTransfers() }} title="只清除结束记录，保留本地和服务器文件"><Trash />清除已结束</Button> : null}<span className="server-upload-target truncate text-[11px] text-muted-foreground" title={`新上传目标：${path}`}>新上传目标 {path}</span><Button size="sm" variant="ghost" disabled={!connected || uploadPreparing} onClick={() => { void pickUpload() }}>{uploadPreparing ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}上传文件</Button></div>
      {trayOpen ? <div className="server-upload-list">{jobs.length ? jobs.map((job) => <div className="server-upload-row" key={job.jobId}>
        <div className="server-upload-task-icon"><UploadFileIcon name={job.name} /></div>
        <div className="min-w-0 flex-1"><div className="server-upload-task-heading"><strong title={job.name}>{job.name}</strong>{job.status === "completed" ? <CheckCircle className="text-success" size={14} /> : null}<span className={job.status === "error" ? "text-danger" : "text-muted-foreground"}>{UPLOAD_STATUS_LABELS[job.status]}</span></div><div className="server-upload-task-target"><span>{job.direction === "download" ? "下载到" : "上传到"}</span><code title={job.localPath ?? job.path}>{job.localPath ?? job.path}</code><CopyUploadPath path={job.localPath ?? job.path} label={`复制 ${job.name} 的${job.direction === "download" ? "下载" : "上传"}路径`} /></div>{job.message ? <p className={(job.status === "interrupted" || job.status === "paused" || job.status === "pausing") ? "text-xs text-muted-foreground" : "text-xs text-danger"}>{job.message}</p> : null}</div>
        <div className="server-upload-progress"><div className="flex w-full justify-between gap-2"><span>{job.status === "verifying" ? "正在校验文件" : job.status === "completed" ? "传输完成" : job.status === "queued" ? "排队中" : job.status === "running" ? (job.phase === "preparing" ? "检查文件" : "正在传输") : "已停止"}</span><strong>{job.status === "completed" ? 100 : Math.min(100, Math.round(job.transferred / (job.bytes || 1) * 100))}%</strong></div><progress aria-label={`${job.name} 传输进度`} value={job.status === "completed" ? job.bytes || 1 : job.transferred} max={job.bytes || 1} /><span>{formatTransferBytes(job.transferred)} / {formatTransferBytes(job.bytes)}</span>{job.status === "running" && job.phase !== "preparing" ? <span data-testid="upload-speed">{job.bytesPerSecond == null ? "正在估算速度…" : job.bytesPerSecond === 0 ? "等待服务器响应…" : `${formatTransferBytes(job.bytesPerSecond)}/s · 剩余${job.etaSeconds == null ? "估算中" : formatTransferEta(job.etaSeconds)}`}</span> : null}</div>
        <div className="server-upload-task-action">{job.canPause ? <Button size="sm" variant="ghost" aria-label={`暂停上传 ${job.name}`} onClick={() => { void pauseUpload(job.jobId) }}><Pause size={14} />暂停</Button> : null}{job.status === "interrupted" || job.status === "paused" ? <><Button size="sm" variant="outline" disabled={!connected || !job.canResume || Boolean(preparation) || Boolean(resumingJobId)} onClick={() => { void resumeUpload(job) }}>{resumingJobId === job.jobId ? <><SpinnerGap className="animate-spin" />正在继续…</> : "继续上传"}</Button><Button size="icon-sm" variant="ghost" aria-label={`取消${job.direction === "download" ? "下载" : "上传"} ${job.name}`} onClick={() => { void cancelUpload(job.jobId) }}><X /></Button></> : ACTIVE_UPLOAD_STATUSES.has(job.status) ? <Button size="icon-sm" variant="ghost" aria-label={`取消${job.direction === "download" ? "下载" : "上传"} ${job.name}`} onClick={() => { void cancelUpload(job.jobId) }}><X /></Button> : job.status === "completed" && job.direction !== "download" ? <Button size="sm" variant="ghost" disabled={!connected} aria-label={`定位到 ${job.name}`} onClick={() => { setMaximized(false); setFileLocation({ path: job.path, id: Date.now() }) }}><MapPin size={14} />定位文件</Button> : null}{job.canRemove ? <Button size="icon-sm" variant="ghost" title="移除记录，保留文件" aria-label={`移除记录 ${job.name}`} onClick={() => { void clearTransfers(job.jobId) }}><X /></Button> : null}</div>
      </div>) : <div className="px-4 py-6 text-center text-xs text-muted-foreground">选择目标目录，再上传本机文件。每项任务会保留自己的上传位置。</div>}</div> : null}
    </section>
    <footer className="server-workspace-footer"><span className="flex items-center gap-1.5"><TerminalWindow size={12} />SSH / SFTP</span><span>返回详情不会结束会话或传输</span></footer>
    <Dialog open={Boolean(preparation)} onOpenChange={(value) => { if (!value && !uploadActionRef.current) cancelPreparation() }}>
      {preparation ? <ServerUploadDialog preparation={preparation} serverName={entry.plugin.displayName} environmentName={entry.environmentName} identity={sshIdentity} busy={uploadConfirming || Boolean(uploadRevising)} confirming={uploadConfirming} removing={uploadRevising === "removing"} connected={connected} needsReview={uploadNeedsReview} overwrite={overwrite} error={uploadError} onOverwrite={setOverwrite} onRevise={reviseUpload} onConfirm={() => { void confirmUpload() }} onCancel={cancelPreparation} onReselect={() => { const target = preparation.sourcePath ?? preparation.path; cancelPreparation(); void pickUpload(target) }} /> : null}
    </Dialog>
    <Dialog open={closeDialog} onOpenChange={setCloseDialog}><DialogContent><DialogHeader><DialogTitle>关闭服务器工作区</DialogTitle><DialogDescription>{activeJobs.length ? "还有传输任务进行中。返回详情可以保留所有任务；请等传输结束或取消任务后再关闭工作区。" : "将结束这个工作区的终端会话并清除显示记录。服务器连接保持。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setCloseDialog(false); onBack() }}>返回详情并保留</Button><Button disabled={activeJobs.length > 0} onClick={onClose}>关闭工作区</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
