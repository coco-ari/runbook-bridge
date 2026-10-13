import type { PluginWorkspaceContribution } from "../plugins/workspace-registry"
import { CodexWorkspace } from "./CodexWorkspace"
export const codexWorkspaceContribution: PluginWorkspaceContribution = {
  type: "codex", Component: CodexWorkspace,
  sessionKey: plugin => JSON.stringify([plugin.projectId, plugin.environmentId, plugin.pluginInstanceId, plugin.revision, plugin.target]),
  canOpen: plugin => plugin.configState === "ready", retainAcrossSelection: true, retainOnDisconnect: "always", requiresConnection: false, maxSessions: 4,
  focusTestId: "codex-workspace-back", returnFocusTestId: "plugin-workspace-open",
}
