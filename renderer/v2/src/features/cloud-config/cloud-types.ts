export interface CloudProject { readonly projectId: string; readonly name: string; readonly warnings?: readonly string[] }
export type CloudSyncStatus = "synced" | "behind" | "modified" | "remote" | "unknown" | "locked" | "error"
export interface CloudRepository {
  readonly repositoryId: string
  readonly name: string
  readonly url: string
  readonly unlocked: boolean
  readonly remembered: boolean
  readonly checkedAt: string | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly snapshotId: string | null
}
export interface CloudLinkedProject extends CloudProject {
  readonly repositoryId: string
  readonly localId: string | null
  readonly visible: boolean
  readonly downloaded: boolean
  readonly syncStatus: CloudSyncStatus
  readonly environmentCount: number
  readonly pluginCount: number
}
export interface CloudBackup { readonly backupId: string; readonly projectId: string; readonly name: string; readonly createdAt: string }
export interface CloudVersion { readonly snapshotId: string; readonly createdAt: string; readonly bytes: number }
export interface CloudRow {
  readonly rowId: string
  readonly name: string
  readonly conflict: boolean
  readonly suggested: "local" | "cloud" | null
  readonly diff: { readonly added: number; readonly removed: number; readonly modified: number; readonly credentialsChanged: boolean; readonly environmentsAdded: number; readonly environmentsRemoved: number; readonly contentChanged: boolean; readonly metadataChanged?: boolean; readonly runbooksChanged?: number; readonly questionsChanged?: number }
  readonly warnings: readonly string[]
  readonly willDisconnect: boolean
}
export interface CloudConfigData {
  readonly repositoryId?: string
  readonly repositories?: readonly CloudRepository[]
  readonly cloudProjects?: readonly CloudLinkedProject[]
  readonly checkIntervalMinutes?: number
  readonly url?: string
  readonly unlocked?: boolean
  readonly remembered?: boolean
  readonly projects?: readonly CloudProject[]
  readonly backups?: readonly CloudBackup[]
  readonly versions?: readonly CloudVersion[]
  readonly snapshotId?: string | null
  readonly planId?: string
  readonly direction?: "upload" | "download" | "restore"
  readonly expiresAt?: number
  readonly rows?: readonly CloudRow[]
  readonly syncStateWarning?: boolean
  readonly results?: readonly { readonly projectId: string; readonly status: string; readonly cleanupPending?: boolean; readonly syncStateWarning?: boolean; readonly error?: { readonly code: string; readonly message: string } }[]
}
export type CloudConfigRequest =
  | { action: "status" }
  | { action: "unbind" | "check"; repositoryId?: string }
  | { action: "bind"; url: string; password: string; remember: boolean; name?: string }
  | { action: "create"; serviceUrl: string; adminToken: string; password: string; remember: boolean; name?: string }
  | { action: "catalog"; snapshotId?: string | null; repositoryId?: string }
  | { action: "prepare"; direction: "upload" | "download"; projectIds: string[]; snapshotId?: string | null; repositoryId?: string }
  | { action: "confirm"; planId: string; choices: Record<string, "local" | "cloud"> }
  | { action: "prepareRestore"; backupId: string }
  | { action: "visibility"; repositoryId: string; projectIds: string[]; visible: boolean }
  | { action: "preferences"; checkIntervalMinutes: number }
  | { action: "sync"; repositoryId: string; direction: "upload" | "download"; projectId?: string }
