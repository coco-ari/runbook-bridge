export interface CloudProject { readonly projectId: string; readonly name: string; readonly warnings?: readonly string[] }
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
  | { action: "status" | "unbind" }
  | { action: "bind"; url: string; password: string; remember: boolean }
  | { action: "create"; serviceUrl: string; adminToken: string; password: string; remember: boolean }
  | { action: "catalog"; snapshotId?: string | null }
  | { action: "prepare"; direction: "upload" | "download"; projectIds: string[]; snapshotId?: string | null }
  | { action: "confirm"; planId: string; choices: Record<string, "local" | "cloud"> }
  | { action: "prepareRestore"; backupId: string }
