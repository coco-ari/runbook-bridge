import { DiagnosticDetails } from "./DiagnosticDetails"
import { EnvironmentPluginRow, type EnvironmentWorkspaceAction } from "./EnvironmentPluginRow"
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
import { RuntimeHostKeyDialog } from "@/features/connections/RuntimeHostKeyDialog"
import {
  summarizeConnectionActions,
} from "@/features/connections/connection-model"
import { useEnvironmentConnection } from "@/features/connections/use-environment-connection"
import { buildEnvironmentDetailModel } from "@/features/environments/environment-detail-model"
import {
  type WorkspaceEnvironmentReadModel,
  type WorkspacePluginReadModel,
} from "@/features/workspace/workspace-read-model"

export interface EnvironmentConnectionPanelProps {
  readonly api: AiOpsV2Api
  readonly environment: WorkspaceEnvironmentReadModel
  readonly plugins: readonly WorkspacePluginReadModel[] | null
  readonly onOpenWorkspace: (pluginInstanceId: string) => void
  readonly workspaceActions: Readonly<Record<string, EnvironmentWorkspaceAction>>
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
  onOpenWorkspace,
  workspaceActions,
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
                label: connection.state.phase === "partial" ? "连接剩余" : "重试连接",
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
      <Card size="sm" className="gap-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium" id="environment-connection-title" title="打开详情和刷新状态不会自动连接">环境连接</h3>
              <Badge aria-live="polite" role="status" variant={phase.variant}>{phase.label}</Badge>
            </div>
            <dl aria-label="环境连接摘要" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="environment-connection-summary">
              <div className="flex gap-1"><dt>插件</dt><dd>{detail.summary.total}</dd></div>
              <div className="flex gap-1"><dt>已连接</dt><dd>{detail.summary.connected}/{detail.summary.total}</dd></div>
              {([["待完善", detail.summary.draft], ["等待依赖", dependencyCount], ["错误", detail.summary.error]] as const).filter(([, count]) => count > 0).map(([label, count]) => <div className="flex gap-1" key={label}><dt>{label}</dt><dd>{count}</dd></div>)}
            </dl>
          </div>
          <div aria-label="环境连接操作" className="flex flex-wrap items-center gap-2" role="group">
            <ButtonGroup aria-label="连接与断开">
              <Button data-testid="environment-connection-primary" disabled={primaryAction.disabled} onClick={(event) => { connectionTriggerRef.current = event.currentTarget; void primaryAction.run() }} size="sm" type="button" variant={primaryAction.variant}>
                {primaryAction.pending ? <SpinnerGap className="animate-spin" /> : <PrimaryIcon />}{primaryAction.label}
              </Button>
              {detail.summary.connected > 0 && ["partial", "blocked", "error"].includes(connection.state.phase) ? <Button disabled={busy} onClick={() => void connection.disconnect()} size="sm" type="button" variant="outline"><LinkBreak />断开全部</Button> : null}
            </ButtonGroup>
            <Button data-testid="environment-connection-refresh" disabled={busy || connection.state.phase === "connecting" || connection.state.phase === "disconnecting"} onClick={() => void connection.refresh()} size="sm" type="button" variant="outline"><ArrowClockwise />刷新</Button>
          </div>
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
            <DiagnosticDetails error={{ code: action.code, message: action.title }} />
          </AlertDescription>
        </Alert>
      ))}

      {connection.state.error && !connection.state.challenge ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>连接操作失败</AlertTitle>
          <AlertDescription><p>{connection.state.error.message}</p><DiagnosticDetails error={connection.state.error} /></AlertDescription>
        </Alert>
      ) : null}

      <Card data-testid="environment-plugin-list" size="sm">
        <CardHeader className="border-b">
          <CardTitle>插件</CardTitle>
          <p className="text-xs leading-5 text-muted-foreground">直接连接插件或进入工作区；点击名称查看配置与详情。</p>
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
            <div aria-label="环境插件状态" className="divide-y divide-border" role="list">
              {detail.rows.map(row => <EnvironmentPluginRow key={row.plugin.pluginInstanceId} api={api} environment={environment} row={row} runtime={connection.state.runtime} onRuntime={onRuntime} onOpenPlugin={onOpenPlugin} onOpenWorkspace={onOpenWorkspace} workspace={workspaceActions[row.plugin.pluginInstanceId]} />)}
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
