import { useEffect, useState } from "react"
import type { AiOpsV2Api, MysqlPluginGroupData, PluginRecord } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"

export function MysqlPluginGroupNotice({ api, plugin, disabled, available, selected, discovering, onDiscover, onSelect, name, onName }: {
  readonly api: AiOpsV2Api
  readonly plugin: PluginRecord
  readonly disabled: boolean
  readonly available: readonly string[]
  readonly selected: readonly string[] | null
  readonly discovering: boolean
  readonly onDiscover: () => void
  readonly onSelect: (databases: readonly string[]) => void
  readonly name: string | null
  readonly onName: (value: string) => void
}) {
  const [group, setGroup] = useState<MysqlPluginGroupData | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setError("")
    setGroup(null)
    void api.describeMysqlPluginGroup(plugin).then(result => {
      if (!active) return
      if (result.ok) setGroup(result.data)
      else setError(result.error.message)
    }).catch(() => { if (active) setError("无法读取连接信息，请重试。") })
    return () => { active = false }
  }, [api, plugin, attempt])
  const original = group?.members.map(item => item.database) ?? []
  const selection = selected ?? original
  const choices = [...new Set([...original, ...available, ...selection])]
  return <div className="space-y-3 rounded-xl border border-border-group bg-surface-raised/50 p-4 text-sm" data-testid="mysql-group-notice">
    <label className="grid gap-2" htmlFor="mysql-connection-name">连接名称<Input id="mysql-connection-name" disabled={disabled || !group} maxLength={120} value={name ?? group?.name ?? ""} onChange={event => onName(event.target.value)} /></label>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="break-words font-medium">管理数据库 · {selection.length} 个库</p>
      <Button type="button" variant="outline" size="sm" disabled={disabled || discovering || !group} onClick={onDiscover}>{discovering ? "读取中…" : "读取数据库"}</Button>
    </div>
    <p className="text-muted-foreground">这些数据库共享下方的连接配置。勾选其他库可扩展为数据库组；取消关联会保留为独立单库。每个库的 Agent 权限独立生效。</p>
    {group ? <div className="max-h-56 overflow-auto rounded-lg border p-2" data-testid="mysql-managed-databases">
      {choices.map(database => <label key={database} data-database={database} className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-surface-hover">
        <Checkbox disabled={disabled} checked={selection.includes(database)} onCheckedChange={checked => onSelect(checked === true ? [...selection, database] : selection.filter(item => item !== database))} />
        <span className="break-all font-mono text-sm">{database}</span>
        {original.includes(database) ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">已关联</span> : null}
      </label>)}
    </div> : <p role="status">{error || "正在读取连接信息…"}</p>}
    {group && selection.length === 0 ? <p role="alert" className="text-destructive">请至少保留一个数据库。</p> : null}
    {error ? <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重新读取</Button> : null}
  </div>
}
