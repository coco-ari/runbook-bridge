import type { EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { normalizeConnectionPhase } from "../connections/connection-model.ts"
import {
  normalizeEnvironmentRuntime,
  type WorkspaceEnvironmentReadModel,
  type WorkspacePluginReadModel,
  type WorkspaceReadStatus,
} from "../workspace/workspace-read-model.ts"

export interface EnvironmentDetailRow {
  readonly plugin: WorkspacePluginReadModel
  readonly status: WorkspaceReadStatus
  readonly description: string
  readonly providerName: string | null
}

export interface EnvironmentDetailModel {
  readonly rows: readonly EnvironmentDetailRow[]
  readonly summary: Readonly<{
    total: number
    connected: number
    draft: number
    waitingDependency: number
    error: number
  }>
  readonly partial: boolean
}

type RecordValue = Readonly<Record<string, unknown>>

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function nodeMatchesScope(
  node: RecordValue,
  environment: WorkspaceEnvironmentReadModel,
  pluginInstanceId: string,
): boolean {
  if ((node.pluginInstanceId !== undefined && node.pluginInstanceId !== pluginInstanceId)
    || (node.projectId !== undefined && node.projectId !== environment.projectId)
    || (node.environmentId !== undefined && node.environmentId !== environment.environmentId)) return false
  for (const scope of [node.scope, record(node.assessment)?.scope]) {
    if (scope === undefined) continue
    const value = record(scope)
    if (value?.projectId !== environment.projectId
      || value.environmentId !== environment.environmentId
      || value.pluginInstanceId !== pluginInstanceId) return false
  }
  return true
}

function statusDescription(status: WorkspaceReadStatus): string {
  switch (status) {
    case "connected": return "已连接。"
    case "connecting": return "正在连接。"
    case "blocked": return "连接被阻塞，请查看插件详情。"
    case "error": return "连接失败，请查看插件详情后重试。"
    case "partial": return "连接状态尚未完整更新。"
    default: return "等待手动连接。"
  }
}

function nodeStatus(node: RecordValue, normalized: WorkspaceReadStatus): WorkspaceReadStatus {
  switch (normalizeConnectionPhase(node.phase)) {
    case "unknown": return "disconnected"
    case "connecting":
    case "disconnecting": return "connecting"
    case "blocked": return "blocked"
    case "error": return "error"
    case "partial": return "partial"
    case "disconnected": return normalized === "connected" ? "disconnected" : normalized
    default: return normalized
  }
}

function nodeDescription(
  node: RecordValue,
  status: WorkspaceReadStatus,
  providerName: string | null,
): string {
  const phase = normalizeConnectionPhase(node.phase)
  if (phase === "unknown") return "连接状态未知，请重新读取。"
  if (phase === "disconnecting") return "正在断开连接。"
  if (status === "connected") return "已连接。"
  if (phase === "connecting") {
    return node.phase === "reconnecting" ? "正在重新连接。" : "正在连接。"
  }

  const primaryKind = record(record(node.assessment)?.primaryStatus)?.kind
  if (primaryKind === "credential-recovery") return "凭据不可用，请在插件详情中处理。"
  if (primaryKind === "persistence-blocked") return "配置存储需要恢复，请查看插件详情。"
  if (primaryKind === "needs-configuration" || primaryKind === "draft") return "配置未完善，请修改插件配置。"
  if (node.phase === "waitingDependency" || node.reason === "TUNNEL_PROVIDER_UNAVAILABLE"
    || primaryKind === "dependency-blocked") {
    return providerName ? "等待 Server 依赖连接。" : "等待 Server 依赖，依赖插件暂不可用。"
  }

  switch (node.reason) {
    case "PLUGIN_CONFIG_INCOMPLETE": return "配置未完善，请修改插件配置。"
    case "SSH_HOST_KEY_CONFIRM_REQUIRED": return "需要确认服务器指纹。"
    case "SSH_HOST_KEY_CHANGED": return "服务器指纹已变化，请核对后重新连接。"
    case "CREDENTIAL_UNAVAILABLE":
    case "CREDENTIAL_BINDING_MISMATCH": return "凭据不可用，请在插件详情中处理。"
    case "AUTHENTICATION_FAILED":
    case "SSH_AUTH_FAILED": return "身份验证失败，请检查插件凭据。"
    case "USER_DISCONNECTED": return "已手动断开。"
    case "CONNECT_CANCELLED": return "连接已取消。"
    case "CONFIGURATION_EDIT": return "正在修改连接配置。"
    case "MANUAL_RECONNECT_REQUIRED": return "需要手动重新连接。"
    case "NETWORK_RECONNECTING": return "正在重新连接。"
    case undefined:
    case null:
    case "": return statusDescription(status)
    default: return status === "error"
      ? statusDescription(status)
      : "连接状态需要重新确认，请查看插件详情。"
  }
}

export function buildEnvironmentDetailModel({
  environment,
  plugins,
  runtime,
}: Readonly<{
  environment: WorkspaceEnvironmentReadModel
  plugins: readonly WorkspacePluginReadModel[] | null
  runtime: EnvironmentRuntime | null
}>): EnvironmentDetailModel {
  // Plugin inputs have already passed the workspace read model's exact-scope allowlist.
  const catalog = plugins ?? environment.resourcePreview
  const directory = new Map(catalog.map((plugin) => [plugin.pluginInstanceId, plugin]))
  const normalized = normalizeEnvironmentRuntime(runtime, environment)
  const rawPlugins = normalized ? record(runtime?.plugins) : null
  const nodes = new Map<string, Readonly<{ raw: RecordValue; status: WorkspaceReadStatus }>>()
  for (const plugin of normalized?.plugins ?? []) {
    const raw = record(rawPlugins?.[plugin.pluginInstanceId])
    if (raw && nodeMatchesScope(raw, environment, plugin.pluginInstanceId)) {
      nodes.set(plugin.pluginInstanceId, { raw, status: nodeStatus(raw, plugin.status) })
    }
  }

  const rows = catalog.map<EnvironmentDetailRow>((plugin) => {
    const node = nodes.get(plugin.pluginInstanceId)
    if (!node) {
      const description = plugin.configState === "draft"
        ? "配置未完善，请修改插件配置。"
        : plugin.configState === "unknown"
          ? "配置状态未知，请重新读取。"
          : statusDescription(plugin.status)
      return {
        plugin,
        status: plugin.status,
        description: runtime ? `${description} 状态尚未更新。` : description,
        providerName: null,
      }
    }
    const providerId = node.raw.providerPluginInstanceId
    const provider = typeof providerId === "string" && providerId !== plugin.pluginInstanceId
      ? directory.get(providerId)
      : undefined
    const providerName = provider?.pluginType === "server" ? provider.displayName : null
    return {
      plugin,
      status: node.status,
      description: nodeDescription(node.raw, node.status, providerName),
      providerName,
    }
  })

  const total = plugins === null ? environment.pluginCount : plugins.length
  const cached = environment.runtime.projectId === environment.projectId
    && environment.runtime.environmentId === environment.environmentId ? environment.runtime : null
  const aggregate = (key: "connectedCount" | "errorCount", fallback: number) => {
    const incoming = normalized ? count(runtime?.[key]) : null
    return Math.min(total, incoming ?? count(cached?.[key]) ?? fallback)
  }
  const waiting = rows.filter((row) => {
    const node = nodes.get(row.plugin.pluginInstanceId)
    if (!node || normalizeConnectionPhase(node.raw.phase) === "unknown"
      || node.status === "connected") return false
    return node.raw.phase === "waitingDependency"
      || node.raw.reason === "TUNNEL_PROVIDER_UNAVAILABLE"
      || record(record(node.raw.assessment)?.primaryStatus)?.kind === "dependency-blocked"
  }).length
  const listPartial = plugins === null
    && (environment.resourcePreviewTruncated || catalog.length < environment.pluginCount)
  const runtimePartial = normalized
    ? normalized.pluginsPartial || nodes.size !== normalized.plugins.length
      || Object.keys(rawPlugins ?? {}).length !== nodes.size
      || rows.some((row) => !nodes.has(row.plugin.pluginInstanceId))
    : runtime !== null || cached?.pluginsPartial === true

  return {
    rows,
    summary: {
      total,
      connected: aggregate("connectedCount", rows.filter((row) => row.status === "connected").length),
      draft: Math.min(total, plugins === null
        ? Math.max(environment.draftCount, count(normalized ? runtime?.draftCount : null) ?? 0)
        : plugins.filter((plugin) => plugin.configState !== "ready").length),
      waitingDependency: waiting,
      error: aggregate("errorCount", rows.filter((row) => row.status === "error").length),
    },
    partial: listPartial || runtimePartial,
  }
}
