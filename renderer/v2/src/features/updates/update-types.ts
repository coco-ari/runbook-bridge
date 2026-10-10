export interface UpdateNotice {
  readonly id: string
  readonly type: "cloud" | "software"
  readonly kind: "added" | "changed" | "conflict" | "deleted" | "available" | "downloaded"
  readonly repositoryId: string
  readonly repositoryName: string
  readonly projectId?: string
  readonly title: string
  readonly description: string
  readonly unread: boolean
}
export interface UpdateCenterState { readonly items: readonly UpdateNotice[]; readonly error: string | null }
export type UpdateCenterRequest = { action: "status" } | { action: "read"; ids: string[] }
export interface UpdateTarget { readonly type: "software" | "cloud"; readonly repositoryId: string; readonly kind: string }
export interface UpdateCenterEvent {
  readonly kind: "changed" | "cloud" | "notice" | "open"
  readonly title?: string
  readonly body?: string
  readonly target?: UpdateTarget
}
export interface UpdateSettingsTarget { readonly section: "about" | "cloud"; readonly repositoryId?: string; readonly projectId?: string; readonly deleted?: boolean; readonly sequence: number }
