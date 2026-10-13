import type { PluginWorkspaceContribution } from "../plugins/workspace-registry"
import { SourceWorkspace } from "./SourceWorkspace"

export const sourceWorkspaceContribution: PluginWorkspaceContribution = {
  type: "source", Component: SourceWorkspace,
  sessionKey: plugin => JSON.stringify([plugin.projectId, plugin.environmentId, plugin.pluginInstanceId, plugin.revision, plugin.target]),
  canOpen: plugin => plugin.configState === "ready", retainAcrossSelection: true, retainOnDisconnect: "always", requiresConnection: false, maxSessions: 8,
  focusTestId: "source-workspace-back", returnFocusTestId: "plugin-workspace-open",
}
