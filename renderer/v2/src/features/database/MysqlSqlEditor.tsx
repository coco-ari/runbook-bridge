import { copyMysqlText } from "./mysql-clipboard"
import { Copy, Play } from "@phosphor-icons/react"
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

import type { MysqlTableDescription, MysqlTableSummary } from "@/bridge/ai-ops-v2"
import { MYSQL_TABLE_DRAG_TYPE, mysqlCompletionContext, mysqlSqlDiagnostic, quoteMysqlIdentifier, type MysqlSqlDiagnostic } from "./mysql-sql-assist"

interface MysqlSqlEditorProps {
  readonly tables: readonly MysqlTableSummary[]
  readonly getSchema: (table: string) => Promise<MysqlTableDescription>
  readonly onTableDrop: (data: string) => void
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

export function MysqlSqlEditor({ active = true, value, loading, collapsed, onChange, onRun, tables, getSchema, onTableDrop }: MysqlSqlEditorProps) {
  const uniqueId = useId()
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const numbersRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [retry, setRetry] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [choices, setChoices] = useState<readonly { name: string; type: string }[]>([])
  const [choiceIndex, setChoiceIndex] = useState(0)
  const [assistNotice, setAssistNotice] = useState("")
  const [diagnostic, setDiagnostic] = useState<{ sql: string; value: MysqlSqlDiagnostic | null } | null>(null)
  const context = useMemo(() => mysqlCompletionContext(value, caret, tables), [value, caret, tables])
  const completionKey = value + "\0" + caret
  const showChoices = active && focused && !composing && !loading && dismissed !== completionKey && choices.length > 0
  const currentDiagnostic = diagnostic?.sql === value ? diagnostic.value : null
  useEffect(() => {
    if (!active || composing) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void mysqlSqlDiagnostic(value).then(result => { if (!cancelled) setDiagnostic({ sql: value, value: result }) })
        .catch(() => { if (!cancelled) setDiagnostic({ sql: value, value: { kind: "error", message: "语法检查暂不可用，执行时仍会校验。" } }) })
    }, 400)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [active, composing, value])
  useEffect(() => {
    setChoices([])
    setChoiceIndex(0)
    setAssistNotice("")
    if (!context || !focused || !active || composing || loading) return
    let cancelled = false
    const matches = (name: string) => name.toLowerCase().startsWith(context.prefix.toLowerCase())
    if (context.kind === "table") setChoices(tables.filter(table => table.queryable && matches(table.name)).slice(0, 30).map(table => ({ name: table.name, type: "表" })))
    else if (context.table) {
      void getSchema(context.table).then(description => {
        if (cancelled) return
        setChoices(description.columns.filter(column => matches(column.name)).slice(0, 30).map(column => ({ name: column.name, type: column.type })))
        if (description.auditWarning) setAssistNotice("字段已读取，但操作记录未能保存。")
      }).catch(() => { if (!cancelled) setAssistNotice("字段读取失败，按 Ctrl+Space 重试。") })
    }
    return () => { cancelled = true }
  }, [context, focused, active, composing, loading, getSchema, tables, retry])
  useEffect(() => {
    if (showChoices) document.getElementById(`${uniqueId}-choice-${choiceIndex}`)?.scrollIntoView({ block: "nearest" })
  }, [showChoices, uniqueId, choiceIndex])
  function insertChoice(index: number) {
    const choice = choices[index]
    if (!choice || !context) return
    const inserted = quoteMysqlIdentifier(choice.name)
    const next = value.slice(0, context.start) + inserted + value.slice(context.end)
    onChange(next)
    setChoices([])
    window.setTimeout(() => { const editor = editorRef.current; if (!editor) return; editor.focus(); editor.setSelectionRange(context.start + inserted.length, context.start + inserted.length); syncCursor() }, 0)
  }
  const highlighted = useMemo(() => highlightedSql(value), [value])
  const lineCount = value.split("\n").length

  function syncCursor() {
    const editor = editorRef.current
    if (!editor) return
    const before = editor.value.slice(0, editor.selectionStart).split("\n")
    setCaret(editor.selectionStart)
    setCursor({ line: before.length, column: (before.at(-1)?.length ?? 0) + 1 })
  }

  async function copySql() {
    try {
      await copyMysqlText(value)
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
      <div className="mysql-editor-code" onDragOver={(event) => { if (event.dataTransfer.types.includes(MYSQL_TABLE_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy" } }} onDrop={(event) => { if (event.dataTransfer.types.includes(MYSQL_TABLE_DRAG_TYPE)) { event.preventDefault(); if (!loading) onTableDrop(event.dataTransfer.getData(MYSQL_TABLE_DRAG_TYPE)) } }}>
        <div aria-hidden="true" className="mysql-editor-line-numbers" ref={numbersRef}>{Array.from({ length: lineCount }, (_, index) => <span className={currentDiagnostic?.line === index + 1 ? "mysql-sql-error-line" : undefined} title={currentDiagnostic?.line === index + 1 ? currentDiagnostic.message : undefined} key={index}>{index + 1}</span>)}</div>
        <div className="mysql-editor-layers">
          <pre aria-hidden="true" className="mysql-editor-highlight" ref={highlightRef}>{highlighted}</pre>
          <textarea
            aria-describedby={`${uniqueId}-hint`}
            aria-label="SQL 语句"
            aria-autocomplete="list"
            aria-controls={showChoices ? `${uniqueId}-completions` : undefined}
            aria-activedescendant={showChoices ? `${uniqueId}-choice-${choiceIndex}` : undefined}
            aria-invalid={currentDiagnostic?.kind === "error" || undefined}
            autoCapitalize="off"
            autoComplete="off"
            className="mysql-editor-input"
            data-testid={active ? "mysql-sql-editor" : undefined}
            disabled={loading}
            onChange={(event) => { onChange(event.target.value); setCaret(event.target.selectionStart); setDismissed(null) }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if ((event.ctrlKey || event.metaKey) && event.code === "Space") { event.preventDefault(); setDismissed(null); setRetry(count => count + 1); syncCursor(); return }
              if (showChoices && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) && !event.ctrlKey && !event.metaKey) {
                event.preventDefault()
                if (event.key === "Escape") setDismissed(completionKey)
                else if (event.key === "Enter" || event.key === "Tab") insertChoice(choiceIndex)
                else setChoiceIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length)
                return
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onRun() }
            }}
            onScroll={(event) => {
              setDismissed(completionKey)
              if (highlightRef.current) { highlightRef.current.scrollTop = event.currentTarget.scrollTop; highlightRef.current.scrollLeft = event.currentTarget.scrollLeft }
              if (numbersRef.current) numbersRef.current.scrollTop = event.currentTarget.scrollTop
            }}
            onSelect={syncCursor}
            placeholder="SELECT 1"
            ref={editorRef}
            spellCheck={false}
            value={value}
          />
          {showChoices ? <div aria-label="SQL 补全建议" className="mysql-editor-completions" data-testid="mysql-sql-completions" id={`${uniqueId}-completions`} role="listbox" style={{ left: Math.max(0, Math.min((cursor.column - 1) * 7.2 - (editorRef.current?.scrollLeft ?? 0), (editorRef.current?.clientWidth ?? 320) - 280)), top: Math.max(0, Math.min(cursor.line * 23 - (editorRef.current?.scrollTop ?? 0), (editorRef.current?.clientHeight ?? 210) - 150)) }}>{choices.map((choice, index) => <button aria-selected={index === choiceIndex} id={`${uniqueId}-choice-${index}`} key={choice.name} onMouseDown={(event) => event.preventDefault()} onClick={() => insertChoice(index)} role="option" tabIndex={-1} type="button"><span>{choice.name}</span><small>{choice.type}</small></button>)}</div> : null}
        </div>
      </div>
      <div className="mysql-editor-status"><span>行 {cursor.line}，列 {cursor.column}</span><span className={currentDiagnostic?.kind === "error" ? "text-danger" : "text-muted-foreground"} data-testid={active ? "mysql-sql-diagnostic" : undefined} title="基础语法检查不访问数据库；字段和权限由执行时校验。">{assistNotice || currentDiagnostic?.message || "拖表生成 SELECT · 表名. 补全字段"}</span><span>UTF-8</span></div>
    </section>
  )
}
