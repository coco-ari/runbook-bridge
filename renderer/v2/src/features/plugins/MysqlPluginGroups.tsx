import { useId, useState, type ReactNode } from "react"
import { CaretRight, Database, DotsThree, LinkSimple, LinkBreak, GearSix, SpinnerGap, Trash } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api, EnvironmentScope, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { normalizeEnvironmentRuntime } from "@/features/workspace/workspace-read-model"
import { Button } from "@/components/ui/button"
import { StatusIndicator, type StatusKind } from "@/components/app-shell/StatusIndicator"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useMenuHandoff } from "@/hooks/use-menu-handoff"
import { cn } from "@/lib/utils"
import { mysqlPluginGroup } from "./mysql-plugin-group"

interface GroupablePlugin {
  readonly pluginType: string
  readonly pluginInstanceId: string
  readonly tags?: readonly string[]
  readonly mysqlConnectionId?: string
  readonly mysqlConnectionName?: string
  readonly status?: string
  readonly database?: string
  readonly displayName?: string
}
interface GroupProps<T extends GroupablePlugin> {
  readonly plugins: readonly T[]
  readonly renderPlugin: (plugin: T) => ReactNode
  readonly api: AiOpsV2Api
  readonly scope: EnvironmentScope
  readonly onConfigure: (plugin: T) => void
  readonly onDelete: (plugin: T) => void
  readonly runtime?: EnvironmentRuntime | null | undefined
  readonly disabled?: boolean | undefined
}

function ConnectionGroup<T extends GroupablePlugin>({ plugins, renderPlugin, api, scope, onConfigure, onDelete, runtime, disabled }: GroupProps<T>) {
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  const first = plugins[0]!
  const group = mysqlPluginGroup(first)!
  const menu = useMenuHandoff(`${scope.projectId}:${scope.environmentId}:${group.id}`)
  const statuses = normalizeEnvironmentRuntime(runtime, scope)?.plugins
  const status = (plugin: T) => statuses?.find(item => item.pluginInstanceId === plugin.pluginInstanceId)?.status ?? plugin.status
  const connected = plugins.filter(item => status(item) === "connected").length
  const busy = pending || plugins.some(item => ["connecting", "disconnecting"].includes(status(item) ?? ""))
  const failed = plugins.filter(item => ["error", "blocked"].includes(status(item) ?? "")).length
  const groupStatus: StatusKind = busy ? "connecting" : connected === plugins.length ? "connected"
    : connected > 0 ? "partial" : failed > 0 ? "error" : "disconnected"
  const statusLabel = busy ? "连接处理中" : failed > 0 ? `连接异常 ${failed}/${plugins.length}`
    : connected > 0 ? `已连接 ${connected}/${plugins.length}` : "未连接"
  const primaryIntent = connected === plugins.length ? "disconnect" : "connect"
  const connectLabel = connected > 0 && connected < plugins.length ? "连接剩余" : "连接全部"
  const actionLabel = primaryIntent === "disconnect" ? "断开全部" : connectLabel
  const ActionIcon = busy ? SpinnerGap : primaryIntent === "disconnect" ? LinkBreak : LinkSimple
  const connect = async (intent: "connect" | "disconnect") => {
    setPending(true)
    try {
      const result = await api.connectMysqlConnection({ projectId: scope.projectId, environmentId: scope.environmentId, pluginInstanceId: first.pluginInstanceId, intent })
      if (!result.ok) toast.error(result.error.message)
      else if (result.data.outcome === "blocked") toast.error("操作暂时无法执行，请检查各库的状态提示")
    } catch { toast.error("连接操作失败，请检查状态后重试") }
    finally { setPending(false) }
  }
  return <div className="min-w-0" role="listitem" data-testid="mysql-plugin-group">
    <div className="flex min-w-0 items-center rounded-md transition-colors duration-150 hover:bg-surface-hover" data-testid="mysql-group-header">
      <Button type="button" variant="ghost" className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-2 px-2 py-1 text-left font-normal hover:bg-transparent focus-visible:ring-inset"
        aria-label={`${expanded ? "收起" : "展开"} ${group.name}，${plugins.length} 个数据库`} aria-expanded={expanded} aria-controls={contentId}
        data-testid="mysql-group-toggle" onClick={() => setExpanded(value => !value)}>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised text-muted-foreground"><Database aria-hidden="true" size={16} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2 leading-5">
            <span className="truncate text-sm text-foreground" title={group.name}>{group.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{plugins.length} 个库</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            <span className="shrink-0">MySQL</span><span aria-hidden="true">·</span>
            <StatusIndicator status={groupStatus} label={statusLabel} className="min-w-0 shrink [&>span]:truncate" />
          </span>
        </span>
        <CaretRight aria-hidden="true" className={cn("size-3 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-90")} />
      </Button>
      <div className="mr-1 flex shrink-0 items-center gap-0.5" role="group" aria-label={`${group.name} 的操作`}>
        <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-foreground" disabled={disabled || busy}
          aria-label={`${actionLabel} · ${group.name}`} title={busy ? "正在处理连接" : `${actionLabel} · ${group.name}`} aria-busy={busy || undefined}
          data-testid="mysql-group-connection" onClick={() => void connect(primaryIntent)}>
          <ActionIcon aria-hidden="true" className={busy ? "animate-spin motion-reduce:animate-none" : undefined} /><span className="sr-only">{actionLabel}</span>
        </Button>
        <DropdownMenu onOpenChange={menu.onOpenChange}>
          <DropdownMenuTrigger asChild><Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-foreground" aria-label={`${group.name} 的更多操作`} data-testid="mysql-group-menu-trigger"><DotsThree aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
            <DropdownMenuItem disabled={busy} onSelect={() => menu.queueAction(() => onConfigure(first))}><GearSix />管理连接</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={disabled || busy || connected === plugins.length} onSelect={() => menu.queueAction(() => void connect("connect"))}><LinkSimple />{connectLabel}</DropdownMenuItem>
            <DropdownMenuItem disabled={disabled || busy || connected === 0} onSelect={() => menu.queueAction(() => void connect("disconnect"))}><LinkBreak />断开全部</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} variant="destructive" onSelect={() => menu.queueAction(() => onDelete(first))}><Trash />删除整组</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <div id={contentId} hidden={!expanded} className="mb-1 ml-5 border-l border-border/60 pl-2" role="list" aria-label={`${group.name} 的数据库`}>{plugins.map(plugin => renderPlugin(plugin.database && plugin.displayName === `${group.name} · ${plugin.database}` ? { ...plugin, displayName: plugin.database } : plugin))}</div>
  </div>
}

export function MysqlPluginGroups<T extends GroupablePlugin>(props: GroupProps<T>) {
  const emitted = new Set<string>()
  return <>{props.plugins.map(plugin => {
    const group = mysqlPluginGroup(plugin)
    if (!group) return props.renderPlugin(plugin)
    if (emitted.has(group.id)) return null
    emitted.add(group.id)
    const members = props.plugins.filter(item => mysqlPluginGroup(item)?.id === group.id)
    if (members.length === 1) return props.renderPlugin(plugin)
    return <ConnectionGroup key={group.id} {...props} plugins={members} />
  })}</>
}
