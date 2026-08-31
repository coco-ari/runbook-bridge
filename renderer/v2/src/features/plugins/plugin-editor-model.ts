import type {
  CredentialStatusData,
  OpaqueData,
  PluginEditPreparation,
  PluginDatabaseListData,
  PluginRecord,
  ProgressRecord,
  PublicError,
} from "@/bridge/ai-ops-v2"
import {
  emptyCredentialDraft,
  type PluginCredentialDraft,
  type PluginFormDraft,
  type PluginFormIssue,
} from "./plugin-types.ts"

export type PluginEditorPhase =
  | "closed"
  | "preparing"
  | "impact-confirmation"
  | "editing"
  | "validating"
  | "saving"
  | "error"

export interface PluginValidationState {
  readonly requestId: string
  readonly purpose: string
  readonly draftGeneration: number
  readonly sequence: number
  readonly editSessionId?: string
  readonly operationId?: string
  readonly configDigest?: string
  readonly state: "running" | "awaiting-confirmation" | "valid" | "failed" | "cancelled" | "stale"
  readonly result?: OpaqueData
  readonly error?: PublicError
}

export interface HostKeyChallenge {
  readonly host: string
  readonly port: number
  readonly fingerprint: string
  readonly algorithm: string
}

export interface PluginEditorConfirmation {
  readonly kind: "edit-impact" | "host-key" | "disable-tls" | "credential-replacement"
  readonly title: string
  readonly description: string
  readonly hostKey?: HostKeyChallenge
}

export interface PluginEditorState {
  readonly ownerKey: string
  readonly phase: PluginEditorPhase
  readonly draft: PluginFormDraft
  readonly credentials: PluginCredentialDraft
  readonly credentialStatus: CredentialStatusData | null
  readonly issues: readonly PluginFormIssue[]
  readonly validation: PluginValidationState | null
  readonly preparation: PluginEditPreparation | null
  readonly editSessionId: string | null
  readonly confirmation: PluginEditorConfirmation | null
  readonly databases: readonly string[]
  readonly databasesLoading: boolean
  readonly databasesTruncated: boolean
  readonly error: PublicError | null
  readonly draftGeneration: number
  readonly sequence: number
}

export interface PluginSaveOutcome {
  readonly plugin: PluginRecord | null
  readonly runtimeWarning: boolean
  readonly persistenceRecoveryPending: boolean
  readonly manualReconnectRequired: boolean
  readonly saveStrategy?: "disconnect" | "connect-current" | "restore-previous"
}

export interface PluginDeleteOutcome {
  readonly pluginInstanceId: string
  readonly runtimeWarning: boolean
  readonly credentialsPreserved: boolean
}

export function pluginEditorIsDirty(
  initialDraft: PluginFormDraft,
  currentDraft: PluginFormDraft,
  credentials: PluginCredentialDraft,
): boolean {
  return JSON.stringify(currentDraft) !== JSON.stringify(initialDraft)
    || credentials.primary.length > 0
    || credentials.proxy.length > 0
}

export type PluginEditorAction =
  | { readonly type: "reset"; readonly ownerKey: string; readonly draft: PluginFormDraft }
  | { readonly type: "preparing" }
  | { readonly type: "prepared"; readonly preparation: PluginEditPreparation; readonly needsConfirmation: boolean; readonly description: string }
  | { readonly type: "edit-started"; readonly editSessionId: string }
  | { readonly type: "draft"; readonly draft: PluginFormDraft }
  | { readonly type: "credentials"; readonly credentials: PluginCredentialDraft }
  | { readonly type: "credential-status"; readonly status: CredentialStatusData }
  | { readonly type: "validation-started"; readonly validation: PluginValidationState }
  | { readonly type: "validation-progress"; readonly validation: PluginValidationState }
  | { readonly type: "validation-finished"; readonly validation: PluginValidationState }
  | { readonly type: "issues"; readonly issues: readonly PluginFormIssue[] }
  | { readonly type: "saving" }
  | { readonly type: "databases-loading" }
  | { readonly type: "databases"; readonly result: PluginDatabaseListData }
  | { readonly type: "confirmation"; readonly confirmation: PluginEditorConfirmation | null }
  | { readonly type: "failure"; readonly error: PublicError }
  | { readonly type: "clear-sensitive" }
  | { readonly type: "closed" }

export function initialPluginEditorState(ownerKey: string, draft: PluginFormDraft): PluginEditorState {
  return {
    ownerKey,
    phase: "closed",
    draft,
    credentials: emptyCredentialDraft(),
    credentialStatus: null,
    issues: [],
    validation: null,
    preparation: null,
    editSessionId: null,
    confirmation: null,
    databases: [],
    databasesLoading: false,
    databasesTruncated: false,
    error: null,
    draftGeneration: 0,
    sequence: 0,
  }
}

export function pluginEditorReducer(
  state: PluginEditorState,
  action: PluginEditorAction,
): PluginEditorState {
  switch (action.type) {
    case "reset":
      return {
        ...initialPluginEditorState(action.ownerKey, action.draft),
        phase: "editing",
      }
    case "preparing":
      return { ...state, phase: "preparing", error: null }
    case "prepared":
      return {
        ...state,
        phase: action.needsConfirmation ? "impact-confirmation" : "preparing",
        preparation: action.preparation,
        confirmation: action.needsConfirmation
          ? {
              kind: "edit-impact",
              title: "确认连接配置编辑影响",
              description: action.description,
            }
          : null,
      }
    case "edit-started":
      return {
        ...state,
        phase: "editing",
        editSessionId: action.editSessionId,
        confirmation: null,
        error: null,
      }
    case "draft":
      return {
        ...state,
        draft: action.draft,
        issues: [],
        databases: [],
        databasesLoading: false,
        databasesTruncated: false,
        validation: state.validation
          ? { ...state.validation, state: "stale" }
          : null,
        error: null,
        draftGeneration: state.draftGeneration + 1,
      }
    case "credentials":
      return {
        ...state,
        credentials: action.credentials,
        databases: [],
        databasesLoading: false,
        databasesTruncated: false,
        validation: state.validation
          ? { ...state.validation, state: "stale" }
          : null,
        error: null,
        draftGeneration: state.draftGeneration + 1,
      }
    case "credential-status":
      return { ...state, credentialStatus: action.status }
    case "validation-started":
      return {
        ...state,
        phase: "validating",
        validation: action.validation,
        issues: [],
        error: null,
        sequence: action.validation.sequence,
      }
    case "validation-progress":
      return { ...state, validation: action.validation }
    case "validation-finished":
      return {
        ...state,
        phase: "editing",
        validation: action.validation,
        error: action.validation.error ?? null,
      }
    case "issues":
      return { ...state, issues: action.issues, phase: "editing" }
    case "saving":
      return { ...state, phase: "saving", error: null }
    case "databases-loading":
      return { ...state, databasesLoading: true, databases: [], databasesTruncated: false, error: null }
    case "databases":
      return { ...state, databasesLoading: false, databases: action.result.databases, databasesTruncated: action.result.truncated }
    case "confirmation":
      return {
        ...state,
        phase: state.phase === "saving" ? "editing" : state.phase,
        confirmation: action.confirmation,
      }
    case "failure":
      return { ...state, phase: "error", databasesLoading: false, error: action.error }
    case "clear-sensitive":
      return {
        ...state,
        credentials: emptyCredentialDraft(),
        credentialStatus: null,
      }
    case "closed":
      return {
        ...state,
        phase: "closed",
        credentials: emptyCredentialDraft(),
        credentialStatus: null,
        validation: null,
        confirmation: null,
        error: null,
        issues: [],
        databases: [],
      }
  }
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function editPreparationNeedsConfirmation(preparation: PluginEditPreparation): boolean {
  const connected = readArray(preparation.preEditConnectedSet).length
  const affected = readArray(preparation.affectedIds).length
  const operations = preparation.activeOperations
  const operationRecord = operations !== null && typeof operations === "object"
    ? (operations as Readonly<Record<string, unknown>>)
    : {}
  const active = readArray(operationRecord.connection).length + readArray(operationRecord.workspace).length
  return connected > 0 || affected > 1 || active > 0
}

export function editPreparationDescription(
  preparation: PluginEditPreparation,
  pluginName: string,
): string {
  const connected = readArray(preparation.preEditConnectedSet).length
  const affected = Math.max(1, readArray(preparation.affectedIds).length)
  const operations = preparation.activeOperations
  const operationRecord = operations !== null && typeof operations === "object"
    ? (operations as Readonly<Record<string, unknown>>)
    : {}
  const active = readArray(operationRecord.connection).length + readArray(operationRecord.workspace).length
  const connectionText = connected > 0
    ? `进入编辑前将安全断开 ${connected} 个连接。`
    : "当前没有需要断开的连接。"
  const activeText = active > 0 ? `还需等待 ${active} 个进行中的操作结束。` : ""
  return `修改“${pluginName}”会影响 ${affected} 个插件。${connectionText}${activeText}`
}

export function validationMatches(
  active: PluginValidationState | null,
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  if (!active) return false
  if (candidate.requestId !== active.requestId) return false
  if (candidate.draftGeneration !== undefined && candidate.draftGeneration !== active.draftGeneration) return false
  if (candidate.sequence !== undefined && candidate.sequence !== active.sequence) return false
  if (active.editSessionId && candidate.editSessionId !== active.editSessionId) return false
  if (active.operationId && candidate.operationId !== undefined && candidate.operationId !== active.operationId) return false
  if (active.configDigest && candidate.configDigest !== undefined && candidate.configDigest !== active.configDigest) return false
  return true
}

export function mergeValidationProgress(
  active: PluginValidationState,
  progress: ProgressRecord,
): PluginValidationState {
  if (active.state !== "running") return active
  const record = progress as Readonly<Record<string, unknown>>
  if (!validationMatches(active, record)) return active
  const rawState = typeof record.state === "string" ? record.state : "running"
  const state = (["running", "valid", "failed", "cancelled"] as const).includes(
    rawState as "running" | "valid" | "failed" | "cancelled",
  )
    ? (rawState as "running" | "valid" | "failed" | "cancelled")
    : "running"
  return {
    ...active,
    state,
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
    ...(typeof record.configDigest === "string" ? { configDigest: record.configDigest } : {}),
    ...(record.result !== null && typeof record.result === "object"
      ? { result: record.result as OpaqueData }
      : {}),
  }
}

export function hostKeyChallengeFromError(
  error: PublicError,
  draft: PluginFormDraft,
): HostKeyChallenge | null {
  if (error.code !== "SSH_HOST_KEY_CONFIRM_REQUIRED") return null
  const details = error.details !== null && typeof error.details === "object"
    ? (error.details as Readonly<Record<string, unknown>>)
    : {}
  const nested = details.hostKeyChallenge !== null && typeof details.hostKeyChallenge === "object"
    ? (details.hostKeyChallenge as Readonly<Record<string, unknown>>)
    : details
  const fingerprint = typeof nested.fingerprint === "string"
    ? nested.fingerprint.trim()
    : typeof nested.hostKeyFingerprint === "string"
      ? nested.hostKeyFingerprint.trim()
      : ""
  if (!fingerprint) return null
  const host = typeof nested.host === "string" ? nested.host.trim() : draft.target.host
  const port = typeof nested.port === "number" ? nested.port : draft.target.port
  if (host !== draft.target.host || port !== draft.target.port) return null
  return {
    host,
    port,
    fingerprint,
    algorithm: typeof nested.algorithm === "string" ? nested.algorithm.trim() : "",
  }
}

export function resultPlugin(value: OpaqueData | PluginRecord): PluginRecord | null {
  const record = value as Readonly<Record<string, unknown>>
  const nested = record.plugin
  const candidate = nested !== null && typeof nested === "object"
    ? (nested as Readonly<Record<string, unknown>>)
    : record
  return typeof candidate.projectId === "string"
    && typeof candidate.environmentId === "string"
    && typeof candidate.pluginInstanceId === "string"
    && typeof candidate.pluginType === "string"
    && typeof candidate.displayName === "string"
    && typeof candidate.revision === "number"
    ? (candidate as unknown as PluginRecord)
    : null
}

function hasWarning(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== null && record[key] !== undefined
}

export function normalizePluginSaveOutcome(
  value: OpaqueData | PluginRecord,
): PluginSaveOutcome {
  const record = value as Readonly<Record<string, unknown>>
  const runtimeWarning = hasWarning(record, "runtimeWarning")
  return {
    plugin: resultPlugin(value),
    runtimeWarning,
    persistenceRecoveryPending: hasWarning(record, "persistenceWarning"),
    manualReconnectRequired: record.manualReconnectRequired === true || runtimeWarning,
  }
}

export function normalizePluginDeleteOutcome(
  value: OpaqueData,
  pluginInstanceId: string,
): PluginDeleteOutcome {
  const record = value as Readonly<Record<string, unknown>>
  return {
    pluginInstanceId,
    runtimeWarning: hasWarning(record, "runtimeWarning"),
    credentialsPreserved: record.credentialsPreserved === true,
  }
}
