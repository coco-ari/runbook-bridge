import {
  ArrowClockwise,
  LinkBreak,
  LinkSimple,
  SpinnerGap,
  Stack,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react"
import { useRef } from "react"

import type { AiOpsV2Api, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
} from "@/components/ui/item"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RuntimeHostKeyDialog } from "@/features/connections/RuntimeHostKeyDialog"
import {
  summarizeConnectionActions,
} from "@/features/connections/connection-model"
import { useEnvironmentConnection } from "@/features/connections/use-environment-connection"
import { buildEnvironmentDetailModel } from "@/features/environments/environment-detail-model"
import {
  pluginTypeLabel,
  type WorkspaceEnvironmentReadModel,
  type WorkspacePluginReadModel,
} from "@/features/workspace/workspace-read-model"

export interface EnvironmentConnectionPanelProps {
  readonly api: AiOpsV2Api
  readonly environment: WorkspaceEnvironmentReadModel
  readonly plugins: readonly WorkspacePluginReadModel[] | null
  readonly onOpenPlugin: (pluginInstanceId: string) => void
  readonly runtime?: EnvironmentRuntime | null
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
}

const PHASE_COPY = {
  connected: { label: "已连接", variant: "success" as const },
  disconnected: { label: "未连接", variant: "outline" as const },
  connecting: { label: "连接中", variant: "info" as const },
  disconnecting: { label: "断开中", variant: "info" as const },
  partial: { label: "部分可用", variant: "warning" as const },
  blocked: { label: "已阻塞", variant: "warning" as const },
  error: { label: "错误", variant: "danger" as const },
  unknown: { label: "状态未知", variant: "outline" as const },
}

export function EnvironmentConnectionPanel({
  api,
  environment,
  plugins,
  onOpenPlugin,
  runtime = null,
  onRuntime,
}: EnvironmentConnectionPanelProps) {
  const connectionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const connection = useEnvironmentConnection({
    api,
    environment,
    runtime,
    ...(onRuntime ? { onRuntime } : {}),
  })
  const phase = PHASE_COPY[connection.state.phase]
  const activeIntent = connection.state.operation?.intent ?? null
  const busy = activeIntent !== null
  const detail = buildEnvironmentDetailModel({ environment, plugins, runtime: connection.state.runtime })
  const dependencyCount = detail.summary.waitingDependency
  const actions = summarizeConnectionActions(connection.state.actions)
    .filter((action) => action.kind !== "host-key")

  const primaryAction = activeIntent === "cancel"
    ? {
        label: "取消中",
        icon: SpinnerGap,
        run: connection.cancel,
        variant: "outline" as const,
        disabled: true,
        pending: true,
      }
    : connection.state.phase === "disconnecting"
      ? {
          label: "断开中",
          icon: SpinnerGap,
          run: connection.disconnect,
          variant: "outline" as const,
          disabled: true,
          pending: true,
        }
      : connection.state.phase === "connecting"
        ? {
            label: "取消",
            icon: XCircle,
            run: connection.cancel,
            variant: "outline" as const,
            disabled: false,
            pending: false,
          }
        : connection.state.phase === "connected"
          ? {
              label: "断开全部",
              icon: LinkBreak,
              run: connection.disconnect,
              variant: "outline" as const,
              disabled: busy,
              pending: busy,
            }
          : ["error", "blocked", "partial"].includes(connection.state.phase)
            ? {
                label: "重试连接",
                icon: ArrowClockwise,
                run: connection.retry,
                variant: "default" as const,
                disabled: busy || detail.summary.total === 0,
                pending: busy,
              }
            : {
                label: "连接全部",
                icon: LinkSimple,
                run: connection.connect,
                variant: "default" as const,
                disabled: busy || detail.summary.total === 0,
                pending: busy,
              }
  const PrimaryIcon = primaryAction.icon

  return (
    <section aria-labelledby="environment-connection-title" className="space-y-4 @container/environment-connection" data-testid="environment-connection-panel">
      <Card size="sm">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <CardTitle id="environment-connection-title">环境连接</CardTitle>
              <Badge aria-live="polite" role="status" variant={phase.variant}>{phase.label}</Badge>
            </div>
            <div aria-label="环境连接操作" className="flex flex-wrap items-center gap-2" role="group">
              <ButtonGroup aria-label="连接与断开">
                <Button
                  data-testid="environment-connection-primary"
                  disabled={primaryAction.disabled}
                  onClick={(event) => {
                    connectionTriggerRef.current = event.currentTarget
                    void primaryAction.run()
                  }}
                  size="sm"
                  type="button"
                  variant={primaryAction.variant}
                >
                  {primaryAction.pending ? <SpinnerGap className="animate-spin" /> : <PrimaryIcon />}
                  {primaryAction.label}
                </Button>
                {detail.summary.connected > 0 && ["partial", "blocked", "error"].includes(connection.state.phase) ? (
                  <Button disabled={busy} onClick={() => void connection.disconnect()} size="sm" type="button" variant="outline">
                    <LinkBreak />断开全部
                  </Button>
                ) : null}
              </ButtonGroup>
              <Button
                data-testid="environment-connection-refresh"
                disabled={busy || connection.state.phase === "connecting" || connection.state.phase === "disconnecting"}
                onClick={() => void connection.refresh()}
                size="sm"
                type="button"
                variant="outline"
              >
                <ArrowClockwise />刷新
              </Button>
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            按依赖连接当前环境中配置完整的插件。打开详情和刷新状态不会自动连接。
          </p>
        </CardHeader>
        <CardContent>
          <dl aria-label="环境连接摘要" className="flex flex-wrap gap-x-8 gap-y-3 border-t pt-3" data-testid="environment-connection-summary">
            {[
              ["插件总数", detail.summary.total],
              ["已连接", detail.summary.connected],
              ["待完善", detail.summary.draft],
              ["等待依赖", dependencyCount],
              ["错误", detail.summary.error],
            ].map(([label, value]) => (
              <div className="flex items-baseline gap-2" key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-mono text-base font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {dependencyCount > 0 && !actions.some((action) => action.kind === "dependency") ? (
        <Alert data-testid="environment-dependency-state">
          <LinkBreak />
          <AlertTitle>连接依赖尚未就绪</AlertTitle>
          <AlertDescription>
            {dependencyCount} 个插件正在等待其 Server 隧道或上游连接。
          </AlertDescription>
        </Alert>
      ) : null}

      {actions.map((action, index) => (
        <Alert
          data-testid={`environment-connection-action-${action.kind}`}
          key={`${action.code}/${action.rootPluginInstanceId ?? "environment"}/${index}`}
          variant={action.kind === "error" ? "destructive" : "default"}
        >
          {action.kind === "error" ? <XCircle /> : <WarningCircle />}
          <AlertTitle>{action.title}</AlertTitle>
          <AlertDescription>
            {action.affectedCount > 0
              ? `影响 ${action.affectedCount} 个插件。`
              : "请检查当前环境状态后再继续。"}
          </AlertDescription>
        </Alert>
      ))}

      {connection.state.error && !connection.state.challenge ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>连接操作失败</AlertTitle>
          <AlertDescription>{connection.state.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card data-testid="environment-plugin-list" size="sm">
        <CardHeader className="border-b">
          <CardTitle>插件</CardTitle>
          <p className="text-xs leading-5 text-muted-foreground">点击插件名称查看详情、管理单个连接或修改配置。</p>
          {detail.partial ? (
            <p className="text-xs leading-5 text-muted-foreground">部分插件信息或运行状态尚未读取，列表保留上次已知状态。</p>
          ) : null}
        </CardHeader>
        {detail.rows.length === 0 ? (
          <Empty className="min-h-36">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Stack aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{detail.summary.total > 0 ? "插件列表尚未读取" : "当前环境还没有插件"}</EmptyTitle>
              <EmptyDescription>{detail.summary.total > 0 ? "请重新读取环境信息后查看插件详情。" : "在环境栏新增插件并完善配置后，即可在此管理连接。"}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CardContent>
            <ItemGroup aria-label="环境插件状态" className="gap-2 @xl/environment-connection:hidden">
              {detail.rows.map((row) => (
                <Item className="min-w-0" key={row.plugin.pluginInstanceId} role="listitem" size="xs" variant="outline">
                  <ItemContent className="min-w-0">
                    <div className="flex w-full items-start justify-between gap-2">
                      <Button
                        aria-label={`查看插件 ${row.plugin.displayName} 的详情`}
                        className="h-auto min-w-0 flex-1 shrink justify-start whitespace-normal break-all p-0 text-left text-sm"
                        data-testid={`environment-plugin-detail-${row.plugin.pluginInstanceId}`}
                        onClick={() => onOpenPlugin(row.plugin.pluginInstanceId)}
                        type="button"
                        variant="link"
                      >{row.plugin.displayName}</Button>
                      <StatusIndicator appearance="badge" status={row.status} />
                    </div>
                    <ItemDescription>{pluginTypeLabel(row.plugin.pluginType)} · {row.description}</ItemDescription>
                    {row.providerName ? <ItemDescription>依赖：{row.providerName}</ItemDescription> : null}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
            <div className="hidden @xl/environment-connection:block">
              <Table aria-label="环境插件状态" className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%]">插件</TableHead>
                    <TableHead className="w-20">类型</TableHead>
                    <TableHead className="w-28">状态</TableHead>
                    <TableHead>连接说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.rows.map((row) => (
                    <TableRow key={row.plugin.pluginInstanceId}>
                      <TableCell className="whitespace-normal">
                        <Button
                          aria-label={`查看插件 ${row.plugin.displayName} 的详情`}
                          className="h-auto max-w-full justify-start whitespace-normal break-all p-0 text-left text-sm"
                          data-testid={`environment-plugin-detail-${row.plugin.pluginInstanceId}`}
                          onClick={() => onOpenPlugin(row.plugin.pluginInstanceId)}
                          type="button"
                          variant="link"
                        >{row.plugin.displayName}</Button>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{pluginTypeLabel(row.plugin.pluginType)}</TableCell>
                      <TableCell><StatusIndicator appearance="badge" status={row.status} /></TableCell>
                      <TableCell className="whitespace-normal text-xs leading-5 text-muted-foreground">
                        <p>{row.description}</p>
                        {row.providerName ? <p className="break-all">依赖：{row.providerName}</p> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        )}
      </Card>

      <RuntimeHostKeyDialog
        onReject={connection.rejectHostKey}
        onTrust={connection.trustHostKey}
        returnFocusRef={connectionTriggerRef}
        showPlugin
        state={connection.state}
        testId="environment-host-key-confirmation"
      />
    </section>
  )
}
