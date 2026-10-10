import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { DownloadSimple, Bell, Check, Cloud, Desktop, WarningCircle } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useCloudConfig } from "@/features/cloud-config/CloudConfigProvider"
import type { UpdateCenterState, UpdateNotice, UpdateSettingsTarget, UpdateTarget } from "./update-types"

const UpdatesContext = createContext<{ count: number; open: () => void } | null>(null)

export function UpdatesButton({ iconOnly = false }: { readonly iconOnly?: boolean }) {
  const updates = useContext(UpdatesContext)
  if (!updates) return null
  const label = updates.count ? `更新，${updates.count} 项待处理` : "更新"
  return <Button variant="ghost" size={iconOnly ? "icon-sm" : "sm"} className="relative shrink-0" aria-label={label} title={label} onClick={updates.open} data-testid="updates-open">
    <Bell aria-hidden="true" />{!iconOnly ? "更新" : null}
    {updates.count > 0 ? <span className={iconOnly ? "absolute -top-0.5 -right-1 rounded bg-primary px-1 text-[9px] leading-3 text-primary-foreground tabular-nums" : "rounded bg-primary/10 px-1 text-xs text-primary tabular-nums"} aria-hidden="true" data-testid="updates-count">{updates.count > 99 ? "99+" : updates.count}</span> : null}
  </Button>
}

export function UpdateCenterProvider({ api, onNavigate, children }: { readonly api: AiOpsV2Api; readonly onNavigate: (target: UpdateSettingsTarget) => void; readonly children: ReactNode }) {
  const cloud = useCloudConfig()
  const [state, setState] = useState<UpdateCenterState>({ items: [], error: null })
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await api.updateCenter({ action: "status" })
      if (!mounted.current || request !== sequence.current) return
      if (result.ok) { setState(result.data); setError("") } else setError(result.error.message)
    } catch { if (mounted.current && request === sequence.current) setError("无法读取更新提醒，请重试。") }
    finally { if (mounted.current && request === sequence.current) setLoading(false) }
  }, [api])
  const navigate = useCallback((target: UpdateTarget, projectId?: string) => {
    setOpen(false)
    onNavigateRef.current({ section: target.type === "software" ? "about" : "cloud", repositoryId: target.repositoryId, ...(projectId ? {projectId} : {}), deleted: target.kind === "deleted", sequence: Date.now() })
  }, [])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onUpdateCenter(event => {
      void refresh()
      if (event.kind === "open" && event.target) navigate(event.target)
      if (event.kind === "notice") toast.info(event.title ?? "有新的更新", { description: event.body, action: { label: "查看", onClick: () => setOpen(true) } })
    })
    void refresh()
    return () => { mounted.current = false; sequence.current++; unsubscribe() }
  }, [api, navigate, refresh])
  const markRead = async (ids: string[]) => {
    setSaving(true)
    try {
      const result = await api.updateCenter({ action: "read", ids })
      if (!mounted.current) return
      if (result.ok) { setState(result.data); setError("") } else setError(result.error.message)
    } catch { if (mounted.current) setError("无法保存已读状态，请重试。") }
    finally { if (mounted.current) setSaving(false) }
  }
  const view = (item: UpdateNotice) => {
    void markRead([item.id])
    navigate(item, item.type === "cloud" && item.kind !== "deleted" ? item.projectId : undefined)
  }
  const groups = [...new Set(state.items.map(item => item.type === "software" ? "software" : item.repositoryId))]
  return <UpdatesContext.Provider value={{ count: state.items.length, open: () => { setOpen(true); void refresh() } }}>
    {children}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl" data-testid="update-center">
        <DialogHeader><DialogTitle>更新</DialogTitle><DialogDescription>软件版本与云端配置的待处理更新。查看后仍会保留，完成更新后自动移除。</DialogDescription></DialogHeader>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{state.items.length} 项待处理 · {state.items.filter(item => item.unread).length} 项未读</span><Button size="xs" variant="ghost" disabled={saving || !state.items.some(item => item.unread)} onClick={() => void markRead(state.items.map(item => item.id))} data-testid="updates-read-all"><Check />全部已读</Button></div>
        {error || state.error ? <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><WarningCircle /><span>{error || state.error}</span><Button size="xs" variant="ghost" onClick={() => void refresh()}>重试</Button></div> : null}
        <div className="min-h-0 space-y-5 overflow-y-auto" aria-busy={loading || saving}>
          {loading ? <p className="py-8 text-center text-sm text-muted-foreground">正在读取更新…</p> : !state.items.length ? <p className="py-8 text-center text-sm text-muted-foreground">暂无待处理更新</p> : groups.map(group => {
            const items = state.items.filter(item => (item.type === "software" ? "software" : item.repositoryId) === group)
            const Icon = group === "software" ? Desktop : Cloud
            return <section key={group} className="space-y-2" aria-label={group === "software" ? "软件更新" : items[0]!.repositoryName}>
              <div className="flex items-center gap-2 text-xs font-medium"><Icon aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{group === "software" ? "软件更新" : items[0]!.repositoryName}</span>{group !== "software" ? <Button size="xs" variant="ghost" onClick={() => navigate(items[0]!)}>打开仓库</Button> : null}</div>
              {items.map(item => <article key={item.id} className="rounded-md border bg-card p-3" data-testid="update-notice" data-update-id={item.id}>
                <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words text-sm font-medium">{item.title}</h3>{item.unread ? <span className="shrink-0 text-xs text-primary">未读</span> : <span className="shrink-0 text-xs text-muted-foreground">已读</span>}</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                <div className="mt-2 flex justify-end gap-2">{item.unread ? <Button size="xs" variant="ghost" disabled={saving} onClick={() => void markRead([item.id])}>稍后处理</Button> : null}<Button size="xs" variant="outline" disabled={cloud.busy} onClick={() => view(item)} data-testid="update-notice-view"><DownloadSimple />{item.type === "software" ? item.kind === "downloaded" ? "前往安装" : "查看版本" : item.kind === "deleted" ? "查看详情" : "查看变更"}</Button></div>
              </article>)}
            </section>
          })}
        </div>
      </DialogContent>
    </Dialog>
  </UpdatesContext.Provider>
}
