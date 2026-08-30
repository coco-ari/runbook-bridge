import {
  CheckCircle,
  CircleDashed,
  ClockCountdown,
  LockKey,
  WarningCircle,
  XCircle,
  type Icon,
} from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type StatusKind =
  | "connected"
  | "disconnected"
  | "connecting"
  | "partial"
  | "blocked"
  | "error"

const statusDefinitions = {
  connected: {
    Icon: CheckCircle,
    label: "已连接",
    className: "!text-success",
    badgeClassName: "!bg-success/10 !text-success",
    badgeVariant: "success",
  },
  disconnected: {
    Icon: CircleDashed,
    label: "未连接",
    className: "!text-muted-foreground",
    badgeClassName: "!bg-transparent !text-muted-foreground",
    badgeVariant: "outline",
  },
  connecting: {
    Icon: ClockCountdown,
    label: "连接中",
    className: "!text-info",
    badgeClassName: "!bg-info/10 !text-info",
    badgeVariant: "info",
  },
  partial: {
    Icon: WarningCircle,
    label: "部分可用",
    className: "!text-warning",
    badgeClassName: "!bg-warning/10 !text-warning",
    badgeVariant: "warning",
  },
  blocked: {
    Icon: LockKey,
    label: "已阻塞",
    className: "!text-warning",
    badgeClassName: "!bg-warning/10 !text-warning",
    badgeVariant: "warning",
  },
  error: {
    Icon: XCircle,
    label: "错误",
    className: "!text-danger",
    badgeClassName: "!bg-danger/10 !text-danger",
    badgeVariant: "danger",
  },
} satisfies Record<
  StatusKind,
  {
    readonly Icon: Icon
    readonly label: string
    readonly className: string
    readonly badgeClassName: string
    readonly badgeVariant: "success" | "outline" | "info" | "warning" | "danger"
  }
>

interface StatusIndicatorProps {
  readonly appearance?: "inline" | "badge"
  readonly className?: string
  readonly compact?: boolean
  readonly status: StatusKind
}

export function StatusIndicator({
  appearance = "inline",
  className,
  compact = false,
  status,
}: StatusIndicatorProps) {
  const definition = statusDefinitions[status]
  const { Icon } = definition

  const content = (
    <>
      <Icon aria-hidden="true" size={13} weight={status === "connected" ? "fill" : "regular"} />
      <span className={compact ? "sr-only" : undefined}>{definition.label}</span>
    </>
  )

  if (appearance === "badge") {
    return (
      <Badge
        className={cn("gap-1 text-xs", definition.badgeClassName, className)}
        data-status={status}
        title={definition.label}
        variant={definition.badgeVariant}
      >
        {content}
      </Badge>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium leading-4",
        definition.className,
        className,
      )}
      data-status={status}
      title={definition.label}
    >
      {content}
    </span>
  )
}

export function statusLabel(status: StatusKind): string {
  return statusDefinitions[status].label
}
