import { useEffect, useRef } from "react"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view"
import { defaultKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { search, searchKeymap } from "@codemirror/search"

const keywords = /^(?:const|let|var|function|class|interface|type|enum|export|import|from|return|if|else|for|while|try|catch|finally|throw|new|async|await|def|class|with|as|in|not|and|or|pass|raise|yield|lambda|public|private|protected|static|void|int|string|package|func|struct|go|defer|select|case|switch|break|continue|extends|implements|namespace|using|include)\b/
// A bounded streaming lexer provides common source highlighting without evaluating repository text.
const sourceLanguage = StreamLanguage.define({
  startState: () => ({ block: false, quote: "" }),
  token(stream, state) {
    if (state.block) { if (stream.skipTo("*/")) { stream.match("*/"); state.block = false } else stream.skipToEnd(); return "comment" }
    if (state.quote) {
      let escaped = false, character
      while ((character = stream.next()) !== undefined) { if (character === state.quote && !escaped) { state.quote = ""; break } escaped = !escaped && character === "\\" }
      if (state.quote !== "`") state.quote = ""
      return "string"
    }
    if (stream.eatSpace()) return null
    if (stream.match("//") || stream.match("#")) { stream.skipToEnd(); return "comment" }
    if (stream.match("/*")) { state.block = true; return "comment" }
    if (stream.match(/^["'`]/)) { state.quote = stream.current(); return "string" }
    if (stream.match(keywords)) return "keyword"
    if (stream.match(/^(?:true|false|null|undefined|None|True|False)\b/)) return "atom"
    if (stream.match(/^(?:0[xX][a-fA-F0-9]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)) return "number"
    if (stream.match(/^[A-Za-z_$][\w$]*/)) return "variableName"
    stream.next(); return null
  },
})
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, class: "source-keyword" }, { tag: tags.string, class: "source-string" },
  { tag: tags.comment, class: "source-comment" }, { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "source-number" },
  { tag: tags.propertyName, class: "source-property" },
]))
export interface SourceViewState { scrollTop?: number; anchor?: number }
export function SourceCodeView({ text, filename, line, saved }: { readonly text: string; readonly filename: string; readonly line?: number | undefined; readonly saved: SourceViewState }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: text, selection: { anchor: Math.min(saved.anchor ?? 0, text.length) }, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), highlightActiveLine(), search(), keymap.of([...searchKeymap, ...defaultKeymap]),
      filename.endsWith(".json") ? json() : sourceLanguage, highlight,
      EditorState.phrases.of({ "Find": "查找", "next": "下一个", "previous": "上一个", "all": "全部", "match case": "区分大小写", "by word": "全词匹配", "regexp": "正则", "close": "关闭" }),
      EditorView.contentAttributes.of({ "aria-label": filename + "（只读）" }),
      EditorView.theme({ "&": { height: "100%", fontSize: "13px" }, ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" }, ".cm-content": { padding: "12px 0" }, ".cm-gutters": { background: "var(--muted)", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" }, ".cm-activeLine": { background: "var(--muted)" }, ".cm-panels": { background: "var(--background)", color: "var(--foreground)" } }),
    ] }) })
    editor.current = view; view.scrollDOM.scrollTop = saved.scrollTop ?? 0
    return () => { saved.scrollTop = view.scrollDOM.scrollTop; saved.anchor = view.state.selection.main.anchor; editor.current = null; view.destroy() }
  }, [text, filename, saved])
  useEffect(() => {
    const view = editor.current
    if (view && line) { const at = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from; view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) }) }
  }, [line, text, filename])
  return <div ref={host} className="h-full min-h-0 min-w-0" data-testid="source-code-view" />
}
