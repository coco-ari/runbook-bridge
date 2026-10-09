export type SoftwareUpdateRequest =
  | { readonly action: "status" | "check" | "download" | "cancel" | "install" }
  | { readonly action: "source"; readonly repositoryId: string | null }

export interface SoftwareUpdateSource {
  readonly repositoryId: string
  readonly name: string
  readonly origin: string
}

export interface SoftwareUpdateState {
  readonly phase: "idle" | "no-source" | "source-required" | "unsupported" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error"
  readonly currentVersion: string
  readonly availableVersion: string | null
  readonly releaseNotes: string
  readonly releaseDate: string | null
  readonly progress: { readonly percent: number; readonly transferred: number; readonly total: number } | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly checkedAt: string | null
  readonly source: SoftwareUpdateSource | null
  readonly sources: readonly SoftwareUpdateSource[]
  readonly supported: boolean
}
