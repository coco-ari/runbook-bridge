import type {
  WorkspaceEnvironmentReadModel,
  WorkspacePluginReadModel,
  WorkspaceProjectReadModel,
  WorkspaceReadModel,
} from "@/features/workspace/workspace-read-model"

export interface WorkspaceSelectionState {
  readonly environmentId: string | null
  readonly initialized: boolean
  readonly pluginInstanceId: string | null
  readonly projectId: string | null
}

export type WorkspaceSelectionAction =
  | {
      readonly type: "workspace-loaded"
      readonly workspace: WorkspaceReadModel
      readonly selectedEnvironmentPlugins?: readonly WorkspacePluginReadModel[]
    }
  | { readonly type: "select-project"; readonly projectId: string; readonly workspace: WorkspaceReadModel }
  | {
      readonly type: "select-environment"
      readonly environmentId: string
      readonly projectId: string
      readonly workspace: WorkspaceReadModel
    }
  | {
      readonly type: "select-plugin"
      readonly environmentId: string
      readonly pluginInstanceId: string
      readonly projectId: string
      readonly plugins?: readonly WorkspacePluginReadModel[]
      readonly workspace: WorkspaceReadModel
    }
  | { readonly type: "clear" }

export const INITIAL_WORKSPACE_SELECTION: WorkspaceSelectionState = {
  environmentId: null,
  initialized: false,
  pluginInstanceId: null,
  projectId: null,
}

function clearSelection(initialized = true): WorkspaceSelectionState {
  return {
    environmentId: null,
    initialized,
    pluginInstanceId: null,
    projectId: null,
  }
}

function availableProject(
  workspace: WorkspaceReadModel,
  projectId: string | null,
): WorkspaceProjectReadModel | null {
  if (!projectId) return null
  return (
    workspace.projects.find(
      (project) => project.projectId === projectId && !project.isolated,
    ) ?? null
  )
}

function scopedEnvironment(
  project: WorkspaceProjectReadModel,
  environmentId: string | null,
): WorkspaceEnvironmentReadModel | null {
  if (!environmentId) return null
  return (
    project.environments.find(
      (environment) =>
        environment.projectId === project.projectId &&
        environment.environmentId === environmentId,
    ) ?? null
  )
}

export function initializeWorkspaceSelection(
  workspace: WorkspaceReadModel,
): WorkspaceSelectionState {
  const project = workspace.projects.find((candidate) => !candidate.isolated)
  return project
    ? {
        environmentId: null,
        initialized: true,
        pluginInstanceId: null,
        projectId: project.projectId,
      }
    : clearSelection(true)
}

export function reconcileWorkspaceSelection(
  state: WorkspaceSelectionState,
  workspace: WorkspaceReadModel,
  selectedEnvironmentPlugins?: readonly WorkspacePluginReadModel[],
): WorkspaceSelectionState {
  const project = availableProject(workspace, state.projectId)
  if (!project) return clearSelection(true)
  const environment = scopedEnvironment(project, state.environmentId)
  if (!state.environmentId) {
    return { ...state, initialized: true, pluginInstanceId: null }
  }
  if (!environment) {
    return {
      environmentId: null,
      initialized: true,
      pluginInstanceId: null,
      projectId: project.projectId,
    }
  }
  if (!state.pluginInstanceId) return { ...state, initialized: true }
  if (selectedEnvironmentPlugins === undefined && environment.resourcePreviewTruncated) {
    // The overview deliberately contains only a bounded preview. Preserve the
    // opaque selection until the exact-scope complete list arrives; no plugin
    // action is enabled without its matching full record.
    return { ...state, initialized: true }
  }
  const pluginExists = (selectedEnvironmentPlugins ?? environment.resourcePreview).some(
    (plugin) => plugin.pluginInstanceId === state.pluginInstanceId,
  )
  return pluginExists
    ? { ...state, initialized: true }
    : {
        environmentId: environment.environmentId,
        initialized: true,
        pluginInstanceId: null,
        projectId: project.projectId,
      }
}

export function workspaceSelectionReducer(
  state: WorkspaceSelectionState,
  action: WorkspaceSelectionAction,
): WorkspaceSelectionState {
  if (action.type === "clear") return clearSelection(true)
  if (action.type === "workspace-loaded") {
    return state.initialized
      ? reconcileWorkspaceSelection(
          state,
          action.workspace,
          action.selectedEnvironmentPlugins,
        )
      : initializeWorkspaceSelection(action.workspace)
  }
  if (action.type === "select-project") {
    const project = availableProject(action.workspace, action.projectId)
    return project
      ? {
          environmentId: null,
          initialized: true,
          pluginInstanceId: null,
          projectId: project.projectId,
        }
      : clearSelection(true)
  }
  const project = availableProject(action.workspace, action.projectId)
  if (!project) return clearSelection(true)
  const environment = scopedEnvironment(project, action.environmentId)
  if (!environment) {
    return {
      environmentId: null,
      initialized: true,
      pluginInstanceId: null,
      projectId: project.projectId,
    }
  }
  if (action.type === "select-environment") {
    return {
      environmentId: environment.environmentId,
      initialized: true,
      pluginInstanceId: null,
      projectId: project.projectId,
    }
  }
  const plugin = (action.plugins ?? environment.resourcePreview).find(
    (candidate) => candidate.pluginInstanceId === action.pluginInstanceId,
  )
  return {
    environmentId: environment.environmentId,
    initialized: true,
    pluginInstanceId: plugin?.pluginInstanceId ?? null,
    projectId: project.projectId,
  }
}
