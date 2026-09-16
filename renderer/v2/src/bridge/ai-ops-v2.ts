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

export interface MysqlTableSummary {
  readonly name: string
  readonly type: string
  readonly queryable: boolean
}

export interface MysqlTableListData {
  readonly auditWarning?: boolean
  readonly tables: readonly MysqlTableSummary[]
  readonly nextCursor: string | null
  readonly truncated: boolean
}

export interface MysqlColumnDescription {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
  readonly key: string | null
  readonly default: unknown
  readonly extra: string | null
}

export interface MysqlTableDescription {
  readonly auditWarning?: boolean
  readonly table: string
  readonly columns: readonly MysqlColumnDescription[]
}

export interface MysqlQueryResult {
  readonly auditWarning?: boolean
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly columns: readonly Readonly<{ name: string; table: string | null; type: number }>[]
  readonly rowCount: number
  readonly bytes: number
  readonly truncated: boolean
  readonly durationMs: number
  readonly fingerprint: string
  readonly limitsApplied: Readonly<{ maxRows: number; maxBytes: number; timeoutMs: number }>
}

export interface MysqlTableListPayload extends PluginScope {
  readonly cursor?: string
  readonly limit?: number
}

export interface MysqlTablePayload extends PluginScope {
  readonly table: string
}

export interface MysqlPreviewPayload extends MysqlTablePayload {
  readonly where?: string
  readonly orderBy?: readonly Readonly<{ column: string; direction: "asc" | "desc" }>[]
  readonly limit?: number
  readonly offset?: number
}

export interface MysqlQueryPayload extends PluginScope {
  readonly sql: string
  readonly params?: readonly (string | number | boolean | null)[]
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

export interface ServerTerminalSession {
  readonly sessionId: string
  readonly status: "open" | "closed"
  readonly cols: number
  readonly rows: number
}

export interface ServerTerminalRead {
  readonly data: Uint8Array
  readonly status: "open" | "closed"
  readonly exitCode?: number | null
}

export interface ServerDirectoryEntry {
  readonly linkTarget?: string
  readonly linkTargetType?: "directory" | "file" | "special" | "unavailable"
  readonly name: string
  readonly path: string
  readonly size: number
  readonly mtime: number
  readonly mode: number
  readonly type: "directory" | "file" | "symlink" | "special"
}

export interface ServerDirectoryPage {
  readonly snapshotId?: string
  readonly metadataPending?: boolean
  readonly canonicalPath?: string
  readonly path: string
  readonly entries: readonly ServerDirectoryEntry[]
  readonly nextCursor: string | null
  readonly truncated: boolean
}

export interface ServerFilePreview {
  readonly canonicalPath?: string
  readonly path: string
  readonly content: string
  readonly size: number
  readonly startByte: number
  readonly endByte: number
  readonly mtime: number
  readonly nextCursor: string | null
  readonly truncated: boolean
}

export interface ServerUploadPreparation {
  readonly sourcePath?: string
  readonly preparationId: string
  readonly path: string
  readonly expiresAt: number
  readonly files: readonly { readonly name: string; readonly localPath: string; readonly bytes: number; readonly remotePath: string; readonly exists: boolean }[]
}

export interface ServerUploadReview extends Omit<ServerUploadPreparation, "preparationId" | "expiresAt" | "files"> {
  readonly resume?: { readonly jobId: string; readonly bytes: number }
  readonly reviewId: string
  readonly status: "checking" | "ready" | "error"
  readonly preparationId: string | null
  readonly expiresAt: number | null
  readonly files: readonly { readonly name: string; readonly localPath: string; readonly bytes: number; readonly remotePath: string; readonly exists: boolean | null }[]
  readonly progress: { readonly phase: "remote" | "hashing" | "ready"; readonly completedFiles: number; readonly totalFiles: number; readonly hashedBytes: number; readonly totalBytes: number; readonly currentFile?: string }
  readonly error?: PublicError
}

export interface ServerUploadJob {
  readonly jobId: string
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly transferred: number
  readonly phase?: "preparing" | "uploading" | "verifying"
  readonly bytesPerSecond?: number | null
  readonly etaSeconds?: number | null
  readonly canResume?: boolean
  readonly resumeBytes?: number
  readonly status: "queued" | "running" | "verifying" | "completed" | "cancelled" | "error" | "interrupted"
  readonly message?: string
}

export interface AiOpsV2Api {
  serverTerminalOpen(payload: PluginScope & { cols: number; rows: number; tabId?: string; defaultColors?: boolean }): Promise<IpcResult<ServerTerminalSession>>
  serverTerminalRead(payload: PluginScope & { sessionId: string }): Promise<IpcResult<ServerTerminalRead>>
  serverTerminalWrite(payload: PluginScope & { sessionId: string; data: string; encoding?: "utf8" | "binary" }): Promise<IpcResult<OpaqueData>>
  serverTerminalClipboard(payload: PluginScope & { sessionId: string } & ({ action: "copy"; text: string } | { action: "paste" })): Promise<IpcResult<{ text?: string }>>
  serverTerminalResize(payload: PluginScope & { sessionId: string; cols: number; rows: number }): Promise<IpcResult<OpaqueData>>
  serverTerminalClose(payload: PluginScope & { sessionId: string }): Promise<IpcResult<OpaqueData>>
  serverWorkspaceListDirectory(payload: PluginScope & { path: string; cursor?: string | null; snapshotId?: string; deferLinks?: boolean; resolveLinks?: boolean }): Promise<IpcResult<ServerDirectoryPage>>
  serverWorkspaceReadFile(payload: PluginScope & { path: string }): Promise<IpcResult<ServerFilePreview>>
  serverWorkspacePrepareUploadResume(payload: PluginScope & { jobId: string }): Promise<IpcResult<ServerUploadReview>>
  serverWorkspacePickUpload(payload: PluginScope & { path: string }): Promise<IpcResult<ServerUploadReview | null>>
  serverWorkspaceReviseUpload(payload: PluginScope & { reviewId: string; fileNames: readonly string[] }): Promise<IpcResult<ServerUploadReview | null>>
  serverWorkspaceReadUploadReview(payload: PluginScope & { reviewId: string }): Promise<IpcResult<ServerUploadReview>>
  serverWorkspaceCancelUploadReview(payload: PluginScope & { reviewId: string }): Promise<IpcResult<OpaqueData>>
  serverWorkspaceConfirmUpload(payload: PluginScope & { preparationId: string; overwrite: boolean }): Promise<IpcResult<{ jobs: readonly ServerUploadJob[] }>>
  serverWorkspaceCancelUpload(payload: PluginScope & { jobId: string }): Promise<IpcResult<ServerUploadJob>>
  serverWorkspaceUploads(payload: PluginScope): Promise<IpcResult<{ jobs: readonly ServerUploadJob[] }>>
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
  mysqlListTables(payload: MysqlTableListPayload): Promise<IpcResult<MysqlTableListData>>
  mysqlDescribeTable(payload: MysqlTablePayload): Promise<IpcResult<MysqlTableDescription>>
  mysqlQueryReadonly(payload: MysqlQueryPayload): Promise<IpcResult<MysqlQueryResult>>
  mysqlPreviewTable(payload: MysqlPreviewPayload): Promise<IpcResult<MysqlQueryResult>>
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
  "serverTerminalOpen",
  "serverTerminalRead",
  "serverTerminalWrite",
  "serverTerminalClipboard",
  "serverTerminalResize",
  "serverTerminalClose",
  "serverWorkspaceListDirectory",
  "serverWorkspaceReadFile",
  "serverWorkspacePrepareUploadResume",
  "serverWorkspacePickUpload",
  "serverWorkspaceReviseUpload",
  "serverWorkspaceReadUploadReview",
  "serverWorkspaceCancelUploadReview",
  "serverWorkspaceConfirmUpload",
  "serverWorkspaceCancelUpload",
  "serverWorkspaceUploads",
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
  "mysqlListTables",
  "mysqlDescribeTable",
  "mysqlQueryReadonly",
  "mysqlPreviewTable",
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
