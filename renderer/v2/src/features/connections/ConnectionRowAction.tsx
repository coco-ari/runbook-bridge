import {
  ArrowClockwise,
  LinkBreak,
  LinkSimple,
  SpinnerGap,
  Wrench,
  XCircle,
  type Icon,
} from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"

import type {
  AiOpsV2Api,
  EnvironmentRuntime,
} from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  resolveConnectionCancelTarget,
  type ConnectionPhase,
  type ConnectionScope,
  type ConnectionState,
} from "@/features/connections/connection-model"
import { RuntimeHostKeyDialog } from "@/features/connections/RuntimeHostKeyDialog"
import {
  deriveConnectionRowAction,
  type ConnectionRowActionKind,
} from "@/features/connections/connection-row-model"
import {
  useEnvironmentConnection,
  type EnvironmentConnectionTarget,
} from "@/features/connections/use-environment-connection"
import {
  usePluginConnection,
  type PluginConnectionTarget,
} from "@/features/connections/use-plugin-connection"
import type { WorkspaceReadStatus } from "@/features/workspace/workspace-read-model"

function fallbackPhase(status: WorkspaceReadStatus): ConnectionPhase {
  return status
}

const actionIcons = {
  cancel: XCircle,
  configure: Wrench,
  connect: LinkSimple,
  disconnect: LinkBreak,
  pending: SpinnerGap,
  retry: ArrowClockwise,
} satisfies Record<ConnectionRowActionKind, Icon>

function ConnectionActionButton({
  connection,
  fallbackStatus,
  onConfigure,
  ready,
  scope,
  scopeLabel,
  testId,
  pluginInstanceId,
}: {
  readonly connection: Readonly<{
    state: ConnectionState
    connect: () => Promise<void>
    retry: () => Promise<void>
    disconnect: () => Promise<void>
    cancel: () => Promise<void>
    trustHostKey: () => Promise<void>
    rejectHostKey: () => void
  }>
  readonly fallbackStatus: WorkspaceReadStatus
  readonly onConfigure: () => void
  readonly ready: boolean
  readonly scope: ConnectionScope
  readonly scopeLabel: string
  readonly testId: string
  readonly pluginInstanceId?: string
}) {
  const connectionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const tooltipBlocked = connection.state.operation !== null || connection.state.challenge !== null

  useEffect(() => {
    // A delayed challenge must not revive an earlier focus/hover tooltip when
    // its operation completes or its confirmation is dismissed.
    if (tooltipBlocked) setTooltipOpen(false)
  }, [tooltipBlocked])

  const phase = connection.state.phase === "unknown"
    ? fallbackPhase(fallbackStatus)
    : connection.state.phase
  const action = deriveConnectionRowAction(
    phase,
    connection.state.operation?.intent ?? null,
    ready,
    resolveConnectionCancelTarget(
      connection.state.operation,
      connection.state.runtime,
      scope,
      pluginInstanceId,
    ) !== null,
  )
  const ActionIcon = actionIcons[action.kind]
  const help = action.kind === "configure"
    ? `${scopeLabel}尚未完成连接配置`
    : action.kind === "pending"
      ? `${scopeLabel}${action.label}`
      : `${action.label}${scopeLabel}`

  const run = () => {
    setTooltipOpen(false)
    if (action.kind === "configure") {
      onConfigure()
      return
    }
    if (action.kind === "connect") void connection.connect()
    if (action.kind === "retry") void connection.retry()
    if (action.kind === "disconnect") void connection.disconnect()
    if (action.kind === "cancel") void connection.cancel()
  }

  return (
    <>
      <Tooltip
        onOpenChange={(open) => setTooltipOpen(open && !tooltipBlocked)}
        open={tooltipOpen && !tooltipBlocked}
      >
        <TooltipTrigger asChild>
          <Button
            aria-busy={action.pending || undefined}
            aria-label={help}
            className="gap-1 px-2 text-[11px]"
            data-connection-intent={action.kind}
            data-testid={testId}
            disabled={action.disabled}
            onClick={(event) => {
              event.stopPropagation()
              connectionTriggerRef.current = event.currentTarget
              run()
            }}
            size="xs"
            type="button"
            variant={action.variant}
          >
            <ActionIcon className={action.pending ? "animate-spin" : undefined} size={12} />
            {action.label}
          </Button>
        </TooltipTrigger>
        {!tooltipBlocked ? <TooltipContent>{help}</TooltipContent> : null}
      </Tooltip>
      <RuntimeHostKeyDialog
        onReject={connection.rejectHostKey}
        onTrust={connection.trustHostKey}
        returnFocusRef={connectionTriggerRef}
        showPlugin
        state={connection.state}
        testId="resource-host-key-confirmation"
      />
    </>
  )
}

export function EnvironmentConnectionRowAction({
  api,
  environment,
  fallbackStatus,
  onConfigure,
  onRuntime,
  rawRuntime,
  ready,
}: {
  readonly api: AiOpsV2Api
  readonly environment: EnvironmentConnectionTarget
  readonly fallbackStatus: WorkspaceReadStatus
  readonly onConfigure: () => void
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
  readonly rawRuntime: EnvironmentRuntime | null
  readonly ready: boolean
}) {
  const connection = useEnvironmentConnection({
    api,
    environment,
    runtime: rawRuntime,
    ...(onRuntime ? { onRuntime } : {}),
  })
  return (
    <ConnectionActionButton
      connection={connection}
      fallbackStatus={fallbackStatus}
      onConfigure={onConfigure}
      ready={ready}
      scope={{
        projectId: environment.projectId,
        environmentId: environment.environmentId,
      }}
      scopeLabel={`环境“${environment.name}”`}
      testId={`environment-connection-${environment.environmentId}`}
    />
  )
}

export function PluginConnectionRowAction({
  api,
  fallbackStatus,
  onConfigure,
  onRuntime,
  plugin,
  ready,
  runtime,
  scopeLabel,
}: {
  readonly api: AiOpsV2Api
  readonly fallbackStatus: WorkspaceReadStatus
  readonly onConfigure: () => void
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
  readonly plugin: PluginConnectionTarget
  readonly ready: boolean
  readonly runtime: EnvironmentRuntime | null
  readonly scopeLabel: string
}) {
  const connection = usePluginConnection({
    api,
    plugin,
    runtime,
    ...(onRuntime ? { onRuntime } : {}),
  })
  return (
    <ConnectionActionButton
      connection={connection}
      fallbackStatus={fallbackStatus}
      onConfigure={onConfigure}
      pluginInstanceId={plugin.pluginInstanceId}
      ready={ready}
      scope={{ projectId: plugin.projectId, environmentId: plugin.environmentId }}
      scopeLabel={`插件“${scopeLabel}”`}
      testId={`plugin-connection-${plugin.pluginInstanceId}`}
    />
  )
}
