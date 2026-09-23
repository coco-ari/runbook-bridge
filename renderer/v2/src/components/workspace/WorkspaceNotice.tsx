import type { ComponentProps } from "react"
import { Info, WarningCircle } from "@phosphor-icons/react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

export function WorkspaceNotice({ children, className, variant = "default", ...props }: ComponentProps<typeof Alert>) {
  const Icon = variant === "destructive" ? WarningCircle : Info
  return <Alert {...props} variant={variant} className={cn("shrink-0 rounded-none border-x-0 border-t-0 px-3 py-2", className)}>
    <Icon aria-hidden="true" />
    <AlertDescription className="flex min-w-0 items-center justify-between gap-2 text-xs">{children}</AlertDescription>
  </Alert>
}
