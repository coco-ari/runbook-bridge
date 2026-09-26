import { useEffect, useState } from "react"
import { SpinnerGap } from "@phosphor-icons/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DiagnosticDetails } from "@/features/connections/DiagnosticDetails"
import type { PublicError } from "@/bridge/ai-ops-v2"

export function OperationSpinner() {
  return <SpinnerGap aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" data-operation-spinner="true" />
}

export function useOperationLabel(active: boolean, label: string) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    if (!active) return
    const started = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return active ? label + (seconds >= 5 ? ` · 响应较慢，已等待 ${seconds} 秒，请勿重复提交` : "") : ""
}

export function OperationMessage({ message, error = false, busy = false, className = "", diagnostic }: {
  readonly message: string; readonly error?: boolean; readonly busy?: boolean; readonly className?: string; readonly diagnostic?: PublicError | undefined
}) {
  const [detail, setDetail] = useState<{ message: string; diagnostic?: PublicError | undefined } | null>(null)
  return <span className="flex min-w-0 items-center gap-1"><Tooltip><TooltipTrigger asChild><span role={error ? "alert" : "status"} aria-live="polite" aria-atomic="true" className={`flex h-6 min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs ${error ? "text-danger" : "text-muted-foreground"} ${className}`}>
    {busy ? <OperationSpinner /> : null}<span className="min-w-0 truncate">{message || "\u00a0"}</span>
  </span></TooltipTrigger><TooltipContent side="top" className="max-w-sm whitespace-pre-wrap break-words">{message}</TooltipContent></Tooltip>
    {error && message ? <Button className="h-6 shrink-0 px-1.5" size="xs" variant="ghost" onClick={() => setDetail({ message, diagnostic })}>详情</Button> : null}
    <Dialog open={Boolean(detail)} onOpenChange={open => { if (!open) setDetail(null) }}><DialogContent data-testid="operation-error-details"><DialogHeader><DialogTitle>操作详情</DialogTitle><DialogDescription>当前操作的反馈与处理建议</DialogDescription></DialogHeader><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm">{detail?.message}</p><DiagnosticDetails domain="operation" error={detail?.diagnostic ?? { code: "UNKNOWN_ERROR", message: detail?.message ?? "" }} /></DialogContent></Dialog>
  </span>
}
