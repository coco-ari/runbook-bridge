import type { ConnectionIntent } from "@/bridge/ai-ops-v2"
import type { ConnectionPhase } from "@/features/connections/connection-model"

export type ConnectionRowActionKind =
  | "cancel"
  | "configure"
  | "connect"
  | "disconnect"
  | "pending"
  | "retry"

export interface ConnectionRowActionPresentation {
  readonly disabled: boolean
  readonly kind: ConnectionRowActionKind
  readonly label: string
  readonly pending: boolean
  readonly variant: "default" | "outline"
}

export function deriveConnectionRowAction(
  phase: ConnectionPhase,
  activeIntent: ConnectionIntent | null,
  ready: boolean,
  canCancel: boolean = false,
): ConnectionRowActionPresentation {
  if (activeIntent === "cancel") {
    return { disabled: true, kind: "pending", label: "取消中", pending: true, variant: "outline" }
  }
  if (activeIntent === "disconnect" || phase === "disconnecting") {
    return { disabled: true, kind: "pending", label: "断开中", pending: true, variant: "outline" }
  }
  if (activeIntent === "connect" || activeIntent === "retry") {
    return { disabled: false, kind: "cancel", label: "取消", pending: false, variant: "outline" }
  }
  if (phase === "connecting") {
    if (canCancel) {
      return { disabled: false, kind: "cancel", label: "取消", pending: false, variant: "outline" }
    }
    return { disabled: true, kind: "pending", label: "连接中", pending: true, variant: "outline" }
  }
  if (phase === "connected") {
    return { disabled: false, kind: "disconnect", label: "断开", pending: false, variant: "outline" }
  }
  if (!ready) {
    return { disabled: false, kind: "configure", label: "配置", pending: false, variant: "outline" }
  }
  if (phase === "partial" || phase === "blocked" || phase === "error") {
    return { disabled: false, kind: "retry", label: "重试", pending: false, variant: "outline" }
  }
  return { disabled: false, kind: "connect", label: "连接", pending: false, variant: "default" }
}
