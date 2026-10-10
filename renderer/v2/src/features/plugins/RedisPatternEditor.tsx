import { useState } from "react"
import { redisKeyAllowed } from "../../../../../src/redis-key-pattern.mjs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { RedisPattern } from "@/features/redis/redis-workspace-model"

export function RedisPatternEditor({ patterns, onChange, disabled }: { patterns: readonly RedisPattern[]; onChange: (patterns: readonly RedisPattern[]) => void; disabled: boolean }) {
  const [example, setExample] = useState("")
  const matches = patterns.filter(item => item.pattern && redisKeyAllowed(item.pattern, example))
  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3 @md/agent-access:col-span-2" data-testid="redis-pattern-editor">
    <legend className="px-1 text-sm font-medium">允许访问的 Key 范围</legend>
    <p className="text-xs text-muted-foreground">同时约束桌面工作区和 Agent。* 匹配任意字符，? 匹配一个字符，其他字符按字面匹配。多个范围取并集；* 表示整个 Logical DB。</p>
    {patterns.map((item, index) => <div key={item.patternId} className="flex flex-wrap gap-2">
      <Input className="min-w-28 flex-1" aria-label={`范围 ${index + 1} 名称`} value={item.displayName} maxLength={80} onChange={event => onChange(patterns.map(row => row.patternId === item.patternId ? { ...row, displayName: event.target.value } : row))} />
      <Input className="min-w-36 flex-1 font-mono" aria-label={`范围 ${index + 1} 模式`} placeholder="service:*" value={item.pattern} maxLength={256} onChange={event => onChange(patterns.map(row => row.patternId === item.patternId ? { ...row, pattern: event.target.value } : row))} />
      <Button size="sm" variant="ghost" disabled={patterns.length <= 1} aria-label={`删除范围 ${index + 1}`} onClick={() => onChange(patterns.filter(row => row.patternId !== item.patternId))}>删除</Button>
    </div>)}
    <Button size="xs" variant="outline" disabled={patterns.length >= 64} onClick={() => onChange([...patterns, { patternId: `pattern-${crypto.randomUUID()}`, displayName: "新范围", pattern: "" }])}>添加 Key 范围</Button>
    <label className="block space-y-1 text-xs">试算 Key（仅本地匹配，不读取 Redis）<Input aria-label="试算 Key" value={example} maxLength={512} placeholder="service:example" onChange={event => setExample(event.target.value)} /></label>
    {example ? <p role="status" className="text-xs">{matches.length ? `允许：${matches.map(item => item.displayName).join("、")}` : "不在允许范围内"}</p> : null}
  </fieldset>
}
