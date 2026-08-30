import { ArrowClockwise, LockKey, Plugs, ShieldCheck, WarningCircle } from "@phosphor-icons/react"
import type { ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  WorkspacePluginReadModel,
  WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"

export interface PluginOverviewProps {
  readonly connectionPanel?: ReactNode
  readonly error?: WorkspaceReadError | null
  readonly loading?: boolean
  readonly onReload?: () => void
  readonly plugin: WorkspacePluginReadModel | null
}

function capabilityBoundary(type: WorkspacePluginReadModel["pluginType"]): string {
  if (type === "server") {
    return "提供有界的日志、配置、文件和服务调查能力。写入、删除、服务控制与 Shell 仍需一次性确认。"
  }
  if (type === "mysql") {
    return "固定到一个数据库，只允许策略批准的单条 SELECT 或 EXPLAIN SELECT。"
  }
  if (type === "redis") {
    return "固定到一个 Logical DB，键扫描与读取受已配置模式和数量上限约束。"
  }
  return "未知插件类型默认拒绝 Agent 使用，也不会自动建立连接或执行操作。"
}

export function PluginOverview({
  connectionPanel,
  error = null,
  loading = false,
  onReload,
  plugin,
}: PluginOverviewProps) {
  if (loading && !plugin) {
    return (
      <section aria-busy="true" aria-label="正在读取插件详情" className="space-y-4" data-testid="plugin-overview-loading">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </section>
    )
  }
  const readErrorNotice = error ? (
    <Alert data-testid="plugin-overview-error" variant="destructive">
      <WarningCircle aria-hidden="true" size={18} weight="fill" />
      <AlertTitle>{plugin ? "插件信息刷新失败" : "插件详情不可用"}</AlertTitle>
      <AlertDescription>
        <p>{plugin ? "显示上次读取的信息，请重新读取后核对配置。当前连接操作仍可管理。" : "无法读取插件详情。请重试。"}</p>
        {onReload ? (
          <Button className="mt-3" onClick={onReload} size="sm" type="button" variant="outline">
            <ArrowClockwise aria-hidden="true" size={14} />
            重新读取
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  ) : null
  if (error && !plugin) return readErrorNotice
  if (!plugin) {
    return (
      <Empty className="min-h-52" data-testid="plugin-overview-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Plugs aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>尚未选择插件</EmptyTitle>
          <EmptyDescription>从环境下选择一个插件以查看脱敏详情。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <section aria-labelledby="plugin-overview-heading" className="space-y-4" data-testid="plugin-overview">
      <h2 className="sr-only" id="plugin-overview-heading">插件详情</h2>
      {readErrorNotice}
      {connectionPanel ?? (
        <Alert>
          <Plugs aria-hidden="true" />
          <AlertTitle>{plugin.pluginType === "unknown" ? "暂不支持此插件类型" : "插件配置尚未载入"}</AlertTitle>
          <AlertDescription>请刷新插件列表后再管理连接；未知插件类型不会被自动执行。</AlertDescription>
        </Alert>
      )}
      <section aria-labelledby="plugin-boundary-heading" className="space-y-2 px-1">
        <div className="flex items-start gap-2">
          <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-primary" size={15} />
          <div className="min-w-0 space-y-1">
            <h3 className="text-xs font-medium" id="plugin-boundary-heading">Agent 能力边界</h3>
            <p className="text-xs leading-5 text-muted-foreground">{capabilityBoundary(plugin.pluginType)}</p>
          </div>
        </div>
        <p className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
          <LockKey aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          只有已连接且获准的插件能力会进入新的 Agent context，凭据不会显示或复制。
        </p>
      </section>
    </section>
  )
}
