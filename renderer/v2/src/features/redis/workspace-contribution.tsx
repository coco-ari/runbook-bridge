import type { PluginWorkspaceContribution, PluginWorkspaceProps } from "../plugins/workspace-registry"
import { RedisWorkspace } from "./RedisWorkspace"
import { redisWorkspaceSessionKey } from "./redis-workspace-model"

function RedisWorkspaceContribution({ api, entry, visible, onBack, onClose, onDirtyChange }: PluginWorkspaceProps) {
  return <div className="absolute inset-0 z-40 min-h-0 min-w-0 bg-background" data-testid="redis-full-window-workspace" hidden={!visible} inert={!visible}>
    <RedisWorkspace api={api} scope={entry.scope} plugin={entry.plugin}
      projectName={entry.projectName} environmentName={entry.environmentName} visible={visible}
      connected={entry.connected} connectionEpoch={entry.connectionEpoch} onDirtyChange={onDirtyChange}
      onBack={onBack} onClose={onClose} />
  </div>
}

export const redisWorkspaceContribution: PluginWorkspaceContribution = {
  type: "redis", Component: RedisWorkspaceContribution,
  sessionKey: (plugin) => redisWorkspaceSessionKey(plugin, plugin), canOpen: () => true,
  retainAcrossSelection: true, retainOnDisconnect: "dirty", requiresConnection: true, maxSessions: 4,
  focusTestId: "redis-workspace-back", returnFocusTestId: "plugin-workspace-open",
}
