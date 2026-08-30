export interface PublicError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: PublicError }

export type OpaqueData = Readonly<Record<string, unknown>>
export type SecretMap = Readonly<Record<string, string>>
export type PluginDraft = Readonly<Record<string, unknown>>
export type PluginPatch = Readonly<Record<string, unknown>>

export interface ProjectRecord extends OpaqueData {
  readonly projectId: string
  readonly name: string
  readonly revision: number
}

export interface EnvironmentRecord extends OpaqueData {
  readonly projectId: string
  readonly environmentId: string
  readonly name: string
  readonly revision: number
}

export interface PluginRecord extends OpaqueData {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string
  readonly pluginType: string
  readonly displayName: string
  readonly revision: number
}

export type WorkspaceProject = ProjectRecord & {
  readonly environments: readonly EnvironmentRecord[]
  readonly pluginCount?: number
}

export interface EnvironmentRuntime extends OpaqueData {
  readonly projectId: string
  readonly environmentId: string
  readonly phase: string
  readonly sequence: number
}

export interface QuickQuestionOpening extends OpaqueData {
  readonly schemaVersion: number
  readonly text: string
  readonly defaultText: string
  readonly revision: number
}

export interface QuickQuestionRecord extends OpaqueData {
  readonly questionId: string
  readonly text: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface QuickQuestionCollectionRecord extends OpaqueData {
  readonly schemaVersion: number
  readonly projectId: string
  readonly environmentId: string
  readonly revision: number
  readonly items: readonly QuickQuestionRecord[]
}

export interface RunbookRecord extends OpaqueData {
  readonly content: string
  readonly bytes: number
  readonly hash: string
  readonly empty: boolean
}

export interface RunbookSaveRecord extends RunbookRecord {
  readonly environment: EnvironmentRecord
}

export interface AuditRecord extends OpaqueData {
  readonly auditId?: string
  readonly type: string
  readonly result?: string
}

export interface AuditPage extends OpaqueData {
  readonly entries: readonly AuditRecord[]
  readonly nextCursor: string | null
}

export interface ConfirmationRecord extends OpaqueData {
  readonly requestId: string
  readonly projectId: string
  readonly environmentId?: string
  readonly pluginInstanceId?: string
  readonly capability: string
  readonly summary: string
}

export interface ProgressRecord extends OpaqueData {
  readonly phase?: string
  readonly status?: string
}

export interface WorkspaceChange extends OpaqueData {
  readonly type: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly pluginInstanceId?: string
}

export interface ProjectCreateInput {
  readonly projectId?: string
  readonly name: string
  readonly environmentName?: string
}

export interface ProjectUpdatePayload {
  readonly projectId: string
  readonly patch: Readonly<{ name?: string }>
  readonly expectedRevision: number
}

export interface ProjectScope {
  readonly projectId: string
}

export interface EnvironmentScope extends ProjectScope {
  readonly environmentId: string
}

export interface PluginScope extends EnvironmentScope {
  readonly pluginInstanceId: string
}

export interface EnvironmentCreatePayload extends ProjectScope {
  readonly input: Readonly<{ name: string; environmentId?: string }>
}

export interface EnvironmentUpdatePayload extends EnvironmentScope {
  readonly patch: Readonly<{ name?: string }>
  readonly expectedRevision: number
}

export interface EnvironmentReorderPayload extends ProjectScope {
  readonly environmentIds: readonly string[]
  readonly expectedRevision: number | null
}

export interface QuickQuestionOpeningSavePayload {
  readonly text: string
  readonly expectedRevision: number
}

export interface QuickQuestionSavePayload extends EnvironmentScope {
  readonly questionId?: string | null
  readonly text: string
  readonly expectedRevision: number | null
}

export interface QuickQuestionDeletePayload extends EnvironmentScope {
  readonly questionId: string
  readonly expectedRevision: number
}

export interface QuickQuestionCopyPayload extends EnvironmentScope {
  readonly text: string
  readonly discoveredDate?: string
  readonly expectedOpeningRevision: number
}

export type ConnectionIntent = "connect" | "disconnect" | "retry" | "cancel"

export interface ConnectionIntentPayload extends EnvironmentScope {
  readonly intent: ConnectionIntent
  readonly requestId?: string
  readonly source?: string
  readonly pluginInstanceId?: string
  readonly expectedRevision?: number
  readonly secretsByPlugin?: Readonly<Record<string, SecretMap>>
  readonly planId?: string | null
  readonly operationId?: string | null
  readonly legacyScope?: boolean
}

export interface ConnectionIntentResult extends OpaqueData {
  readonly outcome: string
  readonly snapshot: EnvironmentRuntime
  readonly actions: readonly OpaqueData[]
  readonly planId?: string | null
  readonly operationId?: string | null
}

export interface ConnectionChallengePayload {
  readonly challengeId: string
  readonly planId: string
  readonly operationId: string
  readonly expectedRevision: number
  readonly decision: "trust-host-key"
}

export interface LegacyEnvironmentConnectionPayload extends EnvironmentScope {
  readonly expectedRevision?: number
  readonly secretsByPlugin?: Readonly<Record<string, SecretMap>>
}

export interface RunbookSavePayload extends EnvironmentScope {
  readonly content: string
  readonly expectedRevision: number
}

export interface PluginAssessmentPayload extends PluginScope {
  readonly editSessionId?: string | null
  readonly draft?: PluginDraft | null
}

export interface PluginCreatePayload extends EnvironmentScope {
  readonly input: PluginDraft
  readonly secrets?: SecretMap
}

export type CredentialMutation =
  | "unchanged"
  | "none"
  | "replace"
  | "rebind-existing"
  | "clear-explicit"
  | Readonly<{ mutation: string; fields?: readonly string[] }>

export interface PluginUpdatePayload extends PluginScope {
  readonly patch: PluginPatch
  readonly expectedRevision: number
  readonly secrets?: SecretMap
  readonly temporarySecrets?: SecretMap
  readonly credentialIntent?: CredentialMutation
  readonly forceCredentialReplacement?: boolean
}

export interface PluginMetadataUpdatePayload extends PluginScope {
  readonly patch: Readonly<{ displayName?: string }>
  readonly expectedRevision: number
}

export interface PluginAgentConfigurationUpdatePayload extends PluginScope {
  readonly patch: PluginPatch
  readonly expectedRevision: number
}

export interface PluginEditPreparation extends OpaqueData {
  readonly prepareToken: string
}

export interface PluginEditPreparePayload extends PluginScope {
  readonly expectedRevision: number
}

export interface PluginEditSession extends OpaqueData {
  readonly editSessionId: string
}

export interface PluginEditBeginPayload {
  readonly prepareToken: string
}

export interface PluginValidationPayload extends EnvironmentScope {
  readonly pluginInstanceId?: string
  readonly editSessionId?: string
  readonly requestId: string
  readonly draft: PluginDraft
  readonly purpose: string
  readonly temporarySecrets?: SecretMap
  readonly credentialIntent?: CredentialMutation
  readonly discardTemporarySecrets?: boolean
  readonly oneTimeGrant?: OpaqueData
  readonly draftGeneration: number
  readonly sequence: number
  readonly formInstanceId?: string
}

export interface PluginValidationCancelPayload extends EnvironmentScope {
  readonly editSessionId: string
  readonly operationId: string
}

export interface PluginProbePayload extends EnvironmentScope {
  readonly pluginInstanceId?: string
  readonly formInstanceId?: string
  readonly requestId: string
  readonly purpose: string
  readonly draft: PluginDraft
  readonly draftGeneration: number
  readonly sequence: number
  readonly secrets?: SecretMap
  readonly temporarySecrets?: SecretMap
  // Temporary probes cannot access committed credentials or reuse grants.
  readonly credentialIntent?: never
  readonly oneTimeGrant?: never
  readonly editSessionId?: string
}

export interface PluginProbeCancelPayload extends EnvironmentScope {
  readonly formInstanceId?: string
  readonly requestId: string
  readonly operationId?: string
}

export type PluginEditAfterCommit =
  | "stay-disconnected"
  | "connect-current"
  | "restore-pre-edit-set"

export interface PluginEditSavePayload {
  readonly editSessionId: string
  readonly patch: PluginPatch
  readonly expectedRevision: number
  readonly afterCommit?: PluginEditAfterCommit
  readonly temporarySecrets?: SecretMap
  readonly credentialIntent?: CredentialMutation
  readonly discardTemporarySecrets?: boolean
  readonly forceCredentialReplacement?: boolean
}

export interface PluginEditCancelPayload {
  readonly prepareToken?: string
  readonly editSessionId?: string
  readonly restorePreEditConnections?: boolean
}

export interface CredentialStatusData extends OpaqueData {
  readonly saved: boolean
  readonly fields: Readonly<Record<string, boolean>>
}

export interface CredentialMigrationPayload extends PluginScope {
  readonly expectedRevision: number
  readonly sourceSha256: string
}

export interface CredentialRevealPayload extends PluginScope {
  readonly field: string
}

export interface CredentialRevealData {
  readonly value: string
}

export interface PluginDatabaseListPayload extends EnvironmentScope {
  readonly pluginInstanceId?: string
  readonly input: PluginDraft
  readonly secrets?: SecretMap
  readonly temporarySecrets?: SecretMap
  readonly credentialIntent?: CredentialMutation
  readonly oneTimeGrant?: OpaqueData
  readonly editSessionId?: string
  readonly draftGeneration?: number
}

export interface PluginDatabaseListData {
  readonly databases: readonly string[]
  readonly truncated: boolean
}

export interface AuditListPayload extends ProjectScope {
  readonly environmentId?: string
  readonly pluginInstanceId?: string
  readonly type?: string
  readonly result?: string
  readonly limit?: number
  readonly cursor?: string
}

export interface AuditClearPayload extends EnvironmentScope {
  readonly pluginInstanceId?: string | null
}

export type Unsubscribe = () => void

export interface AiOpsV2Api {
  listProjects(): Promise<IpcResult<readonly ProjectRecord[]>>
  workspaceOverview(): Promise<IpcResult<readonly WorkspaceProject[]>>
  createProject(input: ProjectCreateInput): Promise<IpcResult<ProjectRecord>>
  updateProject(payload: ProjectUpdatePayload): Promise<IpcResult<ProjectRecord>>
  deleteProject(payload: ProjectScope): Promise<IpcResult<OpaqueData>>
  listEnvironments(projectId: string): Promise<IpcResult<readonly EnvironmentRecord[]>>
  getQuickQuestionOpening(): Promise<IpcResult<QuickQuestionOpening>>
  saveQuickQuestionOpening(payload: QuickQuestionOpeningSavePayload): Promise<IpcResult<QuickQuestionOpening>>
  listQuickQuestions(payload: EnvironmentScope): Promise<IpcResult<QuickQuestionCollectionRecord>>
  saveQuickQuestion(payload: QuickQuestionSavePayload): Promise<IpcResult<QuickQuestionCollectionRecord>>
  deleteQuickQuestion(payload: QuickQuestionDeletePayload): Promise<IpcResult<QuickQuestionCollectionRecord>>
  copyQuickQuestion(payload: QuickQuestionCopyPayload): Promise<IpcResult<Readonly<{ copied: true }>>>
  createEnvironment(payload: EnvironmentCreatePayload): Promise<IpcResult<EnvironmentRecord>>
  updateEnvironment(payload: EnvironmentUpdatePayload): Promise<IpcResult<EnvironmentRecord>>
  deleteEnvironment(payload: EnvironmentScope): Promise<IpcResult<OpaqueData>>
  reorderEnvironments(payload: EnvironmentReorderPayload): Promise<IpcResult<ProjectRecord>>
  requestConnectionIntent(payload: ConnectionIntentPayload): Promise<IpcResult<ConnectionIntentResult>>
  confirmConnectionChallenge(payload: ConnectionChallengePayload): Promise<IpcResult<OpaqueData>>
  connectEnvironment(payload: LegacyEnvironmentConnectionPayload): Promise<IpcResult<EnvironmentRuntime>>
  retryEnvironment(payload: LegacyEnvironmentConnectionPayload): Promise<IpcResult<EnvironmentRuntime>>
  disconnectEnvironment(payload: EnvironmentScope): Promise<IpcResult<EnvironmentRuntime>>
  cancelEnvironment(payload: EnvironmentScope): Promise<IpcResult<EnvironmentRuntime>>
  environmentStatus(payload: EnvironmentScope): Promise<IpcResult<EnvironmentRuntime>>
  connectPlugin(payload: PluginScope): Promise<IpcResult<EnvironmentRuntime>>
  disconnectPlugin(payload: PluginScope): Promise<IpcResult<EnvironmentRuntime>>
  readRunbook(payload: EnvironmentScope): Promise<IpcResult<RunbookRecord>>
  saveRunbook(payload: RunbookSavePayload): Promise<IpcResult<RunbookSaveRecord>>
  listPlugins(payload: EnvironmentScope): Promise<IpcResult<readonly PluginRecord[]>>
  assessPlugin(payload: PluginAssessmentPayload): Promise<IpcResult<OpaqueData>>
  createPlugin(payload: PluginCreatePayload): Promise<IpcResult<PluginRecord>>
  updatePlugin(payload: PluginUpdatePayload): Promise<IpcResult<PluginRecord>>
  updatePluginMetadata(payload: PluginMetadataUpdatePayload): Promise<IpcResult<PluginRecord>>
  updatePluginAgentConfiguration(payload: PluginAgentConfigurationUpdatePayload): Promise<IpcResult<PluginRecord>>
  updatePluginConnection(payload: PluginUpdatePayload): Promise<IpcResult<PluginRecord>>
  preparePluginConnectionEdit(payload: PluginEditPreparePayload): Promise<IpcResult<PluginEditPreparation>>
  beginPluginConnectionEdit(payload: PluginEditBeginPayload): Promise<IpcResult<PluginEditSession>>
  validatePluginDraft(payload: PluginValidationPayload): Promise<IpcResult<OpaqueData>>
  cancelPluginValidation(payload: PluginValidationCancelPayload): Promise<IpcResult<OpaqueData>>
  probePluginDraft(payload: PluginProbePayload): Promise<IpcResult<OpaqueData>>
  cancelPluginProbe(payload: PluginProbeCancelPayload): Promise<IpcResult<OpaqueData>>
  savePluginConnectionEdit(payload: PluginEditSavePayload): Promise<IpcResult<OpaqueData>>
  cancelPluginConnectionEdit(payload: PluginEditCancelPayload): Promise<IpcResult<OpaqueData>>
  onPluginValidationProgress(callback: (progress: ProgressRecord) => void): Unsubscribe
  onPluginProbeProgress(callback: (progress: ProgressRecord) => void): Unsubscribe
  deletePlugin(payload: PluginScope): Promise<IpcResult<OpaqueData>>
  credentialStatus(payload: PluginScope): Promise<IpcResult<CredentialStatusData>>
  confirmCredentialMigration(payload: CredentialMigrationPayload): Promise<IpcResult<OpaqueData>>
  revealCredential(payload: CredentialRevealPayload): Promise<IpcResult<CredentialRevealData>>
  listPluginDatabases(payload: PluginDatabaseListPayload): Promise<IpcResult<PluginDatabaseListData>>
  listAudit(payload: AuditListPayload): Promise<IpcResult<AuditPage>>
  clearAudit(payload: AuditClearPayload): Promise<IpcResult<OpaqueData>>
  listConfirmations(): Promise<IpcResult<readonly ConfirmationRecord[]>>
  approveConfirmation(requestId: string): Promise<IpcResult<OpaqueData>>
  rejectConfirmation(requestId: string): Promise<IpcResult<OpaqueData>>
  onEnvironmentStatus(callback: (runtime: EnvironmentRuntime) => void): Unsubscribe
  onWorkspaceChanged(callback: (change: WorkspaceChange) => void): Unsubscribe
  onConfirmations(callback: (pending: readonly ConfirmationRecord[]) => void): Unsubscribe
  notifyNetworkChanged(): void
}

export const AI_OPS_V2_API_NAMES = [
  "listProjects",
  "workspaceOverview",
  "createProject",
  "updateProject",
  "deleteProject",
  "listEnvironments",
  "getQuickQuestionOpening",
  "saveQuickQuestionOpening",
  "listQuickQuestions",
  "saveQuickQuestion",
  "deleteQuickQuestion",
  "copyQuickQuestion",
  "createEnvironment",
  "updateEnvironment",
  "deleteEnvironment",
  "reorderEnvironments",
  "requestConnectionIntent",
  "confirmConnectionChallenge",
  "connectEnvironment",
  "retryEnvironment",
  "disconnectEnvironment",
  "cancelEnvironment",
  "environmentStatus",
  "connectPlugin",
  "disconnectPlugin",
  "readRunbook",
  "saveRunbook",
  "listPlugins",
  "assessPlugin",
  "createPlugin",
  "updatePlugin",
  "updatePluginMetadata",
  "updatePluginAgentConfiguration",
  "updatePluginConnection",
  "preparePluginConnectionEdit",
  "beginPluginConnectionEdit",
  "validatePluginDraft",
  "cancelPluginValidation",
  "probePluginDraft",
  "cancelPluginProbe",
  "savePluginConnectionEdit",
  "cancelPluginConnectionEdit",
  "onPluginValidationProgress",
  "onPluginProbeProgress",
  "deletePlugin",
  "credentialStatus",
  "confirmCredentialMigration",
  "revealCredential",
  "listPluginDatabases",
  "listAudit",
  "clearAudit",
  "listConfirmations",
  "approveConfirmation",
  "rejectConfirmation",
  "onEnvironmentStatus",
  "onWorkspaceChanged",
  "onConfirmations",
  "notifyNetworkChanged",
] as const

export type AiOpsV2ApiName = (typeof AI_OPS_V2_API_NAMES)[number]

export function getAiOpsV2(): AiOpsV2Api {
  const candidate = window.aiOps?.v2
  if (!candidate) {
    throw new Error("preload API 不可用。")
  }

  const callable = candidate as unknown as Partial<Record<AiOpsV2ApiName, unknown>>
  const missing = AI_OPS_V2_API_NAMES.filter((name) => typeof callable[name] !== "function")
  if (missing.length > 0) {
    throw new Error("preload API 合同不完整。")
  }

  return candidate
}
