import type { PluginConnectionState } from "@/features/connections/connection-model"

type ConnectionViewState = Pick<PluginConnectionState, "phase" | "operation" | "challenge" | "error">
export interface WorkspaceConnectionPresentation {
  readonly status: "connected" | "disconnected" | "connecting" | "blocked" | "error" | "partial"
  readonly label: string
}

export function workspaceConnectionPresentation(state: ConnectionViewState, recovery?: string): WorkspaceConnectionPresentation {
  // 在途意图优先于上次运行状态，避免取消、确认和重连阶段显示为已断开。
  if (state.operation?.intent === "cancel") return { status: "connecting", label: "正在取消连接" }
  if (state.operation?.intent === "disconnect" || state.phase === "disconnecting") return { status: "connecting", label: "正在断开" }
  if (state.challenge) return { status: "blocked", label: "等待身份确认" }
  if (state.operation || state.phase === "connecting" || recovery === "connecting") return { status: "connecting", label: "正在连接" }
  if (recovery === "waiting") return { status: "connecting", label: "等待重连" }
  if (state.phase === "connected") return { status: "connected", label: "已连接" }
  if (state.phase === "error" || recovery === "exhausted") return { status: "error", label: "连接失败" }
  if (state.phase === "blocked" || recovery === "action-required") return { status: "blocked", label: "连接需要处理" }
  if (state.phase === "partial") return { status: "partial", label: "部分可用" }
  if (state.phase === "disconnected") return { status: "disconnected", label: "已断开" }
  return { status: "blocked", label: "连接状态待确认" }
}

export function workspaceConnectionNotice(presentation: WorkspaceConnectionPresentation, retention: string): string {
  return (presentation.status === "disconnected" ? "连接已断开" : presentation.label) + "，" + retention
}
