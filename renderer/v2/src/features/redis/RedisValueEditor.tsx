import { useEffect, useLayoutEffect, useImperativeHandle, useRef, type Ref } from "react"
import { Annotation, Compartment, EditorState, Transaction, type Text, type ChangeSet } from "@codemirror/state"
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { foldAll, foldedRanges, foldEffect, foldGutter, foldKeymap, forceParsing, HighlightStyle, syntaxHighlighting, unfoldAll } from "@codemirror/language"
import { getSearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery, type SearchQuery } from "@codemirror/search"
import { tags } from "@lezer/highlight"
import { REDIS_EDITABLE_BYTES } from "./redis-desktop-limits"
import { runRedisValueWork } from "./use-redis-value-processing"

export interface RedisViewState {
  mode?: "text" | "json" | "hex"
  wrap?: boolean
  capture?: () => void
  pending?: RedisViewState["current"]
  current?: { length: number; scroll: ReturnType<EditorView["scrollSnapshot"]>; anchor: number; query: SearchQuery; searchOpen: boolean; folds: { from: number; to: number }[] }
}

export interface RedisValueEditorHandle {
  fold: () => void
  unfold: () => void
  find: () => void
  replace: (text: string) => void
  formatJson: () => Promise<void>
}
const externalUpdate = Annotation.define<boolean>()
function changedBytes(before: Text, after: Text, changes: ChangeSet, previous: number) {
  let bytes = previous, surrogate = false
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const value = inserted.toString()
    surrogate ||= /[\uD800-\uDFFF]/u.test(before.sliceString(Math.max(0, from - 1), Math.min(before.length, to + 1)) + value)
    bytes += new TextEncoder().encode(value).length - new TextEncoder().encode(before.sliceString(from, to)).length
  })
  // 代理对可能跨越修改边界，涉及此类字符时重新计数，避免低估 UTF-8 容量。
  return surrogate ? new TextEncoder().encode(after.toString()).length : bytes
}
const highlighting = HighlightStyle.define([
  { tag: tags.propertyName, class: "redis-json-property" },
  { tag: tags.string, class: "redis-json-string" },
  { tag: tags.number, class: "redis-json-number" },
  { tag: tags.bool, class: "redis-json-bool" },
  { tag: tags.null, class: "redis-json-null" },
  { tag: [tags.bracket, tags.separator], class: "redis-json-punctuation" },
])
const phrases = {
  "Find": "查找内容", "Replace": "替换", "next": "下一个", "previous": "上一个", "all": "全部",
  "match case": "区分大小写", "by word": "全词匹配", "regexp": "正则", "close": "关闭",
  "Fold line": "折叠此层", "Unfold line": "展开此层", "unfold": "展开", "folded code": "已折叠内容",
  "Go to line": "跳转行", "go": "跳转", "Selection deleted": "已删除选区",
}

export function RedisValueEditor({ text, language, wrap, ref, readOnly = true, disabled = false, invalid = false, autoFocus = false, maxBytes = REDIS_EDITABLE_BYTES, onChange, onSave, onLimit, viewState }: {
  readonly text: string
  readonly language: "json" | "text" | "hex"
  readonly wrap: boolean
  readonly ref: Ref<RedisValueEditorHandle>
  readonly readOnly?: boolean
  readonly disabled?: boolean
  readonly invalid?: boolean
  readonly autoFocus?: boolean
  readonly maxBytes?: number
  readonly onChange?: (text: string) => void
  readonly onSave?: () => void
  readonly onLimit?: (reason: "characters" | "bytes") => void
  readonly viewState?: RedisViewState | undefined
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wrapping = useRef(new Compartment())
  const syntax = useRef(new Compartment())
  const access = useRef(new Compartment())
  const attributes = useRef(new Compartment())
  const byteLength = useRef(0)
  const formatTask = useRef<AbortController | null>(null)
  const restoreView = useRef<RedisViewState["current"]>(undefined)
  const callbacks = useRef({ onChange, onSave, onLimit, maxBytes, readOnly, disabled })
  callbacks.current = { onChange, onSave, onLimit, maxBytes, readOnly, disabled }
  useImperativeHandle(ref, () => ({
    fold: () => { if (editor.current) { forceParsing(editor.current, editor.current.state.doc.length, 100); foldAll(editor.current) } },
    unfold: () => { if (editor.current) unfoldAll(editor.current) },
    find: () => { if (editor.current) openSearchPanel(editor.current) },
    replace: (value) => {
      const view = editor.current
      if (view && !callbacks.current.readOnly && !callbacks.current.disabled) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")] })
    },
    formatJson: async () => {
      const view = editor.current
      if (!view || callbacks.current.readOnly || callbacks.current.disabled) return
      formatTask.current?.abort()
      const controller = new AbortController()
      formatTask.current = controller
      const original = view.state.doc
      try {
        const { text: value } = await runRedisValueWork({ source: original.toString(), mode: "format" }, controller.signal)
        if (value !== null && editor.current === view && original === view.state.doc && !callbacks.current.readOnly && !callbacks.current.disabled) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")] })
      } finally { if (formatTask.current === controller) formatTask.current = null }
    },
  }), [])
  useLayoutEffect(() => {
    if (!host.current) return
    byteLength.current = new TextEncoder().encode(text).length
    const previous = viewState?.pending ?? viewState?.current
    if (viewState) delete viewState.pending
    restoreView.current = previous
    const rememberView = (view: EditorView) => {
      if (!viewState || !view.dom.isConnected || !view.scrollDOM.clientHeight) return
      const folds: { from: number; to: number }[] = []
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { folds.push({ from, to }) })
      viewState.current = { length: view.state.doc.length, scroll: view.scrollSnapshot(), anchor: view.state.selection.main.anchor, query: getSearchQuery(view.state), searchOpen: searchPanelOpen(view.state), folds }
    }
    const instance = new EditorView({
      parent: host.current,
      ...(previous?.length === text.length ? { scrollTo: previous.scroll } : {}),
      state: EditorState.create({ doc: text, extensions: [
        lineNumbers(), history(), ...(readOnly ? [] : [highlightActiveLine()]),
        access.current.of([]), attributes.current.of([]),
        EditorState.phrases.of(phrases),
        search({ top: true, literal: true }), keymap.of([
          { key: "Mod-s", run: () => { callbacks.current.onSave?.(); return true } },
          ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
        ]),
        syntax.current.of([]), wrapping.current.of([]),
        EditorView.domEventHandlers({ scroll: (_event, view) => { rememberView(view) } }),
        // 只读和待核实状态都禁止用户改文档，受控值同步通过专用标记保持原文。
        EditorState.changeFilter.of(tr => Boolean(tr.annotation(externalUpdate)) || !callbacks.current.readOnly && !callbacks.current.disabled),
        EditorState.transactionFilter.of(tr => {
          if (!tr.docChanged || tr.annotation(externalUpdate) || callbacks.current.readOnly) return tr
          const nextBytes = changedBytes(tr.startState.doc, tr.newDoc, tr.changes, byteLength.current)
          const reason = tr.newDoc.length > REDIS_EDITABLE_BYTES ? "characters" : nextBytes > callbacks.current.maxBytes ? "bytes" : null
          if (reason) { callbacks.current.onLimit?.(reason); return [] }
          return tr
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            byteLength.current = changedBytes(update.startState.doc, update.state.doc, update.changes, byteLength.current)
          }
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalUpdate))) callbacks.current.onChange?.(update.state.sliceDoc())
          rememberView(update.view)
        }),
      ] }),
    })
    editor.current = instance
    const captureView = () => { rememberView(instance); if (viewState) viewState.pending = viewState.current }
    if (viewState) viewState.capture = captureView
    if (previous) {
      instance.dispatch({ selection: { anchor: Math.min(previous.anchor, text.length) }, effects: setSearchQuery.of(previous.query) })
      if (previous.searchOpen) openSearchPanel(instance)
    }
    if (autoFocus) instance.focus()
    return () => {
      formatTask.current?.abort()
      // 父节点可能已被移除，优先保留最后一次可见时的滚动快照。
      rememberView(instance)
      if (viewState?.capture === captureView) delete viewState.capture
      editor.current = null; instance.destroy()
    }
  }, [])
  useEffect(() => {
    const view = editor.current
    if (view && view.state.sliceDoc() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] })
    const previous = restoreView.current
    // 后台格式化完成后再恢复对应文档的快照，避免虚拟行尚未测量时被卷回顶部。
    if (view && previous?.length === text.length) {
      view.dispatch({ selection: { anchor: Math.min(previous.anchor, text.length) }, effects: [previous.scroll, ...previous.folds.map(range => foldEffect.of(range))] })
      restoreView.current = undefined
    }
  }, [text])
  useEffect(() => {
    editor.current?.dispatch({ effects: syntax.current.reconfigure(language === "json" ? [json(), syntaxHighlighting(highlighting), foldGutter()] : []) })
  }, [language])
  useEffect(() => {
    const locked = readOnly || disabled
    editor.current?.dispatch({ effects: [
      access.current.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]),
      attributes.current.reconfigure(EditorView.contentAttributes.of({ tabindex: "0", role: "textbox", "aria-label": readOnly ? "Redis Value（只读）" : "Redis Value", "aria-readonly": String(locked), "aria-disabled": String(disabled), "aria-invalid": String(invalid), "aria-multiline": "true", spellcheck: "false" })),
    ] })
  }, [readOnly, disabled, invalid])
  useEffect(() => {
    editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrap && language !== "hex" ? EditorView.lineWrapping : []) })
  }, [wrap, text, language])
  return <div className={"redis-value-code" + (readOnly ? "" : " redis-write-code")} data-testid={readOnly ? "redis-value" : "redis-draft-value"} data-mode={language} data-disabled={disabled} ref={host}
    onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && ["s", "f", "h"].includes(event.key.toLowerCase())) event.stopPropagation() }} />
}
