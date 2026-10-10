import { ArrowsOutSimple } from "@phosphor-icons/react"
import type { AiOpsV2Api, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import { Button } from "@/components/ui/button"
import { pluginIcons } from "@/features/plugins/plugin-icons"
import type { EnvironmentDetailRow } from "@/features/environments/environment-detail-model"
import { pluginTypeLabel, type WorkspaceEnvironmentReadModel } from "@/features/workspace/workspace-read-model"
import { PluginConnectionRowAction } from "./ConnectionRowAction"

export interface EnvironmentWorkspaceAction {
  readonly enabled: boolean
  readonly retained: boolean
}

export function EnvironmentPluginRow({ api, environment, row, runtime, onRuntime, onOpenPlugin, onConfigurePlugin, onOpenWorkspace, workspace }: {
  readonly api: AiOpsV2Api
  readonly environment: WorkspaceEnvironmentReadModel
  readonly row: EnvironmentDetailRow
  readonly runtime: EnvironmentRuntime | null
  readonly onRuntime?: ((runtime: EnvironmentRuntime) => void) | undefined
  readonly onConfigurePlugin: (id: string) => void
  readonly onOpenPlugin: (id: string) => void
  readonly onOpenWorkspace: (id: string) => void
  readonly workspace?: EnvironmentWorkspaceAction | undefined
}) {
  const plugin = row.plugin
  const PluginIcon = pluginIcons[plugin.pluginType]
  const openDetails = () => onOpenPlugin(plugin.pluginInstanceId)
  return <div role="listitem" className="grid min-w-0 grid-cols-1 gap-2 py-3 @sm/environment-connection:grid-cols-[minmax(0,1fr)_auto] @sm/environment-connection:items-center" data-testid={`environment-plugin-row-${plugin.pluginInstanceId}`}>
    <div className="flex min-w-0 items-start gap-2.5">
      <PluginIcon aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground" size={18} />
      <div className="min-w-0 space-y-1">
        <Button aria-label={`查看插件 ${plugin.displayName} 的详情`} className="h-auto max-w-full justify-start whitespace-normal break-words p-0 text-left text-sm text-foreground" data-testid={`environment-plugin-detail-${plugin.pluginInstanceId}`} onClick={openDetails} type="button" variant="link">{plugin.displayName}</Button>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{pluginTypeLabel(plugin.pluginType)}</span><StatusIndicator status={row.status} /></div>
        {row.providerName ? <p className="break-words text-xs leading-5 text-muted-foreground">依赖：{row.providerName}</p> : null}
        {!["已连接。", "已手动断开。", "等待手动连接。"].includes(row.description) ? <p className="break-words text-xs leading-5 text-muted-foreground">{row.description}</p> : null}
      </div>
    </div>
    <div aria-label={`${plugin.displayName} 的操作`} className="flex flex-wrap items-center gap-1.5 pl-7 @sm/environment-connection:justify-end @sm/environment-connection:pl-0" role="group">
      <PluginConnectionRowAction api={api} plugin={{ projectId: environment.projectId, environmentId: environment.environmentId, pluginInstanceId: plugin.pluginInstanceId }} fallbackStatus={row.status} ready={plugin.configState === "ready"} runtime={runtime} {...(onRuntime ? { onRuntime } : {})} onConfigure={() => onConfigurePlugin(plugin.pluginInstanceId)} scopeLabel={plugin.displayName} testId={`environment-plugin-connection-${plugin.pluginInstanceId}`} />
      {workspace?.enabled ? <Button aria-label={`${workspace.retained ? "继续" : "打开"} ${plugin.displayName} 工作区`} data-testid={`environment-plugin-workspace-${plugin.pluginInstanceId}`} onClick={() => onOpenWorkspace(plugin.pluginInstanceId)} size="xs" type="button" variant="outline"><ArrowsOutSimple />{workspace.retained ? "继续工作区" : "打开工作区"}</Button> : null}
    </div>
  </div>
}
