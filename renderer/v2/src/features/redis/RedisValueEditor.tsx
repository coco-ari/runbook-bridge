import { useEffect, useImperativeHandle, useRef, type Ref } from "react"
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state"
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { foldAll, foldGutter, foldKeymap, forceParsing, HighlightStyle, syntaxHighlighting, unfoldAll } from "@codemirror/language"
import { openSearchPanel, search, searchKeymap } from "@codemirror/search"
import { tags } from "@lezer/highlight"
import { redisEditorLimit } from "./redis-editor-model"
import { formatRedisJson } from "./redis-value-format"

export interface RedisValueEditorHandle {
  fold: () => void
  unfold: () => void
  find: () => void
  replace: (text: string) => void
  formatJson: () => void
}
const externalUpdate = Annotation.define<boolean>()
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

export function RedisValueEditor({ text, language, wrap, ref, readOnly = true, disabled = false, invalid = false, autoFocus = false, maxBytes = 65536, onChange, onSave, onLimit }: {
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
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wrapping = useRef(new Compartment())
  const syntax = useRef(new Compartment())
  const access = useRef(new Compartment())
  const attributes = useRef(new Compartment())
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
    formatJson: () => {
      const view = editor.current
      if (!view || callbacks.current.readOnly || callbacks.current.disabled) return
      const value = formatRedisJson(view.state.sliceDoc())
      if (value !== null) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")] })
    },
  }), [])
  useEffect(() => {
    if (!host.current) return
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: text, extensions: [
        lineNumbers(), history(), ...(readOnly ? [] : [highlightActiveLine()]),
        access.current.of([]), attributes.current.of([]),
        EditorState.phrases.of(phrases),
        search({ top: true, literal: true }), keymap.of([
          { key: "Mod-s", run: () => { callbacks.current.onSave?.(); return true } },
          ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
        ]),
        syntax.current.of([]), wrapping.current.of([]),
        // 只读和待核实状态都禁止用户改文档，受控值同步通过专用标记保持原文。
        EditorState.changeFilter.of(tr => Boolean(tr.annotation(externalUpdate)) || !callbacks.current.readOnly && !callbacks.current.disabled),
        EditorState.transactionFilter.of(tr => {
          if (!tr.docChanged || tr.annotation(externalUpdate) || callbacks.current.readOnly) return tr
          const reason = redisEditorLimit(tr.newDoc.toString(), callbacks.current.maxBytes)
          if (reason) { callbacks.current.onLimit?.(reason); return [] }
          return tr
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalUpdate))) callbacks.current.onChange?.(update.state.sliceDoc())
        }),
      ] }),
    })
    editor.current = instance
    if (autoFocus) instance.focus()
    return () => { editor.current = null; instance.destroy() }
  }, [])
  useEffect(() => {
    const view = editor.current
    if (view && view.state.sliceDoc() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] })
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
