import { CaretDown } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"

export function ScopeIdentity({ projectName, environmentName, pluginName, label }: {
  readonly projectName: string
  readonly environmentName?: string | undefined
  readonly pluginName?: string | undefined
  readonly label?: string | undefined
}) {
  const entries = [["项目", projectName], ["环境", environmentName], ["插件", pluginName]]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
  return (
    <Popover key={entries.map(([, name]) => name).join("/")}>
      <PopoverTrigger asChild>
        <Button aria-label="核对完整对象信息" className="-ml-1 max-w-full min-w-0 justify-start gap-1 px-1 text-xs font-normal text-muted-foreground" data-testid="scope-identity-trigger" size="xs" variant="ghost">
          <span className="truncate">{label ?? [projectName, environmentName].filter(Boolean).join(" / ")}</span>
          <CaretDown aria-hidden="true" className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="完整对象信息" className="max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-3" data-testid="scope-identity-content">
        <PopoverTitle>当前操作对象</PopoverTitle>
        <dl className="space-y-3">
          {entries.map(([label, name]) => (
            <div key={label} className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="select-text text-sm [overflow-wrap:anywhere]">{name}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
