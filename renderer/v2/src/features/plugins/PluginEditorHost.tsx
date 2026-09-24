import { useState } from "react"
import type { PluginEditorWorkspaceProps } from "./PluginEditorWorkspace"
import { pluginUi } from "./plugin-ui-contributions"

export function PluginEditorHost(props: Omit<PluginEditorWorkspaceProps, "initialKind"> & { readonly initialKind?: string }) {
  const [selectedType, setSelectedType] = useState(props.initialKind ?? "server")
  const contribution = pluginUi.get(props.plugin?.pluginType ?? selectedType)
  if (!contribution) return <p role="alert">此插件尚未注册配置界面。</p>
  const Editor = contribution.Editor
  return <Editor {...props} initialKind={props.plugin?.pluginType ?? selectedType}
    pluginTypeOptions={pluginUi.options} onChoosePluginType={(type) => {
      const next = pluginUi.get(type)
      if (!next) return true
      if (next.Editor === Editor) return false
      setSelectedType(type)
      return true
    }} />
}
