import { PluginConnectionPanel } from "../connections/PluginConnectionPanel"
import { PluginAgentAccess } from "./PluginAgentAccess"
import { PluginEditorWorkspace } from "./PluginEditorWorkspace"
import { PLUGIN_CATALOG } from "./plugin-catalog"
import { isPluginKind } from "./plugin-types"
import { createPluginUiRegistry, type PluginEditorContributionProps } from "./plugin-ui-registry"

function BuiltinPluginEditor(props: PluginEditorContributionProps) {
  if (!isPluginKind(props.initialKind)) throw new Error("该插件需要自己的配置编辑器。")
  return <PluginEditorWorkspace {...props} initialKind={props.initialKind} />
}

export const pluginUi = createPluginUiRegistry([
  { type:"server", label:PLUGIN_CATALOG.server.label, Editor:BuiltinPluginEditor, ConnectionPanel:PluginConnectionPanel, AgentAccess:PluginAgentAccess },
  { type:"mysql", label:PLUGIN_CATALOG.mysql.label, Editor:BuiltinPluginEditor, ConnectionPanel:PluginConnectionPanel, AgentAccess:PluginAgentAccess },
  { type:"redis", label:PLUGIN_CATALOG.redis.label, Editor:BuiltinPluginEditor, ConnectionPanel:PluginConnectionPanel, AgentAccess:PluginAgentAccess },
])
