import { useEffect, useState } from "react"
import { CaretDown } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { RedisPattern } from "./redis-workspace-model"

interface Props {
  readonly database: string
  readonly patterns: readonly RedisPattern[]
  readonly patternId: string
  readonly visible: boolean
  readonly onChange: (patternId: string) => void
}

export function RedisScopePicker({ database, patterns, patternId, visible, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const selected = patterns.find((pattern) => pattern.patternId === patternId)
  const label = selected?.pattern === "*" ? "全部 Key（*）" : selected?.pattern ?? "未配置范围"
  const description = selected ? "Key 范围：" + selected.displayName + "（" + selected.pattern + "）" : "请先在插件配置中登记 Key 范围"

  useEffect(() => { if (!visible) setOpen(false) }, [visible])

  return <div className="redis-scope-identity">
    <span className="redis-db-label" title="固定使用当前插件配置的数据库">DB {database}</span>
    {patterns.length > 1 ? <DropdownMenu open={open && visible} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" className="redis-scope-trigger" aria-label={"切换 Key 范围，当前 " + label} title={description} data-testid="redis-pattern">
        <span data-testid="redis-pattern-current">{label}</span><CaretDown />
      </Button></DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 max-w-[calc(100vw-24px)]" align="start" onCloseAutoFocus={(event) => { if (!visible) event.preventDefault() }}>
        <DropdownMenuLabel>已登记的 Key 范围</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={patternId} onValueChange={(value) => { setOpen(false); onChange(value) }}>
          {patterns.map((pattern) => <DropdownMenuRadioItem key={pattern.patternId} value={pattern.patternId} data-testid={"redis-pattern-option-" + pattern.patternId}>
            <span className="min-w-0"><span className="block truncate text-xs">{pattern.displayName}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{pattern.pattern === "*" ? "全部允许 Key（*）" : pattern.pattern}</span></span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu> : <span className="redis-scope-static" title={description} data-testid="redis-pattern-current">{label}</span>}
  </div>
}
