import { createContext, useContext } from "react"
import type { EnvironmentType } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"

export const EnvironmentTypeContext = createContext<EnvironmentType>("unspecified")

export function EnvironmentTypeBadge({ type }: { readonly type?: EnvironmentType | undefined }) {
  const inherited = useContext(EnvironmentTypeContext)
  const value = type ?? inherited
  if (value !== "production" && value !== "test") return null
  return <Badge className="w-fit shrink-0" variant={value === "production" ? "warning" : "info"} data-testid="environment-type-badge" data-environment-type={value}>
    {value === "production" ? "生产环境" : "测试环境"}
  </Badge>
}
