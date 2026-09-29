import { createContext, useContext } from "react"
import { GearSix } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"

export const SettingsNavigationContext = createContext<(() => void) | null>(null)

export function SettingsButton({ className }: { readonly className?: string }) {
  const openSettings = useContext(SettingsNavigationContext)
  return <Button className={className} size="sm" variant="ghost" type="button" aria-label="应用设置" title="应用设置" data-testid="settings-open" onClick={() => openSettings?.()}>
    <GearSix aria-hidden="true" size={16} /><span className="text-xs">应用设置</span>
  </Button>
}
