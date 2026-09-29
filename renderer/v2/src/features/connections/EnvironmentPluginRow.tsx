import { ArrowsOutSimple } from "@phosphor-icons/react"
import type { AiOpsV2Api, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import { Button } from "@/components/ui/button"
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
  const openDetails = () => onOpenPlugin(plugin.pluginInstanceId)
  return <div role="listitem" className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-4 @2xl/environment-connection:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @2xl/environment-connection:items-center" data-testid={`environment-plugin-row-${plugin.pluginInstanceId}`}>
    <div className="min-w-0 space-y-1">
      <Button aria-label={`查看插件 ${plugin.displayName} 的详情`} className="h-auto max-w-full justify-start whitespace-normal break-all p-0 text-left text-sm" data-testid={`environment-plugin-detail-${plugin.pluginInstanceId}`} onClick={openDetails} type="button" variant="link">{plugin.displayName}</Button>
      <p className="text-xs text-muted-foreground">{pluginTypeLabel(plugin.pluginType)}</p>
    </div>
    <div className="min-w-0 space-y-1.5">
      <StatusIndicator appearance="badge" status={row.status} />
      {!["已连接。", "已手动断开。", "等待手动连接。"].includes(row.description) ? <p className="break-all text-xs leading-5 text-muted-foreground">{row.description}</p> : null}
      {row.providerName ? <p className="break-all text-xs leading-5 text-muted-foreground">依赖：{row.providerName}</p> : null}
    </div>
    <div aria-label={`${plugin.displayName} 的操作`} className="col-span-2 flex flex-wrap items-center gap-2 @2xl/environment-connection:col-span-1" role="group">
      <PluginConnectionRowAction api={api} plugin={{ projectId: environment.projectId, environmentId: environment.environmentId, pluginInstanceId: plugin.pluginInstanceId }} fallbackStatus={row.status} ready={plugin.configState === "ready"} runtime={runtime} {...(onRuntime ? { onRuntime } : {})} onConfigure={() => onConfigurePlugin(plugin.pluginInstanceId)} scopeLabel={plugin.displayName} testId={`environment-plugin-connection-${plugin.pluginInstanceId}`} />
      {workspace ? <Button aria-label={`${workspace.retained ? "继续" : "打开"} ${plugin.displayName} 工作区`} data-testid={`environment-plugin-workspace-${plugin.pluginInstanceId}`} disabled={!workspace.enabled} onClick={() => onOpenWorkspace(plugin.pluginInstanceId)} size="xs" title={workspace.enabled ? undefined : "请先连接插件并完善配置"} type="button" variant={workspace.enabled ? "default" : "outline"}><ArrowsOutSimple />{workspace.retained ? "继续工作区" : "打开工作区"}</Button> : null}
    </div>
  </div>
}
