import {
  ArrowClockwise,
  Database,
  DotsThree,
  GearSix,
  HardDrives,
  Plugs,
  Plus,
  ShieldWarning,
  TerminalWindow,
  TreeStructure,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type {
  AiOpsV2Api,
  EnvironmentRuntime,
} from "@/bridge/ai-ops-v2"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  EnvironmentConnectionRowAction,
  PluginConnectionRowAction,
} from "@/features/connections/ConnectionRowAction"
import {
  pluginTypeLabel,
  type WorkspaceEnvironmentReadModel,
  type WorkspacePluginReadModel,
  type WorkspacePluginType,
  type WorkspaceProjectReadModel,
  type WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"
import { useRovingNavigation } from "@/hooks/use-roving-navigation"
import { useMenuHandoff } from "@/hooks/use-menu-handoff"
import { cn } from "@/lib/utils"
import {
  reconcileEnvironmentExpansion,
  type EnvironmentNavigationTarget,
} from "./environment-expansion"

const pluginIcons = {
  server: TerminalWindow,
  mysql: Database,
  redis: HardDrives,
  unknown: Plugs,
} satisfies Record<WorkspacePluginType, Icon>

function pluginConfigLabel(state: WorkspacePluginReadModel["configState"]): string {
  if (state === "ready") return "配置完整"
  if (state === "draft") return "待完善"
  return "配置未知"
}

export type ResourcePaneAction =
  | Readonly<{ type: "create-environment"; project: WorkspaceProjectReadModel }>
  | Readonly<{ type: "edit-environment"; environment: WorkspaceEnvironmentReadModel }>
  | Readonly<{ type: "delete-environment"; environment: WorkspaceEnvironmentReadModel }>
  | Readonly<{ type: "create-plugin"; environment: WorkspaceEnvironmentReadModel }>
  | Readonly<{ type: "edit-plugin"; environment: WorkspaceEnvironmentReadModel; plugin: WorkspacePluginReadModel }>

interface ResourcePaneProps {
  readonly api: AiOpsV2Api
  readonly loading?: boolean
  readonly onReloadScope?: (() => void) | undefined
  readonly onReloadWorkspace?: (() => void) | undefined
  readonly pluginsLoading?: boolean
  readonly pluginError?: WorkspaceReadError | null
  readonly pluginErrorDataSource?: "cached" | "summary" | null
  readonly onAction: (action: ResourcePaneAction) => void
  readonly onEnvironmentKeyDown?: ((event: React.KeyboardEvent<HTMLElement>, environmentId: string) => void) | undefined
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
  readonly onSelectEnvironment: (environmentId: string) => void
  readonly onSelectPlugin: (environmentId: string, pluginId: string) => void
  readonly pluginsByEnvironment?: ReadonlyMap<string, readonly WorkspacePluginReadModel[]>
  readonly project: WorkspaceProjectReadModel | null
  readonly rawRuntime?: EnvironmentRuntime | null
  readonly runtimeError?: WorkspaceReadError | null
  readonly runtimeErrorDataSource?: "cached" | "summary" | null
  readonly selectedEnvironmentId: string | null
  readonly selectedPluginId: string | null
  readonly workspaceError?: WorkspaceReadError | null
}

function NavigationReadFailure({
  className,
  descriptions,
  onReload,
  testId,
  title,
}: {
  readonly className?: string
  readonly descriptions: readonly string[]
  readonly onReload?: (() => void) | undefined
  readonly testId: string
  readonly title: string
}) {
  return (
    <Alert className={className} data-testid={testId} variant="destructive">
      <WarningCircle weight="fill" />
      <AlertTitle className="text-xs">{title}</AlertTitle>
      <AlertDescription className="space-y-2 text-[11px] leading-4">
        <span className="block space-y-0.5">
          {descriptions.map((description) => (
            <span className="block" key={description}>{description}</span>
          ))}
        </span>
        {onReload ? (
          <Button onClick={onReload} size="xs" type="button" variant="outline">
            <ArrowClockwise />
            重试
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

function PluginContextMenu({ children, icon: PluginIcon, onEdit, onView, scopeKey }: {
  readonly children: ReactNode
  readonly icon: Icon
  readonly onEdit: () => void
  readonly onView: () => void
  readonly scopeKey: string
}) {
  const handoff = useMenuHandoff(scopeKey)
  return (
    <ContextMenu onOpenChange={handoff.onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handoff.onCloseAutoFocus}>
        <ContextMenuItem onSelect={() => handoff.queueAction(onView)}>
          <PluginIcon />
          查看详情
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handoff.queueAction(onEdit)}>
          <GearSix />
          插件设置
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function EnvironmentGroup({
  api,
  connectionControlsReady,
  environment,
  expanded,
  loadingPlugins,
  onReloadScope,
  onAction,
  onEnvironmentKeyDown,
  onRuntime,
  onSelectEnvironment,
  onSelectPlugin,
  pluginError,
  pluginErrorDataSource,
  plugins,
  rawRuntime,
  runtimeError,
  runtimeErrorDataSource,
  selectedEnvironmentId,
  selectedPluginId,
  tabStopItemId,
}: {
  readonly api: AiOpsV2Api
  readonly connectionControlsReady: boolean
  readonly environment: WorkspaceEnvironmentReadModel
  readonly expanded: boolean
  readonly loadingPlugins: boolean
  readonly onReloadScope?: (() => void) | undefined
  readonly onAction: (action: ResourcePaneAction) => void
  readonly onEnvironmentKeyDown?: ((event: React.KeyboardEvent<HTMLElement>, environmentId: string) => void) | undefined
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
  readonly onSelectEnvironment: () => void
  readonly onSelectPlugin: (pluginId: string) => void
  readonly pluginError: WorkspaceReadError | null
  readonly pluginErrorDataSource: "cached" | "summary" | null
  readonly plugins: readonly WorkspacePluginReadModel[]
  readonly rawRuntime: EnvironmentRuntime | null
  readonly runtimeError: WorkspaceReadError | null
  readonly runtimeErrorDataSource: "cached" | "summary" | null
  readonly selectedEnvironmentId: string | null
  readonly selectedPluginId: string | null
  readonly tabStopItemId: string | null
}) {
  const environmentScopeSelected =
    selectedEnvironmentId === environment.environmentId
  const environmentSelected =
    selectedEnvironmentId === environment.environmentId && selectedPluginId === null
  const menuScopeKey = `${environment.projectId}/${environment.environmentId}:${environment.revision}/${selectedEnvironmentId}/${selectedPluginId}`
  const contextHandoff = useMenuHandoff(menuScopeKey)
  const actionsHandoff = useMenuHandoff(menuScopeKey)

  return (
    <AccordionItem
      className={cn(
        "group/environment-card mx-2 overflow-hidden rounded-lg border border-border/70 bg-surface",
        "transition-colors duration-150",
      )}
      data-environment-id={environment.environmentId}
      data-expanded={expanded}
      data-testid={`environment-row-${environment.environmentId}`}
      value={environment.environmentId}
    >
      <Item
        className={cn(
          "group/environment relative min-w-0 flex-nowrap items-stretch gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0",
          "before:absolute before:inset-y-2 before:left-0 before:z-10 before:w-0.5 before:rounded-r-full before:bg-transparent",
          "transition-colors duration-150 hover:bg-accent/40",
          environmentSelected && "bg-primary/[0.08] before:bg-primary",
        )}
        size="xs"
        variant={expanded ? "muted" : "default"}
      >
        <ContextMenu onOpenChange={contextHandoff.onOpenChange}>
          <ContextMenuTrigger asChild>
            <AccordionTrigger
              aria-current={environmentSelected ? "page" : undefined}
              className={cn(
                "min-h-14 min-w-0 flex-1 gap-2 rounded-none border-0 px-2.5 py-2 hover:no-underline",
                "transition-colors duration-150 hover:bg-transparent focus-visible:ring-inset",
                "[&_[data-slot=accordion-trigger-icon]]:hidden",
                environmentSelected && "text-accent-foreground dark:text-primary",
              )}
              data-shell-nav-item
              data-testid={`environment-trigger-${environment.environmentId}`}
              onClick={() => {
                // Selecting a plugin is not selecting its environment details.
                // Navigate independently of the native Accordion toggle.
                if (!environmentSelected) onSelectEnvironment()
              }}
              onKeyDown={(event) => onEnvironmentKeyDown?.(event, environment.environmentId)}
              tabIndex={
                tabStopItemId === `environment:${environment.environmentId}` ? 0 : -1
              }
            >
              <ItemMedia
                asChild
                className={cn(
                  "grid size-8 shrink-0 place-items-center self-center rounded-md border border-border/70 bg-surface-raised text-muted-foreground",
                  "transition-[color,background-color,border-color] duration-150",
                  environmentScopeSelected && "border-primary/25 bg-primary/12 text-primary",
                )}
                variant="icon"
              >
                <span><TreeStructure size={15} weight={expanded ? "fill" : "regular"} /></span>
              </ItemMedia>
              <ItemContent asChild className="self-center gap-0.5">
                <span>
                  <ItemTitle asChild className="block w-full truncate text-xs font-semibold" title={environment.name}>
                    <span>{environment.name}</span>
                  </ItemTitle>
                  <ItemDescription asChild className={cn(
                    "flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4",
                    environmentScopeSelected && "dark:text-primary/75",
                  )}>
                    <span>
                      <span className="min-w-0 flex-1 truncate">
                        {environment.pluginCount === 0
                          ? "暂无插件"
                          : `${environment.readyPluginCount}/${environment.pluginCount} 已就绪`}
                      </span>
                    </span>
                  </ItemDescription>
                </span>
              </ItemContent>
              <ItemActions asChild className="self-center">
                <span>
                  <StatusIndicator
                    appearance="badge"
                    className="h-5 max-w-18 px-1.5 font-mono text-[10px]"
                    status={environment.status}
                  />
                </span>
              </ItemActions>
            </AccordionTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={contextHandoff.onCloseAutoFocus}>
            <ContextMenuItem onSelect={() => contextHandoff.queueAction(onSelectEnvironment)}>
              <TreeStructure />
              查看环境
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => contextHandoff.queueAction(() => onAction({ type: "create-plugin", environment }))}>
              <Plus />
              新增插件
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => contextHandoff.queueAction(() => onAction({ type: "edit-environment", environment }))}>
              <GearSix />
              环境设置
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => contextHandoff.queueAction(() => onAction({ type: "delete-environment", environment }))} variant="destructive">
              删除环境
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <ItemActions
          aria-label={environment.name + "快捷操作"}
          className="my-1 mr-1 shrink-0 self-center gap-1"
          data-testid={`environment-actions-${environment.environmentId}`}
          role="group"
        >
          {environmentScopeSelected && connectionControlsReady && rawRuntime ? (
            <EnvironmentConnectionRowAction
              api={api}
              environment={environment}
              fallbackStatus={environment.status}
              onConfigure={() => onAction({ type: "create-plugin", environment })}
              {...(onRuntime ? { onRuntime } : {})}
              rawRuntime={rawRuntime}
              ready={environment.readyPluginCount > 0}
            />
          ) : null}
          <DropdownMenu onOpenChange={actionsHandoff.onOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={environment.name + "更多操作"}
                className="opacity-70 transition-opacity group-focus-within/environment:opacity-100 group-hover/environment:opacity-100"
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <DotsThree weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={actionsHandoff.onCloseAutoFocus}>
              <DropdownMenuLabel>{environment.name}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => actionsHandoff.queueAction(() => onAction({ type: "create-plugin", environment }))}>
                <Plus />
                新增插件
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => actionsHandoff.queueAction(() => onAction({ type: "edit-environment", environment }))}>
                <GearSix />
                环境设置
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </Item>

      <AccordionContent className="border-t border-border/60 bg-surface-inset/36 p-0">
          {pluginError || runtimeError ? (
            <NavigationReadFailure
              className="m-2 rounded-md"
              descriptions={[
                ...(pluginError
                  ? [pluginErrorDataSource === "cached"
                    ? "插件列表：显示上次成功读取的数据。"
                    : "插件列表：显示工作区摘要数据。"]
                  : []),
                ...(runtimeError
                  ? [runtimeErrorDataSource === "cached"
                    ? "连接状态：显示上次成功读取的数据。"
                    : "连接状态：显示工作区摘要数据。"]
                  : []),
              ]}
              onReload={onReloadScope}
              testId={`environment-navigation-read-error-${environment.environmentId}`}
              title="环境数据刷新失败"
            />
          ) : null}
          {loadingPlugins && plugins.length === 0 ? (
            <div aria-busy="true" className="space-y-2 px-2 py-2">
              {[0, 1].map((index) => (
                <div className="flex h-10 items-center gap-2" key={index}>
                  <Skeleton className="size-7 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/5" />
                    <Skeleton className="h-2.5 w-2/5" />
                  </div>
                  <Skeleton className="h-6 w-12" />
                </div>
              ))}
            </div>
          ) : null}
          {plugins.length > 0 ? <ItemGroup className="gap-0">
            {plugins.map((plugin) => {
            const PluginIcon = pluginIcons[plugin.pluginType]
            const selected =
              selectedEnvironmentId === environment.environmentId
              && selectedPluginId === plugin.pluginInstanceId
            const row = (
              <Item
                className={cn(
                  "group/plugin relative min-h-12 min-w-0 flex-nowrap items-stretch gap-0 overflow-hidden rounded-none border-0 border-b border-border/50 p-0 last:border-b-0",
                  "before:absolute before:inset-y-2 before:left-0 before:z-10 before:w-0.5 before:rounded-r-full before:bg-transparent",
                  "transition-colors duration-150 hover:bg-accent/55",
                  selected && "bg-primary/[0.08] text-foreground before:bg-primary dark:text-primary",
                )}
                data-plugin-id={plugin.pluginInstanceId}
                data-testid={`plugin-row-${plugin.pluginInstanceId}`}
                role="listitem"
                size="xs"
                variant={selected ? "muted" : "default"}
              >
                <Button
                  aria-current={selected ? "page" : undefined}
                  className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-2 py-1.5 text-left hover:bg-transparent focus-visible:ring-inset"
                  data-shell-nav-item
                  data-testid={`plugin-trigger-${plugin.pluginInstanceId}`}
                  onClick={() => onSelectPlugin(plugin.pluginInstanceId)}
                  tabIndex={
                    tabStopItemId
                      === `plugin:${environment.environmentId}:${plugin.pluginInstanceId}`
                      ? 0
                      : -1
                  }
                  title={plugin.displayName}
                  type="button"
                  variant="ghost"
                >
                  <ItemMedia
                    asChild
                    className={cn(
                      "grid size-7 place-items-center self-center rounded-md border border-border/60 bg-surface-raised text-muted-foreground",
                      "transition-colors duration-150",
                      selected && "border-primary/25 bg-primary/12 text-primary",
                    )}
                    variant="icon"
                  >
                    <span><PluginIcon size={14} weight={selected ? "fill" : "regular"} /></span>
                  </ItemMedia>
                  <ItemContent asChild className="self-center gap-0">
                    <span>
                      <ItemTitle asChild className="block w-full truncate text-xs font-medium">
                        <span>{plugin.displayName}</span>
                      </ItemTitle>
                      <ItemDescription asChild className={cn(
                        "flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4",
                        selected && "dark:text-primary/75",
                      )}>
                        <span>
                          <span className="min-w-0 flex-1 truncate">
                            {pluginTypeLabel(plugin.pluginType)} · {pluginConfigLabel(plugin.configState)}
                          </span>
                        </span>
                      </ItemDescription>
                    </span>
                  </ItemContent>
                  <ItemActions asChild className="self-center">
                    <span>
                      <StatusIndicator
                        appearance="badge"
                        className="size-5 justify-center p-0"
                        compact
                        status={plugin.status}
                      />
                    </span>
                  </ItemActions>
                </Button>
                {environmentScopeSelected && connectionControlsReady && rawRuntime ? (
                  <ItemActions
                    className="mr-1 shrink-0 self-center gap-1"
                    data-testid={`plugin-actions-${plugin.pluginInstanceId}`}
                  >
                    <PluginConnectionRowAction
                      api={api}
                      fallbackStatus={plugin.status}
                      onConfigure={() => onAction({ type: "edit-plugin", environment, plugin })}
                      {...(onRuntime ? { onRuntime } : {})}
                      plugin={{
                        projectId: environment.projectId,
                        environmentId: environment.environmentId,
                        pluginInstanceId: plugin.pluginInstanceId,
                      }}
                      ready={plugin.configState === "ready" && plugin.pluginType !== "unknown"}
                      runtime={rawRuntime}
                      scopeLabel={plugin.displayName}
                    />
                  </ItemActions>
                ) : null}
              </Item>
            )
            return (
              <PluginContextMenu
                icon={PluginIcon}
                key={plugin.pluginInstanceId}
                onEdit={() => onAction({ type: "edit-plugin", environment, plugin })}
                onView={() => onSelectPlugin(plugin.pluginInstanceId)}
                scopeKey={`${menuScopeKey}/${plugin.pluginInstanceId}:${plugin.revision}`}
              >
                {row}
              </PluginContextMenu>
            )
            })}
          </ItemGroup> : null}
          <Button
            className={cn(
              "group h-8 w-full justify-start rounded-none border-0 border-border/60 bg-transparent text-primary shadow-none transition-colors duration-150 hover:bg-primary/[0.08]",
              (plugins.length > 0 || loadingPlugins || pluginError || runtimeError) && "border-t",
            )}
            data-testid={"add-plugin-" + environment.environmentId}
            onClick={() => onAction({ type: "create-plugin", environment })}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span className="grid size-5 place-items-center rounded-md bg-primary/12 transition-colors group-hover:bg-primary/18">
              <Plus size={12} weight="bold" />
            </span>
            新增插件
          </Button>
      </AccordionContent>
    </AccordionItem>
  )
}

export function ResourcePane({
  api,
  loading = false,
  onReloadScope,
  onReloadWorkspace,
  pluginsLoading = false,
  pluginError = null,
  pluginErrorDataSource = null,
  onAction,
  onEnvironmentKeyDown,
  onRuntime,
  onSelectEnvironment,
  onSelectPlugin,
  pluginsByEnvironment = new Map(),
  project,
  rawRuntime = null,
  runtimeError = null,
  runtimeErrorDataSource = null,
  selectedEnvironmentId,
  selectedPluginId,
  workspaceError = null,
}: ResourcePaneProps) {
  const [expandedEnvironmentIds, setExpandedEnvironmentIds] = useState<readonly string[]>(() =>
    reconcileEnvironmentExpansion([], project?.environments.map((environment) => environment.environmentId) ?? [], {
      projectId: project?.projectId ?? null,
      environmentId: selectedEnvironmentId,
      pluginInstanceId: selectedPluginId,
    }, null),
  )
  const previousNavigationTargetRef = useRef<Readonly<{
    target: EnvironmentNavigationTarget
    environmentIds: readonly string[]
  }> | null>(null)
  const resourceNavigation = useRovingNavigation<HTMLElement>()
  const selectedEnvironment = project?.environments.find(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
  const selectedRawRuntime = rawRuntime
    && rawRuntime.projectId === project?.projectId
    && rawRuntime.environmentId === selectedEnvironmentId
    ? rawRuntime
    : null
  const selectedEnvironmentPlugins = selectedEnvironment
    ? pluginsByEnvironment.get(selectedEnvironment.environmentId)
      ?? selectedEnvironment.resourcePreview
    : []
  const selectedPluginIsAvailable =
    selectedPluginId !== null
    && selectedEnvironmentPlugins.some(
      (plugin) => plugin.pluginInstanceId === selectedPluginId,
    )
  const selectedPluginIsVisible =
    selectedEnvironment !== undefined
    && expandedEnvironmentIds.includes(selectedEnvironment.environmentId)
    && selectedPluginIsAvailable
  const tabStopItemId = selectedEnvironment && selectedPluginIsVisible
    ? `plugin:${selectedEnvironment.environmentId}:${selectedPluginId}`
    : selectedEnvironment
      ? `environment:${selectedEnvironment.environmentId}`
      : project?.environments[0]
        ? `environment:${project.environments[0].environmentId}`
        : null

  useEffect(() => {
    const target = {
      projectId: project?.projectId ?? null,
      environmentId: selectedEnvironmentId,
      pluginInstanceId: selectedPluginId,
    }
    const environmentIds = project?.environments.map((environment) => environment.environmentId) ?? []
    const previous = previousNavigationTargetRef.current
    previousNavigationTargetRef.current = { target, environmentIds }
    setExpandedEnvironmentIds((current) => reconcileEnvironmentExpansion(
      current,
      environmentIds,
      target,
      previous?.target ?? null,
      previous?.environmentIds ?? [],
    ))
  }, [project?.projectId, project?.environments, selectedEnvironmentId, selectedPluginId])

  return (
    <aside
      aria-label="环境与插件栏"
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-inset"
      data-testid="resource-pane"
    >
      <header className="flex h-13 shrink-0 items-center gap-2.5 border-b border-border/80 bg-surface px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <TreeStructure size={16} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            环境与插件
          </p>
          <h2 className="truncate text-[13px] font-semibold tracking-tight" title={project?.name}>
            {project?.name ?? "未选择项目"}
          </h2>
        </div>
        {project ? (
          <Badge className="h-5 px-1.5 font-mono text-[10px]" variant="outline">
            {project.environments.length}
          </Badge>
        ) : null}
      </header>

      {loading && !project ? (
        <div aria-busy="true" className="min-h-0 flex-1 space-y-2 px-2 py-3">
          {[0, 1, 2].map((index) => (
            <div className="rounded-lg border border-border/60 p-2.5" key={index}>
              <div className="flex h-10 items-center gap-2">
                <Skeleton className="size-8 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-2.5 w-2/5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : workspaceError && !project ? (
        <div className="min-h-0 flex-1 p-3">
          <NavigationReadFailure
            descriptions={["暂时无法读取项目与环境摘要。"]}
            onReload={onReloadWorkspace}
            testId="resource-workspace-read-error"
            title="环境列表读取失败"
          />
        </div>
      ) : !project ? (
        <Empty className="min-h-0 flex-1 rounded-none px-6" data-testid="no-project-resource-state">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TreeStructure /></EmptyMedia>
            <EmptyTitle>先选择项目</EmptyTitle>
            <EmptyDescription>环境和插件始终显示在明确的项目范围内。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : project.isolated ? (
        <Empty
          className="min-h-0 flex-1 rounded-none px-6"
          data-testid="isolated-project-resource-state"
          role="status"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon"><ShieldWarning /></EmptyMedia>
            <EmptyTitle>项目已隔离</EmptyTitle>
            <EmptyDescription>
              项目配置不可用，无法选择、排序或新增环境。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <nav
            aria-label="环境与插件"
            className="min-h-0 flex-1"
            onFocusCapture={resourceNavigation.onFocusCapture}
            onKeyDownCapture={resourceNavigation.onKeyDown}
          >
            <ScrollArea className="h-full" data-testid="resource-list-scroll">
              {workspaceError ? (
                <NavigationReadFailure
                  className="mx-2 mt-2 rounded-md"
                  descriptions={["当前显示上次成功读取的环境摘要。"]}
                  onReload={onReloadWorkspace}
                  testId="resource-workspace-read-error"
                  title="环境列表刷新失败"
                />
              ) : null}
              {project.environments.length === 0 ? (
                workspaceError ? null : (
                  <Empty className="min-h-40 rounded-none px-4" data-testid="empty-project-resource-state">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><TreeStructure /></EmptyMedia>
                      <EmptyTitle>此项目还没有环境</EmptyTitle>
                      <EmptyDescription>新增环境后，再在环境内配置插件。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )
              ) : (
                <Accordion
                  className="gap-2 py-2"
                  onValueChange={setExpandedEnvironmentIds}
                  type="multiple"
                  value={[...expandedEnvironmentIds]}
                >
                  {project.environments.map((environment) => (
                    <EnvironmentGroup
                      api={api}
                      connectionControlsReady={
                        selectedEnvironmentId === environment.environmentId
                        && pluginsByEnvironment.has(environment.environmentId)
                        && selectedRawRuntime !== null
                      }
                      environment={environment}
                      expanded={expandedEnvironmentIds.includes(environment.environmentId)}
                      key={environment.environmentId}
                      loadingPlugins={
                        selectedEnvironmentId === environment.environmentId
                        && pluginsLoading
                      }
                      onAction={onAction}
                      onEnvironmentKeyDown={onEnvironmentKeyDown}
                      onReloadScope={onReloadScope}
                      {...(onRuntime ? { onRuntime } : {})}
                      onSelectEnvironment={() => onSelectEnvironment(environment.environmentId)}
                      onSelectPlugin={(pluginId) => onSelectPlugin(environment.environmentId, pluginId)}
                      pluginError={selectedEnvironmentId === environment.environmentId ? pluginError : null}
                      pluginErrorDataSource={selectedEnvironmentId === environment.environmentId ? pluginErrorDataSource : null}
                      plugins={pluginsByEnvironment.get(environment.environmentId) ?? environment.resourcePreview}
                      rawRuntime={
                        selectedEnvironmentId === environment.environmentId
                          ? selectedRawRuntime
                          : null
                      }
                      runtimeError={selectedEnvironmentId === environment.environmentId ? runtimeError : null}
                      runtimeErrorDataSource={selectedEnvironmentId === environment.environmentId ? runtimeErrorDataSource : null}
                      selectedEnvironmentId={selectedEnvironmentId}
                      selectedPluginId={selectedPluginId}
                      tabStopItemId={tabStopItemId}
                    />
                  ))}
                </Accordion>
              )}
            </ScrollArea>
          </nav>
          <div
            className="shrink-0 border-t border-border bg-surface/95 px-2 py-2"
            data-testid="resource-actions-footer"
          >
            <Button
              className="group h-10 w-full justify-between rounded-lg px-2.5 shadow-none transition-colors duration-150"
              data-testid="add-environment-footer"
              onClick={() => onAction({ type: "create-environment", project })}
              size="default"
              type="button"
              variant="outline"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Plus className="text-muted-foreground" size={14} />
                <span className="truncate text-xs font-medium">新增环境</span>
              </span>
              <Badge className="border-border bg-muted/50 font-mono text-[10px] text-muted-foreground" variant="outline">
                {project.environments.length} 个
              </Badge>
            </Button>
          </div>
        </>
      )}
    </aside>
  )
}
