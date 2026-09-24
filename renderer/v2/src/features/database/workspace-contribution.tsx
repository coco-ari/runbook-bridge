import type { PluginWorkspaceContribution, PluginWorkspaceProps } from "../plugins/workspace-registry"
import { MysqlDatabaseWorkspace } from "./MysqlDatabaseWorkspace"
import { mysqlDatabaseName, mysqlWorkspaceSessionKey } from "./mysql-workspace-model"

function MysqlWorkspaceContribution({ api, entry, visible, onBack, onClose, onDirtyChange }: PluginWorkspaceProps) {
  return <div className="absolute inset-0 z-40 min-h-0 min-w-0 bg-background" data-testid="mysql-full-window-workspace" hidden={!visible} inert={!visible}>
    <MysqlDatabaseWorkspace api={api} scope={entry.scope} plugin={entry.plugin}
      projectName={entry.projectName} environmentName={entry.environmentName}
      connected={entry.connected} connectionEpoch={entry.connectionEpoch} onEditingChange={onDirtyChange}
      onBack={onBack} onClose={onClose} />
  </div>
}

export const mysqlWorkspaceContribution: PluginWorkspaceContribution = {
  type: "mysql", Component: MysqlWorkspaceContribution,
  sessionKey: (plugin) => mysqlWorkspaceSessionKey(plugin, plugin),
  canOpen: (plugin) => Boolean(mysqlDatabaseName(plugin)),
  retainAcrossSelection: false, retainOnDisconnect: "dirty", requiresConnection: true, maxSessions: 1,
  focusTestId: "mysql-workspace-back", returnFocusTestId: "plugin-workspace-open",
}
