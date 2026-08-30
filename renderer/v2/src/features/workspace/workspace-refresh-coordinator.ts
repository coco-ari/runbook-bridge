export interface WorkspaceRefreshCoordinator {
  readonly hasPending: () => boolean
  readonly inFlight: () => boolean
  readonly request: () => Promise<boolean>
}

export interface StaleRefreshSnapshot<Data, ErrorValue> {
  readonly data: Data | null
  readonly error: ErrorValue | null
  readonly loading: boolean
}

export function beginStaleRefresh<Data, ErrorValue>(
  current: StaleRefreshSnapshot<Data, ErrorValue>,
): StaleRefreshSnapshot<Data, ErrorValue> {
  return { ...current, error: null, loading: true }
}

export function failStaleRefresh<Data, ErrorValue>(
  current: StaleRefreshSnapshot<Data, ErrorValue>,
  error: ErrorValue,
): StaleRefreshSnapshot<Data, ErrorValue> {
  return { data: current.data, error, loading: false }
}

export function settleRefresh<Snapshot extends Readonly<{ loading: boolean }>>(
  current: Snapshot,
): Snapshot {
  return { ...current, loading: false }
}

export function createWorkspaceRefreshCoordinator(
  refresh: () => Promise<boolean>,
): WorkspaceRefreshCoordinator {
  let requestedVersion = 0
  let completedVersion = 0
  let active: Promise<boolean> | null = null

  const drain = async (): Promise<boolean> => {
    while (completedVersion < requestedVersion) {
      const targetVersion = requestedVersion
      let refreshed = false
      try {
        refreshed = await refresh()
      } catch {
        refreshed = false
      }
      if (!refreshed) return false
      completedVersion = targetVersion
    }
    return true
  }

  const request = (): Promise<boolean> => {
    requestedVersion += 1
    if (!active) {
      active = Promise.resolve()
        .then(drain)
        .finally(() => {
          active = null
        })
    }
    return active
  }

  return {
    hasPending: () => completedVersion < requestedVersion,
    inFlight: () => active !== null,
    request,
  }
}
