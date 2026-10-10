import { countActiveConfirmations } from "./confirmation-count-model.ts"

interface ConfirmationItem {
  readonly requestId?: unknown
  readonly projectId?: unknown
  readonly environmentId?: unknown
  readonly expiresAt?: unknown
}

export interface ConfirmationEnvironment {
  readonly projectId: string
  readonly environmentId: string
  readonly count: number
}

export function confirmationEnvironments(items: readonly ConfirmationItem[], now = Date.now()): readonly ConfirmationEnvironment[] {
  const groups = new Map<string, ConfirmationEnvironment>()
  const seen = new Set<string>()
  for (const item of items) {
    if (!countActiveConfirmations([item], undefined, now) || seen.has(item.requestId as string)) continue
    seen.add(item.requestId as string)
    const projectId = item.projectId as string, environmentId = item.environmentId as string
    const key = JSON.stringify([projectId, environmentId])
    const previous = groups.get(key)
    groups.set(key, { projectId, environmentId, count: (previous?.count ?? 0) + 1 })
  }
  return [...groups.values()]
}
