import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { CloudConfigData, CloudConfigRequest, CloudRow } from "./cloud-types"

function changeSummary(diff: CloudRow["diff"]): string {
  const changes: string[] = []
  if (diff.added || diff.modified || diff.removed) changes.push(`插件：新增 ${diff.added}、修改 ${diff.modified}、删除 ${diff.removed}`)
  if (diff.environmentsAdded || diff.environmentsRemoved) changes.push(`环境：新增 ${diff.environmentsAdded}、删除 ${diff.environmentsRemoved}`)
  if (diff.metadataChanged) changes.push("项目或环境信息有变更")
  if (diff.runbooksChanged) changes.push(`${diff.runbooksChanged} 份运维说明有变更`)
  if (diff.questionsChanged) changes.push("快捷提问有变更")
  if (diff.credentialsChanged) changes.push("凭据有变更")
  return changes.join("；") || "将完整替换项目配置"
}

interface CloudController {
  readonly data: CloudConfigData
  readonly busy: boolean
  readonly checking: boolean
  readonly loading: boolean
  readonly error: string
  readonly refresh: () => Promise<void>
  readonly check: (repositoryId?: string) => Promise<void>
  readonly run: (request: CloudConfigRequest) => Promise<CloudConfigData | null>
  readonly upload: (projectId: string, repositoryId?: string) => void
}
const CloudContext = createContext<CloudController | null>(null)
export function useCloudConfig() {
  const value = useContext(CloudContext)
  if (!value) throw new Error("云配置上下文不可用")
  return value
}

export function CloudConfigProvider({ api, onChanged, children }: { api: AiOpsV2Api; onChanged: () => void; children: ReactNode }) {
  const [data, setData] = useState<CloudConfigData>({})
  const [working, setWorking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [plan, setPlan] = useState<(CloudConfigData & { historical: boolean }) | null>(null)
  const [choices, setChoices] = useState<Record<string, "local" | "cloud">>({})
  const [uploadId, setUploadId] = useState<string | null>(null)
  const active = useRef(false)
  const busyRef = useRef(false)
  const checkingRef = useRef<Promise<void> | null>(null)
  const sequence = useRef(0)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const call = useCallback(async (request: CloudConfigRequest) => {
    const result = await api.cloudConfig(request)
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }, [api])
  const refresh = useCallback(async () => {
    const revision = ++sequence.current
    try { const next = await call({ action: "status" }); if (active.current && sequence.current === revision) { setData(next); setError("") } }
    catch (cause) { if (active.current && sequence.current === revision) setError(cause instanceof Error ? cause.message : "无法读取云配置") }
    finally { if (active.current) setLoading(false) }
  }, [call])
  const check = useCallback(async (repositoryId?: string) => {
    if (checkingRef.current) {
      if (!repositoryId) return checkingRef.current
      await checkingRef.current
    }
    setChecking(true)
    const revision = ++sequence.current
    const pending = (async () => {
      try { const next = await call({ action: "check", ...(repositoryId ? { repositoryId } : {}) }); if (active.current && revision === sequence.current) { setData(next); setError("") } }
      catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "云仓库检测失败") }
    })()
    checkingRef.current = pending
    try { await pending }
    finally { if (checkingRef.current === pending) checkingRef.current = null; if (active.current) setChecking(false) }
  }, [call])
  useEffect(() => {
    active.current = true
    void refresh().then(() => { if (active.current) void check() })
    return () => { active.current = false; sequence.current++ }
  }, [refresh, check])
  const interval = data.checkIntervalMinutes ?? 15
  useEffect(() => {
    if (!interval) return
    const timer = window.setInterval(() => { void check() }, interval * 60_000)
    return () => window.clearInterval(timer)
  }, [interval, check])
  const run = useCallback(async (request: CloudConfigRequest) => {
    if (busyRef.current) return null
    busyRef.current = true
    setWorking(true); setError("")
    try {
      const result = await call(request)
      if (!active.current) return null
      if (result.planId) {
        setPlan({ ...result, historical: request.action === "prepare" && Boolean(request.snapshotId) })
        setChoices(Object.fromEntries((result.rows ?? []).map(row => [row.rowId, "cloud"])))
      }
      if (result.results) {
        const failed = result.results.filter(row => row.status === "failed")
        const completed = result.results.filter(row => row.status === "imported" || row.status === "uploaded")
        if (failed.length) toast.error(`${failed.length} 个项目未完成同步`, { description: failed.map(row => row.error?.message).join("；") })
        else if (completed.length) toast.success(`已完成 ${completed.length} 个项目${request.action === "sync" && request.direction === "upload" ? "上传" : "更新"}`)
        else if (!result.planId) toast.info("项目配置已是最新")
        if (result.syncStateWarning || result.results.some(row => row.syncStateWarning || row.cleanupPending)) toast.warning("配置已写入，请重新检测同步状态；事务清理未完成时请重启应用。")
        onChangedRef.current()
      }
      if (request.action === "bind" || request.action === "create") await check(result.repositoryId)
      await refresh()
      return result
    } catch (cause) {
      if (active.current) { const message = cause instanceof Error ? cause.message : "云配置操作失败"; setError(message); toast.error(message) }
      return null
    } finally { busyRef.current = false; if (active.current) setWorking(false) }
  }, [call, check, refresh])
  const upload = useCallback((projectId: string, repositoryId?: string) => {
    const available = (data.repositories ?? []).filter(repo => repo.unlocked)
    const target = repositoryId ?? (available.length === 1 ? available[0]?.repositoryId : undefined)
    if (target) void run({ action: "sync", repositoryId: target, direction: "upload", projectId })
    else setUploadId(projectId)
  }, [data.repositories, run])
  const busy = working || plan !== null
  return <CloudContext.Provider value={{ data, busy, checking, loading, error, refresh, check, run, upload }}>
    {children}
    <AlertDialog open={Boolean(plan)} onOpenChange={open => { if (!open && !working) setPlan(null) }}>
      <AlertDialogContent data-testid="cloud-update-confirmation">
        <AlertDialogHeader>
          <AlertDialogTitle>{plan?.direction === "restore" ? "恢复本机备份" : plan?.historical ? "恢复云端历史版本？" : "覆盖本地修改？"}</AlertDialogTitle>
          <AlertDialogDescription>{plan?.direction === "restore" ? "选中项目将用备份完整替换。" : plan?.historical ? "选中项目将用所选历史版本完整替换。" : "以下项目存在本地修改。选中项目将用云端配置完整替换。"}覆盖前自动备份，原连接将断开。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto">{plan?.rows?.map(row => <label key={row.rowId} className="flex items-start gap-2 text-xs">
          <Checkbox checked={choices[row.rowId] === "cloud"} disabled={working} onCheckedChange={checked => setChoices(current => ({ ...current, [row.rowId]: checked ? "cloud" : "local" }))} />
          <span className="min-w-0"><span className="block break-words font-medium">{row.name}</span><span className="text-muted-foreground">{changeSummary(row.diff)}</span></span>
        </label>)}</div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={working} onClick={() => setPlan(null)}>保留本地</Button>
          <Button disabled={working} data-testid="cloud-confirm-update" onClick={() => { const current = plan; setPlan(null); if (current?.planId) void run({ action: "confirm", planId: current.planId, choices }) }}>确认覆盖</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={uploadId !== null} onOpenChange={open => { if (!open) setUploadId(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>选择上传仓库</DialogTitle><DialogDescription>用此项目的本地配置更新所选云仓库。</DialogDescription></DialogHeader>
        <div className="grid max-h-[50vh] gap-2 overflow-y-auto">{(data.repositories ?? []).filter(repo => repo.unlocked).map(repo => <Button key={repo.repositoryId} variant="outline" onClick={() => { const id = uploadId; setUploadId(null); if (id) upload(id, repo.repositoryId) }}>{repo.name}</Button>)}</div>
        {!(data.repositories ?? []).some(repo => repo.unlocked) ? <p className="text-xs text-muted-foreground">请先在配置 → 云配置中关联或解锁仓库。</p> : null}
      </DialogContent>
    </Dialog>
  </CloudContext.Provider>
}
