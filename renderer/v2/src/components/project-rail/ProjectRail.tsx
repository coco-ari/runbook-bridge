import { cloudStatusLabels } from "@/features/cloud-config/CloudProjectActions"
import type { CloudLinkedProject, CloudRepository } from "@/features/cloud-config/cloud-types"
import { shortcutLabel } from "@/lib/platform"
import { useEffect, useMemo, useState } from "react"
import {
  ArrowClockwise,
  DotsThree,
  DownloadSimple,
  FolderSimple,
  GearSix,
  LockKey,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  ShieldWarning,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react"

import { StatusIndicator, statusLabel } from "@/components/app-shell/StatusIndicator"
import { SettingsButton } from "@/features/settings/SettingsButton"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  WorkspaceProjectReadModel,
  WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"
import type { ProjectOrderController } from "@/features/projects/ProjectOrderController"
import { useProjectDragOrder } from "@/features/projects/use-project-drag-order"
import { useRovingNavigation } from "@/hooks/use-roving-navigation"
import { useMenuHandoff } from "@/hooks/use-menu-handoff"
import { cn } from "@/lib/utils"
import { PROJECT_RAIL_COLLAPSED_SIZE } from "@/state/layout-state"

const ISOLATED_PROJECT_MESSAGE = "项目配置已隔离，无法选择、排序或新增环境"

function projectDescription(project: WorkspaceProjectReadModel): string {
  return project.isolated
    ? ISOLATED_PROJECT_MESSAGE
    : project.environmentCount + " 个环境"
}

function normalizeProjectQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase()
}

function ProjectListStatus({ project, linked, hasActions = true }: { project: WorkspaceProjectReadModel; linked?: CloudLinkedProject | undefined; hasActions?: boolean }) {
  const syncStatus = linked?.syncStatus
  const NoticeIcon = syncStatus === "behind" || syncStatus === "remote" ? DownloadSimple
    : syncStatus === "modified" ? PencilSimple
    : syncStatus === "error" ? WarningCircle
    : syncStatus === "locked" ? LockKey : null
  const showNotice = NoticeIcon && !project.isolated && (project.status === "connected" || project.status === "disconnected")
  return <span aria-hidden="true" className={cn("grid size-3 shrink-0 place-items-center", hasActions && "group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0 group-has-[[data-sidebar=menu-action][aria-expanded=true]]/menu-item:opacity-0")} data-project-compact-status data-project-status-badge data-cloud-status={syncStatus}>
    {showNotice ? <NoticeIcon data-cloud-notice={syncStatus} className={cn("size-3", syncStatus === "behind" ? "text-primary" : syncStatus === "modified" ? "text-warning" : syncStatus === "error" ? "text-destructive" : "text-muted-foreground")} /> : project.status === "disconnected" ? (
      <span className="grid size-3 place-items-center" data-status="disconnected" title={statusLabel(project.status)}>
        <span className="size-[7px] rounded-full border border-muted-foreground" />
      </span>
    ) : <StatusIndicator className="size-3 justify-center leading-none [&_svg]:size-3!" compact status={project.status} />}
  </span>
}

export type ProjectRailAction =
  | Readonly<{ type: "create-project" }>
  | Readonly<{ type: "create-environment"; project: WorkspaceProjectReadModel }>
  | Readonly<{ type: "edit-project"; project: WorkspaceProjectReadModel }>
  | Readonly<{ type: "delete-project"; project: WorkspaceProjectReadModel }>
  | Readonly<{ type: "open-confirmations" }>

interface ProjectRailProps {
  readonly cloudRepositories?: readonly CloudRepository[]
  readonly cloudProjects?: readonly CloudLinkedProject[]
  readonly cloudBusy?: boolean
  readonly cloudChecking?: boolean
  readonly onCheckCloud?: () => void
  readonly onOpenCloudProject?: (repositoryId: string, projectId: string) => void
  readonly shortcutsDisabled?: boolean
  readonly collapsed: boolean
  readonly expandDisabled?: boolean
  readonly error?: WorkspaceReadError | null
  readonly loading?: boolean
  readonly onAction: (action: ProjectRailAction) => void
  readonly onMoveProjectRelative?: ProjectOrderController["moveProjectRelative"] | undefined
  readonly onProjectKeyDown?: ((event: React.KeyboardEvent<HTMLElement>, projectId: string) => void) | undefined
  readonly onReload?: (() => void) | undefined
  readonly onSelectProject: (projectId: string) => void
  readonly onToggleCollapsed: () => void
  readonly pendingConfirmationCount: number
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly selectedProjectId: string | null
}

function ProjectContextMenu({
  children,
  project,
  onAction,
  onSelectProject,
  selectedProjectId,
}: {
  readonly children: React.ReactNode
  readonly onAction: (action: ProjectRailAction) => void
  readonly onSelectProject: () => void
  readonly project: WorkspaceProjectReadModel
  readonly selectedProjectId: string | null
}) {
  const handoff = useMenuHandoff(`${project.projectId}:${project.revision}:${selectedProjectId}`)
  return (
    <ContextMenu onOpenChange={handoff.onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handoff.onCloseAutoFocus}>
        {project.isolated ? (
          <>
            <ContextMenuItem disabled>
              <ShieldWarning />
              项目已隔离，无法打开
            </ContextMenuItem>
            <ContextMenuItem disabled>
              <Plus />
              无法新增环境
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => handoff.queueAction(onSelectProject)}>
              <FolderSimple />
              打开项目
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handoff.queueAction(() => onAction({ type: "create-environment", project }))}>
              <Plus />
              新增环境
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handoff.queueAction(() => onAction({ type: "edit-project", project }))}>
          <GearSix />
          项目设置
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handoff.queueAction(() => onAction({ type: "delete-project", project }))} variant="destructive">
          删除项目
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ProjectActionsMenu({ project, onAction, selectedProjectId }: {
  readonly project: WorkspaceProjectReadModel
  readonly onAction: (action: ProjectRailAction) => void
  readonly selectedProjectId: string | null
}) {
  const handoff = useMenuHandoff(`${project.projectId}:${project.revision}:${selectedProjectId}`)
  return (
    <DropdownMenu onOpenChange={handoff.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          aria-label={project.name + "更多操作"}
          className="top-2! right-1.5 opacity-0"
          showOnHover
        >
          <DotsThree weight="bold" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={handoff.onCloseAutoFocus} side="right">
        <DropdownMenuLabel>{project.name}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={project.isolated}
          onSelect={() => handoff.queueAction(() => onAction({ type: "create-environment", project }))}
        >
          {project.isolated ? <ShieldWarning /> : <Plus />}
          {project.isolated ? "项目已隔离，无法新增环境" : "新增环境"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => handoff.queueAction(() => onAction({ type: "edit-project", project }))}>
          <GearSix />
          项目设置
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => handoff.queueAction(() => onAction({ type: "delete-project", project }))} variant="destructive">
          <Trash />
          删除项目
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectRail({
  cloudRepositories = [], cloudProjects = [], cloudBusy = false, cloudChecking = false, onCheckCloud, onOpenCloudProject,
  shortcutsDisabled = false,
  collapsed,
  expandDisabled = false,
  error = null,
  loading = false,
  onAction,
  onMoveProjectRelative,
  onProjectKeyDown,
  onReload,
  onSelectProject,
  onToggleCollapsed,
  pendingConfirmationCount,
  projects,
  selectedProjectId,
}: ProjectRailProps) {
  const projectNavigation = useRovingNavigation<HTMLElement>()
  const [projectQuery, setProjectQuery] = useState("")
  const linkedByLocalId = new Map(cloudProjects.filter(item => item.localId).map(item => [item.localId, item]))
  const displayedProjects = [
    ...projects.filter(project => linkedByLocalId.get(project.projectId)?.visible !== false),
    ...cloudProjects.filter(item => item.visible && !projects.some(project => project.projectId === item.localId)).map(item => ({
      projectId: `cloud:${item.repositoryId}:${item.projectId}`, name: item.name, environmentCount: item.environmentCount,
      pluginCount: item.pluginCount, environments: [], revision: 0, isolated: false, status: "disconnected" as const,
    })),
  ]
  const linkedByDisplayId = new Map(cloudProjects.map(item => [projects.some(project => project.projectId === item.localId) ? item.localId : `cloud:${item.repositoryId}:${item.projectId}`, item]))
  const projectDrag = useProjectDragOrder({
    disabled: loading || !!error,
    onMoveProjectRelative,
    projects: displayedProjects.filter(project => !project.projectId.startsWith("cloud:")),
    query: projectQuery,
  })
  const confirmationCount = pendingConfirmationCount
  const toggleDisabled = collapsed && expandDisabled

  useEffect(() => {
    if (shortcutsDisabled) return
    // 此导航栏只在主工作台中响应快捷键。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "b") return
      const target = event.target instanceof HTMLElement ? event.target : document.activeElement
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]')
      )) return
      const modalOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]'))
        .some((element) => element.getClientRects().length > 0 && element.dataset.state !== "closed")
      if (modalOpen) return
      event.preventDefault()
      if (!toggleDisabled) onToggleCollapsed()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onToggleCollapsed, toggleDisabled, shortcutsDisabled])
  const normalizedProjectQuery = normalizeProjectQuery(projectQuery)
  const visibleProjects = useMemo(() => {
    if (!normalizedProjectQuery) return displayedProjects
    return displayedProjects.filter((project) => normalizeProjectQuery(
      project.name + " " + projectDescription(project),
    ).includes(normalizedProjectQuery))
  }, [normalizedProjectQuery, displayedProjects])
  const selectedProject = visibleProjects.find(
    (project) => project.projectId === selectedProjectId && !project.isolated,
  )
  const tabStopProjectId =
    selectedProject?.projectId
    ?? visibleProjects.find((project) => !project.isolated)?.projectId
    ?? visibleProjects[0]?.projectId
    ?? null

  return (
    <SidebarProvider
      className="h-full min-h-0 w-full overflow-hidden"
      keyboardShortcutEnabled={false}
      onOpenChange={(open) => {
        if (open === collapsed) onToggleCollapsed()
      }}
      open={!collapsed}
      style={{
        "--sidebar-width": "100%",
        "--sidebar-width-icon": PROJECT_RAIL_COLLAPSED_SIZE,
      } as React.CSSProperties}
    >
      <Sidebar
        aria-label="项目栏"
        className="h-full w-full overflow-hidden border-0"
        collapsible="none"
        data-collapsed={collapsed}
        data-testid="project-rail"
      >
        <SidebarHeader className="gap-2 px-3 py-2">
          <div className="flex h-10 min-w-0 items-center gap-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold tracking-tight">AI 运维工具</p>
              <p className="truncate text-xs text-muted-foreground">本地三栏工作台</p>
            </div>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={"操作确认，" + confirmationCount + " 项待处理"}
                className="h-8 w-full justify-start gap-1 px-1.5"
                data-testid="confirmation-center"
                onClick={() => onAction({ type: "open-confirmations" })}
                size="sm"
                type="button"
                variant="outline"
              >
                <ShieldWarning className={confirmationCount > 0 ? "text-warning" : undefined} size={14} />
                <span className="min-w-0 flex-1 truncate text-left text-xs leading-4">操作确认</span>
                {confirmationCount > 0 ? (
                  <span aria-hidden="true" className="min-w-3.5 shrink-0 rounded-sm bg-warning/15 px-0.5 text-center font-mono text-xs font-semibold leading-3.5 text-warning">
                    {confirmationCount > 9 ? "9+" : confirmationCount}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">操作确认中心，{confirmationCount} 项待处理</TooltipContent>
          </Tooltip>
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent className="overflow-hidden" id="project-navigation-content">
          <div aria-label="项目搜索" className="shrink-0 px-2 pt-2" role="search">
            <InputGroup className="h-8 bg-sidebar shadow-none">
              <InputGroupAddon className="shrink-0 pl-2.5 pr-0">
                <MagnifyingGlass aria-hidden="true" className="size-3.5" />
              </InputGroupAddon>
              {/* Keep the narrow field at navigation size despite the shared form font reset. */}
              <InputGroupInput
                aria-controls="project-list"
                aria-describedby="project-search-status"
                aria-label="按项目名或描述搜索项目"
                autoComplete="off"
                className="h-8 px-2 text-xs!"
                data-testid="project-search"
                onChange={(event) => setProjectQuery(event.currentTarget.value)}
                placeholder="搜索项目"
                spellCheck={false}
                type="search"
                value={projectQuery}
              />
            </InputGroup>
            <p aria-live="polite" className="sr-only" id="project-search-status">
              {normalizedProjectQuery
                ? `找到 ${visibleProjects.length} 个项目，共 ${displayedProjects.length} 个项目`
                : `共 ${displayedProjects.length} 个项目`}
            </p>
          </div>
          <SidebarGroupLabel className="mx-4 mt-3 mb-2 h-6 px-0 text-xs leading-4 tracking-normal">
            项目
            <span aria-hidden="true" className={cn("ml-2 text-xs font-normal text-muted-foreground", (!projectDrag.enabled || collapsed) && "hidden")}>拖动排序</span>
            {cloudRepositories.length > 0 ? <Button aria-label="检测云仓库更新" size="icon-xs" variant="ghost" className="ml-auto mr-1" disabled={cloudChecking} onClick={onCheckCloud}><ArrowClockwise className={cloudChecking ? "animate-spin" : undefined} /></Button> : null}
            <span className="ml-auto font-mono tabular-nums">
              {normalizedProjectQuery ? `${visibleProjects.length}/${displayedProjects.length}` : displayedProjects.length}
            </span>
          </SidebarGroupLabel>
          <p className="sr-only" id="project-order-help">拖动项目调整顺序，也可按 Alt + 上下方向键排序。顺序保存在本机。</p>
          <nav
            aria-label="项目导航"
            className="min-h-0 flex-1"
            onDragLeave={projectDrag.onDragLeave}
            onDragOver={projectDrag.onDragOver}
            onDrop={projectDrag.onDrop}
            onFocusCapture={projectNavigation.onFocusCapture}
            onKeyDown={projectNavigation.onKeyDown}
          >
            <ScrollArea className="h-full" data-testid="project-list-scroll" viewportRef={projectDrag.viewportRef}>
            <SidebarGroup className="px-1.5 pt-0 pb-1">
              <SidebarGroupContent>
                {error ? (
                  <div
                    className={cn("pb-2", collapsed && "flex justify-center")}
                    data-cached-summary={projects.length > 0 || undefined}
                    data-testid="project-navigation-read-error"
                  >
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label="项目列表读取失败，重试"
                            onClick={onReload}
                            size="icon-sm"
                            type="button"
                            variant="destructive"
                          >
                            <WarningCircle weight="fill" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {projects.length > 0
                            ? "项目刷新失败，当前显示上次成功读取的项目摘要。点击重试。"
                            : "项目列表读取失败。点击重试。"}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Alert className="rounded-md" variant="destructive">
                        <WarningCircle weight="fill" />
                        <AlertTitle className="text-xs">项目列表刷新失败</AlertTitle>
                        <AlertDescription className="space-y-2 text-xs leading-4">
                          <span className="block">
                            {projects.length > 0
                              ? "当前显示上次成功读取的项目摘要。"
                              : "暂时无法读取项目，请重试。"}
                          </span>
                          {onReload ? (
                            <Button onClick={onReload} size="xs" type="button" variant="outline">
                              <ArrowClockwise />
                              重试
                            </Button>
                          ) : null}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                ) : null}
                <SidebarMenu className="gap-0.5" id="project-list">
                  {loading && displayedProjects.length === 0 ? (
                    <>
                      {[0, 1, 2].map((index) => (
                        <SidebarMenuItem aria-busy="true" key={index}>
                          <SidebarMenuSkeleton
                            className="h-9 w-full px-2.5"
                          />
                        </SidebarMenuItem>
                      ))}
                    </>
                  ) : error && displayedProjects.length === 0 ? null : visibleProjects.length > 0 ? (
                    visibleProjects.map((project) => {
                      const linked = linkedByDisplayId.get(project.projectId)
                      const repository = cloudRepositories.find(repo => repo.repositoryId === linked?.repositoryId)
                      const cloudDescription = linked ? `${repository?.name ?? "云仓库"} · ${cloudStatusLabels[linked.syncStatus]}` : ""
                      if (linked && project.projectId.startsWith("cloud:")) return <SidebarMenuItem key={project.projectId}>
                        <SidebarMenuButton className="h-8 gap-2 px-2.5" data-shell-nav-item data-cloud-project-id={linked.projectId}
                          aria-label={`${project.name}，${cloudDescription}`} disabled={cloudBusy || !repository?.unlocked}
                          tooltip={{ hidden: false, children: <span className="space-y-1"><span className="block font-semibold">{project.name}</span><span className="block text-xs">{cloudDescription}</span></span> }}
                          tabIndex={tabStopProjectId === project.projectId ? 0 : -1}
                          onClick={() => onOpenCloudProject?.(linked.repositoryId, linked.projectId)}>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium" data-project-name>{project.name}</span><ProjectListStatus project={project} linked={linked} hasActions={false} />
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      const selected =
                        selectedProjectId === project.projectId && !project.isolated
                      const isolationDescriptionId = `project-isolated-${project.projectId}`
                      const dropPosition = projectDrag.dropTarget?.projectId === project.projectId
                        ? (projectDrag.dropTarget.after ? "after" : "before") : undefined
                      return (
                        <SidebarMenuItem
                          data-project-dragging={projectDrag.draggingProjectId === project.projectId || undefined}
                          data-project-drop-id={project.projectId}
                          data-project-drop-target={dropPosition}
                          key={project.projectId}
                        >
                          {dropPosition ? (
                            <span
                              aria-hidden="true"
                              className={cn("pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary", dropPosition === "after" ? "-bottom-px" : "-top-px")}
                              data-position={dropPosition}
                              data-project-drop-indicator
                            />
                          ) : null}
                          <ProjectContextMenu
                            onAction={onAction}
                            onSelectProject={() => {
                              if (!project.isolated) onSelectProject(project.projectId)
                            }}
                            project={project}
                            selectedProjectId={selectedProjectId}
                          >
                            <SidebarMenuButton
                              aria-current={selected ? "page" : undefined}
                              aria-describedby={project.isolated ? isolationDescriptionId : "project-order-help"}
                              aria-keyshortcuts={project.isolated ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
                              aria-disabled={project.isolated || undefined}
                              aria-label={`${project.name}，${projectDescription(project)}，${statusLabel(project.status)}${cloudDescription ? `，${cloudDescription}` : ""}`}
                              className={cn(
                                "relative before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-transparent",
                                "transition-colors duration-150",
                                "h-8 w-full justify-start gap-2 px-2.5 py-0 group-has-data-[sidebar=menu-action]/menu-item:pr-2.5",
                                selected && "bg-surface-selected text-primary before:bg-primary",
                                selected && "text-primary data-active:text-primary",
                                project.isolated && "aria-disabled:pointer-events-auto",
                                projectDrag.canDrag(project) && "cursor-grab active:cursor-grabbing",
                                projectDrag.draggingProjectId === project.projectId && "opacity-40",
                              )}
                              data-project-id={project.projectId}
                              data-shell-nav-item
                              draggable={projectDrag.canDrag(project)}
                              isActive={selected}
                              onClick={() => {
                                if (!project.isolated) onSelectProject(project.projectId)
                              }}
                              onKeyDown={(event) => {
                                if (project.isolated) return
                                if (cloudRepositories.length && event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                                  event.preventDefault()
                                  const siblings = displayedProjects.filter(item => !item.isolated && !item.projectId.startsWith("cloud:"))
                                  const offset = event.key === "ArrowUp" ? -1 : 1
                                  const target = siblings[siblings.findIndex(item => item.projectId === project.projectId) + offset]
                                  if (target) onMoveProjectRelative?.(project.projectId, target.projectId, offset === 1)
                                } else onProjectKeyDown?.(event, project.projectId)
                              }}
                              onDragEnd={projectDrag.clearDrag}
                              onDragStart={(event) => projectDrag.onDragStart(event, project)}
                              size="default"
                              tabIndex={tabStopProjectId === project.projectId ? 0 : -1}
                              tooltip={{
                                hidden: projectDrag.draggingProjectId !== null,
                                sideOffset: 8,
                                children: (
                                  <span className="min-w-0 space-y-1">
                                    <span className="block font-semibold [overflow-wrap:anywhere]">{project.name}</span>
                                    <span className="block text-xs [overflow-wrap:anywhere]">
                                      {projectDescription(project)} · {statusLabel(project.status)}
                                    </span>
                                    {cloudDescription ? <span className="block text-xs [overflow-wrap:anywhere]">{cloudDescription}</span> : null}
                                    {projectDrag.canDrag(project) ? <span className="block text-xs">拖动排序 · Alt + ↑ / ↓</span> : null}
                                  </span>
                                ),
                              }}
                              type="button"
                            >
                              <span aria-hidden="true" className="min-w-0 flex-1 truncate text-left text-xs font-medium leading-5" data-project-name data-project-compact-name>
                                {project.name}
                              </span>
                              <ProjectListStatus project={project} linked={linked} />
                              {project.isolated ? (
                                <span className="sr-only" id={isolationDescriptionId}>
                                  {ISOLATED_PROJECT_MESSAGE}
                                </span>
                              ) : null}
                            </SidebarMenuButton>
                          </ProjectContextMenu>
                          <ProjectActionsMenu onAction={onAction} project={project} selectedProjectId={selectedProjectId} />
                        </SidebarMenuItem>
                      )
                    })
                  ) : displayedProjects.length > 0 && normalizedProjectQuery ? (
                    <li data-testid="project-search-empty-state">
                      <Empty className="min-h-32 gap-2 rounded-md p-3">
                        <EmptyHeader className="gap-1">
                          <EmptyMedia variant="icon"><MagnifyingGlass /></EmptyMedia>
                          <EmptyTitle>没有匹配项目</EmptyTitle>
                          <EmptyDescription className="text-xs">请尝试其他项目名或描述。</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </li>
                  ) : (
                    <li data-testid="project-empty-state">
                      <Empty className="min-h-36 gap-2 rounded-md p-3">
                        <EmptyHeader className="gap-1">
                          <EmptyMedia variant="icon"><FolderSimple /></EmptyMedia>
                          <EmptyTitle>还没有项目</EmptyTitle>
                          <EmptyDescription className="text-xs">新建项目以隔离环境与插件范围。</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </li>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            </ScrollArea>
          </nav>
        </SidebarContent>

        <SettingsButton className="mx-2 mb-2 justify-start gap-2" />

        <SidebarFooter
          className={cn(
            "shrink-0 border-t border-sidebar-border bg-sidebar/95",
            "gap-0 px-2 py-2",
          )}
          data-testid="project-actions-footer"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-keyshortcuts="Control+N Meta+N"
                aria-label="新增项目"
                className="h-10 w-full justify-start gap-2 rounded-lg px-2.5 shadow-none transition-colors duration-150"
                data-testid="add-project-footer"
                onClick={() => onAction({ type: "create-project" })}
                size="default"
                type="button"
                variant="outline"
              >
                <Plus className="text-muted-foreground" size={14} />
                <span className="truncate text-xs font-medium leading-4">新增项目</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              新增项目
              <Kbd
                className="border border-background/20 bg-background/10 px-1.5 py-0.5 font-mono text-xs leading-none"
              >
                {shortcutLabel("N")}
              </Kbd>
            </TooltipContent>
          </Tooltip>
        </SidebarFooter>
      </Sidebar>
    </SidebarProvider>
  )
}
