import { useEffect, useRef } from "react"
import { Compartment, EditorState } from "@codemirror/state"
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { search, searchKeymap } from "@codemirror/search"

export function RemoteTextCode({ value, separator, label, readOnly = false, ranges, revealLine, onChange, onSave, onLimit }: {
  value: string; separator: string; label: string; readOnly?: boolean
  ranges?: readonly { start: number; end: number; kind: "before" | "after" }[] | undefined
  revealLine?: number | undefined
  onChange?: (value: string) => void; onSave?: () => void; onLimit?: () => void
}) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null)
  const access = useRef(new Compartment())
  const callbacks = useRef({ onChange, onSave, onLimit }); callbacks.current = { onChange, onSave, onLimit }
  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({ doc: value, extensions: [
      EditorState.lineSeparator.of(separator), lineNumbers(), ...(ranges ? [] : [highlightActiveLine()]), history(),
      EditorView.clipboardInputFilter.of(text => text.replace(/\r\n|\r|\n/g, separator)),
      access.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.contentAttributes.of({ role: "textbox", "aria-label": label, "aria-multiline": "true", spellcheck: "false" }),
      EditorState.phrases.of({ Find: "查找", Replace: "替换", next: "下一处", previous: "上一处", all: "全部", "match case": "区分大小写", "by word": "全词", regexp: "正则", close: "关闭" }),
      search({ top: true }), keymap.of([{ key: "Mod-s", run: () => { callbacks.current.onSave?.(); return true } }, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorState.transactionFilter.of(tr => { if (tr.newDoc.length > 1048576) { callbacks.current.onLimit?.(); return [] } return tr }),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange?.(update.state.sliceDoc()) }),
      ...(ranges ? [EditorView.decorations.of(view => {
        const lines = []
        for (const visible of view.visibleRanges) {
          for (let line = view.state.doc.lineAt(visible.from).number; line <= view.state.doc.lineAt(visible.to).number; line++) {
            const range = ranges.find(range => line >= range.start && line <= range.end)
            if (range) lines.push(Decoration.line({ class: "server-edit-diff-" + range.kind }).range(view.state.doc.line(line).from))
          }
        }
        return Decoration.set(lines, true)
      })] : []),
    ] })
    const instance = new EditorView({ parent: host.current, state }); editor.current = instance
    return () => { instance.destroy(); editor.current = null }
  }, [separator, label, ranges])
  useEffect(() => { if (editor.current && editor.current.state.sliceDoc() !== value) editor.current.dispatch({ changes: { from: 0, to: editor.current.state.doc.length, insert: value } }) }, [value])
  useEffect(() => { editor.current?.dispatch({ effects: access.current.reconfigure(EditorState.readOnly.of(readOnly)) }) }, [readOnly])
  useEffect(() => {
    const view = editor.current
    if (view && revealLine !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(Math.max(1, Math.min(revealLine, view.state.doc.lines))).from, { y: "center" }) })
  }, [revealLine, ranges])
  return <div ref={host} className="server-remote-code" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ["s", "f", "h"].includes(event.key.toLowerCase())) event.stopPropagation() }} />
}
