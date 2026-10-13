export interface UpdateNotice {
  readonly id: string
  readonly type: "cloud" | "software"
  readonly kind: "added" | "changed" | "conflict" | "deleted" | "available" | "downloaded"
  readonly repositoryId: string
  readonly repositoryName: string
  readonly projectId?: string
  readonly localProjectId?: string
  readonly title: string
  readonly description: string
  readonly version?: string
  readonly installationMode?: "restart" | "manual-dmg"
  readonly sourceOrigin?: string
  readonly downloadId?: string | null
  readonly firstSeenAt?: number
}
export type NotificationMode = "app" | "background" | "always"
export interface UpdateCenterState { readonly items: readonly UpdateNotice[]; readonly error: string | null; readonly notificationMode?: NotificationMode }
export type UpdateCenterRequest = { action: "status" }
  | { action: "preferences"; notificationMode: NotificationMode }
export interface UpdateTarget { readonly type: "software" | "cloud"; readonly repositoryId: string; readonly kind: string; readonly projectId?: string }
export interface UpdateCenterEvent {
  readonly kind: "changed" | "cloud" | "notice" | "open" | "confirmations-open"
  readonly title?: string
  readonly body?: string
  readonly target?: UpdateTarget
}
export interface UpdateSettingsTarget { readonly section: "about" | "cloud"; readonly repositoryId?: string; readonly projectId?: string; readonly deleted?: boolean; readonly sequence: number }
