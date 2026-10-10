import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowLeft, ArrowSquareOut, Bell, Cloud, Desktop, DownloadSimple, GearSix, ShieldWarning, WarningCircle } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { UtilityPopover, useUtilityPopover } from "@/components/ui/utility-popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useCloudConfig } from "@/features/cloud-config/CloudConfigProvider"
import { useSoftwareUpdate } from "@/features/software-update/use-software-update"
import { SoftwareUpdateConfirmation } from "@/features/software-update/SoftwareUpdateConfirmation"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import { ConfirmationsFeature } from "@/features/confirmations/ConfirmationsFeature"
import { ConfirmationMessages, confirmationTarget, type MessageConfirmations } from "@/features/confirmations/ConfirmationMessages"
import { ConfirmationArrivals, type ConfirmationMessage } from "@/features/confirmations/confirmation-message-model"
import type { ConfirmationEnvironment } from "@/features/confirmations/global-confirmation-model"
import type { NotificationMode, UpdateCenterState, UpdateNotice, UpdateSettingsTarget, UpdateTarget } from "./update-types"

interface UpdatesController {
  readonly confirmations: MessageConfirmations
  readonly openConfirmations: (anchor?: HTMLElement) => void
  readonly items: readonly UpdateNotice[]
  readonly count: number
  readonly busy: boolean
  readonly isOpen: boolean
  readonly contentId: string
  readonly open: (anchor: HTMLElement) => void
  readonly view: (item: UpdateNotice) => void
}
const UpdatesContext = createContext<UpdatesController | null>(null)
export const useUpdates = () => useContext(UpdatesContext)

export function updateAction(item: UpdateNotice) {
  return item.type === "software" ? item.kind === "downloaded" ? "立即更新" : "下载新版本"
    : item.kind === "deleted" ? "查看详情" : "立即更新"
}

function noticedTime(timestamp?: number) {
  if (!timestamp) return ""
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  return minutes < 1 ? "刚刚发现" : minutes < 60 ? `${minutes} 分钟前发现` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前发现` : `${Math.floor(minutes / 1440)} 天前发现`
}

export function UpdatesButton({ iconOnly = false, compact = false, className = "" }: { readonly iconOnly?: boolean; readonly compact?: boolean; readonly className?: string }) {
  const updates = useUpdates()
  if (!updates) return null
  const confirmations = updates.confirmations
  const label = ["消息中心", confirmations.unavailable ? "待确认不可用" : confirmations.loading ? "正在读取待确认" : confirmations.count ? `${confirmations.count} 项待确认操作` : "", updates.count ? `${updates.count} 项更新` : ""].filter(Boolean).join("，")
  return <Button variant="ghost" size={iconOnly ? "icon-sm" : "sm"} className={`relative shrink-0 text-muted-foreground ${className}`} aria-label={label} aria-haspopup="dialog" aria-expanded={updates.isOpen} aria-controls={updates.isOpen ? updates.contentId : undefined} title={label} onClick={event => updates.open(event.currentTarget)} data-testid="updates-open">
    <Bell aria-hidden="true" className={confirmations.unavailable || (confirmations.count ?? 0) > 0 ? "text-warning" : undefined} />{!iconOnly ? <span data-utility-label={compact || undefined}>消息中心</span> : null}
    {updates.count > 0 ? <span className={iconOnly ? "absolute -top-0.5 -right-1 rounded bg-primary/10 px-1 text-[9px] leading-3 text-primary tabular-nums" : "rounded bg-primary/10 px-0.5 text-[10px] text-primary tabular-nums"} aria-hidden="true" data-utility-count={compact || undefined} data-testid="updates-count">{updates.count > 99 ? "99+" : updates.count}</span> : null}
  </Button>
}

export function ConfirmationNotice({ inline = false }: { readonly inline?: boolean }) {
  const center = useUpdates()
  if (!center || center.confirmations.loading || (!center.confirmations.unavailable && !center.confirmations.count)) return null
  const label = center.confirmations.unavailable ? "待确认暂不可用" : `${center.confirmations.count} 项操作待确认`
  return <Button variant="outline" size="sm" className={inline ? "shrink-0 gap-1.5 border-warning/25 bg-warning/10 px-2 text-xs text-warning hover:bg-warning/15" : "mx-2 mb-2 h-auto min-h-9 shrink-0 justify-between gap-2 whitespace-normal border-warning/25 bg-warning/10 px-2 py-2 text-left text-xs text-warning hover:bg-warning/15"}
    data-testid={inline ? "workspace-confirmation-notice" : "confirmation-notice"} aria-label={`${label}，打开消息中心`} aria-haspopup="dialog" aria-expanded={center.isOpen} onClick={event => center.openConfirmations(event.currentTarget)}>
    {inline ? <ShieldWarning aria-hidden="true" /> : null}<span>{inline && !center.confirmations.unavailable ? `${center.confirmations.count} 项待确认` : label}</span>{!inline ? <span className="shrink-0">查看 →</span> : null}
  </Button>
}

export function UpdateCenterProvider({ api, onNavigate, confirmations, projects, onConfirmationNavigate, children }: {
  readonly api: AiOpsV2Api
  readonly onNavigate: (target: UpdateSettingsTarget) => void
  readonly confirmations: MessageConfirmations
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly onConfirmationNavigate: (scope: ConfirmationEnvironment) => void
  readonly children: ReactNode
}) {
  const cloud = useCloudConfig()
  const [state, setState] = useState<UpdateCenterState>({ items: [], error: null })
  const popup = useUtilityPopover('[data-testid="updates-open"], [data-testid="confirmation-notice"], [data-testid="workspace-confirmation-notice"]')
  const [selected, setSelected] = useState<ConfirmationMessage | null>(null)
  const reviewHeading = useRef<HTMLHeadingElement | null>(null)
  const pendingScope = useRef<ConfirmationEnvironment | null>(null)
  const arrivals = useRef(new ConfirmationArrivals())
  const [decisionNotice, setDecisionNotice] = useState("")
  const selectedTarget = selected ? confirmationTarget(selected, projects) : null
  const { show, setOpen } = popup
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [actionError, setActionError] = useState("")
  const [saving, setSaving] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [installTarget, setInstallTarget] = useState<UpdateNotice | null>(null)
  const software = useSoftwareUpdate(api, state.items.some(item => item.type === "software") || Boolean(installTarget))
  const [, setClock] = useState(0)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const savingRef = useRef(false)
  const acting = useRef(false)
  const navigating = useRef(false)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const openConfirmations = useCallback((anchor?: HTMLElement) => {
    navigating.current = false
    setSelected(null)
    setDecisionNotice("")
    const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="updates-open"]')).find(element => element.checkVisibility() && !element.closest('[hidden],[inert]'))
    show(trigger ?? anchor)
    requestAnimationFrame(() => document.querySelector('[data-testid="message-confirmations"]')?.scrollIntoView({ block: "start" }))
  }, [show])
  useEffect(() => { if (!popup.open) { setSelected(null); setDecisionNotice("") } }, [popup.open])
  useEffect(() => { if (selected) reviewHeading.current?.focus() }, [selected])
  useEffect(() => {
    if (confirmations.loading || confirmations.unavailable) return
    const count = arrivals.current.receive(confirmations.items)
    if (count) toast.warning(`有 ${count} 项新操作需要确认`, { id: "confirmation-arrivals", description: "请核对项目、环境和操作内容。", action: { label: "查看", onClick: () => openConfirmations() } })
  }, [confirmations.items, confirmations.loading, confirmations.unavailable, openConfirmations])
  const backToMessages = () => {
    const id = selected?.requestId
    setSelected(null)
    requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-confirmation-message]')).find(item => item.dataset.confirmationMessage === id)
      const target = row?.querySelector<HTMLElement>('button:not(:disabled)') ?? document.getElementById(popup.id)
      target?.focus()
    })
  }
  const refresh = useCallback(async () => {
    if (savingRef.current) return
    const request = ++sequence.current
    try {
      const result = await api.updateCenter({ action: "status" })
      if (!mounted.current || request !== sequence.current) return
      if (result.ok) { setState(result.data); setError(""); if (!result.data.items.length) setActionError("") } else setError(result.error.message)
    } catch { if (mounted.current && request === sequence.current) setError("无法读取消息，请重试。") }
    finally { if (mounted.current && request === sequence.current) setLoading(false) }
  }, [api])
  const navigate = useCallback((target: UpdateTarget) => {
    navigating.current = true
    setOpen(false)
    onNavigateRef.current({ section: target.type === "software" ? "about" : "cloud", repositoryId: target.repositoryId,
      ...(target.type === "cloud" && target.kind !== "deleted" && target.projectId ? {projectId:target.projectId} : {}), deleted: target.kind === "deleted", sequence: Date.now() })
  }, [setOpen])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onUpdateCenter(event => {
      void refresh()
      if (event.kind === "open" && event.target) navigate(event.target)
      if (event.kind === "notice") toast.info(event.title ?? "有新的更新", { id: `update-${event.target?.repositoryId ?? "all"}`, description: event.body, action: { label: "查看", onClick: () => {
        const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="updates-open"]')).find(element => element.checkVisibility() && !element.closest('[hidden],[inert]'))
        if (trigger) { navigating.current = false; show(trigger); void refresh() }
        else if (event.target) navigate(event.target)
        else onNavigateRef.current({ section: "cloud", sequence: Date.now() })
      } } })
    })
    void refresh()
    return () => { mounted.current = false; sequence.current++; unsubscribe() }
  }, [api, navigate, refresh, show])
  useEffect(() => {
    if (!popup.open) return
    const timer = window.setInterval(() => setClock(value => value + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [popup.open])
  const savePreferences = async (notificationMode: NotificationMode) => {
    if (savingRef.current) return
    savingRef.current = true; sequence.current++; setSaving(true)
    try {
      const result = await api.updateCenter({ action: "preferences", notificationMode })
      if (mounted.current) { if (result.ok) { setState(result.data); setError("") } else setError(result.error.message) }
    } catch { if (mounted.current) setError("无法保存提醒设置，请重试。") }
    finally { savingRef.current = false; if (mounted.current) { setSaving(false); void refresh() } }
  }
  const matches = (item: UpdateNotice, current: typeof software.state) => Boolean(item.version && current?.source?.repositoryId === item.repositoryId && current.availableVersion === item.version)
  const actOnSoftware = async (item: UpdateNotice, install = false) => {
    if (acting.current) return
    acting.current = true; setActingId(item.id); setActionError("")
    const fail = (message: string) => { setActionError(message); if (install) { navigating.current = false; show() } }
    try {
      let current = await software.refresh()
      if (!current) { fail("暂时无法读取更新状态，请重试。"); return }
      if (!matches(item, current)) { fail("版本或更新来源已变化，请刷新消息后重试。"); return }
      if (install) {
        if (current?.phase !== "downloaded") { fail("安装包尚未就绪，请重新下载。"); return }
        const result = await software.run({ action: "install" })
        if (!result || result.phase === "error") { navigating.current = false; show(); toast.error(result?.error?.message ?? "更新未完成，请查看消息中心后重试。") }
      } else if (current?.phase === "downloaded") {
        navigating.current = true; setOpen(false); setInstallTarget(item)
      } else {
        navigating.current = false; show()
        if (current?.phase === "error") current = await software.run({ action: "check" })
        if (current && !matches(item, current)) { fail("版本或更新来源已变化，请刷新消息后重试。"); return }
        if (matches(item, current) && current?.phase === "available") await software.run({ action: "download" })
      }
    } finally { acting.current = false; if (mounted.current) { setActingId(null); void refresh() } }
  }
  const view = (item: UpdateNotice) => {
    if (savingRef.current || cloud.busy) return
    if (item.type === "software") void actOnSoftware(item)
    else navigate(item)
  }
  const groups = [...new Set(state.items.map(item => item.type === "software" ? "software" : item.repositoryId))]
  const preferences = <DropdownMenu>
    <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" className="text-muted-foreground" disabled={saving} aria-label="提醒设置" title="提醒设置" data-testid="update-preferences"><GearSix /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuLabel>更新提醒方式</DropdownMenuLabel><DropdownMenuRadioGroup value={state.notificationMode ?? "background"} onValueChange={value => void savePreferences(value as NotificationMode)}>
      <DropdownMenuRadioItem value="app" data-testid="update-mode-app">仅应用内</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="background" data-testid="update-mode-background">仅后台时系统通知</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="always" data-testid="update-mode-always">始终系统通知</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>
  return <UpdatesContext.Provider value={{ confirmations, openConfirmations, items: state.items, count: state.items.length, busy: saving || cloud.busy, isOpen: popup.open, contentId: popup.id, open: trigger => { navigating.current = false; popup.toggle(trigger); if (confirmations.unavailable) confirmations.retry(); void refresh() }, view }}>
    {children}
    <UtilityPopover controller={popup} title={selected ? "核对操作" : "消息中心"} summary={selected ? null : [confirmations.count ? `${confirmations.count} 项待确认` : "", state.items.length ? `${state.items.length} 项更新` : ""].filter(Boolean).join(" · ")} description="待确认操作优先显示；配置与软件更新单独列出。" actions={selected ? null : preferences} testId="update-center" closeTestId="updates-close"
      footer={selected ? <div className="flex items-center justify-between gap-2"><Button size="xs" variant="ghost" data-testid="confirmation-review-back" onClick={backToMessages}><ArrowLeft />返回消息</Button><Button size="xs" variant="ghost" disabled={!selectedTarget?.available} data-testid="confirmation-review-page" onClick={() => { pendingScope.current = { projectId: selected.projectId, environmentId: selected.environmentId, count: 1 }; popup.setOpen(false) }}>在页面中查看<ArrowSquareOut /></Button></div> : null}
      onCloseAutoFocus={event => { const scope = pendingScope.current; pendingScope.current = null; if (scope) { event.preventDefault(); requestAnimationFrame(() => onConfirmationNavigate(scope)) } else if (navigating.current) event.preventDefault() }}>
      {selected ? <div data-testid="confirmation-review">
        <h3 ref={reviewHeading} tabIndex={-1} className="break-words py-3 text-sm font-semibold outline-none">{selectedTarget?.project?.name ?? selected.projectId} / {selectedTarget?.environment?.name ?? selected.environmentId}</h3>
        {selectedTarget?.available && selectedTarget.project && selectedTarget.environment ? <ConfirmationsFeature key={selected.requestId} compact requestId={selected.requestId}
          projectId={selected.projectId} environmentId={selected.environmentId} pluginInstanceId={selected.pluginInstanceId}
          projectName={selectedTarget.project.name} environmentName={selectedTarget.environment.name}
          onDecided={decision => { setDecisionNotice(decision === "approve" ? "已授权一次，等待 Agent 执行。" : "操作已拒绝。"); confirmations.retry(); backToMessages() }} /> : <p role="alert" className="py-4 text-sm text-muted-foreground">环境已不存在或暂不可用，无法确认操作。</p>}
      </div> : <>
      {decisionNotice ? <p role="status" className="border-b py-3 text-xs" data-testid="message-decision-feedback">{decisionNotice}</p> : null}
      <ConfirmationMessages confirmations={confirmations} projects={projects} onReview={item => { setDecisionNotice(""); setSelected(item) }} />
      {actionError || error || state.error ? <div role="alert" className="flex items-center gap-2 py-3 text-xs text-destructive"><WarningCircle /><span>{actionError || error || state.error}</span><Button size="xs" variant="ghost" onClick={() => { setActionError(""); void refresh() }}>刷新</Button></div> : null}
      <div aria-busy={loading || saving} data-testid="updates-list" className={state.items.length && (confirmations.count || confirmations.unavailable || confirmations.loading) ? "border-t" : undefined}>
        {state.items.length ? <h3 className="pt-3 text-xs font-medium text-muted-foreground">配置与软件更新 · {state.items.length}</h3> : null}
        {loading ? <p className="py-4 text-center text-sm text-muted-foreground">正在读取消息…</p> : !state.items.length ? (!confirmations.loading && !confirmations.unavailable && !confirmations.count && !error && !state.error && !actionError && !decisionNotice ? <p className="py-4 text-center text-sm text-muted-foreground">暂无消息</p> : null) : groups.map(group => {
          const items = state.items.filter(item => (item.type === "software" ? "software" : item.repositoryId) === group)
          const Icon = group === "software" ? Desktop : Cloud
          return <section key={group} className="py-2" aria-label={group === "software" ? "软件更新" : items[0]!.repositoryName}>
            <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" /><span className="min-w-0 flex-1 break-words">{group === "software" ? "软件更新" : items[0]!.repositoryName}</span></div>
            <div className="divide-y divide-border/60">{items.map(item => {
              const current = item.type === "software" && matches(item, software.state) ? software.state : null
              const downloading = current?.phase === "downloading"
              const installing = current?.phase === "installing"
              const label = downloading ? `下载中 ${Math.floor(current.progress?.percent ?? 0)}%` : installing ? "正在更新…" : current?.phase === "downloaded" ? "立即更新" : updateAction(item)
              return <article key={item.id} className="py-3" data-testid="update-notice" data-update-id={item.id}>
                <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-semibold leading-5">{item.title}</h3>{item.kind === "conflict" ? <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">本地有修改</span> : null}</div>
                <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{item.description}</p>
                {item.type === "software" && (software.error || current?.error) ? <p role="alert" className="mt-1 text-xs text-destructive">{software.error || current?.error?.message}</p> : null}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><time className="text-[11px] text-muted-foreground" title={item.firstSeenAt ? new Date(item.firstSeenAt).toLocaleString("zh-CN") : undefined}>{noticedTime(item.firstSeenAt)}</time>
                  <div className="ml-auto flex items-center gap-1">
                  {item.type === "cloud" && item.kind !== "deleted" ? <Button size="xs" variant="ghost" disabled={saving || cloud.busy} onClick={() => navigate(item)} data-testid="update-notice-diff">查看差异</Button> : null}
                  <Button size="xs" variant={item.kind === "deleted" ? "outline" : "default"} disabled={saving || cloud.busy || item.id === actingId || downloading || installing} onClick={() => view(item)} data-testid="update-notice-view">{item.type === "software" && !installing && current?.phase !== "downloaded" ? <DownloadSimple /> : null}{label}</Button>
                  </div>
                </div>
              </article>
            })}</div>
          </section>
        })}
      </div>
      </>}
    </UtilityPopover>
    <SoftwareUpdateConfirmation open={Boolean(installTarget)} onOpenChange={open => { if (!open) setInstallTarget(null) }} version={installTarget?.version ?? null} disabled={Boolean(actingId) || !installTarget || !matches(installTarget, software.state) || software.state?.phase !== "downloaded"} onInstall={() => { if (installTarget) void actOnSoftware(installTarget, true) }} />
  </UpdatesContext.Provider>
}
