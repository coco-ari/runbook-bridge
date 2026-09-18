import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import type { Terminal } from "@xterm/xterm"
import type { SearchAddon, ISearchResultChangeEvent } from "@xterm/addon-search"
import { ArrowDown, ArrowUp, X } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface TerminalSearchHandle { open: () => void }
export interface TerminalSearchEngine { terminal: Terminal; addon: SearchAddon }

export function TerminalSearch({ engine, visible, theme, ref }: {
  readonly engine: TerminalSearchEngine | null
  readonly visible: boolean
  readonly theme: string
  readonly ref: Ref<TerminalSearchHandle>
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<ISearchResultChangeEvent>({ resultIndex: -1, resultCount: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const focusFrame = useRef(0)
  const find = useCallback((previous = false, incremental = false) => {
    if (!engine || !query || !visible) return
    const decorations = theme === "dark"
      ? { matchBackground: "#4d421f", matchBorder: "#a88632", activeMatchBackground: "#70561b", activeMatchBorder: "#facc15", matchOverviewRuler: "#a88632", activeMatchColorOverviewRuler: "#facc15" }
      : { matchBackground: "#fef3c7", matchBorder: "#d97706", activeMatchBackground: "#fde68a", activeMatchBorder: "#92400e", matchOverviewRuler: "#d97706", activeMatchColorOverviewRuler: "#92400e" }
    const options = { caseSensitive, incremental, decorations }
    if (previous) engine.addon.findPrevious(query, options)
    else engine.addon.findNext(query, options)
  }, [engine, query, caseSensitive, theme, visible])

  useImperativeHandle(ref, () => ({
    open() {
      if (!engine || !visible) return
      const selection = engine.terminal.getSelection()
      if (!expanded && selection && selection.length <= 256 && !/[\r\n]/u.test(selection)) setQuery(selection)
      setExpanded(true)
      cancelAnimationFrame(focusFrame.current)
      focusFrame.current = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
    },
  }), [engine, visible, expanded])
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  useEffect(() => {
    const listener = engine?.addon.onDidChangeResults(setResult)
    return () => listener?.dispose()
  }, [engine])
  useEffect(() => {
    if (!engine) return
    if (!expanded || !visible || !query) {
      engine.addon.clearDecorations()
      return
    }
    // 搜索词、大小写或主题变化时清理扩展缓存，确保匹配数量与高亮同步更新。
    const timer = window.setTimeout(() => { engine.addon.clearDecorations(); find(false, true) }, 100)
    return () => window.clearTimeout(timer)
  }, [engine, expanded, visible, query, find])
  const close = () => {
    setExpanded(false)
    engine?.addon.clearDecorations()
    engine?.terminal.clearSelection()
    if (visible) engine?.terminal.focus()
  }
  if (!expanded) return null
  const totalLabel = result.resultCount >= 1000 ? "1000+" : String(result.resultCount)
  const resultLabel = !query ? "当前终端" : !result.resultCount ? "无匹配"
    : result.resultIndex < 0 ? totalLabel + " 处" : (result.resultIndex + 1) + " / " + totalLabel
  return <div className="server-terminal-search" role="search" aria-label="终端内容搜索" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
    else if (event.key === "Enter" && event.target === inputRef.current) { event.preventDefault(); event.stopPropagation(); find(event.shiftKey) }
  }}>
    <Input ref={inputRef} value={query} maxLength={256} aria-label="搜索终端内容" placeholder="搜索已加载的终端内容" spellCheck={false} autoComplete="off"
      onChange={event => setQuery(event.target.value)} />
    <span className="server-terminal-search-count" role="status" aria-live="polite">{resultLabel}</span>
    <div className="server-terminal-search-actions">
      <Button size="icon-sm" variant={caseSensitive ? "secondary" : "ghost"} aria-label="区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive(value => !value)}><span className="font-mono text-xs">Aa</span></Button>
      <Button size="icon-sm" variant="ghost" disabled={!query} aria-label="上一个匹配" title="上一个匹配（Shift+Enter）" onClick={() => find(true)}><ArrowUp /></Button>
      <Button size="icon-sm" variant="ghost" disabled={!query} aria-label="下一个匹配" title="下一个匹配（Enter）" onClick={() => find()}><ArrowDown /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="关闭终端搜索" title="关闭搜索（Esc）" onClick={close}><X /></Button>
    </div>
  </div>
}
