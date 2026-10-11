import type { ComponentProps } from "react"
import { Button } from "./button"
import { cn } from "@/lib/utils"

// 全局工具入口共用文字层级；需要关注的状态由图标和角标表达。
export function UtilityButton({ className, variant = "ghost", size = "sm", type = "button", ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} type={type} variant={variant} size={size} className={cn("relative text-xs text-muted-foreground hover:text-foreground", className)} />
}

export function UtilityCount({ count, max = 99, attention = false, floating = false, className, ...props }: Omit<ComponentProps<"span">, "children"> & {
  readonly count: number
  readonly max?: number
  readonly attention?: boolean
  readonly floating?: boolean
}) {
  if (count <= 0) return null
  return <span {...props} aria-hidden="true" data-utility-count className={cn(
    "inline-flex h-4 min-w-3.5 shrink-0 items-center justify-center rounded-sm px-0.5 text-center text-[10px] font-medium leading-4 tabular-nums",
    attention ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
    floating && "absolute -top-0.5 -right-0.5",
    className,
  )}>{count > max ? `${max}+` : count}</span>
}
