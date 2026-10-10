import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowRight, Bell, Check, Clock, Cloud, Desktop, WarningCircle } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useCloudConfig } from "@/features/cloud-config/CloudConfigProvider"
import { cn } from "@/lib/utils"
import type { NotificationMode, UpdateCenterRequest, UpdateCenterState, UpdateNotice, UpdateSettingsTarget, UpdateTarget } from "./update-types"

interface UpdatesController {
  readonly items: readonly UpdateNotice[]
  readonly count: number
  readonly busy: boolean
  readonly open: () => void
  readonly view: (item: UpdateNotice) => void
}
const UpdatesContext = createContext<UpdatesController | null>(null)
export const useUpdates = () => useContext(UpdatesContext)

export function updateAction(item: UpdateNotice) {
  return item.type === "software" ? item.kind === "downloaded" ? "准备重启更新" : "查看版本"
    : item.kind === "deleted" ? "查看详情" : item.kind === "conflict" ? "比较并选择" : item.kind === "added" ? "查看配置" : "查看差异"
}

function noticedTime(timestamp?: number) {
  if (!timestamp) return ""
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  return minutes < 1 ? "刚刚发现" : minutes < 60 ? `${minutes} 分钟前发现` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前发现` : `${Math.floor(minutes / 1440)} 天前发现`
}

export function UpdatesButton({ iconOnly = false }: { readonly iconOnly?: boolean }) {
  const updates = useUpdates()
  if (!updates) return null
  const label = updates.count ? `更新，${updates.count} 项未读` : "更新"
  return <Button variant="ghost" size={iconOnly ? "icon-sm" : "sm"} className="relative shrink-0" aria-label={label} title={label} onClick={updates.open} data-testid="updates-open">
    <Bell aria-hidden="true" />{!iconOnly ? "更新" : null}
    {updates.count > 0 ? <span className={iconOnly ? "absolute -top-0.5 -right-1 rounded bg-foreground px-1 text-[9px] leading-3 text-background tabular-nums" : "rounded bg-muted px-1 text-xs text-foreground tabular-nums"} aria-hidden="true" data-testid="updates-count">{updates.count > 99 ? "99+" : updates.count}</span> : null}
  </Button>
}

export function UpdateCenterProvider({ api, onNavigate, children }: { readonly api: AiOpsV2Api; readonly onNavigate: (target: UpdateSettingsTarget) => void; readonly children: ReactNode }) {
  const cloud = useCloudConfig()
  const [state, setState] = useState<UpdateCenterState>({ items: [], error: null })
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"pending" | "later">("pending")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [, setClock] = useState(0)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const savingRef = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const navigating = useRef(false)
  const interactedOutside = useRef(false)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const refresh = useCallback(async () => {
    if (savingRef.current) return
    const request = ++sequence.current
    try {
      const result = await api.updateCenter({ action: "status" })
      if (!mounted.current || request !== sequence.current) return
      if (result.ok) { setState(result.data); setError("") } else setError(result.error.message)
    } catch { if (mounted.current && request === sequence.current) setError("无法读取更新提醒，请重试。") }
    finally { if (mounted.current && request === sequence.current) setLoading(false) }
  }, [api])
  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    navigating.current = false
    interactedOutside.current = false
    setOpen(true)
    void refresh()
  }, [refresh])
  const navigate = useCallback((target: UpdateTarget) => {
    navigating.current = true
    setOpen(false)
    onNavigateRef.current({ section: target.type === "software" ? "about" : "cloud", repositoryId: target.repositoryId,
      ...(target.type === "cloud" && target.kind !== "deleted" && target.projectId ? {projectId:target.projectId} : {}), deleted: target.kind === "deleted", sequence: Date.now() })
  }, [])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onUpdateCenter(event => {
      void refresh()
      if (event.kind === "open" && event.target) navigate(event.target)
      if (event.kind === "notice") toast.info(event.title ?? "有新的更新", { id: `update-${event.target?.repositoryId ?? "all"}`, description: event.body, action: { label: "查看", onClick: show } })
    })
    void refresh()
    return () => { mounted.current = false; sequence.current++; unsubscribe() }
  }, [api, navigate, refresh, show])
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setClock(value => value + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [open])
  const save = async (request: UpdateCenterRequest) => {
    if (savingRef.current) return
    savingRef.current = true
    sequence.current++
    setSaving(true)
    let saved = false
    try {
      const result = await api.updateCenter(request)
      if (!mounted.current) return
      if (result.ok) { setState(result.data); setError(""); saved = true } else setError(result.error.message)
    } catch { if (mounted.current) setError("无法保存提醒设置，请重试。") }
    finally {
      savingRef.current = false
      if (mounted.current) { setSaving(false); if (saved) void refresh() }
    }
  }
  const view = (item: UpdateNotice) => {
    if (savingRef.current || cloud.busy) return
    if (item.unread) void save({action:"read",ids:[item.id]})
    navigate(item)
  }
  const pending = state.items.filter(item => !item.snoozedUntil)
  const later = state.items.filter(item => item.snoozedUntil)
  const unread = pending.filter(item => item.unread)
  const visible = tab === "pending" ? pending : later
  const groups = [...new Set(visible.map(item => item.type === "software" ? "software" : item.repositoryId))]
  return <UpdatesContext.Provider value={{ items: state.items, count: unread.length, busy: saving || cloud.busy, open: show, view }}>
    {children}
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent className="gap-0 data-[side=right]:w-[420px] data-[side=right]:sm:max-w-[420px]" data-testid="update-center" onInteractOutside={() => { interactedOutside.current = true }} onCloseAutoFocus={event => {
        event.preventDefault()
        if (!navigating.current && !interactedOutside.current && opener.current?.isConnected && !opener.current.closest('[hidden],[inert]')) opener.current.focus()
      }}>
        <SheetHeader className="gap-2 border-b px-5 pt-5 pb-4 pr-12">
          <SheetTitle className="flex items-center gap-2"><Bell className="size-4 text-muted-foreground" />更新</SheetTitle>
          <SheetDescription className="text-xs leading-5">查看新版本和云端变更，选择合适的时间处理。</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <div className="flex gap-1" role="group" aria-label="更新筛选">
            <Button size="sm" variant={tab === "pending" ? "secondary" : "ghost"} aria-pressed={tab === "pending"} onClick={() => setTab("pending")} data-testid="updates-pending">待处理 <span className="text-muted-foreground tabular-nums">{pending.length}</span></Button>
            <Button size="sm" variant={tab === "later" ? "secondary" : "ghost"} aria-pressed={tab === "later"} onClick={() => setTab("later")} data-testid="updates-later">稍后 <span className="text-muted-foreground tabular-nums">{later.length}</span></Button>
          </div>
          <Button size="xs" variant="ghost" disabled={saving || !unread.length} onClick={() => void save({action:"read",ids:unread.map(item => item.id)})} data-testid="updates-read-all" title="全部标为已读，保留待处理更新"><Check />全部已读</Button>
        </div>
        {error || state.error ? <div role="alert" className="mx-4 mt-3 flex items-center gap-2 text-xs text-destructive"><WarningCircle /><span>{error || state.error}</span><Button size="xs" variant="ghost" onClick={() => void refresh()}>重试</Button></div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5" aria-busy={loading || saving}>
          {loading ? <p className="py-12 text-center text-sm text-muted-foreground">正在读取更新…</p> : !visible.length ? <div className="py-14 text-center text-muted-foreground"><Check className="mx-auto mb-3 size-7" /><p className="text-sm">{tab === "later" ? "没有延后的提醒" : later.length ? "其余更新已安排稍后提醒" : "暂无待处理更新"}</p><p className="mt-2 text-xs">{tab === "later" ? "需要时，可把更新留到合适的时间。" : "有新的变化时，会在这里告诉你。"}</p></div> : groups.map(group => {
            const items = visible.filter(item => (item.type === "software" ? "software" : item.repositoryId) === group)
            const Icon = group === "software" ? Desktop : Cloud
            return <section key={group} className="py-4" aria-label={group === "software" ? "软件更新" : items[0]!.repositoryName}>
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Icon aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{group === "software" ? "软件更新" : items[0]!.repositoryName}</span></div>
              <div className="divide-y">{items.map(item => <article key={item.id} className="py-4" data-testid="update-notice" data-update-id={item.id}>
                <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-medium leading-5">{item.title}</h3>{item.kind === "conflict" ? <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">需要比较</span> : item.unread ? <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground" aria-label="未读" /> : null}</div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
                <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">{item.snoozedUntil ? <><Clock />{new Date(item.snoozedUntil).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})} 提醒</> : <time title={item.firstSeenAt ? new Date(item.firstSeenAt).toLocaleString("zh-CN") : undefined}>{noticedTime(item.firstSeenAt)}</time>}</p>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  {item.snoozedUntil ? <Button size="xs" variant="ghost" disabled={saving} onClick={() => void save({action:"snooze",ids:[item.id],duration:"cancel"})} data-testid="update-resume">移回待处理</Button> : <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" className="text-muted-foreground" disabled={saving} aria-label={`${item.title}，稍后提醒`} data-testid="update-snooze"><Clock />稍后提醒</Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => void save({action:"snooze",ids:[item.id],duration:"hour"})} data-testid="update-snooze-hour">1 小时后</DropdownMenuItem><DropdownMenuItem onSelect={() => void save({action:"snooze",ids:[item.id],duration:"tomorrow"})} data-testid="update-snooze-tomorrow">明天上午 9 点</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>}
                  <Button size="xs" variant="outline" className={cn(item.kind === "conflict" && "text-warning")} disabled={saving || cloud.busy} onClick={() => view(item)} data-testid="update-notice-view">{updateAction(item)}<ArrowRight /></Button>
                </div>
              </article>)}</div>
            </section>
          })}
        </div>
        <div className="space-y-3 border-t bg-muted/20 px-5 py-4">
          <div className="flex items-center justify-between gap-2"><label htmlFor="update-notification-mode" className="text-xs text-muted-foreground">提醒方式</label><select id="update-notification-mode" data-testid="update-notification-mode" className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" value={state.notificationMode ?? "background"} disabled={saving} onChange={event => void save({action:"preferences",notificationMode:event.target.value as NotificationMode})}><option value="app">仅应用内</option><option value="background">仅后台时系统通知</option><option value="always">始终系统通知</option></select></div>
          <p className="text-[11px] text-muted-foreground">{unread.length} 项未读 · 已读的更新仍保留，完成后自动移除。</p>
        </div>
      </SheetContent>
    </Sheet>
  </UpdatesContext.Provider>
}
