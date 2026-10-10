import type { ConfirmationRecord } from "@/bridge/ai-ops-v2"

export interface ConfirmationMessage extends ConfirmationRecord {
  readonly environmentId: string
  readonly pluginInstanceId: string
  readonly expiresAt: number
}

export function activeConfirmationMessages(items: readonly ConfirmationRecord[], now = Date.now()): readonly ConfirmationMessage[] {
  const seen = new Set<string>()
  return items.flatMap(item => {
    if (!item.requestId || seen.has(item.requestId) || !item.projectId || !item.environmentId || !item.pluginInstanceId
      || typeof item.expiresAt !== "number" || !Number.isFinite(item.expiresAt) || item.expiresAt <= now) return []
    seen.add(item.requestId)
    return [item as ConfirmationMessage]
  }).sort((a, b) => a.expiresAt - b.expiresAt || a.requestId.localeCompare(b.requestId))
}

// 首次快照只恢复持续提示；新到达的请求只提醒一次，读取重试不会重复提醒。
export class ConfirmationArrivals {
  private ready = false
  private seen = new Map<string, number>()
  receive(items: readonly ConfirmationRecord[], now = Date.now()): number {
    for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id)
    const active = activeConfirmationMessages(items, now)
    const fresh = active.filter(item => !this.seen.has(item.requestId)).length
    for (const item of active) this.seen.set(item.requestId, item.expiresAt)
    const count = this.ready ? fresh : 0
    this.ready = true
    return count
  }
}
