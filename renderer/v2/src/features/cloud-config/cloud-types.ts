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
export interface CloudDeletedProject extends CloudProject {
  readonly repositoryId: string
  readonly deletedAt: string
  readonly environmentCount: number
  readonly pluginCount: number
}
export interface CloudProjectVersion extends CloudProject {
  readonly versionId: string
  readonly createdAt: string
  readonly hash: string
  readonly current: boolean
  readonly environmentCount: number
  readonly pluginCount: number
  readonly diff: CloudRow["diff"]
}
export interface CloudProjectHistory extends CloudProject {
  readonly repositoryId: string
  readonly snapshotId: string
  readonly deletedAt: string | null
  readonly versions: readonly CloudProjectVersion[]
}
export interface CloudProjectOperation extends CloudProject {
  readonly planId: string
  readonly repositoryId: string
  readonly repositoryName: string
  readonly operation: "delete" | "restore" | "restoreVersion"
  readonly versionId: string
  readonly versionName: string
  readonly createdAt: string
  readonly expiresAt: number
}
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
  readonly deletedCloudProjects?: readonly CloudDeletedProject[]
  readonly projectHistory?: CloudProjectHistory
  readonly projectOperation?: CloudProjectOperation
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
  | { action: "renameRepository"; repositoryId: string; name: string }
  | { action: "projectHistory"; repositoryId: string; projectId: string }
  | { action: "prepareProjectOperation"; repositoryId: string; projectId: string; operation: "delete" | "restore" | "restoreVersion"; snapshotId: string; versionId?: string }
  | { action: "confirmProjectOperation"; planId: string }
