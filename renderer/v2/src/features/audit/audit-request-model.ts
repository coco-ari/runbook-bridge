export interface AuditRequestTicket {
  readonly scopeKey: string
  readonly generation: number
}

export interface AuditRequestLease<T> {
  readonly ticket: AuditRequestTicket
  readonly promise: Promise<T>
}

export interface AuditRequestStart<T> {
  readonly lease: AuditRequestLease<T>
  readonly started: boolean
}

export class AuditRequestCoordinator<T> {
  private activeScopeKey = ""
  private generation = 0
  private readonly inflight = new Map<string, AuditRequestLease<T>>()

  activateScope(scopeKey: string): AuditRequestTicket {
    this.activeScopeKey = scopeKey
    this.generation += 1
    return { scopeKey, generation: this.generation }
  }

  deactivateScope(scopeKey: string): void {
    if (this.activeScopeKey !== scopeKey) return
    this.activeScopeKey = ""
    this.generation += 1
  }

  isScopeActive(scopeKey: string): boolean {
    return this.activeScopeKey === scopeKey
  }

  isCurrent(ticket: AuditRequestTicket): boolean {
    return this.activeScopeKey === ticket.scopeKey
      && this.generation === ticket.generation
  }

  start(scopeKey: string, task: () => Promise<T>): AuditRequestStart<T> {
    const existing = this.inflight.get(scopeKey)
    if (existing && this.isCurrent(existing.ticket)) {
      return { lease: existing, started: false }
    }
    if (existing) this.inflight.delete(scopeKey)

    const ticket = { scopeKey, generation: this.generation }
    let lease: AuditRequestLease<T>
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.inflight.get(scopeKey) === lease) this.inflight.delete(scopeKey)
      })
    lease = { ticket, promise }
    this.inflight.set(scopeKey, lease)
    return { lease, started: true }
  }

  invalidateScope(scopeKey: string): Promise<T> | null {
    const existing = this.inflight.get(scopeKey)
    if (this.activeScopeKey === scopeKey) this.generation += 1
    if (existing && this.inflight.get(scopeKey) === existing) {
      this.inflight.delete(scopeKey)
    }
    return existing?.promise ?? null
  }

  pending(scopeKey: string): Promise<T> | null {
    return this.inflight.get(scopeKey)?.promise ?? null
  }

  get inflightCount(): number {
    return this.inflight.size
  }
}
