import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import type { PluginConnectionState } from "@/features/connections/connection-model"
import { workspaceConnectionPresentation } from "./workspace-connection-presentation"

export function WorkspaceConnectionStatus({ state, recovery }: { readonly state: PluginConnectionState; readonly recovery?: string }) {
  const presentation = workspaceConnectionPresentation(state, recovery)
  return <StatusIndicator appearance="badge" status={presentation.status} label={presentation.label} />
}
