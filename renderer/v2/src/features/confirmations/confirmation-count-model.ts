interface ConfirmationCountItem {
  readonly requestId?: unknown
  readonly projectId?: unknown
  readonly environmentId?: unknown
  readonly expiresAt?: unknown
}

export interface ConfirmationCountScope {
  readonly projectId: string | null
  readonly environmentId: string | null
}

export interface ConfirmationCountSnapshot {
  readonly count: number | null
  readonly loading: boolean
  readonly unavailable: boolean
}

export interface ScopedConfirmationCountSnapshot extends ConfirmationCountSnapshot {
  readonly scopeKey: string
}

interface ConfirmationCountReadTicket {
  readonly scopeKey: string
  readonly generation: number
  readonly subscriptionRevision: number
}

export function confirmationCountScopeKey(scope: ConfirmationCountScope): string {
  return JSON.stringify([scope.projectId, scope.environmentId])
}

export function confirmationCountLoading(scope: ConfirmationCountScope): ConfirmationCountSnapshot {
  return { count: null, loading: Boolean(scope.projectId && scope.environmentId), unavailable: false }
}

export function confirmationCountForScope(
  snapshot: ScopedConfirmationCountSnapshot,
  scope: ConfirmationCountScope,
): ConfirmationCountSnapshot {
  if (snapshot.scopeKey !== confirmationCountScopeKey(scope)) return confirmationCountLoading(scope)
  return { count: snapshot.count, loading: snapshot.loading, unavailable: snapshot.unavailable }
}

export class ConfirmationCountReadCoordinator {
  private generation = 0
  private subscriptionRevision = 0
  private scopeKey: string | null = null

  activateScope(scope: ConfirmationCountScope): ConfirmationCountReadTicket {
    this.generation += 1
    this.subscriptionRevision = 0
    this.scopeKey = confirmationCountScopeKey(scope)
    return { scopeKey: this.scopeKey, generation: this.generation, subscriptionRevision: 0 }
  }

  isScopeCurrent(ticket: ConfirmationCountReadTicket): boolean {
    return ticket.generation === this.generation && ticket.scopeKey === this.scopeKey
  }

  isReadCurrent(ticket: ConfirmationCountReadTicket): boolean {
    return this.isScopeCurrent(ticket) && ticket.subscriptionRevision === this.subscriptionRevision
  }

  acceptSubscription(ticket: ConfirmationCountReadTicket): boolean {
    if (!this.isScopeCurrent(ticket)) return false
    this.subscriptionRevision += 1
    return true
  }

  deactivateScope(ticket: ConfirmationCountReadTicket): void {
    if (this.isScopeCurrent(ticket)) {
      this.generation += 1
      this.scopeKey = null
    }
  }
}

export function confirmationCountSnapshot(
  items: readonly ConfirmationCountItem[] | null,
  scope: ConfirmationCountScope,
  now = Date.now(),
): ConfirmationCountSnapshot {
  if (!scope.projectId || !scope.environmentId) return { count: null, loading: false, unavailable: false }
  if (items === null) return { count: null, loading: false, unavailable: true }
  return { count: countActiveConfirmations(items, scope, now), loading: false, unavailable: false }
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
