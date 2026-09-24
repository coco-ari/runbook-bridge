import type { ComponentType } from "react"
import type { PluginEditorWorkspaceProps } from "./PluginEditorWorkspace"
import type { PluginConnectionPanelProps } from "../connections/PluginConnectionPanel"
import type { PluginAgentAccessProps } from "./PluginAgentAccess"

export interface PluginEditorContributionProps extends Omit<PluginEditorWorkspaceProps, "initialKind"> {
  readonly initialKind: string
  readonly pluginTypeOptions: readonly { readonly type: string; readonly label: string }[]
  readonly onChoosePluginType: (type: string) => boolean
}

export interface PluginUiContribution {
  readonly type: string
  readonly label: string
  readonly Editor: ComponentType<PluginEditorContributionProps>
  readonly ConnectionPanel: ComponentType<PluginConnectionPanelProps>
  readonly AgentAccess: ComponentType<PluginAgentAccessProps>
}

export function createPluginUiRegistry(contributions: readonly PluginUiContribution[]) {
  const entries = new Map<string, PluginUiContribution>()
  for (const contribution of contributions) {
    if (!contribution.type || entries.has(contribution.type) || !contribution.Editor
      || !contribution.ConnectionPanel || !contribution.AgentAccess) {
      throw new Error("插件界面贡献不完整或重复注册。")
    }
    entries.set(contribution.type, Object.freeze({ ...contribution }))
  }
  return Object.freeze({
    get: (type: string) => entries.get(type),
    options: Object.freeze([...entries.values()].map(({ type, label }) => Object.freeze({ type, label }))),
  })
}
