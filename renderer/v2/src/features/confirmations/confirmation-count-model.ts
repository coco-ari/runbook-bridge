interface ConfirmationCountItem {
  readonly requestId?: unknown
  readonly projectId?: unknown
  readonly environmentId?: unknown
  readonly expiresAt?: unknown
}

interface ConfirmationCountScope {
  readonly projectId: string | null
  readonly environmentId: string | null
}

export function countActiveConfirmations(
  items: readonly ConfirmationCountItem[],
  scope: ConfirmationCountScope,
  now = Date.now(),
): number {
  if (!scope.projectId || !scope.environmentId) return 0
  const ids = new Set<string>()
  for (const item of items) {
    if (
      typeof item.requestId === "string"
      && item.requestId.length > 0
      && item.projectId === scope.projectId
      && item.environmentId === scope.environmentId
      && typeof item.expiresAt === "number"
      && Number.isFinite(item.expiresAt)
      && item.expiresAt > now
    ) ids.add(item.requestId)
  }
  return ids.size
}
