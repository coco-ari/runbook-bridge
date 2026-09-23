import { useEffect, useId, useState, type RefObject } from "react"
import { MagnifyingGlass } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type RedisSearchMode = "keyword" | "exact"
export interface RedisSearchEntry {
  readonly scope: string
  readonly query: string
  readonly mode: RedisSearchMode
}
interface Props {
  readonly value: string
  readonly mode: RedisSearchMode
  readonly history: readonly RedisSearchEntry[]
  readonly visible: boolean
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly onChange: (value: string) => void
  readonly onModeChange: (mode: RedisSearchMode) => void
  readonly onSubmit: (query: string, mode: RedisSearchMode) => void
  readonly onClearHistory: () => void
}

export function RedisKeySearch({ value, mode, history, visible, disabled, inputRef, onChange, onModeChange, onSubmit, onClearHistory }: Props) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(-1)
  const suggestions = history.filter((entry) => entry.query.toLocaleLowerCase().includes(value.toLocaleLowerCase())).slice(0, 8)
  const expanded = open && visible && !disabled && suggestions.length > 0
  useEffect(() => { if (!visible) { setOpen(false); setSelected(-1) } }, [visible])
  function submit(query = value, searchMode = mode) {
    setOpen(false); setSelected(-1)
    if (!disabled && visible) onSubmit(query, searchMode)
  }
  return <form className="redis-searchbox" onSubmit={(event) => { event.preventDefault(); submit() }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setSelected(-1) } }}>
    <Input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && suggestions[selected] ? listId + "-" + selected : undefined}
      aria-label={mode === "exact" ? "完整 Key" : "Key 关键词"} placeholder={mode === "exact" ? "输入完整 Key" : "关键词或 * 模式，Enter 查找"}
      autoComplete="off" spellCheck={false} value={value} data-testid="redis-search-input"
      onFocus={() => { setOpen(true); setSelected(-1) }}
      onChange={(event) => { onChange(event.target.value); setOpen(true); setSelected(-1) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          if (event.key === "Enter") event.preventDefault()
          return
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
          event.preventDefault(); setOpen(true)
          setSelected(event.key === "ArrowDown" ? (expanded ? selected + 1 : 0) % suggestions.length : (expanded && selected >= 0 ? selected - 1 + suggestions.length : suggestions.length - 1) % suggestions.length)
        } else if (event.key === "Escape" && expanded) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); setSelected(-1)
        } else if (event.key === "Enter" && expanded && suggestions[selected]) {
          event.preventDefault(); submit(suggestions[selected].query, suggestions[selected].mode)
        }
      }} />
    <Button type="submit" size="icon-xs" variant="ghost" aria-label="搜索 Key" title="搜索 Key（Enter）" disabled={disabled} data-testid="redis-search-submit"><MagnifyingGlass /></Button>
    <label className="redis-exact-toggle" title="勾选后直接读取完整 Key；未勾选时支持关键词包含、* 任意字符和 ? 单个字符，区分大小写。">
      <input type="checkbox" checked={mode === "exact"} onChange={(event) => { setOpen(false); setSelected(-1); onModeChange(event.target.checked ? "exact" : "keyword") }} aria-label="精确匹配 Key" data-testid="redis-search-exact" />
      <span>精确匹配</span>
    </label>
    {expanded ? <div className="redis-search-history" data-testid="redis-search-history">
      <div className="redis-search-history-heading"><span>最近搜索</span><Button type="button" size="xs" variant="ghost" data-testid="redis-search-history-clear"
        onClick={() => { onClearHistory(); setOpen(false); setSelected(-1); inputRef.current?.focus() }}>清空记录</Button></div>
      <div role="listbox" id={listId} aria-label="最近的 Key 搜索">
        {suggestions.map((entry, index) => <button type="button" role="option" aria-selected={selected === index} id={listId + "-" + index}
          key={JSON.stringify([entry.query, entry.mode])} tabIndex={-1} className="redis-search-suggestion" data-testid="redis-search-suggestion"
          title={entry.query} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => submit(entry.query, entry.mode)}>
          <span>{entry.query}</span><small>{entry.mode === "exact" ? "精确" : "模糊"}</small>
        </button>)}
      </div>
    </div> : null}
  </form>
}
