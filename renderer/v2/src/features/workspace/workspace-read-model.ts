import type { EnvironmentRuntime, PublicError } from "@/bridge/ai-ops-v2"

export type WorkspaceReadStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "partial"
  | "blocked"
  | "error"

export type WorkspacePluginType = "server" | "mysql" | "redis" | "unknown"
export type WorkspacePluginConfigState = "ready" | "draft" | "unknown"
export type WorkspaceRuntimePhase =
  | "blocked"
  | "connected"
  | "connecting"
  | "disconnected"
  | "disconnecting"
  | "error"
  | "failed"
  | "partial"
  | "reconnecting"
  | "waitingDependency"

export interface WorkspaceReadError {
  readonly code: string
  readonly message: string
}

export interface WorkspacePluginRuntimeReadModel {
  readonly pluginInstanceId: string
  readonly status: WorkspaceReadStatus
}

export interface EnvironmentRuntimeReadModel {
  readonly blockedCount: number
  readonly connectedCount: number
  readonly desiredConnected: boolean
  readonly draftCount: number
  readonly eligibleCount: number
  readonly environmentId: string
  readonly errorCount: number
  readonly phase: WorkspaceRuntimePhase
  readonly plugins: readonly WorkspacePluginRuntimeReadModel[]
  readonly pluginsPartial: boolean
  readonly projectId: string
  readonly sequence: number
  readonly status: WorkspaceReadStatus
}

export interface EnvironmentRuntimeValue {
  readonly data: EnvironmentRuntimeReadModel
  readonly raw: EnvironmentRuntime
}

export type EnvironmentRuntimeResolutionReason =
  | "accepted"
  | "invalid"
  | "stale"
  | "superseded"

export interface EnvironmentRuntimeResolution {
  readonly reason: EnvironmentRuntimeResolutionReason
  readonly value: EnvironmentRuntimeValue | null
}

export interface WorkspacePluginReadModel {
  readonly configState: WorkspacePluginConfigState
  readonly displayName: string
  readonly pluginInstanceId: string
  readonly pluginType: WorkspacePluginType
  readonly revision: number
  readonly status: WorkspaceReadStatus
}

export interface WorkspaceEnvironmentReadModel {
  readonly draftCount: number
  readonly environmentId: string
  readonly name: string
  readonly pluginCount: number
  readonly projectId: string
  readonly readyPluginCount: number
  readonly resourcePreview: readonly WorkspacePluginReadModel[]
  readonly resourcePreviewTruncated: boolean
  readonly revision: number
  readonly runtime: EnvironmentRuntimeReadModel
  readonly status: WorkspaceReadStatus
}

export interface WorkspaceProjectReadModel {
  readonly environmentCount: number
  readonly environments: readonly WorkspaceEnvironmentReadModel[]
  readonly isolated: boolean
  readonly name: string
  readonly pluginCount: number
  readonly projectId: string
  readonly revision: number
  readonly status: WorkspaceReadStatus
}

export interface WorkspaceReadModel {
  readonly projects: readonly WorkspaceProjectReadModel[]
}

export type WorkspaceRuntimeCache = ReadonlyMap<string, EnvironmentRuntimeReadModel>

export interface WorkspaceRuntimeCacheUpdate {
  readonly accepted: boolean
  readonly cache: WorkspaceRuntimeCache
}

type UnknownRecord = Readonly<Record<string, unknown>>

const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const MAX_DISPLAY_NAME_LENGTH = 256

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function scopeId(value: unknown): string | null {
  return typeof value === "string" && SCOPE_ID_PATTERN.test(value) ? value : null
}

function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return null
  return normalized.slice(0, MAX_DISPLAY_NAME_LENGTH)
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function pluginType(value: unknown): WorkspacePluginType {
  return value === "server" || value === "mysql" || value === "redis" ? value : "unknown"
}

function configState(value: unknown): WorkspacePluginConfigState {
  return value === "ready" || value === "draft" ? value : "unknown"
}

function runtimeStatus(value: unknown): WorkspaceReadStatus {
  switch (value) {
    case "connected":
      return "connected"
    case "connecting":
    case "reconnecting":
    case "disconnecting":
      return "connecting"
    case "partial":
      return "partial"
    case "blocked":
    case "waitingDependency":
      return "blocked"
    case "error":
    case "failed":
      return "error"
    default:
      return "disconnected"
  }
}

function runtimePhase(value: unknown): WorkspaceRuntimePhase {
  switch (value) {
    case "blocked":
    case "connected":
    case "connecting":
    case "disconnected":
    case "disconnecting":
    case "error":
    case "failed":
    case "partial":
    case "reconnecting":
    case "waitingDependency":
      return value
    default:
      return "disconnected"
  }
}

function primaryStatus(value: unknown): WorkspaceReadStatus {
  const primary = asRecord(value)
  const kind = primary?.kind
  switch (kind) {
    case "connected":
      return "connected"
    case "connecting":
    case "reconnecting":
    case "disconnecting":
    case "preparing":
    case "editing":
    case "saving":
    case "restoring":
      return "connecting"
    case "dependency-blocked":
    case "persistence-blocked":
    case "credential-recovery":
      return "blocked"
    case "connection-error":
      return "error"
    default:
      return "disconnected"
  }
}

function pluginStatus(value: UnknownRecord): WorkspaceReadStatus {
  const assessment = asRecord(value.assessment)
  if (assessment?.primaryStatus) return primaryStatus(assessment.primaryStatus)
  return runtimeStatus(assessment?.phase)
}

function normalizePlugin(value: unknown): WorkspacePluginReadModel | null {
  const source = asRecord(value)
  if (!source) return null
  const pluginInstanceId = scopeId(source.pluginInstanceId)
  const name = displayName(source.displayName)
  if (!pluginInstanceId || !name) return null
  return {
    configState: configState(source.configState),
    displayName: name,
    pluginInstanceId,
    pluginType: pluginType(source.pluginType),
    revision: nonNegativeInteger(source.revision),
    status: pluginStatus(source),
  }
}

function uniquePlugins(value: unknown): readonly WorkspacePluginReadModel[] {
  if (!Array.isArray(value)) return []
  const normalized = value.map(normalizePlugin).filter((item) => item !== null)
  const counts = new Map<string, number>()
  for (const item of normalized) {
    counts.set(item.pluginInstanceId, (counts.get(item.pluginInstanceId) ?? 0) + 1)
  }
  return normalized.filter((item) => counts.get(item.pluginInstanceId) === 1)
}

export function normalizeWorkspacePluginList(
  value: unknown,
  expectedScope: Readonly<{ projectId: string; environmentId: string }>,
): readonly WorkspacePluginReadModel[] {
  if (!Array.isArray(value)) return []
  const scoped = value.filter((candidate) => {
    const source = asRecord(candidate)
    return source?.projectId === expectedScope.projectId
      && source.environmentId === expectedScope.environmentId
  })
  return uniquePlugins(scoped)
}

function normalizeRuntimePlugin(
  pluginInstanceId: string,
  value: unknown,
): WorkspacePluginRuntimeReadModel | null {
  const source = asRecord(value)
  if (!source) return null
  const nestedId = source.pluginInstanceId
  if (nestedId !== undefined && nestedId !== pluginInstanceId) return null
  const assessment = asRecord(source.assessment)
  return {
    pluginInstanceId,
    status: assessment?.primaryStatus
      ? primaryStatus(assessment.primaryStatus)
      : runtimeStatus(source.phase),
  }
}

export function normalizeEnvironmentRuntime(
  value: unknown,
  expectedScope?: Readonly<{ projectId: string; environmentId: string }>,
): EnvironmentRuntimeReadModel | null {
  const source = asRecord(value)
  if (!source) return null
  const projectId = scopeId(source.projectId)
  const environmentId = scopeId(source.environmentId)
  if (!projectId || !environmentId) return null
  if (
    expectedScope &&
    (expectedScope.projectId !== projectId || expectedScope.environmentId !== environmentId)
  ) {
    return null
  }

  const runtimePlugins = asRecord(source.plugins)
  const plugins: WorkspacePluginRuntimeReadModel[] = []
  if (runtimePlugins) {
    for (const [rawId, plugin] of Object.entries(runtimePlugins)) {
      const pluginInstanceId = scopeId(rawId)
      if (!pluginInstanceId) continue
      const normalized = normalizeRuntimePlugin(pluginInstanceId, plugin)
      if (normalized) plugins.push(normalized)
    }
  }

  return {
    blockedCount: nonNegativeInteger(source.blockedCount),
    connectedCount: nonNegativeInteger(source.connectedCount),
    desiredConnected: booleanValue(source.desiredConnected),
    draftCount: nonNegativeInteger(source.draftCount),
    eligibleCount: nonNegativeInteger(source.eligibleCount),
    environmentId,
    errorCount: nonNegativeInteger(source.errorCount),
    phase: runtimePhase(source.phase),
    plugins,
    pluginsPartial: booleanValue(source.pluginsPartial),
    projectId,
    sequence: nonNegativeInteger(source.sequence),
    status: runtimeStatus(source.phase),
  }
}

function sameRuntimeScope(
  left: Readonly<{ projectId: string; environmentId: string }>,
  right: Readonly<{ projectId: string; environmentId: string }>,
): boolean {
  return left.projectId === right.projectId
    && left.environmentId === right.environmentId
}

export function mergeEnvironmentRuntimeReadModel(
  incoming: EnvironmentRuntimeReadModel,
  current: EnvironmentRuntimeReadModel | null,
): EnvironmentRuntimeReadModel {
  if (
    !incoming.pluginsPartial
    || !current
    || current.pluginsPartial
    || !sameRuntimeScope(incoming, current)
  ) return incoming

  const plugins = new Map(
    current.plugins.map((plugin) => [plugin.pluginInstanceId, plugin]),
  )
  for (const plugin of incoming.plugins) plugins.set(plugin.pluginInstanceId, plugin)
  return {
    ...current,
    ...incoming,
    plugins: [...plugins.values()],
    pluginsPartial: false,
  }
}

export function mergeEnvironmentRuntimeSnapshot(
  incoming: EnvironmentRuntime,
  current: EnvironmentRuntime | null,
): EnvironmentRuntime {
  if (
    incoming.pluginsPartial !== true
    || !current
    || current.pluginsPartial === true
    || !sameRuntimeScope(incoming, current)
  ) return incoming

  return {
    ...current,
    ...incoming,
    plugins: {
      ...(asRecord(current.plugins) ?? {}),
      ...(asRecord(incoming.plugins) ?? {}),
    },
    pluginsPartial: false,
  }
}

function mergeEnvironmentRuntimeValue(
  incoming: EnvironmentRuntimeValue,
  current: EnvironmentRuntimeValue | null,
): EnvironmentRuntimeValue {
  return {
    data: mergeEnvironmentRuntimeReadModel(incoming.data, current?.data ?? null),
    raw: mergeEnvironmentRuntimeSnapshot(incoming.raw, current?.raw ?? null),
  }
}

function scopedRuntimeValue(
  value: unknown,
  expectedScope: Readonly<{ projectId: string; environmentId: string }>,
): EnvironmentRuntimeValue | null {
  const source = asRecord(value)
  if (
    !source
    || typeof source.phase !== "string"
    || !Number.isSafeInteger(source.sequence)
    || Number(source.sequence) < 0
  ) return null
  const data = normalizeEnvironmentRuntime(value, expectedScope)
  if (!data) return null
  return { data, raw: value as EnvironmentRuntime }
}

export function resolveEnvironmentRuntimeEvent(
  value: unknown,
  expectedScope: Readonly<{ projectId: string; environmentId: string }>,
  current: EnvironmentRuntimeValue | null,
): EnvironmentRuntimeResolution {
  const incoming = scopedRuntimeValue(value, expectedScope)
  if (!incoming) return { reason: "invalid", value: current }
  const scopedCurrent = current && sameRuntimeScope(current.data, expectedScope)
    ? current
    : null
  if (scopedCurrent && incoming.data.sequence < scopedCurrent.data.sequence) {
    return { reason: "stale", value: scopedCurrent }
  }
  return {
    reason: "accepted",
    value: mergeEnvironmentRuntimeValue(incoming, scopedCurrent),
  }
}

export function resolveEnvironmentRuntimePoll(
  value: unknown,
  expectedScope: Readonly<{ projectId: string; environmentId: string }>,
  current: EnvironmentRuntimeValue | null,
  sequenceAtStart: number,
): EnvironmentRuntimeResolution {
  const scopedCurrent = current && sameRuntimeScope(current.data, expectedScope)
    ? current
    : null
  const incoming = scopedRuntimeValue(value, expectedScope)
  if (!incoming) {
    return {
      reason: scopedCurrent && scopedCurrent.data.sequence !== sequenceAtStart
        ? "superseded"
        : "invalid",
      value: scopedCurrent,
    }
  }
  if (scopedCurrent && incoming.data.sequence < scopedCurrent.data.sequence) {
    return { reason: "stale", value: scopedCurrent }
  }
  return {
    reason: "accepted",
    value: mergeEnvironmentRuntimeValue(incoming, scopedCurrent),
  }
}

function emptyRuntime(projectId: string, environmentId: string): EnvironmentRuntimeReadModel {
  return {
    blockedCount: 0,
    connectedCount: 0,
    desiredConnected: false,
    draftCount: 0,
    eligibleCount: 0,
    environmentId,
    errorCount: 0,
    phase: "disconnected",
    plugins: [],
    pluginsPartial: true,
    projectId,
    sequence: 0,
    status: "disconnected",
  }
}

function normalizeEnvironment(
  value: unknown,
  projectId: string,
): WorkspaceEnvironmentReadModel | null {
  const source = asRecord(value)
  if (!source) return null
  const nestedProjectId = scopeId(source.projectId)
  const environmentId = scopeId(source.environmentId)
  const name = displayName(source.name)
  if (nestedProjectId !== projectId || !environmentId || !name) return null
  const resourcePreview = uniquePlugins(source.resourcePreview)
  const runtime =
    normalizeEnvironmentRuntime(source.runtime, { projectId, environmentId }) ??
    emptyRuntime(projectId, environmentId)
  const pluginCount = nonNegativeInteger(source.pluginCount, resourcePreview.length)
  const readyPluginCount = Math.min(
    pluginCount,
    nonNegativeInteger(source.readyPluginCount),
  )
  return {
    draftCount: Math.max(
      0,
      nonNegativeInteger(source.draftCount, pluginCount - readyPluginCount),
    ),
    environmentId,
    name,
    pluginCount,
    projectId,
    readyPluginCount,
    resourcePreview,
    resourcePreviewTruncated: booleanValue(source.resourcePreviewTruncated),
    revision: nonNegativeInteger(source.revision),
    runtime,
    status: runtime.status,
  }
}

function uniqueEnvironments(value: unknown, projectId: string): readonly WorkspaceEnvironmentReadModel[] {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((environment) => normalizeEnvironment(environment, projectId))
    .filter((environment) => environment !== null)
  const counts = new Map<string, number>()
  for (const environment of normalized) {
    counts.set(
      environment.environmentId,
      (counts.get(environment.environmentId) ?? 0) + 1,
    )
  }
  return normalized.filter(
    (environment) => counts.get(environment.environmentId) === 1,
  )
}

function aggregateProjectStatus(
  environments: readonly WorkspaceEnvironmentReadModel[],
  isolated: boolean,
): WorkspaceReadStatus {
  if (isolated) return "error"
  const statuses = environments.map((environment) => environment.status)
  if (statuses.includes("error")) return "error"
  if (statuses.includes("blocked")) return "blocked"
  if (statuses.includes("partial")) return "partial"
  if (statuses.includes("connecting")) return "connecting"
  if (statuses.length > 0 && statuses.every((status) => status === "connected")) {
    return "connected"
  }
  if (statuses.includes("connected")) return "partial"
  return "disconnected"
}

function normalizeProject(value: unknown): WorkspaceProjectReadModel | null {
  const source = asRecord(value)
  if (!source) return null
  const projectId = scopeId(source.projectId)
  const name = displayName(source.name)
  if (!projectId || !name) return null
  const isolated = asRecord(source.configurationError) !== null
  const environments = isolated ? [] : uniqueEnvironments(source.environments, projectId)
  const pluginCount = isolated
    ? 0
    : nonNegativeInteger(
        source.pluginCount,
        environments.reduce((total, environment) => total + environment.pluginCount, 0),
      )
  return {
    environmentCount: isolated
      ? 0
      : nonNegativeInteger(source.environmentCount, environments.length),
    environments,
    isolated,
    name,
    pluginCount,
    projectId,
    revision: nonNegativeInteger(source.revision),
    status: aggregateProjectStatus(environments, isolated),
  }
}

export function normalizeWorkspaceOverview(value: unknown): WorkspaceReadModel {
  if (!Array.isArray(value)) return { projects: [] }
  const normalized = value.map(normalizeProject).filter((project) => project !== null)
  const counts = new Map<string, number>()
  for (const project of normalized) {
    counts.set(project.projectId, (counts.get(project.projectId) ?? 0) + 1)
  }
  return {
    projects: normalized.filter((project) => counts.get(project.projectId) === 1),
  }
}

export function workspaceRuntimeScopeKey(
  projectId: string,
  environmentId: string,
): string {
  return `${projectId}/${environmentId}`
}

function navigationRuntime(
  environment: WorkspaceEnvironmentReadModel,
  runtime: EnvironmentRuntimeReadModel,
): EnvironmentRuntimeReadModel {
  const visiblePluginIds = new Set(
    environment.resourcePreview.map((plugin) => plugin.pluginInstanceId),
  )
  return {
    ...runtime,
    plugins: runtime.plugins.filter((plugin) =>
      visiblePluginIds.has(plugin.pluginInstanceId),
    ),
  }
}

/**
 * Keeps only exact scopes that still exist in the current workspace. The cache
 * deliberately stores the normalized read model and only plugin statuses that
 * are already represented by the bounded workspace resource preview.
 */
export function reconcileWorkspaceRuntimeCache(
  workspace: WorkspaceReadModel | null,
  current: WorkspaceRuntimeCache,
): WorkspaceRuntimeCache {
  const next = new Map<string, EnvironmentRuntimeReadModel>()
  for (const project of workspace?.projects ?? []) {
    for (const environment of project.environments) {
      const key = workspaceRuntimeScopeKey(project.projectId, environment.environmentId)
      const cached = current.get(key)
      const baseline = navigationRuntime(environment, environment.runtime)
      let selected = baseline
      if (cached && sameRuntimeScope(cached, baseline)) {
        if (cached.sequence > baseline.sequence) {
          selected = cached
        } else {
          selected = mergeEnvironmentRuntimeReadModel(baseline, cached)
        }
      }
      next.set(key, navigationRuntime(environment, selected))
    }
  }
  return next
}

export function acceptWorkspaceRuntimeEvent(
  workspace: WorkspaceReadModel | null,
  current: WorkspaceRuntimeCache,
  value: unknown,
): WorkspaceRuntimeCacheUpdate {
  const cache = reconcileWorkspaceRuntimeCache(workspace, current)
  const source = asRecord(value)
  const projectId = scopeId(source?.projectId)
  const environmentId = scopeId(source?.environmentId)
  if (!projectId || !environmentId) return { accepted: false, cache }

  const project = workspace?.projects.find((candidate) => candidate.projectId === projectId)
  const environment = project?.environments.find(
    (candidate) => candidate.environmentId === environmentId,
  )
  if (!project || !environment) return { accepted: false, cache }

  const incoming = scopedRuntimeValue(value, { projectId, environmentId })
  if (!incoming) return { accepted: false, cache }
  const key = workspaceRuntimeScopeKey(projectId, environmentId)
  const previous = cache.get(key) ?? null
  if (previous && incoming.data.sequence < previous.sequence) {
    return { accepted: false, cache }
  }

  const next = new Map(cache)
  next.set(
    key,
    navigationRuntime(
      environment,
      mergeEnvironmentRuntimeReadModel(
        navigationRuntime(environment, incoming.data),
        previous,
      ),
    ),
  )
  return { accepted: true, cache: next }
}

/** Applies normalized status fields only; no raw runtime event reaches navigation. */
export function overlayWorkspaceRuntimeStatuses(
  projects: readonly WorkspaceProjectReadModel[],
  cache: WorkspaceRuntimeCache,
): readonly WorkspaceProjectReadModel[] {
  return projects.map((project) => {
    const environments = project.environments.map((environment) => {
      const runtime = cache.get(
        workspaceRuntimeScopeKey(project.projectId, environment.environmentId),
      )
      if (!runtime || !sameRuntimeScope(runtime, environment)) return environment
      const pluginStatuses = new Map(
        runtime.plugins.map((plugin) => [plugin.pluginInstanceId, plugin.status]),
      )
      return {
        ...environment,
        resourcePreview: environment.resourcePreview.map((plugin) => ({
          ...plugin,
          status: pluginStatuses.get(plugin.pluginInstanceId) ?? plugin.status,
        })),
        runtime,
        status: runtime.status,
      }
    })
    return {
      ...project,
      environments,
      status: aggregateProjectStatus(environments, project.isolated),
    }
  })
}

export function createWorkspaceReadError(
  operation: "workspace" | "environment-status",
  error?: PublicError | unknown,
): WorkspaceReadError {
  const source = asRecord(error)
  const candidateCode = source?.code
  const code =
    typeof candidateCode === "string" && SAFE_ERROR_CODE_PATTERN.test(candidateCode)
      ? candidateCode
      : operation === "workspace"
        ? "WORKSPACE_READ_FAILED"
        : "ENVIRONMENT_STATUS_READ_FAILED"
  return {
    code,
    message:
      operation === "workspace"
        ? "无法读取工作区。请重试。"
        : "无法读取环境状态。请重试。",
  }
}

export function workspaceStatusLabel(status: WorkspaceReadStatus): string {
  const labels: Record<WorkspaceReadStatus, string> = {
    blocked: "已阻塞",
    connected: "已连接",
    connecting: "连接中",
    disconnected: "未连接",
    error: "错误",
    partial: "部分可用",
  }
  return labels[status]
}

export function pluginTypeLabel(type: WorkspacePluginType): string {
  const labels: Record<WorkspacePluginType, string> = {
    mysql: "MySQL",
    redis: "Redis",
    server: "Server",
    unknown: "未知类型",
  }
  return labels[type]
}
