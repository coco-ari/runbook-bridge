import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

export function DisabledReason({ reason, children }: { readonly reason: string; readonly children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span className="inline-flex max-w-full" tabIndex={reason ? 0 : undefined} aria-label={reason || undefined}>{children}</span></TooltipTrigger>{reason ? <TooltipContent>{reason}</TooltipContent> : null}</Tooltip>
}
