import { PluginWorkspaceHost } from "@/features/plugins/PluginWorkspaceHost"
import { usePluginWorkspaceSessions, useSelectedPluginWorkspace } from "@/features/plugins/use-plugin-workspaces"
import { useAppShellLayout } from "@/components/app-shell/use-app-shell-layout"
import { shortcutLabel } from "@/lib/platform"
import { SettingsPage } from "@/features/settings/SettingsPage"
import { SettingsNavigationContext } from "@/features/settings/SettingsButton"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { toast } from "sonner"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

import {
  getAiOpsV2,
  type PluginRecord,
} from "@/bridge/ai-ops-v2"
import { GlobalCommand } from "@/components/app-shell/GlobalCommand"
import { WorkspaceDetail, type WorkspaceDetailAction } from "@/components/detail-workspace/WorkspaceDetail"
import {
  createPluginWorkMode,
  type PluginWorkMode,
  type WorkspaceLeaveRequest,
} from "@/components/detail-workspace/detail-work-mode"
import {
  detailSelectionKind,
  isDetailTabAllowed,
} from "@/components/detail-workspace/detail-navigation"
import { ProjectRail, type ProjectRailAction } from "@/components/project-rail/ProjectRail"
import { ResourcePane, type ResourcePaneAction } from "@/components/resource-pane/ResourcePane"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useConfirmationCount } from "@/features/confirmations/use-confirmation-count"
import type { ConfirmationScope } from "@/features/confirmations/ConfirmationsFeature"
import {
  DirtyLeaveAlertDialog,
  useDirtyLeaveGuard,
} from "@/features/environments/DirtyLeaveGuard"
import {
  EnvironmentMutationSurfaces,
  type EnvironmentMutationSurface,
} from "@/features/environments/EnvironmentMutationSurfaces"
import {
  EnvironmentOrderAnnouncement,
  useEnvironmentOrder,
} from "@/features/environments/EnvironmentOrderController"
import {
  useEnvironmentMutations,
  type EnvironmentMutationEvent,
} from "@/features/environments/use-environment-mutations"
import { PluginDeleteDialog } from "@/features/plugins/PluginDeleteDialog"
import { PluginEditorHost } from "@/features/plugins/PluginEditorHost"
import { pluginUi } from "@/features/plugins/plugin-ui-contributions"
import { PluginMetadataDialog } from "@/features/plugins/PluginMetadataDialog"
import type { PluginSaveOutcome } from "@/features/plugins/plugin-editor-model"
import {
  type PluginConfigurationRecord,
} from "@/features/plugins/plugin-types"
import {
  ProjectMutationSurfaces,
  type ProjectMutationSurface,
} from "@/features/projects/ProjectMutationSurfaces"
import {
  ProjectOrderAnnouncement,
  useProjectOrder,
} from "@/features/projects/ProjectOrderController"
import type { ProjectMutationEvent } from "@/features/projects/use-project-mutations"
import { useEnvironmentPlugins } from "@/features/workspace/use-environment-plugins"
import { useEnvironmentStatus } from "@/features/workspace/use-environment-status"
import { useWorkspaceOverview } from "@/features/workspace/use-workspace-overview"
import { useWorkspaceRuntimeCache } from "@/features/workspace/use-workspace-runtime-cache"
import {
  INITIAL_WORKSPACE_SELECTION,
  workspaceSelectionReducer,
} from "@/features/workspace/selection-reducer"
import {
  overlayWorkspaceRuntimeStatuses,
  type WorkspaceEnvironmentReadModel,
  type WorkspacePluginReadModel,
} from "@/features/workspace/workspace-read-model"
import {
  APP_SHELL_PANEL_IDS,
  PROJECT_RAIL_COLLAPSED_SIZE,
  PROJECT_RAIL_COLLAPSE_THRESHOLD,
} from "@/state/layout-state"


interface PendingSelection {
  readonly environmentId?: string
  readonly focusTarget?: (() => HTMLElement | null) | undefined
  readonly pluginInstanceId?: string
  readonly projectId: string
  readonly tab?: string
}

type PluginSurface =
  | Readonly<{ kind: "metadata"; plugin: PluginConfigurationRecord }>
  | Readonly<{ kind: "delete"; plugin: PluginConfigurationRecord }>
  | null

function supportedPlugin(record: PluginRecord | null): PluginConfigurationRecord | null {
  return record && pluginUi.get(record.pluginType)
    ? (record as PluginConfigurationRecord)
    : null
}

function dependentPlugins(
  plugin: PluginConfigurationRecord,
  records: readonly PluginRecord[],
): readonly PluginRecord[] {
  if (plugin.pluginType !== "server") return []
  return records.filter((candidate) => {
    if (candidate.pluginInstanceId === plugin.pluginInstanceId) return false
    const transport = candidate.transport
    if (!transport || typeof transport !== "object" || Array.isArray(transport)) return false
    return (transport as Readonly<Record<string, unknown>>).serverPluginInstanceId
      === plugin.pluginInstanceId
  })
}

export function AppShell() {
  const api = useMemo(() => getAiOpsV2(), [])
  const workspace = useWorkspaceOverview()
  const runtimeCache = useWorkspaceRuntimeCache(workspace.data)
  const [selection, dispatchSelection] = useReducer(
    workspaceSelectionReducer,
    INITIAL_WORKSPACE_SELECTION,
  )
  const confirmations = useConfirmationCount({
    projectId: selection.projectId,
    environmentId: selection.environmentId,
  })
  const [commandOpen, setCommandOpen] = useState(false)
  const workspaceSessions = usePluginWorkspaceSessions(api)
  const removePluginWorkspaces = workspaceSessions.removeScope
  const [detailTab, setDetailTab] = useState("overview")
  const [notice, setNotice] = useState("")
  const [runbookDirty, setRunbookDirty] = useState(false)
  const [runbookSaving, setRunbookSaving] = useState(false)
  const [agentAccessDirty, setAgentAccessDirty] = useState(false)
  const [agentAccessSaving, setAgentAccessSaving] = useState(false)
  const [quickQuestionsDirty, setQuickQuestionsDirty] = useState(false)
  const [quickQuestionsSaving, setQuickQuestionsSaving] = useState(false)
  const [detailDraftEpoch, setDetailDraftEpoch] = useState(0)
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null)
  const [projectSurface, setProjectSurface] = useState<ProjectMutationSurface>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const [environmentSurface, setEnvironmentSurface] = useState<EnvironmentMutationSurface>(null)
  const [pluginSurface, setPluginSurface] = useState<PluginSurface>(null)
  const [pluginWorkMode, setPluginWorkMode] = useState<PluginWorkMode | null>(null)
  const [pluginSaveNotice, setPluginSaveNotice] = useState<Readonly<{
    projectId: string
    environmentId: string
    pluginInstanceId: string
    message: string
  }> | null>(null)
  const {
    layoutState, viewportWidth, projectPanelPixels, editorExpanded,
    panelGroupRef, panelGroupElementRef, projectPanelRef, detailPanelRef,
    setProjectCollapsed, setDetailCollapsed, syncProjectSize, syncDetailSize,
    handleLayoutChanged, restoreEditorLayout, toggleEditorExpanded,
  } = useAppShellLayout(Boolean(pluginWorkMode))
  const editorLeaveRef = useRef<WorkspaceLeaveRequest | null>(null)
  const editorReturnFocusRef = useRef<(() => HTMLElement | null) | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const pendingNavigationRef = useRef<(() => void) | null>(null)
  const navigationRequestPendingRef = useRef(false)
  const focusGenerationRef = useRef(0)
  const scheduleWorkspaceFocus = useCallback((resolveTarget: () => HTMLElement | null = () => document.getElementById("detail-main")) => {
    const generation = ++focusGenerationRef.current
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (focusGenerationRef.current === generation) focusWorkspaceElement(settingsOpenRef.current ? document.getElementById("settings-heading") : resolveTarget())
    }))
  }, [])
  useEffect(() => () => { focusGenerationRef.current += 1 }, [])
  const registerEditorLeaveGuard = useCallback((request: WorkspaceLeaveRequest | null) => {
    editorLeaveRef.current = request
  }, [])

  const projects = workspace.data?.projects ?? []
  const projectOrder = useProjectOrder({
    projects,
    projectsReady: workspace.data !== null,
    resolveFocusTarget: (projectId) =>
      document.querySelector<HTMLElement>(`[data-project-id="${projectId}"]`),
  })
  const selectedProject = projectOrder.orderedProjects.find(
    (project) => project.projectId === selection.projectId,
  ) ?? null

  const handleEnvironmentCommitted = useCallback((event: EnvironmentMutationEvent) => {
    workspace.reload()
    if (event.kind === "created") {
      setPendingSelection({
        projectId: event.environment.projectId,
        environmentId: event.environment.environmentId,
      })
      toast.success("环境已创建")
    } else if (event.kind === "deleted") {
      removePluginWorkspaces({ projectId: event.projectId, environmentId: event.environmentId })
      if (
        selection.projectId === event.projectId
        && selection.environmentId === event.environmentId
      ) {
        dispatchSelection({
          type: "select-project",
          projectId: event.projectId,
          workspace: workspace.data ?? { projects: [] },
        })
      }
      toast.success("环境已删除")
    } else if (event.kind === "renamed") {
      toast.success("环境名称已更新")
    }
  }, [removePluginWorkspaces, selection.environmentId, selection.projectId, workspace])

  const environmentMutations = useEnvironmentMutations({
    api,
    onCommitted: handleEnvironmentCommitted,
  })
  const environmentOrder = useEnvironmentOrder({
    project: selectedProject,
    persistOrder: environmentMutations.reorder,
    resolveFocusTarget: (environmentId) =>
      document.querySelector<HTMLElement>(`[data-environment-id="${environmentId}"]`),
  })
  const orderedProject = selectedProject
    ? { ...selectedProject, environments: environmentOrder.orderedEnvironments }
    : null
  const cachedNavigationProjects = useMemo(() =>
    overlayWorkspaceRuntimeStatuses(
      projectOrder.orderedProjects.map((project) =>
        orderedProject?.projectId === project.projectId ? orderedProject : project,
      ),
      runtimeCache,
    ), [orderedProject, projectOrder.orderedProjects, runtimeCache])
  const cachedNavigationProject = cachedNavigationProjects.find(
    (project) => project.projectId === selectedProject?.projectId,
  ) ?? null
  const selectedEnvironmentBase = orderedProject?.environments.find(
    (environment) => environment.environmentId === selection.environmentId,
  ) ?? null
  const selectedEnvironmentNavigationBase = cachedNavigationProject?.environments.find(
    (environment) => environment.environmentId === selection.environmentId,
  ) ?? selectedEnvironmentBase
  const selectedScope = selectedProject && selectedEnvironmentBase
    ? {
        projectId: selectedProject.projectId,
        environmentId: selectedEnvironmentBase.environmentId,
      }
    : null
  const expectedScopeKey = selectedScope
    ? `${selectedScope.projectId}/${selectedScope.environmentId}`
    : null
  const pluginList = useEnvironmentPlugins(selectedScope)
  const environmentStatus = useEnvironmentStatus(selectedScope)
  const scopedRuntime = environmentStatus.data
    && environmentStatus.data.projectId === selectedScope?.projectId
    && environmentStatus.data.environmentId === selectedScope.environmentId
    ? environmentStatus.data
    : null
  const rawRuntime = environmentStatus.raw
    && environmentStatus.raw.projectId === selectedScope?.projectId
    && environmentStatus.raw.environmentId === selectedScope.environmentId
    ? environmentStatus.raw
    : null
  const listedPlugins = pluginList.scopeKey === expectedScopeKey ? pluginList.data : null
  const runtimeStatusByPlugin = useMemo(() => new Map(
    scopedRuntime?.plugins.map((plugin) => [plugin.pluginInstanceId,plugin.status]) ?? [],
  ),[scopedRuntime])
  const scopedPlugins = useMemo(() => listedPlugins?.map((plugin) => ({
    ...plugin,
    status: runtimeStatusByPlugin.get(plugin.pluginInstanceId) ?? plugin.status,
  })) ?? null,[listedPlugins,runtimeStatusByPlugin])
  const scopedPluginRecords = pluginList.scopeKey === expectedScopeKey
    ? pluginList.records ?? []
    : []
  const selectedEnvironment = useMemo(() => {
    if (!selectedEnvironmentNavigationBase || !scopedRuntime) {
      return selectedEnvironmentNavigationBase
    }
    return {
      ...selectedEnvironmentNavigationBase,
      runtime: scopedRuntime,
      status: scopedRuntime.status,
      resourcePreview: selectedEnvironmentNavigationBase.resourcePreview.map((plugin) => ({
        ...plugin,
        status: runtimeStatusByPlugin.get(plugin.pluginInstanceId) ?? plugin.status,
      })),
    }
  },[runtimeStatusByPlugin,scopedRuntime,selectedEnvironmentNavigationBase])
  const navigationProject = cachedNavigationProject && selectedEnvironment
    ? {
        ...cachedNavigationProject,
        environments: cachedNavigationProject.environments.map((environment) =>
          environment.environmentId === selectedEnvironment.environmentId
            ? selectedEnvironment
            : environment),
      }
    : cachedNavigationProject
  const navigationProjects = cachedNavigationProjects.map((project) =>
    navigationProject?.projectId === project.projectId ? navigationProject : project,
  )
  const navigationPlugins = scopedPlugins ?? selectedEnvironment?.resourcePreview ?? []
  const selectedPlugin = navigationPlugins.find(
    (plugin) => plugin.pluginInstanceId === selection.pluginInstanceId,
  ) ?? null
  const selectedPluginRecord = supportedPlugin(
    scopedPluginRecords.find(
      (plugin) => plugin.pluginInstanceId === selection.pluginInstanceId,
    ) ?? null,
  )
  const selectedWorkspaceScope = selectedProject && selectedEnvironment && selectedPluginRecord
    ? { projectId:selectedProject.projectId, environmentId:selectedEnvironment.environmentId, pluginInstanceId:selectedPluginRecord.pluginInstanceId }
    : null
  const pluginWorkspace = useSelectedPluginWorkspace(workspaceSessions, {
    plugin:selectedPluginRecord, scope:selectedWorkspaceScope,
    connected:Boolean(selectedWorkspaceScope && !environmentStatus.error
      && scopedRuntime?.plugins.find((plugin) => plugin.pluginInstanceId === selectedWorkspaceScope.pluginInstanceId)?.status === "connected"),
    projectName:selectedProject?.name ?? "", environmentName:selectedEnvironment?.name ?? "", runtime:rawRuntime,
  })
  useEffect(() => { if (pluginWorkspace.visible) setCommandOpen(false) }, [pluginWorkspace.visible])
  const workspaceVisible = pluginWorkspace.visible
  const pluginsByEnvironment = useMemo(() => {
    const result = new Map<string, readonly WorkspacePluginReadModel[]>()
    if (selectedEnvironment && scopedPlugins) {
      result.set(selectedEnvironment.environmentId, scopedPlugins)
    }
    return result
  }, [scopedPlugins, selectedEnvironment])
  const pluginsByScope = useMemo(() => {
    const result = new Map<string,readonly WorkspacePluginReadModel[]>()
    if (selectedScope && scopedPlugins) {
      result.set(`${selectedScope.projectId}/${selectedScope.environmentId}`,scopedPlugins)
    }
    return result
  },[scopedPlugins,selectedScope])
  const latestWorkspaceRef = useRef(workspace.data)
  const latestSelectionRef = useRef(selection)
  const latestPluginsRef = useRef<Readonly<{
    data: readonly WorkspacePluginReadModel[] | null
    scopeKey: string | null
  }>>({ data: scopedPlugins,scopeKey: expectedScopeKey })
  latestWorkspaceRef.current = workspace.data
  latestSelectionRef.current = selection
  latestPluginsRef.current = { data: scopedPlugins,scopeKey: expectedScopeKey }

  useEffect(() => {
    if (!workspace.data || workspace.loading || pluginList.loading) return
    dispatchSelection({
      type: "workspace-loaded",
      workspace: workspace.data,
      ...(scopedPlugins ? { selectedEnvironmentPlugins: scopedPlugins } : {}),
    })
  }, [pluginList.loading, scopedPlugins, workspace.data, workspace.loading])

  useEffect(() => {
    const kind = detailSelectionKind(
      Boolean(selectedEnvironment),
      selectedPlugin?.pluginType ?? null,
    )
    if (!isDetailTabAllowed(kind, detailTab)) setDetailTab("overview")
  },[detailTab,selectedEnvironment,selectedPlugin])

  useEffect(() => {
    if (!pendingSelection || !workspace.data || workspace.loading || workspace.error) return
    const project = workspace.data.projects.find(
      (candidate) => candidate.projectId === pendingSelection.projectId && !candidate.isolated,
    )
    if (!project) {
      if (!workspace.loading) setPendingSelection(null)
      return
    }
    if (!pendingSelection.environmentId) {
      dispatchSelection({
        type: "select-project",
        projectId: project.projectId,
        workspace: workspace.data,
      })
      setDetailTab(pendingSelection.tab ?? "overview")
      setPendingSelection(null)
      scheduleWorkspaceFocus(pendingSelection.focusTarget)
      return
    }
    const environment = project.environments.find(
      (candidate) => candidate.environmentId === pendingSelection.environmentId,
    )
    if (!environment) {
      if (!workspace.loading) setPendingSelection(null)
      return
    }
    if (
      selection.projectId !== project.projectId
      || selection.environmentId !== environment.environmentId
    ) {
      dispatchSelection({
        type: "select-environment",
        projectId: project.projectId,
        environmentId: environment.environmentId,
        workspace: workspace.data,
      })
      return
    }
    if (!pendingSelection.pluginInstanceId) {
      setDetailTab(pendingSelection.tab ?? "overview")
      setPendingSelection(null)
      scheduleWorkspaceFocus(pendingSelection.focusTarget)
      return
    }
    if (pluginList.loading || pluginList.error || pluginList.scopeKey !== expectedScopeKey || pluginList.data === null) return
    const plugin = pluginList.data.find(
      (candidate) => candidate.pluginInstanceId === pendingSelection.pluginInstanceId,
    )
    if (!plugin) {
      if (!pluginList.loading) {
        toast.error("目标插件已不存在或不属于该环境")
        setPendingSelection(null)
      }
      return
    }
    dispatchSelection({
      type: "select-plugin",
      projectId: project.projectId,
      environmentId: environment.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
      plugins: pluginList.data,
      workspace: workspace.data,
    })
    setDetailTab(pendingSelection.tab ?? "overview")
    setPendingSelection(null)
    scheduleWorkspaceFocus(pendingSelection.focusTarget)
  }, [
    expectedScopeKey,
    pendingSelection,
    pluginList.data,
    pluginList.error,
    pluginList.loading,
    pluginList.scopeKey,
    selection.environmentId,
    selection.projectId,
    scheduleWorkspaceFocus,
    workspace.data,
    workspace.error,
    workspace.loading,
  ])

  const dirtyLeave = useDirtyLeaveGuard({
    ownerKey: [selection.projectId, selection.environmentId, selection.pluginInstanceId]
      .filter(Boolean)
      .join("/"),
    dirty: {
      agentAccessDirty,
      metadataDirty: false,
      pluginConfigurationDirty: false,
      runbookDirty,
      quickQuestionsDirty,
      saveInFlight: runbookSaving || agentAccessSaving || quickQuestionsSaving,
    },
    onBlocked: (message) => toast.warning(message),
    onLeaveApproved: () => {
      if (runbookDirty || agentAccessDirty || quickQuestionsDirty) {
        setDetailDraftEpoch((current) => current + 1)
      }
      setRunbookDirty(false)
      setAgentAccessDirty(false)
      setQuickQuestionsDirty(false)
      setPendingSelection(null)
      setPluginWorkMode(null)
      const navigation = pendingNavigationRef.current
      pendingNavigationRef.current = null
      navigation?.()
    },
  })

  const requestNavigation = useCallback((navigation: () => void) => {
    if (navigationRequestPendingRef.current) {
      toast.info("请先处理当前的未保存更改提示")
      return
    }
    navigationRequestPendingRef.current = true
    focusGenerationRef.current += 1
    pendingNavigationRef.current = navigation
    void (async () => {
      const editorLeave = editorLeaveRef.current
      if (editorLeave && !await editorLeave()) return
      const allowed = await dirtyLeave.requestLeave()
      if (allowed && editorLeave) scheduleWorkspaceFocus()
    })().finally(() => {
      if (pendingNavigationRef.current === navigation) pendingNavigationRef.current = null
      navigationRequestPendingRef.current = false
    })
  }, [dirtyLeave, scheduleWorkspaceFocus])

  const rememberFocus = useCallback(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  }, [])

  const openSettings = useCallback(() => {
    settingsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestNavigation(() => {
      setCommandOpen(false)
      setSettingsOpen(true)
    })
  }, [requestNavigation])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    scheduleWorkspaceFocus(() => {
      const trigger = settingsReturnFocusRef.current
      return trigger?.isConnected && !trigger.closest('[hidden],[inert]') ? trigger : document.querySelector<HTMLElement>('[data-testid="settings-open"]')
    })
  }, [scheduleWorkspaceFocus])

  const focusDetail = useCallback(() => {
    if (layoutState.detailCollapsed) setDetailCollapsed(false)
    scheduleWorkspaceFocus()
  }, [layoutState.detailCollapsed, scheduleWorkspaceFocus, setDetailCollapsed])

  const enterPluginEditor = useCallback((environment: WorkspaceEnvironmentReadModel, plugin: PluginConfigurationRecord | null, resolveReturnFocus?: () => HTMLElement | null) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const returnSelection = { ...latestSelectionRef.current }
    const returnTab = detailTab
    requestNavigation(() => {
      const latestWorkspace = latestWorkspaceRef.current
      const project = latestWorkspace?.projects.find((candidate) => candidate.projectId === environment.projectId && !candidate.isolated)
      const currentEnvironment = project?.environments.find((candidate) => candidate.environmentId === environment.environmentId)
      if (!latestWorkspace || !project || !currentEnvironment) {
        toast.error("目标编辑范围已不存在或不可用")
        return
      }
      if (plugin && (plugin.projectId !== project.projectId || plugin.environmentId !== currentEnvironment.environmentId)) {
        toast.error("插件不属于当前编辑范围")
        return
      }
      restoreEditorLayout()
      // The detail workspace is remounted after editing. Resolve its logical
      // trigger then, rather than retaining a detached pre-edit DOM node.
      editorReturnFocusRef.current = resolveReturnFocus ?? (() => returnFocus)
      setPluginWorkMode(createPluginWorkMode({
        scope: { projectId: project.projectId, environmentId: currentEnvironment.environmentId },
        projectName: project.name,
        environmentName: currentEnvironment.name,
        plugin,
        returnSelection,
        returnTab,
      }))
      // Choosing another environment to create a plugin updates the visible scope,
      // but the edit mode owns its immutable snapshot until save or safe cancel.
      if (latestSelectionRef.current.projectId !== project.projectId || latestSelectionRef.current.environmentId !== currentEnvironment.environmentId) {
        dispatchSelection({ type: "select-environment", projectId: project.projectId, environmentId: currentEnvironment.environmentId, workspace: latestWorkspace })
      }
      setDetailCollapsed(false)
    })
  }, [detailTab, requestNavigation, restoreEditorLayout, setDetailCollapsed])

  const closePluginWorkspace = useCallback(() => {
    const mode = pluginWorkMode
    setPluginWorkMode(null)
    restoreEditorLayout()
    if (mode) {
      const previous = mode.returnSelection
      const latestWorkspace = latestWorkspaceRef.current
      if (latestWorkspace && previous.projectId) {
        if (previous.environmentId && previous.pluginInstanceId) {
          const completeList = latestPluginsRef.current
          if (completeList.scopeKey === `${previous.projectId}/${previous.environmentId}` && completeList.data !== null) {
            dispatchSelection({ type: "select-plugin", projectId: previous.projectId, environmentId: previous.environmentId, pluginInstanceId: previous.pluginInstanceId, plugins: completeList.data, workspace: latestWorkspace })
          } else {
            setPendingSelection({ projectId: previous.projectId, environmentId: previous.environmentId, pluginInstanceId: previous.pluginInstanceId, tab: mode.returnTab, focusTarget: editorReturnFocusRef.current ?? undefined })
          }
        } else if (previous.environmentId) {
          dispatchSelection({ type: "select-environment", projectId: previous.projectId, environmentId: previous.environmentId, workspace: latestWorkspace })
        } else {
          dispatchSelection({ type: "select-project", projectId: previous.projectId, workspace: latestWorkspace })
        }
      }
      setDetailTab(mode.returnTab)
    }
    scheduleWorkspaceFocus(() => {
      const target = editorReturnFocusRef.current?.()
      return target?.isConnected && target.getClientRects().length ? target : document.getElementById("detail-main")
    })
  }, [pluginWorkMode, restoreEditorLayout, scheduleWorkspaceFocus])

  const selectProject = useCallback((projectId: string) => {
    requestNavigation(() => {
      const latestWorkspace = latestWorkspaceRef.current
      const target = latestWorkspace?.projects.find(
        (project) => project.projectId === projectId && !project.isolated,
      )
      if (!latestWorkspace || !target) {
        toast.error("目标项目已不存在或不可用")
        return
      }
      dispatchSelection({ type: "select-project", projectId, workspace: latestWorkspace })
      setDetailTab("overview")
      setNotice("已选择项目")
    })
  }, [requestNavigation])

  const selectEnvironment = useCallback((projectId: string, environmentId: string) => {
    requestNavigation(() => {
      const latestWorkspace = latestWorkspaceRef.current
      const target = latestWorkspace?.projects.find(
        (project) => project.projectId === projectId && !project.isolated,
      )?.environments.find((environment) => environment.environmentId === environmentId)
      if (!latestWorkspace || !target) {
        toast.error("目标环境已不存在或不属于该项目")
        return
      }
      dispatchSelection({
        type: "select-environment",
        projectId,
        environmentId,
        workspace: latestWorkspace,
      })
      setDetailTab("overview")
      setNotice("已选择环境")
    })
  }, [requestNavigation])

  const selectPlugin = useCallback((
    projectId: string,
    environmentId: string,
    pluginInstanceId: string,
    focusTarget?: () => HTMLElement | null,
  ) => {
    requestNavigation(() => {
      const latestWorkspace = latestWorkspaceRef.current
      const project = latestWorkspace?.projects.find(
        (candidate) => candidate.projectId === projectId && !candidate.isolated,
      )
      const environment = project?.environments.find(
        (candidate) => candidate.environmentId === environmentId,
      )
      if (!latestWorkspace || !project || !environment) {
        toast.error("目标插件范围已不存在")
        return
      }
      const latestSelection = latestSelectionRef.current
      const latestPlugins = latestPluginsRef.current
      if (
        latestSelection.projectId === projectId
        && latestSelection.environmentId === environmentId
        && latestPlugins.scopeKey === `${projectId}/${environmentId}`
        && latestPlugins.data !== null
      ) {
        const target = latestPlugins.data.find(
          (plugin) => plugin.pluginInstanceId === pluginInstanceId,
        )
        if (!target) {
          toast.error("目标插件已不存在或不属于该环境")
          return
        }
        dispatchSelection({
          type: "select-plugin",
          projectId,
          environmentId,
          pluginInstanceId,
          plugins: latestPlugins.data,
          workspace: latestWorkspace,
        })
        setDetailTab("overview")
        if (focusTarget) scheduleWorkspaceFocus(focusTarget)
      } else {
        setPendingSelection({ projectId, environmentId, pluginInstanceId, focusTarget })
      }
      setNotice("已选择插件")
    })
  }, [requestNavigation, scheduleWorkspaceFocus])

  const openProjectAction = useCallback((action: ProjectRailAction) => {
    rememberFocus()
    if (action.type === "create-project") requestNavigation(() => setProjectSurface({ kind: "create" }))
    else if (action.type === "create-environment") {
      requestNavigation(() => setEnvironmentSurface({ kind: "create", project: action.project }))
    } else if (action.type === "edit-project" || action.type === "delete-project") {
      const open = () => setProjectSurface({ kind: action.type === "delete-project" ? "delete" : "settings", project: action.project })
      if (pluginWorkMode || (action.type === "delete-project" && selection.projectId === action.project.projectId)) requestNavigation(open)
      else open()
    } else if (selectedEnvironment && selectedProject) {
      const projectId = selectedProject.projectId
      const environmentId = selectedEnvironment.environmentId
      requestNavigation(() => {
        const latestWorkspace = latestWorkspaceRef.current
        const target = latestWorkspace?.projects.find(
          (project) => project.projectId === projectId && !project.isolated,
        )?.environments.find(
          (environment) => environment.environmentId === environmentId,
        )
        if (!latestWorkspace || !target) {
          toast.error("当前环境已不存在或不可用")
          return
        }
        dispatchSelection({
          type: "select-environment",
          projectId,
          environmentId,
          workspace: latestWorkspace,
        })
        setDetailTab("confirmations")
        focusDetail()
      })
    } else {
      toast.info("请先选择一个环境以查看确认队列")
    }
  }, [focusDetail, pluginWorkMode, rememberFocus, requestNavigation, selectedEnvironment, selectedProject, selection.projectId])

  const openResourceAction = useCallback((action: ResourcePaneAction) => {
    rememberFocus()
    if (action.type === "create-environment") {
      requestNavigation(() => setEnvironmentSurface({ kind: "create", project: action.project }))
      return
    }
    if (action.type === "edit-environment" || action.type === "delete-environment") {
      const project = projects.find((candidate) => candidate.projectId === action.environment.projectId)
      if (project) {
        const open = () => setEnvironmentSurface({ kind: action.type === "delete-environment" ? "delete" : "settings", project, environment: action.environment })
        if (pluginWorkMode || (action.type === "delete-environment" && selection.environmentId === action.environment.environmentId && selection.projectId === project.projectId)) requestNavigation(open)
        else open()
      }
      return
    }
    if (action.type === "create-plugin") {
      enterPluginEditor(action.environment, null)
      return
    }
    const record = scopedPluginRecords.find(
      (candidate) => candidate.pluginInstanceId === action.plugin.pluginInstanceId,
    ) ?? null
    const plugin = supportedPlugin(record)
    if (!plugin) {
      toast.error("插件配置尚未载入或类型不受支持")
      pluginList.reload()
      return
    }
    enterPluginEditor(action.environment, plugin)
  }, [enterPluginEditor, pluginList, pluginWorkMode, projects, rememberFocus, requestNavigation, scopedPluginRecords, selection.environmentId, selection.projectId])

  const openDetailAction = useCallback((action: WorkspaceDetailAction) => {
    rememberFocus()
    if (action.type === "create-project") requestNavigation(() => setProjectSurface({ kind: "create" }))
    else if (action.type === "edit-project") setProjectSurface({ kind: "settings", project: action.project })
    else if (action.type === "edit-environment") {
      setEnvironmentSurface({ kind: "settings", project: action.project, environment: action.environment })
    } else if (action.type === "edit-plugin") {
      const returnFocusSelector = action.returnFocus === "plugin-action-edit"
        ? '[data-testid="plugin-action-edit"]'
        : '[data-testid="detail-scope-actions"]'
      if (selectedEnvironment) enterPluginEditor(selectedEnvironment, action.plugin, () => document.querySelector<HTMLElement>(returnFocusSelector))
    } else if (action.type === "rename-plugin") {
      setPluginSurface({ kind: "metadata", plugin: action.plugin })
    } else {
      requestNavigation(() => setPluginSurface({ kind: "delete", plugin: action.plugin }))
    }
  }, [enterPluginEditor, rememberFocus, requestNavigation, selectedEnvironment])

  const handleProjectCommitted = useCallback((event: ProjectMutationEvent) => {
    workspace.reload()
    if (event.kind === "created") {
      setPendingSelection({ projectId: event.project.projectId })
      toast.success("项目已创建")
    } else if (event.kind === "deleted") {
      if (selection.projectId === event.projectId) dispatchSelection({ type: "clear" })
      toast.success("项目已删除")
    } else {
      toast.success("项目名称已更新")
    }
  }, [selection.projectId, workspace])

  const reloadSelectedScope = useCallback(() => {
    workspace.reload()
    pluginList.reload()
    environmentStatus.reload()
  }, [environmentStatus, pluginList, workspace])

  const reloadSelectedNavigationScope = useCallback(() => {
    pluginList.reload()
    environmentStatus.reload()
  }, [environmentStatus, pluginList])

  const handlePluginSaved = useCallback((outcome: PluginSaveOutcome) => {
    reloadSelectedScope()
    setPluginWorkMode(null)
    restoreEditorLayout()
    const { plugin } = outcome
    setPluginSaveNotice(plugin && (outcome.persistenceRecoveryPending || outcome.runtimeWarning || outcome.manualReconnectRequired) ? {
      projectId: plugin.projectId,
      environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
      message: outcome.persistenceRecoveryPending
        ? "配置与凭据已保存，但本地恢复记录仍待处理。请重启应用完成恢复检查，不要重复保存。"
        : "配置与凭据已保存，但连接恢复尚未完成。请在插件详情中查看状态并手动重连，不要重复保存配置。",
    } : null)
    if (plugin) {
      setPendingSelection({
        projectId: plugin.projectId,
        environmentId: plugin.environmentId,
        pluginInstanceId: plugin.pluginInstanceId,
      })
    }
    scheduleWorkspaceFocus()
    if (outcome.persistenceRecoveryPending) {
      toast.warning("插件配置与凭据已保存", {
        description: "本地恢复记录仍待处理。请重启应用完成恢复检查，不要重复保存。",
      })
    } else if (outcome.runtimeWarning || outcome.manualReconnectRequired) {
      toast.warning("插件配置与凭据已保存", {
        description: "运行连接恢复失败。请在详情中手动重新连接，不要重复保存配置。",
      })
    } else if (outcome.saveStrategy === "connect-current") {
      toast.success("插件配置已保存并开始连接", {
        description: "连接请求已经受理，可在插件详情中查看进度。",
      })
    } else if (outcome.saveStrategy === "restore-previous") {
      toast.success("插件配置已保存", {
        description: "编辑前的连接集合已按原范围恢复。",
      })
    } else {
      toast.success("插件配置已保存", { description: "保存后保持断开，连接需要再次明确点击。" })
    }
  }, [reloadSelectedScope, restoreEditorLayout, scheduleWorkspaceFocus])

  const locateConfirmationScope = useCallback((
    scope: ConfirmationScope,
    tab: "overview" | "audit" = "overview",
  ) => {
    requestNavigation(() => {
      setPendingSelection({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        pluginInstanceId: scope.pluginInstanceId,
        tab,
      })
      focusDetail()
    })
  }, [focusDetail, requestNavigation])

  const shellLabel = selectedPlugin?.displayName
    ?? selectedEnvironment?.name
    ?? selectedProject?.name
    ?? "未选择项目"
  // Saved collapse state describes user intent; the current panel geometry
  // decides its presentation, including temporary compression in small windows.
  const compactProjectRail = projectPanelPixels === null
    ? layoutState.projectCollapsed || viewportWidth < 720
    : projectPanelPixels <= PROJECT_RAIL_COLLAPSE_THRESHOLD
  const constraintLimited = viewportWidth < 960
  const projectResizeDescription = viewportWidth < 720
    ? "窗口过窄，放大窗口后可调整项目栏宽度。"
    : `拖动调整项目栏宽度，双击恢复默认宽度（224 像素，受窗口空间限制）。聚焦分隔线后，按左右方向键调整宽度，按 Enter 折叠或展开；在非输入区域也可按 ${shortcutLabel("B")}。`

  return (
    <SettingsNavigationContext.Provider value={openSettings}>
    <div className="h-full max-h-full min-h-0 relative w-full min-w-0 overflow-hidden bg-background text-foreground" data-shell-ready="true" data-testid="react-app-shell">
      <a
        className="fixed left-3 top-2 z-[70] -translate-y-14 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm outline-none transition-transform focus:translate-y-0 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
        hidden={workspaceVisible || settingsOpen}
        href="#detail-main"
        onClick={(event) => {
          event.preventDefault()
          focusDetail()
        }}
      >
        跳到详情内容
      </a>

      <p className="sr-only" role="status" data-testid="shell-notice">{notice}</p>
      <p className="sr-only" id="project-rail-resize-help">{projectResizeDescription}</p>
      <ProjectOrderAnnouncement announcement={projectOrder.announcement} />
      <EnvironmentOrderAnnouncement announcement={environmentOrder.announcement} />

      <ResizablePanelGroup inert={workspaceVisible || settingsOpen} style={settingsOpen ? { visibility: "hidden" } : undefined} aria-hidden={settingsOpen || undefined} aria-label="三栏工作台" className="app-shell-grid" defaultLayout={layoutState.layout} elementRef={panelGroupElementRef} groupRef={panelGroupRef} id="app-shell-panels" onLayoutChanged={handleLayoutChanged} orientation="horizontal">
        <ResizablePanel collapsedSize={PROJECT_RAIL_COLLAPSED_SIZE} collapsible defaultSize="224px" groupResizeBehavior="preserve-pixel-size" id={APP_SHELL_PANEL_IDS.project} maxSize={viewportWidth < 720 ? PROJECT_RAIL_COLLAPSED_SIZE : "300px"} minSize={viewportWidth < 720 ? PROJECT_RAIL_COLLAPSED_SIZE : "176px"} onResize={syncProjectSize} panelRef={projectPanelRef}>
          <ProjectRail
            shortcutsDisabled={workspaceVisible || settingsOpen}
            collapsed={compactProjectRail}
            expandDisabled={viewportWidth < 720}
            error={workspace.error}
            loading={workspace.loading || confirmations.loading}
            onAction={openProjectAction}
            onMoveProjectRelative={projectOrder.moveProjectRelative}
            onProjectKeyDown={projectOrder.onProjectKeyDown}
            onReload={workspace.reload}
            onSelectProject={selectProject}
            onToggleCollapsed={() => setProjectCollapsed(!compactProjectRail)}
            pendingConfirmationCount={confirmations.count}
            projects={navigationProjects}
            selectedProjectId={selectedProject?.projectId ?? null}
          />
        </ResizablePanel>

        <ResizableHandle aria-controls="project-panel resource-panel" aria-describedby="project-rail-resize-help" aria-keyshortcuts={viewportWidth < 720 ? undefined : "Enter ArrowLeft ArrowRight Control+B Meta+B"} aria-label="调整项目栏宽度" data-testid="project-resource-resizer" disableDoubleClick id="project-resource-resizer" onDoubleClick={() => setProjectCollapsed(false, true)} title={projectResizeDescription} withHandle />

        <ResizablePanel defaultSize="32%" id={APP_SHELL_PANEL_IDS.resource} maxSize="80%" minSize={constraintLimited ? (viewportWidth < 720 ? "184px" : "200px") : "240px"}>
          <ResourcePane
            api={api}
            loading={workspace.loading}
            onAction={openResourceAction}
            onEnvironmentKeyDown={environmentOrder.onEnvironmentKeyDown}
            onReloadScope={reloadSelectedNavigationScope}
            onReloadWorkspace={workspace.reload}
            onRuntime={reloadSelectedScope}
            onSelectEnvironment={(environmentId) => selectedProject && selectEnvironment(selectedProject.projectId, environmentId)}
            onSelectPlugin={(environmentId, pluginInstanceId) => selectedProject && selectPlugin(selectedProject.projectId, environmentId, pluginInstanceId)}
            pluginsByEnvironment={pluginsByEnvironment}
            pluginError={pluginList.error}
            pluginErrorDataSource={pluginList.error
              ? scopedPlugins !== null ? "cached" : "summary"
              : null}
            pluginsLoading={pluginList.loading}
            project={navigationProject}
            rawRuntime={rawRuntime}
            runtimeError={environmentStatus.error}
            runtimeErrorDataSource={environmentStatus.error
              ? scopedRuntime !== null ? "cached" : "summary"
              : null}
            selectedEnvironmentId={selectedEnvironment?.environmentId ?? null}
            selectedPluginId={selectedPlugin?.pluginInstanceId ?? null}
            workspaceError={workspace.error}
          />
        </ResizablePanel>

        <ResizableHandle aria-controls="resource-panel detail-panel" aria-label="调整详情工作区宽度" data-testid="resource-detail-resizer" id="resource-detail-resizer" onDoubleClick={() => detailPanelRef.current?.resize("48%")} withHandle />

        <ResizablePanel collapsedSize="48px" collapsible defaultSize="48%" id={APP_SHELL_PANEL_IDS.detail} minSize={constraintLimited ? "320px" : "360px"} onResize={syncDetailSize} panelRef={detailPanelRef}>
          {pluginWorkMode ? (
            <PluginEditorHost
              api={api}
              availableServers={pluginList.scopeKey === `${pluginWorkMode.scope.projectId}/${pluginWorkMode.scope.environmentId}`
                ? scopedPluginRecords.filter((record) => record.pluginType === "server")
                : []}
              collapsed={layoutState.detailCollapsed}
              environmentName={pluginWorkMode.environmentName}
              expanded={editorExpanded}
              key={pluginWorkMode.id}
              onClosed={closePluginWorkspace}
              onRegisterLeaveGuard={registerEditorLeaveGuard}
              onSaved={handlePluginSaved}
              onToggleCollapsed={() => setDetailCollapsed(!layoutState.detailCollapsed)}
              onToggleExpanded={toggleEditorExpanded}
              plugin={pluginWorkMode.plugin}
              projectName={pluginWorkMode.projectName}
              scope={pluginWorkMode.scope}
            />
          ) : <WorkspaceDetail
            onOpenWorkspace={pluginWorkspace.openSelected}
            workspaceRetained={pluginWorkspace.retained}
            activeTab={detailTab}
            api={api}
            collapsed={layoutState.detailCollapsed}
            environment={selectedEnvironment}
            environmentPlugins={scopedPlugins}
            environmentError={environmentStatus.error ?? pluginList.error}
            environmentLoading={environmentStatus.loading || pluginList.loading}
            key={`${[selection.projectId,selection.environmentId,selection.pluginInstanceId].filter(Boolean).join("/") || "workspace"}/${detailDraftEpoch}`}
            onAction={openDetailAction}
            onAgentAccessDirtyChange={setAgentAccessDirty}
            onAgentAccessSavingChange={setAgentAccessSaving}
            onLocateScope={locateConfirmationScope}
            onOpenPlugin={(projectId, environmentId, pluginInstanceId) => selectPlugin(projectId, environmentId, pluginInstanceId, () => document.getElementById("detail-main"))}
            onPluginUpdated={reloadSelectedScope}
            onDismissSaveNotice={() => setPluginSaveNotice(null)}
            onReloadEnvironment={reloadSelectedScope}
            onReloadWorkspace={workspace.reload}
            onRunbookDirtyChange={setRunbookDirty}
            onRunbookSavingChange={setRunbookSaving}
            onQuickQuestionsDirtyChange={setQuickQuestionsDirty}
            onQuickQuestionsSavingChange={setQuickQuestionsSaving}
            onTabChange={(value) => { if (value !== detailTab) requestNavigation(() => setDetailTab(value)) }}
            onToggleCollapsed={() => setDetailCollapsed(!layoutState.detailCollapsed)}
            plugin={selectedPlugin}
            pluginRecord={selectedPluginRecord}
            saveNotice={pluginSaveNotice?.projectId === selection.projectId
              && pluginSaveNotice.environmentId === selection.environmentId
              && pluginSaveNotice.pluginInstanceId === selection.pluginInstanceId
              ? pluginSaveNotice.message : null}
            project={selectedProject}
            rawRuntime={rawRuntime}
            runtime={scopedRuntime}
            workspaceError={workspace.error}
            workspaceLoading={workspace.loading}
          />}
        </ResizablePanel>
      </ResizablePanelGroup>
      <PluginWorkspaceHost api={api} state={pluginWorkspace.state} hidden={settingsOpen}
        onBack={workspaceSessions.back} onClose={workspaceSessions.close} onDirtyChange={workspaceSessions.setDirty} />

      <GlobalCommand
        disabled={workspaceVisible || settingsOpen}
        onCreateEnvironment={selectedProject ? () => {
          rememberFocus()
          requestNavigation(() => setEnvironmentSurface({ kind: "create", project: selectedProject }))
        } : undefined}
        onCreateProject={() => {
          rememberFocus()
          requestNavigation(() => setProjectSurface({ kind: "create" }))
        }}
        onOpenChange={setCommandOpen}
        onSelectEnvironment={selectEnvironment}
        onSelectPlugin={selectPlugin}
        onSelectProject={selectProject}
        open={commandOpen}
        pluginsByScope={pluginsByScope}
        projects={navigationProjects}
      />

      {settingsOpen ? <SettingsPage api={api} onBack={closeSettings} onChanged={workspace.reload} /> : null}
      <ProjectMutationSurfaces
        action={projectSurface}
        api={api}
        mayLeaveProject={(projectId) => {
          if (selection.projectId !== projectId) return true
          pendingNavigationRef.current = () => undefined
          return dirtyLeave.requestLeave()
        }}
        onActionChange={setProjectSurface}
        onCommitted={handleProjectCommitted}
        restoreFocusRef={restoreFocusRef}
      />
      <EnvironmentMutationSurfaces
        action={environmentSurface}
        api={api}
        mayLeaveEnvironment={(scope) => {
          if (selection.projectId !== scope.projectId || selection.environmentId !== scope.environmentId) return true
          pendingNavigationRef.current = () => undefined
          return dirtyLeave.requestLeave()
        }}
        onActionChange={setEnvironmentSurface}
        onCommitted={handleEnvironmentCommitted}
        restoreFocusRef={restoreFocusRef}
      />

      {pluginSurface?.kind === "metadata" ? (
        <PluginMetadataDialog
          api={api}
          onOpenChange={(open) => { if (!open) setPluginSurface(null) }}
          onUpdated={() => {
            setPluginSurface(null)
            reloadSelectedScope()
            toast.success("插件名称已更新")
          }}
          open
          plugin={pluginSurface.plugin}
        />
      ) : null}
      {pluginSurface?.kind === "delete" ? (
        <PluginDeleteDialog
          api={api}
          dependents={dependentPlugins(pluginSurface.plugin, scopedPluginRecords)}
          onDeleted={(outcome) => {
            removePluginWorkspaces(pluginSurface.plugin)
            setPluginSurface(null)
            if (workspace.data && selectedProject && selectedEnvironment) {
              dispatchSelection({
                type: "select-environment",
                projectId: selectedProject.projectId,
                environmentId: selectedEnvironment.environmentId,
                workspace: workspace.data,
              })
            }
            reloadSelectedScope()
            if (outcome.runtimeWarning) {
              toast.warning(`“${pluginSurface.plugin.displayName}”已删除`, {
                description: "本机凭据仍保留，但旧连接清理异常；请手动断开并重新连接环境。",
              })
            } else {
              toast.success(`“${pluginSurface.plugin.displayName}”已删除`, {
                description: outcome.credentialsPreserved ? "本机凭据仍按应用策略保留。" : undefined,
              })
            }
          }}
          onOpenChange={(open) => { if (!open) setPluginSurface(null) }}
          open
          plugin={pluginSurface.plugin}
        />
      ) : null}

      <DirtyLeaveAlertDialog controller={dirtyLeave} onCloseAutoFocus={(event) => {
        event.preventDefault()
        scheduleWorkspaceFocus(() => {
          const detail = document.getElementById("detail-main")
          if (quickQuestionsDirty) {
            const questionEditor = [...(detail?.querySelectorAll<HTMLElement>('#quick-opening-editor, #common-question-editor') ?? [])]
              .find((field) => field.getClientRects().length > 0)
            if (questionEditor) return questionEditor
          }
          if (runbookDirty || agentAccessDirty || quickQuestionsDirty) {
            const retainedField = [...(detail?.querySelectorAll<HTMLElement>('textarea:not([readonly]):not(:disabled), input:not([readonly]):not(:disabled)') ?? [])]
              .find((field) => field.getClientRects().length > 0)
            if (retainedField) return retainedField
          }
          return detail
        })
      }} />
      <span className="sr-only">当前范围：{shellLabel}</span>
    </div>
    </SettingsNavigationContext.Provider>
  )
}
