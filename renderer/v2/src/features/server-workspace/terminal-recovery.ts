import type { EnvironmentRuntime, OpaqueData } from "@/bridge/ai-ops-v2"

export interface TerminalConnection {
  readonly connected: boolean
  readonly allowRecovery: boolean
  readonly pauseRecovery: boolean
  readonly phase: "connected" | "waiting" | "connecting" | "exhausted" | "action-required" | "disconnected"
  readonly sequence: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly nextRetryAt: number | null
  readonly reason: string
  readonly message: string
}

function record(value: unknown): OpaqueData {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as OpaqueData : {}
}

export function terminalConnection(runtime: EnvironmentRuntime | null, pluginInstanceId: string, fallbackPhase: string): TerminalConnection {
  const plugin = record(record(runtime?.plugins)[pluginInstanceId])
  const phase = fallbackPhase === "disconnecting" ? "disconnecting" : typeof plugin.phase === "string" ? plugin.phase : fallbackPhase
  const reason = typeof plugin.reason === "string" ? plugin.reason : ""
  const reconnect = record(runtime?.reconnect)
  const relevant = Array.isArray(reconnect.pluginInstanceIds) && reconnect.pluginInstanceIds.includes(pluginInstanceId)
  const stopped = runtime?.desiredConnected === false || record(runtime?.manualDisconnected)[pluginInstanceId] === true
    || phase === "disconnecting" || reason === "USER_DISCONNECTED" || reason === "MANUAL_RECONNECT_REQUIRED"
  const needsAction = !stopped && (phase === "blocked" || phase === "error") && plugin.retryable !== true
  const awaitingPlugin = phase === "disconnected" && [runtime?.phase, fallbackPhase].some(value => value === "connecting" || value === "reconnecting")
  const connecting = phase === "connecting" || phase === "reconnecting" || awaitingPlugin
  const connected = phase === "connected"
  const pauseRecovery = stopped && reason !== "MANUAL_RECONNECT_REQUIRED" && phase !== "blocked" && phase !== "error"
  return {
    connected,
    pauseRecovery,
    allowRecovery: !stopped && !needsAction && (connected || relevant || connecting || plugin.retryable === true),
    phase: connected ? "connected" : stopped ? "disconnected" : needsAction ? "action-required"
      : phase === "connecting" || awaitingPlugin ? "connecting"
      : relevant && reconnect.phase === "waiting" ? "waiting"
      : relevant && reconnect.phase === "exhausted" ? "exhausted"
      : phase === "reconnecting" || (relevant && reconnect.phase === "connecting") ? "connecting" : "disconnected",
    sequence: runtime?.sequence ?? 0,
    attempt: relevant && typeof reconnect.attempt === "number" ? reconnect.attempt : 0,
    maxAttempts: relevant && typeof reconnect.maxAttempts === "number" ? reconnect.maxAttempts : 0,
    nextRetryAt: relevant && typeof reconnect.nextRetryAt === "number" ? reconnect.nextRetryAt : null,
    reason,
    message: typeof record(plugin.error).message === "string" ? String(record(plugin.error).message) : "",
  }
}

// 只串行创建 PTY，不占用终端读取或文件传输；执行时再检查标签是否仍然有效。
export class TerminalOpenQueue {
  private pending: { priority: () => number; run: () => Promise<void> }[] = []
  private running = false

  run<T>(operation: () => Promise<T>, priority: () => number): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ priority, run: async () => { try { resolve(await operation()) } catch (error) { reject(error) } } })
    })
    if (!this.running) {
      this.running = true
      setTimeout(() => { void this.drain() }, 0)
    }
    return result
  }

  private async drain() {
    try {
      while (this.pending.length) {
        this.pending.sort((left, right) => right.priority() - left.priority())
        await this.pending.shift()!.run()
      }
    } finally { this.running = false }
  }
}

export const terminalOpenQueue = new TerminalOpenQueue()
