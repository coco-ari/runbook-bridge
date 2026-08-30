import {
  BookOpenText,
  CaretLeft,
  CaretRight,
  ChatsCircle,
  ClockCounterClockwise,
  DotsThree,
  FolderOpen,
  GearSix,
  GridFour,
  NotePencil,
  Plugs,
  ShieldCheck,
  SidebarSimple,
  Trash,
  WarningDiamond,
} from "@phosphor-icons/react"
import { useCallback,useEffect,useRef,useState,type ReactNode } from "react"

import type { AiOpsV2Api, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useMenuHandoff } from "@/hooks/use-menu-handoff"
import {
  detailSelectionKind,
  detailTabsForSelection,
} from "@/components/detail-workspace/detail-navigation"
import { AuditFeature } from "@/features/audit/AuditFeature"
import { ConfirmationsFeature, type ConfirmationScope } from "@/features/confirmations/ConfirmationsFeature"
import { PluginConnectionPanel } from "@/features/connections/PluginConnectionPanel"
import { EnvironmentConnectionPanel } from "@/features/connections/EnvironmentConnectionPanel"
import { EnvironmentOverview } from "@/features/environments/EnvironmentOverview"
import { PluginAgentAccess } from "@/features/plugins/PluginAgentAccess"
import { PluginOverview } from "@/features/plugins/PluginOverview"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { ProjectOverview } from "@/features/projects/ProjectOverview"
import { QuickQuestionsFeature } from "@/features/quick-questions/QuickQuestionsFeature"
import { RunbookFeature } from "@/features/runbooks/RunbookFeature"
import type {
  EnvironmentRuntimeReadModel,
  WorkspaceEnvironmentReadModel,
  WorkspacePluginReadModel,
  WorkspaceProjectReadModel,
  WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"

export type WorkspaceDetailAction =
  | Readonly<{ type: "create-project" }>
  | Readonly<{ type: "edit-project"; project: WorkspaceProjectReadModel }>
  | Readonly<{
      type: "edit-environment"
      project: WorkspaceProjectReadModel
      environment: WorkspaceEnvironmentReadModel
    }>
  | Readonly<{ type: "edit-plugin"; plugin: PluginConfigurationRecord; returnFocus?: "plugin-action-edit" }>
  | Readonly<{ type: "rename-plugin"; plugin: PluginConfigurationRecord }>
  | Readonly<{ type: "delete-plugin"; plugin: PluginConfigurationRecord }>

export interface WorkspaceDetailProps {
  readonly activeTab: string
  readonly api: AiOpsV2Api
  readonly collapsed: boolean
  readonly environment: WorkspaceEnvironmentReadModel | null
  readonly environmentError: WorkspaceReadError | null
  readonly environmentLoading: boolean
  readonly environmentPlugins: readonly WorkspacePluginReadModel[] | null
  readonly onAction: (action: WorkspaceDetailAction) => void
  readonly onAgentAccessDirtyChange: (dirty: boolean) => void
  readonly onAgentAccessSavingChange: (saving: boolean) => void
  readonly onLocateScope: (scope: ConfirmationScope, tab?: "overview" | "audit") => void
  readonly onOpenPlugin: (projectId: string, environmentId: string, pluginInstanceId: string) => void
  readonly onTabChange: (value: string) => void
  readonly onPluginUpdated: () => void
  readonly onDismissSaveNotice: () => void
  readonly onRunbookDirtyChange: (dirty: boolean) => void
  readonly onRunbookSavingChange: (saving: boolean) => void
  readonly onQuickQuestionsDirtyChange: (dirty: boolean) => void
  readonly onQuickQuestionsSavingChange: (saving: boolean) => void
  readonly onToggleCollapsed: () => void
  readonly plugin: WorkspacePluginReadModel | null
  readonly pluginRecord: PluginConfigurationRecord | null
  readonly saveNotice: string | null
  readonly project: WorkspaceProjectReadModel | null
  readonly rawRuntime: EnvironmentRuntime | null
  readonly runtime: EnvironmentRuntimeReadModel | null
  readonly workspaceError: WorkspaceReadError | null
  readonly workspaceLoading: boolean
  readonly onReloadEnvironment: () => void
  readonly onReloadWorkspace: () => void
}

function PersistentTabsContent({
  activeValue,
  children,
  value,
}: {
  readonly activeValue: string
  readonly children: ReactNode
  readonly value: string
}) {
  const [visited,setVisited] = useState(activeValue === value)
  useEffect(() => {
    if (activeValue === value) setVisited(true)
  },[activeValue,value])
  if (!visited && activeValue !== value) return null
  return (
    <TabsContent className="data-[state=inactive]:hidden" forceMount value={value}>
      {children}
    </TabsContent>
  )
}

function CollapsedDetail({ onToggle }: { readonly onToggle: () => void }) {
  return (
    <aside
      aria-label="已折叠的详情工作区"
      className="flex h-full flex-col items-center border-l bg-surface py-2"
      data-collapsed="true"
      data-testid="detail-workspace"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="展开详情工作区" data-testid="detail-expand" onClick={onToggle} size="icon-sm" type="button" variant="ghost">
            <CaretLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">展开详情工作区</TooltipContent>
      </Tooltip>
      <SidebarSimple className="mt-3 text-muted-foreground" size={17} />
    </aside>
  )
}

function DetailTabIcon({ value }: { readonly value: string }) {
  const iconProps = { "aria-hidden": true, size: 15, weight: "bold" as const }
  if (value === "agent") return <ShieldCheck {...iconProps} />
  if (value === "runbook") return <BookOpenText {...iconProps} />
  if (value === "questions") return <ChatsCircle {...iconProps} />
  if (value === "audit") return <ClockCounterClockwise {...iconProps} />
  if (value === "confirmations") return <WarningDiamond {...iconProps} />
  return <GridFour {...iconProps} />
}

function SelectionActions({
  environment,
  onAction,
  plugin,
  pluginSelected,
  project,
}: {
  readonly environment: WorkspaceEnvironmentReadModel | null
  readonly onAction: (action: WorkspaceDetailAction) => void
  readonly plugin: PluginConfigurationRecord | null
  readonly pluginSelected: boolean
  readonly project: WorkspaceProjectReadModel
}) {
  const handoff = useMenuHandoff(`${project.projectId}:${project.revision}/${environment?.environmentId}:${environment?.revision}/${plugin?.pluginInstanceId}:${plugin?.revision}`)
  const queueAction = (action: WorkspaceDetailAction) => handoff.queueAction(() => onAction(action))

  return (
    <DropdownMenu onOpenChange={handoff.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button aria-label="当前范围更多操作" data-testid="detail-scope-actions" size="icon-xs" type="button" variant="ghost">
          <DotsThree weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={handoff.onCloseAutoFocus}>
        <DropdownMenuLabel>当前范围</DropdownMenuLabel>
        {plugin ? (
          <>
            <DropdownMenuItem onSelect={() => queueAction({ type: "rename-plugin", plugin })}>
              <NotePencil />修改名称
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => queueAction({ type: "edit-plugin", plugin })}>
              <GearSix />连接配置
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => queueAction({ type: "delete-plugin", plugin })} variant="destructive">
              <Trash />删除插件
            </DropdownMenuItem>
          </>
        ) : pluginSelected ? (
          <DropdownMenuItem disabled>
            <Plugs />未知插件类型，默认拒绝修改
          </DropdownMenuItem>
        ) : environment ? (
          <DropdownMenuItem onSelect={() => queueAction({ type: "edit-environment", project, environment })}>
            <GearSix />环境设置
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => queueAction({ type: "edit-project", project })}>
            <GearSix />项目设置
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorkspaceDetail({
  api,
  activeTab,
  collapsed,
  environment,
  environmentError,
  environmentLoading,
  environmentPlugins,
  onAction,
  onAgentAccessDirtyChange,
  onAgentAccessSavingChange,
  onLocateScope,
  onOpenPlugin,
  onTabChange,
  onPluginUpdated,
  onDismissSaveNotice,
  onRunbookDirtyChange,
  onRunbookSavingChange,
  onQuickQuestionsDirtyChange,
  onQuickQuestionsSavingChange,
  onToggleCollapsed,
  plugin,
  pluginRecord,
  saveNotice,
  project,
  rawRuntime,
  runtime,
  workspaceError,
  workspaceLoading,
  onReloadEnvironment,
  onReloadWorkspace,
}: WorkspaceDetailProps) {
  const detailTabTriggers = useRef(new Map<string, HTMLButtonElement>())
  const detailTabsViewportRef = useRef<HTMLDivElement>(null)
  const tabRevealFrames = useRef<number[]>([])
  const [detailTabsOverflow,setDetailTabsOverflow] = useState({
    backward: false,
    forward: false,
    overflow: false,
  })

  const updateDetailTabsOverflow = useCallback(() => {
    const viewport = detailTabsViewportRef.current
    if (!viewport) return

    const maximumScrollLeft = Math.max(0,viewport.scrollWidth - viewport.clientWidth)
    const next = {
      backward: viewport.scrollLeft > 1,
      forward: viewport.scrollLeft < maximumScrollLeft - 1,
      overflow: maximumScrollLeft > 1,
    }
    setDetailTabsOverflow((current) => current.backward === next.backward
      && current.forward === next.forward
      && current.overflow === next.overflow
      ? current
      : next)
  }, [])

  const revealDetailTab = useCallback((value: string) => {
    const trigger = detailTabTriggers.current.get(value)
    const viewport = detailTabsViewportRef.current
    if (!trigger || !viewport) return

    trigger.scrollIntoView({ block: "nearest", inline: "nearest" })
    const triggerRect = trigger.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    if (triggerRect.right > viewportRect.right) {
      viewport.scrollLeft += triggerRect.right - viewportRect.right + 8
    } else if (triggerRect.left < viewportRect.left) {
      viewport.scrollLeft -= viewportRect.left - triggerRect.left + 8
    }
    updateDetailTabsOverflow()
  }, [updateDetailTabsOverflow])

  const scheduleDetailTabReveal = useCallback((value: string) => {
    tabRevealFrames.current.forEach(cancelAnimationFrame)
    tabRevealFrames.current = []
    const firstFrame = requestAnimationFrame(() => {
      revealDetailTab(value)
      const secondFrame = requestAnimationFrame(() => revealDetailTab(value))
      tabRevealFrames.current = [secondFrame]
    })
    tabRevealFrames.current = [firstFrame]
  }, [revealDetailTab])

  useEffect(() => () => {
    tabRevealFrames.current.forEach(cancelAnimationFrame)
  }, [])

  useEffect(() => {
    const activeTrigger = detailTabTriggers.current.get(activeTab)
    if (!activeTrigger) return

    scheduleDetailTabReveal(activeTab)
  },[
    activeTab,
    collapsed,
    environment?.environmentId,
    plugin?.pluginInstanceId,
    project?.projectId,
    scheduleDetailTabReveal,
  ])

  useEffect(() => {
    const viewport = detailTabsViewportRef.current
    if (!viewport) return
    let frame = 0
    const keepActiveTabVisible = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        scheduleDetailTabReveal(activeTab)
      })
    }
    const observer = new ResizeObserver(keepActiveTabVisible)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    viewport.addEventListener("scroll",updateDetailTabsOverflow,{ passive: true })
    window.addEventListener("resize", keepActiveTabVisible)
    updateDetailTabsOverflow()
    return () => {
      observer.disconnect()
      viewport.removeEventListener("scroll",updateDetailTabsOverflow)
      window.removeEventListener("resize", keepActiveTabVisible)
      cancelAnimationFrame(frame)
    }
  }, [
    activeTab,
    collapsed,
    environment?.environmentId,
    plugin?.pluginInstanceId,
    project?.projectId,
    scheduleDetailTabReveal,
    updateDetailTabsOverflow,
  ])

  const handleDetailTabChange = useCallback((value: string) => {
    onTabChange(value)
    scheduleDetailTabReveal(value)
  }, [onTabChange,scheduleDetailTabReveal])

  const scrollDetailTabs = (direction: -1 | 1) => {
    const viewport = detailTabsViewportRef.current
    if (!viewport) return
    viewport.scrollBy({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      left: direction * Math.max(120,Math.floor(viewport.clientWidth * 0.65)),
    })
  }

  if (collapsed) return <CollapsedDetail onToggle={onToggleCollapsed} />

  if (!project && !workspaceLoading) {
    return (
      <main className="relative grid h-full min-h-0 place-items-center bg-background px-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60" id="detail-main" tabIndex={-1}>
        <Button aria-label="折叠详情工作区" className="absolute right-3 top-3" data-testid="detail-collapse" onClick={onToggleCollapsed} size="icon-xs" type="button" variant="ghost">
          <CaretRight />
        </Button>
        <Empty className="max-w-sm" data-testid="no-project-detail-state">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
            <EmptyTitle>{workspaceError ? "工作区暂时不可用" : "建立第一个运维项目"}</EmptyTitle>
            <EmptyDescription>
              {workspaceError ? workspaceError.message : "项目用于隔离环境、插件、确认与操作范围。"}
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => workspaceError ? onReloadWorkspace() : onAction({ type: "create-project" })} size="sm" type="button">
            {workspaceError ? "重新读取" : "新增项目"}
          </Button>
        </Empty>
      </main>
    )
  }

  const selectedPluginRuntime = plugin
    ? runtime?.plugins.find((item) => item.pluginInstanceId === plugin.pluginInstanceId)
    : null
  const selectedStatus = selectedPluginRuntime?.status
    ?? plugin?.status
    ?? runtime?.status
    ?? environment?.status
    ?? project?.status
    ?? "disconnected"
  const title = plugin?.displayName ?? environment?.name ?? project?.name ?? "正在读取工作区"
  const scopePath = [project?.name, environment?.name, plugin?.displayName].filter(Boolean).join(" / ")
  const hasEnvironment = Boolean(project && environment)
  const hasPlugin = Boolean(hasEnvironment && plugin)
  const selectionKind = detailSelectionKind(hasEnvironment, plugin?.pluginType ?? null)
  const visibleTabs = detailTabsForSelection(selectionKind)
  const supportedPlugin = pluginRecord
    && ["server", "mysql", "redis"].includes(pluginRecord.pluginType)
    ? pluginRecord
    : null

  return (
    <Tabs
      activationMode="manual"
      className="flex h-full min-h-0 min-w-0 flex-col gap-0 bg-background"
      data-collapsed="false"
      data-testid="detail-workspace"
      onValueChange={handleDetailTabChange}
      orientation="horizontal"
      value={activeTab}
    >
      <header className="shrink-0 bg-surface">
        <div className="flex min-w-0 items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] text-muted-foreground" title={scopePath}>{scopePath || "本地工作区"}</p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight" title={title}>{title}</h1>
              <StatusIndicator appearance="badge" status={selectedStatus} />
              {workspaceLoading || environmentLoading ? <Badge variant="info">正在刷新</Badge> : null}
            </div>
          </div>
          {project ? <SelectionActions environment={environment} onAction={onAction} plugin={supportedPlugin} pluginSelected={hasPlugin} project={project} /> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button aria-label="折叠详情工作区" data-testid="detail-collapse" onClick={onToggleCollapsed} size="icon-xs" type="button" variant="ghost">
                <CaretRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">折叠详情工作区</TooltipContent>
          </Tooltip>
        </div>

        {visibleTabs.length > 1 ? (
          <div
            className="flex max-w-full items-center gap-1 border-y border-border/70 bg-background/35 px-1.5 py-1.5"
            data-overflow={detailTabsOverflow.overflow}
            data-testid="detail-tabs-navigation"
          >
            <Button
              aria-controls="detail-tabs"
              aria-hidden={!detailTabsOverflow.overflow}
              aria-label="向左滚动详情视图"
              className={detailTabsOverflow.overflow ? "shrink-0" : "hidden"}
              data-testid="detail-tabs-scroll-backward"
              disabled={!detailTabsOverflow.backward}
              onClick={() => scrollDetailTabs(-1)}
              size="icon-xs"
              tabIndex={detailTabsOverflow.overflow ? undefined : -1}
              type="button"
              variant="ghost"
            >
              <CaretLeft aria-hidden="true" />
            </Button>
            <ScrollArea
              className="min-w-0 flex-1 whitespace-nowrap"
              orientation="horizontal"
              viewportClassName="[&>div]:min-w-max!"
              viewportRef={detailTabsViewportRef}
            >
              <TabsList aria-label="详情视图" className="w-max min-w-max justify-start" data-testid="detail-tabs" id="detail-tabs" variant="navigation">
                {visibleTabs.map((tab) => (
                  <TabsTrigger
                    className="min-w-max flex-none text-xs"
                    data-detail-tab={tab.value}
                    data-testid={tab.value === "overview"
                      ? "detail-tab-overview"
                      : tab.value === "audit"
                        ? "detail-tab-history"
                        : undefined}
                    key={tab.value}
                    ref={(element) => {
                      if (element) detailTabTriggers.current.set(tab.value,element)
                      else detailTabTriggers.current.delete(tab.value)
                    }}
                    value={tab.value}
                  >
                    <DetailTabIcon value={tab.value} />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </ScrollArea>
            <Button
              aria-controls="detail-tabs"
              aria-hidden={!detailTabsOverflow.overflow}
              aria-label="向右滚动详情视图"
              className={detailTabsOverflow.overflow ? "shrink-0" : "hidden"}
              data-testid="detail-tabs-scroll-forward"
              disabled={!detailTabsOverflow.forward}
              onClick={() => scrollDetailTabs(1)}
              size="icon-xs"
              tabIndex={detailTabsOverflow.overflow ? undefined : -1}
              type="button"
              variant="ghost"
            >
              <CaretRight aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60" data-selection-kind={hasPlugin ? "plugin" : hasEnvironment ? "environment" : "project"} id="detail-main" tabIndex={-1}>
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-5xl px-4 py-4">
            {saveNotice ? (
              <Alert className="mb-4 border-warning/30 bg-warning/5" data-testid="plugin-save-recovery-notice">
                <WarningDiamond aria-hidden="true" className="text-warning" />
                <AlertTitle>保存已完成，仍有恢复事项</AlertTitle>
                <AlertDescription>
                  <p>{saveNotice}</p>
                  <Button className="mt-2" onClick={onDismissSaveNotice} size="xs" variant="outline">知道了</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            <PersistentTabsContent activeValue={activeTab} value="overview">
              {plugin ? (
                <PluginOverview
                  error={environmentError}
                  loading={environmentLoading}
                  onReload={onReloadEnvironment}
                  plugin={plugin}
                  connectionPanel={supportedPlugin ? (
                    <PluginConnectionPanel api={api} onEdit={() => onAction({ type: "edit-plugin", plugin: supportedPlugin, returnFocus: "plugin-action-edit" })} onRuntime={onReloadEnvironment} plugin={supportedPlugin} runtime={rawRuntime} />
                  ) : null}
                />
              ) : environment ? (
                <EnvironmentOverview
                  environment={environment}
                  error={environmentError}
                  loading={environmentLoading}
                  onReload={onReloadEnvironment}
                  connectionPanel={(
                    <EnvironmentConnectionPanel
                      api={api}
                      environment={environment}
                      onOpenPlugin={(pluginInstanceId) => onOpenPlugin(environment.projectId, environment.environmentId, pluginInstanceId)}
                      onRuntime={onReloadEnvironment}
                      plugins={environmentPlugins}
                      runtime={rawRuntime}
                    />
                  )}
                />
              ) : (
                <ProjectOverview error={workspaceError} loading={workspaceLoading} onReload={onReloadWorkspace} project={project} />
              )}
            </PersistentTabsContent>

            {selectionKind === "plugin" ? (
              <PersistentTabsContent activeValue={activeTab} value="agent">
                {supportedPlugin ? (
                  <PluginAgentAccess api={api} onDirtyChange={onAgentAccessDirtyChange} onSavingChange={onAgentAccessSavingChange} onUpdated={onPluginUpdated} plugin={supportedPlugin} />
                ) : (
                  <Alert><Plugs /><AlertTitle>Agent 权限不可用</AlertTitle><AlertDescription>未知插件类型默认拒绝 Agent 能力。</AlertDescription></Alert>
                )}
              </PersistentTabsContent>
            ) : null}

            {project && environment ? (
              <>
                {selectionKind === "environment" ? (
                  <>
                    <PersistentTabsContent activeValue={activeTab} value="runbook">
                      <RunbookFeature environmentId={environment.environmentId} environmentName={environment.name} environmentRevision={environment.revision} onDirtyChange={onRunbookDirtyChange} onEnvironmentRevisionChange={onPluginUpdated} onSavingChange={onRunbookSavingChange} projectId={project.projectId} projectName={project.name} />
                    </PersistentTabsContent>
                    <PersistentTabsContent activeValue={activeTab} value="questions">
                      <QuickQuestionsFeature environmentId={environment.environmentId} environmentName={environment.name} onDirtyChange={onQuickQuestionsDirtyChange} onSavingChange={onQuickQuestionsSavingChange} projectId={project.projectId} projectName={project.name} />
                    </PersistentTabsContent>
                  </>
                ) : null}
                <TabsContent value="audit">
                  <AuditFeature
                    environmentId={environment.environmentId}
                    environmentName={environment.name}
                    pluginInstanceId={plugin?.pluginInstanceId ?? null}
                    projectId={project.projectId}
                    projectName={project.name}
                    {...(plugin ? { pluginName: plugin.displayName } : {})}
                  />
                </TabsContent>
                <TabsContent value="confirmations">
                  <ConfirmationsFeature
                    environmentId={environment.environmentId}
                    environmentName={environment.name}
                    onLocateScope={(scope) => onLocateScope(scope, "overview")}
                    onOpenAudit={(scope) => onLocateScope(scope, "audit")}
                    pluginInstanceId={plugin?.pluginInstanceId ?? null}
                    scopeMode={hasPlugin ? "plugin" : "environment"}
                    projectId={project.projectId}
                    projectName={project.name}
                    {...(plugin ? { pluginName: plugin.displayName } : {})}
                  />
                </TabsContent>
              </>
            ) : null}
          </div>
        </ScrollArea>
      </main>
    </Tabs>
  )
}
