import { createContext, useContext } from "react"
import type { EnvironmentType } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"

export const EnvironmentTypeContext = createContext<EnvironmentType>("unspecified")

export function EnvironmentTypeBadge({ type, compact = false }: { readonly type?: EnvironmentType | undefined; readonly compact?: boolean }) {
  const inherited = useContext(EnvironmentTypeContext)
  const value = type ?? inherited
  if (value !== "production" && value !== "test") return null
  return <Badge aria-label={value === "production" ? "生产环境" : "测试环境"} className={compact ? "h-5 min-h-5 w-fit shrink-0 px-1 py-0 text-xs leading-4" : "w-fit shrink-0"} title={value === "production" ? "生产环境" : "测试环境"} variant={value === "production" ? "warning" : "info"} data-testid="environment-type-badge" data-environment-type={value}>
    {value === "production" ? compact ? "生产" : "生产环境" : compact ? "测试" : "测试环境"}
  </Badge>
}
