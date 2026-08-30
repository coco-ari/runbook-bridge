import type { EnvironmentScope } from "@/bridge/ai-ops-v2"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import type { WorkspaceSelectionState } from "@/features/workspace/selection-reducer"

export interface PluginWorkMode {
  readonly id: string
  readonly kind: "plugin-editor"
  readonly scope: EnvironmentScope
  readonly projectName: string
  readonly environmentName: string
  readonly plugin: PluginConfigurationRecord | null
  readonly returnSelection: WorkspaceSelectionState
  readonly returnTab: string
}

export type WorkspaceLeaveRequest = () => Promise<boolean>

/** A work mode is memory-only. A refresh must never replace an active edit snapshot. */
export function createPluginWorkMode(input: Omit<PluginWorkMode, "kind" | "id">): PluginWorkMode {
  if (input.plugin && (
    input.plugin.projectId !== input.scope.projectId
    || input.plugin.environmentId !== input.scope.environmentId
  )) throw new Error("插件不属于当前编辑范围。")

  return {
    id: globalThis.crypto.randomUUID(),
    kind: "plugin-editor",
    scope: { ...input.scope },
    projectName: input.projectName,
    environmentName: input.environmentName,
    plugin: input.plugin ? structuredClone(input.plugin) : null,
    returnSelection: { ...input.returnSelection },
    returnTab: input.returnTab,
  }
}
