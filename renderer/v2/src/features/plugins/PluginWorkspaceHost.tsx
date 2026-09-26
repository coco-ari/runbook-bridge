import { EnvironmentTypeContext } from "@/features/environments/EnvironmentTypeBadge"
import type { WorkspaceReadModel } from "@/features/workspace/workspace-read-model"
import { useCallback } from "react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { pluginWorkspaces } from "./workspace-contributions"
import type { PluginWorkspaceEntry, PluginWorkspaceState } from "./workspace-registry"

interface Props {
  readonly api: AiOpsV2Api
  readonly workspace: WorkspaceReadModel | null
  readonly state: PluginWorkspaceState
  readonly hidden: boolean
  readonly onBack: () => void
  readonly onClose: (key: string) => void
  readonly onDirtyChange: (key: string, dirty: boolean) => void
}

function WorkspaceSlot({ api, entry, visible, onBack, onClose, onDirtyChange, workspace }: Omit<Props, "state" | "hidden"> & {
  readonly entry: PluginWorkspaceEntry
  readonly visible: boolean
}) {
  const close = useCallback(() => onClose(entry.key), [entry.key, onClose])
  const dirty = useCallback((value: boolean) => onDirtyChange(entry.key, value), [entry.key, onDirtyChange])
  const Component = pluginWorkspaces.get(entry.type)?.Component
  const environmentType = workspace?.projects.find(project => project.projectId === entry.scope.projectId)?.environments.find(environment => environment.environmentId === entry.scope.environmentId)?.environmentType ?? "unspecified"
  return Component ? <EnvironmentTypeContext.Provider value={environmentType}><Component api={api} entry={entry} visible={visible} onBack={onBack} onClose={close} onDirtyChange={dirty} /></EnvironmentTypeContext.Provider> : null
}

export function PluginWorkspaceHost({ api, state, hidden, workspace, onBack, onClose, onDirtyChange }: Props) {
  return state.entries.map((entry) => <WorkspaceSlot key={entry.key} workspace={workspace} api={api} entry={entry}
    visible={!hidden && entry.key === state.activeKey} onBack={onBack} onClose={onClose} onDirtyChange={onDirtyChange} />)
}
