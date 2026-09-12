import { Copy, Play } from "@phosphor-icons/react"
import { useId, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

interface MysqlSqlEditorProps {
  readonly active?: boolean
  readonly value: string
  readonly loading: boolean
  readonly collapsed: boolean
  readonly onChange: (value: string) => void
  readonly onRun: () => void
}

function highlightedSql(source: string): ReactNode[] {
  const tokens: ReactNode[] = []
  const pattern = /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`|\b(?:SELECT|FROM|WHERE|ORDER|BY|DESC|ASC|LIMIT|AS|AND|OR|IS|NOT|NULL|JOIN|LEFT|RIGHT|INNER|ON|GROUP|HAVING|EXPLAIN|COUNT|SUM|AVG|MIN|MAX|DISTINCT|IN|LIKE|BETWEEN|OFFSET|CASE|WHEN|THEN|ELSE|END)\b|\b\d+(?:\.\d+)?\b)/gi
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    tokens.push(source.slice(offset, match.index))
    const token = match[0]
    const kind = token.startsWith("--") || token.startsWith("/*") ? "comment" : /^[`'"]/.test(token) ? "string" : /^\d/.test(token) ? "number" : "keyword"
    tokens.push(<span className={`mysql-sql-${kind}`} key={match.index}>{token}</span>)
    offset = match.index + token.length
  }
  tokens.push(source.slice(offset), "\n")
  return tokens
}

export function MysqlSqlEditor({ active = true, value, loading, collapsed, onChange, onRun }: MysqlSqlEditorProps) {
  const uniqueId = useId()
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const numbersRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const highlighted = useMemo(() => highlightedSql(value), [value])
  const lineCount = value.split("\n").length

  function syncCursor() {
    const editor = editorRef.current
    if (!editor) return
    const before = editor.value.slice(0, editor.selectionStart).split("\n")
    setCursor({ line: before.length, column: (before.at(-1)?.length ?? 0) + 1 })
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("SQL 已复制")
    } catch {
      toast.error("无法访问剪贴板，请选中 SQL 后复制。")
    }
  }

  return (
    <section aria-label="SQL 编辑器" className={`mysql-sql-editor-panel ${collapsed ? "is-collapsed" : ""}`} data-testid={active ? "mysql-query-editor-panel" : undefined}>
      <div className="mysql-editor-toolbar">
        <Button data-testid={active ? "mysql-query-run" : undefined} disabled={loading || !value.trim()} onClick={onRun} size="sm" type="button">
          <Play aria-hidden="true" weight="fill" />{loading ? "查询中…" : "执行查询"}<kbd className="ml-2 hidden font-mono text-[10px] opacity-65 sm:inline">Ctrl ↵</kbd>
        </Button>
        <Button aria-label="复制 SQL" data-testid={active ? "mysql-query-copy" : undefined} disabled={!value} onClick={() => void copySql()} size="icon-sm" title="复制 SQL" type="button" variant="ghost"><Copy aria-hidden="true" /></Button>
        <p className="mysql-editor-hint" id={`${uniqueId}-hint`}>支持单条 SELECT · Ctrl / ⌘ + Enter 执行</p>
        <span className="mysql-editor-dialect">MySQL</span>
      </div>
      <div className="mysql-editor-code">
        <div aria-hidden="true" className="mysql-editor-line-numbers" ref={numbersRef}>{Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
        <div className="mysql-editor-layers">
          <pre aria-hidden="true" className="mysql-editor-highlight" ref={highlightRef}>{highlighted}</pre>
          <textarea
            aria-describedby={`${uniqueId}-hint`}
            aria-label="SQL 语句"
            autoCapitalize="off"
            autoComplete="off"
            className="mysql-editor-input"
            data-testid={active ? "mysql-sql-editor" : undefined}
            disabled={loading}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onRun() }
            }}
            onScroll={(event) => {
              if (highlightRef.current) { highlightRef.current.scrollTop = event.currentTarget.scrollTop; highlightRef.current.scrollLeft = event.currentTarget.scrollLeft }
              if (numbersRef.current) numbersRef.current.scrollTop = event.currentTarget.scrollTop
            }}
            onSelect={syncCursor}
            placeholder="SELECT 1"
            ref={editorRef}
            spellCheck={false}
            value={value}
          />
        </div>
      </div>
      <div className="mysql-editor-status"><span>行 {cursor.line}，列 {cursor.column}</span><span>UTF-8</span><span>只读查询</span></div>
    </section>
  )
}
