import {
  ArrowClockwise,
  GearSix,
  LinkBreak,
  LinkSimple,
  Plugs,
  SpinnerGap,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react"
import { useRef } from "react"

import type { AiOpsV2Api, EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { summarizeConnectionActions, type ConnectionPhase } from "@/features/connections/connection-model"
import { pluginTypeLabel } from "@/features/workspace/workspace-read-model"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table"
import { RuntimeHostKeyDialog } from "@/features/connections/RuntimeHostKeyDialog"
import { usePluginConnection } from "@/features/connections/use-plugin-connection"
import {
  pluginDraftFromRecord,
  type PluginConfigurationRecord,
} from "@/features/plugins/plugin-types"

interface PluginConnectionPanelProps {
  readonly api: AiOpsV2Api
  readonly plugin: PluginConfigurationRecord
  readonly runtime?: EnvironmentRuntime | null
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
  readonly onEdit: () => void
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

const AUTH_COPY: Readonly<Record<string, string>> = {
  password: "密码",
  privateKey: "私钥",
  agent: "SSH 密钥代理",
}

const ADDRESS_COPY: Readonly<Record<string, string>> = {
  ipv4Preferred: "IPv4 优先",
  ipv4Only: "仅 IPv4",
  ipv6Preferred: "IPv6 优先",
  ipv6Only: "仅 IPv6",
}

const TRANSPORT_COPY: Readonly<Record<string, string>> = {
  direct: "直接连接",
  serverTunnel: "服务器隧道",
  windowsVpn: "Windows VPN",
}

const TLS_COPY: Readonly<Record<string, string>> = {
  disabled: "关闭",
  preferred: "加密，不校验证书",
  required: "必须加密",
  verifyIdentity: "加密并校验身份",
}

function enumLabel(value: string | undefined, labels: Readonly<Record<string, string>>, fallback: string): string {
  return value ? labels[value] ?? fallback : fallback
}

function connectionGuidance(phase: ConnectionPhase, configReady: boolean) {
  if (phase === "connecting") {
    return { title: "正在建立连接", description: "可在此查看进度或取消本次连接。连接完成前无法修改配置。" }
  }
  if (phase === "disconnecting") {
    return { title: "正在断开连接", description: "请等待连接断开后再进行其他操作。" }
  }
  if (phase === "connected") {
    return { title: "插件已连接", description: "当前连接可供已授权的 Agent 能力使用；断开后将停止使用此连接。" }
  }
  if (!configReady) {
    return { title: "先完善连接配置", description: "当前配置还不能建立正式连接。请修改并验证配置后，再手动连接。" }
  }
  if (phase === "partial") {
    return { title: "部分能力可用", description: "连接未完全就绪，请检查依赖和配置后重试。" }
  }
  if (phase === "blocked") {
    return { title: "连接被阻止", description: "请检查凭据、上游 Server 或网络路径；依赖不会被自动绕过。" }
  }
  if (phase === "error") {
    return { title: "连接失败，需要处理", description: "请查看失败原因后重试。失败不会触发自动重连或配置变更。" }
  }
  if (phase === "unknown") {
    return { title: "连接状态尚未确认", description: "当前没有可用的连接状态，请刷新后核对；打开页面不会自动连接。" }
  }
  return { title: "等待手动连接", description: "配置已保存。首次连接必须由用户明确触发，打开页面不会自动联网。" }
}

export function PluginConnectionPanel({
  api,
  plugin,
  runtime = null,
  onRuntime,
  onEdit,
}: PluginConnectionPanelProps) {
  const connectionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const connection = usePluginConnection({
    api,
    plugin,
    runtime,
    ...(onRuntime ? { onRuntime } : {}),
  })
  const draft = pluginDraftFromRecord(plugin)
  const phase = PHASE_COPY[connection.state.phase]
  const activeIntent = connection.state.operation?.intent ?? null
  const busy = activeIntent !== null
  const actions = summarizeConnectionActions(connection.state.actions)
    .filter((action) => action.kind !== "host-key")
  const configReady = plugin.configState === "ready"
  const guidance = connectionGuidance(connection.state.phase, configReady)
  const editingBlocked = busy
    || connection.state.phase === "connecting"
    || connection.state.phase === "disconnecting"
    || connection.state.challenge !== null
  const statusRailTone = connection.state.phase === "error"
    ? "bg-danger"
    : connection.state.phase === "partial" || connection.state.phase === "blocked" || !configReady
      ? "bg-warning"
      : connection.state.phase === "connected" ? "bg-success" : "bg-primary"
  const facts = draft.pluginType === "server"
    ? [
        ["SSH 目标", `${draft.auth.username || "未配置"}@${draft.target.host}:${draft.target.port}`],
        ["认证方式", enumLabel(draft.auth.type, AUTH_COPY, "密码")],
        ["地址策略", enumLabel(draft.target.addressFamily, ADDRESS_COPY, "地址策略未知")],
        ["主机指纹", draft.target.hostKeyFingerprint || "首次连接时确认"],
      ]
    : [
        ["服务端点", `${draft.target.host}:${draft.target.port}`],
        [draft.pluginType === "mysql" ? "固定数据库" : "Logical DB", draft.pluginType === "mysql"
          ? draft.target.database || "未选择"
          : String(draft.target.db ?? 0)],
        ["连接路径", enumLabel(draft.transport?.kind, TRANSPORT_COPY, "直接连接")],
        ["TLS", enumLabel(draft.tls?.mode, TLS_COPY, "关闭")],
      ]

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
              label: "断开",
              icon: LinkBreak,
              run: connection.disconnect,
              variant: "outline" as const,
              disabled: busy,
              pending: busy,
            }
          : ["error", "blocked", "partial"].includes(connection.state.phase)
            ? {
                label: "重试",
                icon: ArrowClockwise,
                run: connection.retry,
                variant: "default" as const,
                disabled: busy,
                pending: busy,
              }
            : {
                label: "连接",
                icon: LinkSimple,
                run: connection.connect,
                variant: "default" as const,
                disabled: busy,
                pending: busy,
              }
  const PrimaryIcon = primaryAction.icon

  return (
    <section aria-labelledby="plugin-connection-title" className="space-y-4 @container/plugin-connection" data-testid="plugin-connection-panel">
      <Card className="relative gap-0 overflow-hidden py-0" data-status={connection.state.phase} data-testid="plugin-status-console">
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${statusRailTone}`} data-testid="plugin-status-rail" />
        <CardContent className="space-y-4 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted-foreground">
              {editingBlocked
                ? <SpinnerGap aria-hidden="true" className="animate-spin" size={18} />
                : <Plugs aria-hidden="true" size={18} />}
            </span>
            <div className="min-w-0 space-y-1">
              <div aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-2" role="status">
                <h3 className="text-sm font-semibold" id="plugin-connection-title">{guidance.title}</h3>
                <Badge variant={phase.variant}>{phase.label}</Badge>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{guidance.description}</p>
            </div>
          </div>
          <ButtonGroup aria-label="插件连接操作" className="max-w-full @sm/plugin-connection:ml-12" data-testid="plugin-overview-actions">
            <Button
              data-testid="plugin-connection-primary"
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
            <Button data-testid="plugin-action-edit" disabled={editingBlocked} onClick={onEdit} size="sm" type="button" variant="outline">
              <GearSix aria-hidden="true" />
              修改配置
            </Button>
          </ButtonGroup>

          {connection.state.error && !connection.state.challenge ? (
            <Alert variant="destructive">
              <XCircle aria-hidden="true" weight="fill" />
              <AlertTitle>连接操作失败</AlertTitle>
              <AlertDescription>{connection.state.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {actions.map((action, index) => (
            <Alert
              data-testid={`plugin-connection-action-${action.kind}`}
              key={`${action.code}/${action.rootPluginInstanceId ?? plugin.pluginInstanceId}/${index}`}
              variant={action.kind === "error" ? "destructive" : "default"}
            >
              <WarningCircle aria-hidden="true" />
              <AlertTitle>{action.title}</AlertTitle>
              <AlertDescription>请核对当前插件的配置、凭据状态与连接依赖后重试。</AlertDescription>
            </Alert>
          ))}
        </CardContent>
      </Card>

      <Card aria-labelledby="plugin-config-title" className="gap-0 overflow-hidden py-0" data-testid="plugin-fact-strip">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <CardTitle><h3 className="text-xs font-semibold" id="plugin-config-title">配置摘要</h3></CardTitle>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">{pluginTypeLabel(draft.pluginType)}</Badge>
            <Badge variant={configReady ? "success" : "warning"}>
              {configReady ? "配置完整" : plugin.configState === "draft" ? "待完善" : "配置未知"}
            </Badge>
            <span className="text-[11px] text-muted-foreground">配置修订 {plugin.revision}</span>
          </div>
        </CardHeader>
        <CardContent className="p-3">
          <ItemGroup className="gap-2 @md/plugin-connection:hidden" aria-label="插件连接配置摘要">
            {facts.map(([label, value]) => (
              <Item className="min-w-0 bg-surface-inset" key={label} role="listitem" size="xs" variant="muted">
                <ItemContent>
                  <ItemDescription>{label}</ItemDescription>
                  <ItemTitle className="line-clamp-none w-full break-all font-mono text-xs">{value}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
          <div className="hidden @md/plugin-connection:block">
            <Table aria-label="插件连接配置摘要">
              <TableBody>
                {facts.map(([label, value]) => (
                  <TableRow key={label}>
                    <TableHead className="w-32 text-xs font-normal text-muted-foreground" scope="row">{label}</TableHead>
                    <TableCell className="font-mono text-xs whitespace-normal break-all">{value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <RuntimeHostKeyDialog
        onReject={connection.rejectHostKey}
        onTrust={connection.trustHostKey}
        returnFocusRef={connectionTriggerRef}
        state={connection.state}
        testId="runtime-host-key-confirmation"
      />
    </section>
  )
}
