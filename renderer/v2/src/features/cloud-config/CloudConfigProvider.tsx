import { CloudFieldDiff } from "./CloudFieldDiff"
import { unsavedWorkCount } from "@/hooks/use-unsaved-work"
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, PublicError } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { CloudConfigData, CloudConfigRequest } from "./cloud-types"

import { changedCloudRows, changeSummary, initialCloudChoices } from "./cloud-diff-presentation"
export { changeSummary } from "./cloud-diff-presentation"

interface CloudController {
  readonly data: CloudConfigData
  readonly busy: boolean
  readonly checking: boolean
  readonly loading: boolean
  readonly error: string
  readonly operationError: PublicError | null
  readonly clearOperationError: () => void
  readonly refresh: () => Promise<void>
  readonly check: (repositoryId?: string) => Promise<void>
  readonly run: (request: CloudConfigRequest) => Promise<CloudConfigData | null>
  readonly upload: (projectId: string, repositoryId?: string) => void
}
const CloudContext = createContext<CloudController | null>(null)
export function useCloudConfig() {
  const value = useContext(CloudContext)
  if (!value) throw new Error("云同步上下文不可用")
  return value
}

export function CloudConfigProvider({ api, onChanged, children }: { api: AiOpsV2Api; onChanged: () => void; children: ReactNode }) {
  const [data, setData] = useState<CloudConfigData>({})
  const [working, setWorking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [operationError, setOperationError] = useState<PublicError | null>(null)
  const [plan, setPlan] = useState<(CloudConfigData & { historical: boolean }) | null>(null)
  const diffId = useId()
  const [choices, setChoices] = useState<Record<string, "local" | "cloud">>({})
  const [uploadId, setUploadId] = useState<string | null>(null)
  const active = useRef(false)
  const busyRef = useRef(false)
  const checkingRef = useRef<Promise<void> | null>(null)
  const refreshingRef = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)
  const sequence = useRef(0)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const call = useCallback(async (request: CloudConfigRequest) => {
    const result = await api.cloudConfig(request)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.data
  }, [api])
  const refresh = useCallback(() => {
    refreshAgain.current = true
    if (refreshingRef.current) return refreshingRef.current
    const pending = (async () => {
      do {
        refreshAgain.current = false
        const revision = ++sequence.current
        try { const next = await call({ action: "status" }); if (active.current && sequence.current === revision && !refreshAgain.current) { setData(next); setError("") } }
        catch (cause) { if (active.current && sequence.current === revision) setError(cause instanceof Error ? cause.message : "无法读取云同步") }
        finally { if (active.current) setLoading(false) }
      } while (active.current && refreshAgain.current)
    })()
    refreshingRef.current = pending
    void pending.finally(() => { if (refreshingRef.current === pending) refreshingRef.current = null })
    return pending
  }, [call])
  const check = useCallback(async (repositoryId?: string) => {
    if (checkingRef.current) {
      if (!repositoryId) return checkingRef.current
      await checkingRef.current
    }
    setChecking(true)
    const revision = ++sequence.current
    const pending = (async () => {
      try { const next = await call({ action: "check", ...(repositoryId ? { repositoryId } : {}) }); if (active.current && revision === sequence.current) { setData(next); setError("") } else if (active.current) await refresh() }
      catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "云仓库检测失败") }
    })()
    checkingRef.current = pending
    try { await pending }
    finally { if (checkingRef.current === pending) checkingRef.current = null; if (active.current) setChecking(false) }
  }, [call, refresh])
  useEffect(() => {
    active.current = true
    void refresh()
    return () => { active.current = false; sequence.current++ }
  }, [refresh, check])
  useEffect(() => {
    return api.onUpdateCenter(event => { if (event.kind === "cloud") void refresh() })
  }, [api, refresh])
  const run = useCallback(async (request: CloudConfigRequest) => {
    if (busyRef.current) return null
    const replacesLocal = request.action === "sync" && request.direction === "download"
      || request.action === "confirm" && plan?.direction !== "upload" && Object.values(request.choices).some(choice => choice === "cloud")
    if (replacesLocal && unsavedWorkCount() > 0) {
      toast.error("还有未保存的草稿或待处理操作", { description: "请先保存、导出或关闭相关编辑，再覆盖本地配置。" })
      return null
    }
    busyRef.current = true
    setWorking(true); setError(""); setOperationError(null)
    try {
      const result = await call(request)
      if (!active.current) return null
      if (result.planId) {
        setPlan({ ...result, historical: request.action === "prepare" && Boolean(request.snapshotId) })
        setChoices(initialCloudChoices(result.rows))
      }
      if (result.results) {
        const failed = result.results.filter(row => row.status === "failed")
        const completed = result.results.filter(row => row.status === "imported" || row.status === "uploaded")
        if (failed.length) { setOperationError(failed[0]?.error ?? { code: "CLOUD_OPERATION_FAILED", message: "部分项目同步失败" }); toast.error(`${failed.length} 个项目未完成同步`, { description: failed.map(row => row.error?.message).join("；") }) }
        else if (result.results.some(row => row.status === "cloud-deleted")) toast.success("云端项目已移入已删除，可在 30 天内恢复")
        else if (result.results.some(row => row.status === "cloud-restored")) toast.success("已发布新的云端版本，点击更新可同步到本机")
        else if (completed.length) toast.success(`已完成 ${completed.length} 个项目${request.action === "sync" && request.direction === "upload" ? "上传" : "更新"}`)
        else if (!result.planId) toast.info("项目配置已是最新")
        if (result.syncStateWarning || result.results.some(row => row.syncStateWarning || row.cleanupPending)) toast.warning("配置已写入，请重新检测同步状态；事务清理未完成时请重启应用。")
        onChangedRef.current()
      }
      if (request.action === "bind" || request.action === "create") await check(result.repositoryId)
      await refresh()
      return result
    } catch (cause) {
      if (active.current) { const message = cause instanceof Error ? cause.message : "云同步操作失败"; setError(message); setOperationError({ code: cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "CLOUD_OPERATION_FAILED", message }); toast.error(message) }
      return null
    } finally { busyRef.current = false; if (active.current) setWorking(false) }
  }, [call, check, refresh, plan?.direction])
  const upload = useCallback((projectId: string, repositoryId?: string) => {
    const available = (data.repositories ?? []).filter(repo => repo.unlocked)
    const target = repositoryId ?? (available.length === 1 ? available[0]?.repositoryId : undefined)
    if (target) void run({ action: "sync", repositoryId: target, direction: "upload", projectId })
    else setUploadId(projectId)
  }, [data.repositories, run])
  const busy = working || plan !== null
  const changedRows = changedCloudRows(plan?.rows)
  const conflict = changedRows.some(row => row.conflict)
  const selectedCount = changedRows.filter(row => choices[row.rowId] === "cloud").length
  return <CloudContext.Provider value={{ data, busy, checking, loading, error, operationError, clearOperationError: () => { if (error === operationError?.message) setError(""); setOperationError(null) }, refresh, check, run, upload }}>
    {children}
    <AlertDialog open={Boolean(plan)} onOpenChange={open => { if (!open && !working) setPlan(null) }}>
      <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-2xl" data-testid="cloud-update-confirmation">
        <AlertDialogHeader className="shrink-0">
          <AlertDialogTitle>{plan?.direction === "restore" ? "恢复本机备份" : plan?.historical ? "恢复云端历史版本？" : conflict ? "覆盖本地修改？" : "查看云端配置变更"}</AlertDialogTitle>
          <AlertDialogDescription>{plan?.direction === "restore" ? "选中项目将用备份完整替换。" : plan?.historical ? "选中项目将用所选历史版本完整替换。" : conflict ? "有本地修改的项目默认保留；核对后需手动勾选，才会用云端配置完整替换。" : "确认后将用云端配置更新选中的项目。"}覆盖前自动备份，原连接将断开。可在“配置 → 云同步 → 本机备份”恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="shrink-0 space-y-2 border-y py-3" data-testid="cloud-change-summary">
          <p className="text-sm font-medium">{changedRows.length} 个项目有变化{(plan?.rows?.length ?? 0) > changedRows.length ? <span className="ml-2 text-xs font-normal text-muted-foreground">已隐藏 {(plan?.rows?.length ?? 0) - changedRows.length} 个无变化项目</span> : null}</p>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">{changedRows.map((row, index) => <Button key={row.rowId} variant="secondary" size="xs" className="max-w-full" onClick={() => document.getElementById(`${diffId}-${index}`)?.scrollIntoView({block:"nearest",behavior:"smooth"})}><span className="truncate">{row.name}</span></Button>)}</div>
        </div>
        <div className="min-h-0 max-h-[50vh] space-y-4 overflow-y-auto" data-testid="cloud-changed-projects">
          {!changedRows.length ? <p className="py-6 text-center text-sm text-muted-foreground">所选项目已是最新，没有需要更新的改动。</p> : changedRows.map((row, index) => <section key={row.rowId} id={`${diffId}-${index}`} className="space-y-3 rounded-lg border p-3" data-cloud-change-project={row.rowId}>
            <label className="flex items-start gap-2">
              <Checkbox checked={choices[row.rowId] === "cloud"} disabled={working} aria-label={`更新 ${row.name}`} onCheckedChange={checked => setChoices(current => ({ ...current, [row.rowId]: checked ? "cloud" : "local" }))} />
              <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{row.name}</span><span className="mt-1 block text-xs text-muted-foreground">{changeSummary(row.diff)}</span></span>
              {row.conflict ? <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">本地有修改</span> : null}
            </label>
            <CloudFieldDiff diff={row.diff} />
            {row.warnings.length ? <ul className="space-y-1 text-xs text-warning">{row.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
          </section>)}
        </div>
        <AlertDialogFooter className="shrink-0">
          <span className="mr-auto self-center text-xs text-muted-foreground">已选择 {selectedCount} 个项目</span>
          <Button variant="outline" disabled={working} onClick={() => setPlan(null)}>保留本地</Button>
          <Button disabled={working || !selectedCount} data-testid="cloud-confirm-update" onClick={() => { const current = plan; setPlan(null); if (current?.planId) void run({ action: "confirm", planId: current.planId, choices }) }}>{conflict || plan?.historical || plan?.direction === "restore" ? "确认覆盖" : "确认更新"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={uploadId !== null} onOpenChange={open => { if (!open) setUploadId(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>选择上传仓库</DialogTitle><DialogDescription>用此项目的本地配置更新所选云仓库。</DialogDescription></DialogHeader>
        <div className="grid max-h-[50vh] gap-2 overflow-y-auto">{(data.repositories ?? []).filter(repo => repo.unlocked).map(repo => <Button key={repo.repositoryId} variant="outline" onClick={() => { const id = uploadId; setUploadId(null); if (id) upload(id, repo.repositoryId) }}>{repo.name}</Button>)}</div>
        {!(data.repositories ?? []).some(repo => repo.unlocked) ? <p className="text-xs text-muted-foreground">请先在配置 → 云同步中关联或解锁仓库。</p> : null}
      </DialogContent>
    </Dialog>
  </CloudContext.Provider>
}
