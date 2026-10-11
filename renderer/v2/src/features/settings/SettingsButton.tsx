import { createContext, useContext } from "react"
import { GearSix } from "@phosphor-icons/react"
import { UtilityButton } from "@/components/ui/utility-button"

export const SettingsNavigationContext = createContext<(() => void) | null>(null)

export function SettingsButton({ className, variant = "ghost", iconOnly = false }: {
  readonly className?: string
  readonly variant?: "ghost" | "outline"
  readonly iconOnly?: boolean
}) {
  const openSettings = useContext(SettingsNavigationContext)
  return <UtilityButton className={className} size={iconOnly ? "icon-sm" : "sm"} variant={variant} aria-label="应用设置" title="应用设置" data-testid="settings-open" onClick={() => openSettings?.()}>
    <GearSix aria-hidden="true" />{iconOnly ? null : <span>应用设置</span>}
  </UtilityButton>
}
