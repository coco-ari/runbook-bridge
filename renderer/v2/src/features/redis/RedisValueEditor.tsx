import { useEffect, useImperativeHandle, useRef, type Ref } from "react"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { defaultKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { foldAll, foldGutter, foldKeymap, forceParsing, HighlightStyle, syntaxHighlighting, unfoldAll } from "@codemirror/language"
import { openSearchPanel, search, searchKeymap } from "@codemirror/search"
import { tags } from "@lezer/highlight"

export interface RedisValueEditorHandle {
  fold: () => void
  unfold: () => void
  find: () => void
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

export function RedisValueEditor({ text, language, wrap, ref }: {
  readonly text: string
  readonly language: "json" | "text" | "hex"
  readonly wrap: boolean
  readonly ref: Ref<RedisValueEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wrapping = useRef(new Compartment())
  useImperativeHandle(ref, () => ({
    fold: () => { if (editor.current) { forceParsing(editor.current, editor.current.state.doc.length, 100); foldAll(editor.current) } },
    unfold: () => { if (editor.current) unfoldAll(editor.current) },
    find: () => { if (editor.current) openSearchPanel(editor.current) },
  }), [])
  useEffect(() => {
    if (!host.current) return
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: text, extensions: [
        // 同时禁止浏览器编辑和文档变更，仅保留选择、复制、折叠及本地查找。
        EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.changeFilter.of(() => false),
        EditorView.contentAttributes.of({ tabindex: "0", role: "textbox", "aria-label": "Redis Value（只读）", "aria-readonly": "true", "aria-multiline": "true" }),
        EditorState.phrases.of(phrases),
        search({ top: true, literal: true }), keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
        ...(language === "json" ? [json(), syntaxHighlighting(highlighting), foldGutter()] : []),
        wrapping.current.of([]),
      ] }),
    })
    editor.current = instance
    return () => { editor.current = null; instance.destroy() }
  }, [text, language])
  useEffect(() => {
    editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrap && language !== "hex" ? EditorView.lineWrapping : []) })
  }, [wrap, text, language])
  return <div className="redis-value-code" data-testid="redis-value" data-mode={language} ref={host}
    onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") event.stopPropagation() }} />
}
