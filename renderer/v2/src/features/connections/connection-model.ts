import type {
  ConnectionIntent,
  ConnectionIntentResult,
  EnvironmentRuntime,
  OpaqueData,
  PublicError,
} from "@/bridge/ai-ops-v2"

export type ConnectionPhase =
  | "connected"
  | "disconnected"
  | "connecting"
  | "disconnecting"
  | "partial"
  | "blocked"
  | "error"
  | "unknown"

export interface ConnectionScope {
  readonly projectId: string
  readonly environmentId: string
}

export interface RuntimeHostKeyChallenge {
  readonly challengeId: string
  readonly planId: string
  readonly operationId: string
  readonly expectedRevision: number
  readonly pluginInstanceId: string
  readonly host: string
  readonly port: number
  readonly fingerprint: string
  readonly algorithm: string
}

export interface ConnectionOperation {
  readonly ownerKey: string
  readonly requestId: string
  readonly intent: ConnectionIntent
  readonly sequence: number
  readonly planId: string | null
  readonly operationId: string | null
}

export interface ConnectionState {
  readonly ownerKey: string
  readonly phase: ConnectionPhase
  readonly runtime: EnvironmentRuntime | null
  readonly operation: ConnectionOperation | null
  readonly actions: readonly OpaqueData[]
  readonly challenge: RuntimeHostKeyChallenge | null
  readonly error: PublicError | null
}

export type PluginConnectionState = ConnectionState
export type EnvironmentConnectionState = ConnectionState

export type ConnectionActionKind =
  | "host-key"
  | "dependency"
  | "configuration"
  | "ownership"
  | "error"

export interface ConnectionActionSummary {
  readonly code: string
  readonly kind: ConnectionActionKind
  readonly title: string
  readonly rootPluginInstanceId: string | null
  readonly affectedCount: number
}

export interface ConnectionCancelTarget {
  readonly planId: string
  readonly operationId: string | null
}

export interface ConnectionCancelOperationInput {
  readonly active: ConnectionOperation | null
  readonly runtime: EnvironmentRuntime | null
  readonly scope: ConnectionScope
  readonly pluginInstanceId?: string
  readonly requestId: string
  readonly sequence: number
}

export interface EnvironmentRuntimeCounts {
  readonly total: number
  readonly connected: number
  readonly blocked: number
  readonly error: number
}

const KNOWN_PHASES = new Set<ConnectionPhase>([
  "connected",
  "disconnected",
  "connecting",
  "disconnecting",
  "partial",
  "blocked",
  "error",
])

const PHASE_ALIASES = new Map<string, ConnectionPhase>([
  ["reconnecting", "connecting"],
  ["waitingDependency", "blocked"],
  ["failed", "error"],
])

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string {
  return typeof record[key] === "string" ? String(record[key]).trim() : ""
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | null {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? Number(record[key])
    : null
}

function pluginRuntime(runtime: EnvironmentRuntime | null, pluginInstanceId: string) {
  if (!runtime) return {}
  return asRecord(asRecord(runtime.plugins)[pluginInstanceId])
}

export function connectionOwnerKey(
  scope: ConnectionScope,
  pluginInstanceId?: string,
): string {
  const environmentKey = `${scope.projectId}/${scope.environmentId}`
  return pluginInstanceId ? `${environmentKey}/${pluginInstanceId}` : environmentKey
}

export function runtimeMatchesEnvironmentScope(
  runtime: EnvironmentRuntime | null,
  scope: ConnectionScope,
): runtime is EnvironmentRuntime {
  return runtime?.projectId === scope.projectId
    && runtime.environmentId === scope.environmentId
}

export function normalizeConnectionPhase(value: unknown): ConnectionPhase {
  if (typeof value !== "string") return "unknown"
  if (KNOWN_PHASES.has(value as ConnectionPhase)) return value as ConnectionPhase
  return PHASE_ALIASES.get(value) ?? "unknown"
}

export function environmentPhaseFromRuntime(
  runtime: EnvironmentRuntime | null,
): ConnectionPhase {
  return runtime ? normalizeConnectionPhase(runtime.phase) : "unknown"
}

export function pluginPhaseFromRuntime(
  runtime: EnvironmentRuntime | null,
  pluginInstanceId: string,
): ConnectionPhase {
  if (!runtime) return "unknown"
  const plugin = pluginRuntime(runtime, pluginInstanceId)
  if (Object.keys(plugin).length > 0) return normalizeConnectionPhase(plugin.phase)
  return "unknown"
}

export function connectionPhaseFromRuntime(
  runtime: EnvironmentRuntime | null,
  pluginInstanceId?: string,
): ConnectionPhase {
  return pluginInstanceId
    ? pluginPhaseFromRuntime(runtime, pluginInstanceId)
    : environmentPhaseFromRuntime(runtime)
}

export function runtimeConnectionOwner(
  runtime: EnvironmentRuntime | null,
  scope: ConnectionScope,
  pluginInstanceId?: string,
): ConnectionCancelTarget | null {
  if (!runtimeMatchesEnvironmentScope(runtime, scope)) return null
  const runtimeRecord = asRecord(runtime)
  const environmentPlanId = readString(runtimeRecord, "connectAttemptId")
  if (!pluginInstanceId) {
    return environmentPlanId ? { planId: environmentPlanId, operationId: null } : null
  }
  const plugin = pluginRuntime(runtime, pluginInstanceId)
  const operationId = readString(plugin, "operationId")
  if (!operationId) return null
  const planId = readString(plugin, "planId") || environmentPlanId
  if (!planId) return null
  return {
    planId,
    operationId,
  }
}

export function resolveConnectionCancelTarget(
  active: ConnectionOperation | null,
  runtime: EnvironmentRuntime | null,
  scope: ConnectionScope,
  pluginInstanceId?: string,
): ConnectionCancelTarget | null {
  const expectedOwner = connectionOwnerKey(scope, pluginInstanceId)
  const observed = runtimeConnectionOwner(runtime, scope, pluginInstanceId)
  if (active?.ownerKey === expectedOwner && active.planId) {
    return {
      planId: active.planId,
      operationId: active.operationId
        ?? (observed?.planId === active.planId ? observed.operationId : null),
    }
  }
  return observed
}

export function supersedeWithConnectionCancel({
  active,
  runtime,
  scope,
  pluginInstanceId,
  requestId,
  sequence,
}: ConnectionCancelOperationInput): ConnectionOperation | null {
  const target = resolveConnectionCancelTarget(
    active,
    runtime,
    scope,
    pluginInstanceId,
  )
  if (!target) return null
  return {
    ownerKey: connectionOwnerKey(scope, pluginInstanceId),
    requestId,
    intent: "cancel",
    sequence,
    planId: target.planId,
    operationId: target.operationId,
  }
}

export function connectionOperationIsCurrent(
  active: ConnectionOperation | null,
  candidate: ConnectionOperation,
): boolean {
  return active !== null
    && active.ownerKey === candidate.ownerKey
    && active.requestId === candidate.requestId
    && active.intent === candidate.intent
    && active.sequence === candidate.sequence
}

export function runtimeHostKeyChallenge(
  result: ConnectionIntentResult,
  pluginInstanceId?: string,
): RuntimeHostKeyChallenge | null {
  for (const actionValue of result.actions) {
    const action = asRecord(actionValue)
    if (action.code !== "SSH_HOST_KEY_CONFIRM_REQUIRED") continue
    const rootPluginInstanceId = readString(action, "rootPluginInstanceId")
    const affected = Array.isArray(action.affectedPluginInstanceIds)
      ? action.affectedPluginInstanceIds.filter((value): value is string => typeof value === "string")
      : []
    if (pluginInstanceId
      && rootPluginInstanceId !== pluginInstanceId
      && !affected.includes(pluginInstanceId)) continue
    const challenge = asRecord(asRecord(action.details).hostKeyChallenge)
    const challengeId = readString(challenge, "challengeId")
    const planId = readString(challenge, "planId")
    const operationId = readString(challenge, "operationId")
    const expectedRevision = readNumber(challenge, "expectedRevision")
    const challengePluginInstanceId = readString(challenge, "pluginInstanceId")
      || rootPluginInstanceId
    const host = readString(challenge, "host")
    const port = readNumber(challenge, "port")
    const fingerprint = readString(challenge, "fingerprint")
    if (!challengeId || !planId || !operationId || !challengePluginInstanceId
      || expectedRevision === null || !Number.isInteger(expectedRevision) || expectedRevision < 0
      || !host || port === null || !Number.isInteger(port) || port < 1 || port > 65_535
      || !fingerprint) continue
    return {
      challengeId,
      planId,
      operationId,
      expectedRevision,
      pluginInstanceId: challengePluginInstanceId,
      host,
      port,
      fingerprint,
      algorithm: readString(challenge, "algorithm"),
    }
  }
  return null
}

export function connectionPlanFromChallengeConfirmation(
  value: unknown,
): ConnectionIntentResult | null {
  const plan = asRecord(asRecord(value).connectionPlan)
  const snapshot = asRecord(plan.snapshot)
  const actions = Array.isArray(plan.actions) ? plan.actions : null
  const outcome = readString(plan, "outcome")
  if (!outcome || !actions
    || !readString(snapshot, "projectId")
    || !readString(snapshot, "environmentId")
    || !readString(snapshot, "phase")
    || readNumber(snapshot, "sequence") === null
    || actions.some((action) => Object.keys(asRecord(action)).length === 0)) return null
  const planId = readString(plan, "planId")
  const operationId = readString(plan, "operationId")
  return {
    outcome,
    snapshot: snapshot as unknown as EnvironmentRuntime,
    actions: actions as readonly OpaqueData[],
    planId: planId || null,
    operationId: operationId || null,
  }
}

function actionPresentation(code: string): Pick<ConnectionActionSummary, "kind" | "title"> {
  if (code === "SSH_HOST_KEY_CONFIRM_REQUIRED") {
    return { kind: "host-key", title: "需要确认服务器指纹" }
  }
  if (code === "TUNNEL_PROVIDER_UNAVAILABLE" || code.includes("DEPENDENCY")) {
    return { kind: "dependency", title: "连接依赖尚未就绪" }
  }
  if (code === "PLUGIN_CONFIG_INCOMPLETE"
    || code === "CREDENTIAL_UNAVAILABLE"
    || code === "CREDENTIAL_BINDING_MISMATCH") {
    return { kind: "configuration", title: "插件配置需要处理" }
  }
  if (code === "CONNECTION_OPERATION_NOT_OWNED") {
    return { kind: "ownership", title: "当前窗口不拥有此连接操作" }
  }
  return { kind: "error", title: "连接操作需要处理" }
}

export function summarizeConnectionActions(
  actions: readonly OpaqueData[],
): readonly ConnectionActionSummary[] {
  return actions.flatMap((actionValue) => {
    const action = asRecord(actionValue)
    const code = readString(action, "code")
    if (!code) return []
    const affectedCount = Array.isArray(action.affectedPluginInstanceIds)
      ? action.affectedPluginInstanceIds.filter((value) => typeof value === "string").length
      : 0
    return [{
      code,
      ...actionPresentation(code),
      rootPluginInstanceId: readString(action, "rootPluginInstanceId") || null,
      affectedCount,
    }]
  })
}

export function runtimeDependencyCount(runtime: EnvironmentRuntime | null): number {
  if (!runtime) return 0
  const plugins = asRecord(runtime.plugins)
  return Object.values(plugins).filter((value) => {
    const plugin = asRecord(value)
    const phase = readString(plugin, "phase")
    const reason = readString(plugin, "reason")
    return phase === "waitingDependency"
      || phase === "blocked"
      || reason === "TUNNEL_PROVIDER_UNAVAILABLE"
      || reason.includes("DEPENDENCY")
  }).length
}

export function environmentRuntimeCounts(
  runtime: EnvironmentRuntime | null,
): EnvironmentRuntimeCounts {
  const counts: EnvironmentRuntimeCounts = {
    total: 0,
    connected: 0,
    blocked: 0,
    error: 0,
  }
  if (!runtime) return counts
  const plugins = Object.values(asRecord(runtime.plugins))
  return plugins.reduce<EnvironmentRuntimeCounts>((current, value) => {
    const phase = normalizeConnectionPhase(asRecord(value).phase)
    return {
      total: current.total + 1,
      connected: current.connected + (phase === "connected" ? 1 : 0),
      blocked: current.blocked + (phase === "blocked" ? 1 : 0),
      error: current.error + (phase === "error" ? 1 : 0),
    }
  }, counts)
}

export function initialConnectionState(ownerKey: string): ConnectionState {
  return {
    ownerKey,
    phase: "unknown",
    runtime: null,
    operation: null,
    actions: [],
    challenge: null,
    error: null,
  }
}

export function initialPluginConnectionState(ownerKey: string): PluginConnectionState {
  return initialConnectionState(ownerKey)
}

export function initialEnvironmentConnectionState(ownerKey: string): EnvironmentConnectionState {
  return initialConnectionState(ownerKey)
}

export function connectionResultMatches(
  active: ConnectionOperation | null,
  result: ConnectionIntentResult,
  ownerKey: string,
): boolean {
  if (!active || active.ownerKey !== ownerKey) return false
  if (active.planId !== null && result.planId !== active.planId) return false
  if (active.operationId !== null && result.operationId !== active.operationId) return false
  return true
}
