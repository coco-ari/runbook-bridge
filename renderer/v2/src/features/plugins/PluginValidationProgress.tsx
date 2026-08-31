import { CheckCircle, CircleNotch, WarningCircle, XCircle } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import type { PluginValidationState } from "@/features/plugins/plugin-editor-model"
import { cn } from "@/lib/utils"

interface PluginValidationProgressProps {
  readonly validation: PluginValidationState | null
  readonly onCancel: () => void
}

const COPY = {
  running: { label: "检查中", description: "使用一次性临时连接，不改变正式运行状态。" },
  "awaiting-confirmation": { label: "等待确认", description: "请核对确认弹窗中的信息。只有明确确认后，才会继续检查当前草稿。" },
  valid: { label: "检查通过", description: "当前草稿通过连接与协议检查。" },
  failed: { label: "检查失败", description: "请根据错误修正当前草稿后重试。" },
  cancelled: { label: "已取消", description: "临时检查已停止，正式配置没有改变。" },
  stale: { label: "结果已过期", description: "草稿已变化，需要重新检查。" },
} as const

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  "resource-access": "资源访问",
  "server-auth": "SSH 认证",
  "tls-probe": "TLS 探测",
}

export function PluginValidationProgress({
  validation,
  onCancel,
}: PluginValidationProgressProps) {
  if (!validation) return null
  const copy = COPY[validation.state]
  const Icon = validation.state === "running"
    ? CircleNotch
    : validation.state === "valid"
      ? CheckCircle
      : validation.state === "failed"
        ? XCircle
        : WarningCircle
  const variant = validation.state === "valid"
    ? "success"
    : validation.state === "failed"
      ? "danger"
      : validation.state === "running"
        ? "info"
        : "warning"

  return (
    <Alert
      aria-live="polite"
      className="bg-surface-inset"
      data-testid="plugin-validation-progress"
      variant={validation.state === "failed" ? "destructive" : "default"}
    >
      <Icon
        aria-hidden="true"
        className={cn(validation.state === "running" && "animate-spin")}
      />
      <AlertTitle className="flex items-center gap-2">
        {copy.label}
        <Badge variant={variant}>{PURPOSE_LABELS[validation.purpose] ?? "连接检查"}</Badge>
      </AlertTitle>
      <AlertDescription className="space-y-2 text-xs leading-5">
        <span className="block">{copy.description}</span>
        {validation.state === "running" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Progress className="min-w-32 flex-1" aria-label="插件配置检查进行中" value={null} />
            <Button onClick={onCancel} size="xs" type="button" variant="outline">
              取消检查
            </Button>
          </div>
        ) : null}
        {validation.error ? <p className="font-medium text-danger">{validation.error.message}</p> : null}
      </AlertDescription>
    </Alert>
  )
}
