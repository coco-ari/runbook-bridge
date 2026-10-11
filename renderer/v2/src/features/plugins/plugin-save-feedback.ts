import type { EnvironmentRuntime, PluginScope } from "@/bridge/ai-ops-v2"
import type { PluginSaveOutcome } from "./plugin-editor-model.ts"

interface RecoverySnapshot {
  readonly sequence: number
  readonly phases: Readonly<Record<string, string>>
}

export interface PluginRecoveryEvidence {
  readonly targets: readonly string[] | null
  readonly outcome: string | null
  readonly needsAction: boolean
  readonly snapshot: RecoverySnapshot | null
}

export interface PluginSaveFeedback {
  readonly state: "not-needed" | "recovering" | "restored" | "partial" | "not-restored" | "unknown"
  readonly tone: "info" | "success" | "warning"
  readonly title: string
  readonly message: string
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null
}

export function recoveryTargetIds(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0)
    ? [...new Set(value)] : null
}

function recoverySnapshot(value: unknown, scope: PluginScope): RecoverySnapshot | null {
  const source = record(value)
  const plugins = record(source?.plugins)
  if (!source || !plugins || source.projectId !== scope.projectId || source.environmentId !== scope.environmentId
    || typeof source.sequence !== "number" || !Number.isSafeInteger(source.sequence) || source.sequence < 0) return null
  return {
    sequence: source.sequence,
    // Only retain status evidence; error messages and operational data are not presentation text.
    phases: Object.fromEntries(Object.entries(plugins).flatMap(([id, value]) => {
      const phase = record(value)?.phase
      return typeof phase === "string" ? [[id, phase]] : []
    })),
  }
}

export function readPluginRecovery(value: unknown, scope: PluginScope, targets: readonly string[] | null): PluginRecoveryEvidence {
  const plan = record(record(value)?.connectionPlan)
  return {
    targets,
    outcome: typeof plan?.outcome === "string" ? plan.outcome : null,
    needsAction: Array.isArray(plan?.actions) && plan.actions.length > 0,
    snapshot: recoverySnapshot(plan?.snapshot, scope),
  }
}

export function pluginSaveFeedback(outcome: PluginSaveOutcome, runtime: EnvironmentRuntime | null = null, runtimeUnavailable = false): PluginSaveFeedback {
  const result = (state: PluginSaveFeedback["state"], tone: PluginSaveFeedback["tone"], message: string): PluginSaveFeedback => ({
    state, tone, title: "插件配置已保存", message,
  })
  const unknown = () => result("unknown", "warning", "连接恢复结果待核实。请刷新状态后查看原有连接，不要重复保存配置。")
  if (outcome.persistenceRecoveryPending) return result("unknown", "warning", "配置与凭据已保存，但本地恢复记录仍待处理。请重启应用完成恢复检查，不要重复保存。")
  if (runtimeUnavailable) return unknown()
  const recovery = outcome.recovery
  if (!recovery) {
    if (outcome.runtimeWarning || outcome.manualReconnectRequired || outcome.saveStrategy === "restore-previous") return unknown()
    if (outcome.saveStrategy === "connect-current") return result("recovering", "info", "连接请求已受理，尚未确认完成。请在详情中查看连接状态。")
    return result("not-needed", "info", "配置已保存，插件保持断开，可在详情中连接。")
  }
  if (!recovery.targets) return unknown()
  if (!recovery.targets.length && !outcome.runtimeWarning && !outcome.manualReconnectRequired && !recovery.needsAction) {
    return result("not-needed", "info", "编辑前没有需要恢复的连接，插件保持断开。")
  }
  if (!recovery.outcome || !["started", "already-satisfied", "needs-action", "cancelled", "blocked"].includes(recovery.outcome)) return unknown()
  // A returned snapshot provides the post-save sequence boundary. Never infer success
  // from an older pre-edit snapshot, a different environment, or the word "started".
  let snapshot = recovery.snapshot
  const current = outcome.plugin ? recoverySnapshot(runtime, outcome.plugin) : null
  if (snapshot && current && current.sequence > snapshot.sequence) snapshot = current
  if (!snapshot || !recovery.targets.length) return unknown()
  const phases = recovery.targets.map(id => snapshot.phases[id])
  const connected = phases.filter(phase => phase === "connected").length
  const pending = phases.some(phase => phase === "connecting" || phase === "reconnecting" || phase === "disconnecting")
  const failed = phases.some(phase => phase === "error" || phase === "failed" || phase === "blocked")
  const complete = connected === phases.length
  if (complete) {
    if (outcome.runtimeWarning || outcome.manualReconnectRequired || (recovery.needsAction && snapshot === recovery.snapshot)) return result("unknown", "warning", "原有连接当前均已连接，但保存时报告的运行恢复事项仍需核实。请查看连接详情，不要重复保存配置。")
    return result("restored", "success", `编辑前的 ${phases.length} 个连接均已恢复。`)
  }
  if (phases.some(phase => !phase || !["connected", "connecting", "reconnecting", "disconnecting", "disconnected", "error", "failed", "blocked"].includes(phase))) return unknown()
  if (failed || (!pending && (recovery.needsAction || connected > 0))) {
    return result(connected > 0 ? "partial" : "not-restored", "warning", `原有连接已恢复 ${connected}/${phases.length}，其余连接尚未恢复。请查看对应插件的状态和处理入口，不要重复保存配置。`)
  }
  if (pending) return result("recovering", "info", `正在恢复原有连接（${connected}/${phases.length} 已连接），尚未全部完成。`)
  return result("not-restored", "warning", "配置已保存，原有连接尚未恢复。请查看插件状态后处理，不要重复保存配置。")
}
