import { useEffect, useState } from "react"
import { SpinnerGap } from "@phosphor-icons/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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

export function OperationMessage({ message, error = false, busy = false, className = "" }: {
  readonly message: string; readonly error?: boolean; readonly busy?: boolean; readonly className?: string
}) {
  return <Tooltip><TooltipTrigger asChild><span role={error ? "alert" : "status"} aria-live="polite" aria-atomic="true" className={`flex h-6 min-w-0 items-center gap-1.5 overflow-hidden text-xs ${error ? "text-danger" : "text-muted-foreground"} ${className}`}>
    {busy ? <OperationSpinner /> : null}<span className="min-w-0 truncate">{message || "\u00a0"}</span>
  </span></TooltipTrigger><TooltipContent side="top" className="max-w-sm whitespace-pre-wrap break-words">{message}</TooltipContent></Tooltip>
}
