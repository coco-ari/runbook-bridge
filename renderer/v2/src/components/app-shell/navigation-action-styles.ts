import { cn } from "@/lib/utils"

export function navigationActionClassName(compact = false): string {
  return cn(
    "h-10 w-full justify-start gap-2 rounded-lg px-3 text-xs font-medium leading-4 text-foreground shadow-none [&_svg]:size-4",
    compact && "gap-1.5 px-1.5",
  )
}
