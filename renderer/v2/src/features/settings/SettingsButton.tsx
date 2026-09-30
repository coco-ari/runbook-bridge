import { createContext, useContext } from "react"
import { GearSix } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"

export const SettingsNavigationContext = createContext<(() => void) | null>(null)

export function SettingsButton({ className, variant = "ghost", iconOnly = false }: {
  readonly className?: string
  readonly variant?: "ghost" | "outline"
  readonly iconOnly?: boolean
}) {
  const openSettings = useContext(SettingsNavigationContext)
  return <Button className={className} size={iconOnly ? "icon-sm" : "sm"} variant={variant} type="button" aria-label="应用设置" title="应用设置" data-testid="settings-open" onClick={() => openSettings?.()}>
    <GearSix aria-hidden="true" size={16} />{iconOnly ? null : <span className="text-xs">应用设置</span>}
  </Button>
}
