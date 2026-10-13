export type SoftwareUpdateRequest =
  | { readonly action: "status" | "check" | "download" | "cancel" | "install" }
  | { readonly action: "source"; readonly repositoryId: string | null }
  | { readonly action: "open-installer" | "reveal-installer"; readonly downloadId: string }

export interface SoftwareUpdateSource {
  readonly repositoryId: string
  readonly name: string
  readonly origin: string
}

export interface SoftwareUpdateState {
  readonly phase: "idle" | "no-source" | "source-required" | "unsupported" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "opening" | "error"
  readonly installationMode: "restart" | "manual-dmg"
  readonly downloadId: string | null
  readonly installerOpened: boolean
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
