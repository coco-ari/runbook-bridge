import { lazy, Suspense } from "react"
import type { PluginWorkspaceContribution, PluginWorkspaceProps } from "../plugins/workspace-registry"
import { serverWorkspaceKey } from "./workspace-model"

const ServerWorkspace = lazy(() => import("./ServerWorkspace").then((module) => ({ default: module.ServerWorkspace })))

function ServerWorkspaceContribution({ api, entry, visible, onBack, onClose }: PluginWorkspaceProps) {
  return <Suspense fallback={visible ? <div className="absolute inset-0 z-30 grid place-items-center bg-background text-sm text-muted-foreground">正在打开服务器工作区…</div> : null}>
    <ServerWorkspace api={api} entry={entry} visible={visible} onBack={onBack} onClose={onClose} />
  </Suspense>
}

export const serverWorkspaceContribution: PluginWorkspaceContribution = {
  type: "server", Component: ServerWorkspaceContribution,
  sessionKey: serverWorkspaceKey, canOpen: () => true,
  retainAcrossSelection: true, retainOnDisconnect: "always", requiresConnection: false, maxSessions: 8,
  focusTestId: "server-workspace-back", returnFocusTestId: "plugin-open-workspace",
}
