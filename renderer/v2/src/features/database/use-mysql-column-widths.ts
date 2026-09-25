import { useEffect, useRef, useState, type PointerEvent } from "react"
import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"
import { autoMysqlColumnWidths, clampMysqlColumnWidth, mysqlColumnSignature, readMysqlColumnWidths, type MysqlWidthCache } from "./mysql-column-widths"

function measureText() {
  const context = document.createElement("canvas").getContext("2d")
  if (!context) return undefined
  context.font = "12px " + (getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace")
  return (text: string) => context.measureText(text).width
}
export function useMysqlColumnWidths(result: MysqlQueryResult, cache: MysqlWidthCache, scopeKey: string, persistent: boolean) {
  const signature = mysqlColumnSignature(result.columns)
  const identity = JSON.stringify([scopeKey, signature])
  const storageKey = "mysql-column-widths:v1:" + identity
  function initialWidths() {
    const remembered = cache.get(identity)
    if (remembered) return remembered
    if (persistent) {
      try {
        const stored = readMysqlColumnWidths(localStorage.getItem(storageKey), result.columns.length)
        if (stored) return stored
      } catch { /* 存储不可用时仍可在当前会话内调整列宽。 */ }
    }
    return autoMysqlColumnWidths(result.columns, result.rows, measureText())
  }
  const [state, setState] = useState(() => ({ identity, widths: initialWidths() }))
  const widths = state.identity === identity ? state.widths : initialWidths()
  if (state.identity !== identity) setState({ identity, widths })
  const drag = useRef<{ pointer: number; index: number; x: number; start: readonly number[]; next: readonly number[]; element: HTMLElement } | null>(null)
  const frame = useRef(0)
  function remember(next: readonly number[]) {
    cache.set(identity, next)
    // 同一标签只保留最近的字段组合，避免长期切换查询累积无界状态。
    if (cache.size > 64) cache.delete(cache.keys().next().value!)
    if (persistent) { try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* 本地存储失败不影响表格操作。 */ } }
  }
  useEffect(() => { remember(widths) }, [identity])
  function apply(next: readonly number[]) { setState({ identity, widths: next }); remember(next) }
  function setWidth(index: number, width: number) { apply(widths.map((value, position) => position === index ? clampMysqlColumnWidth(width) : value)) }
  function fit(index?: number, rows = result.rows) {
    const fitted = autoMysqlColumnWidths(result.columns, rows, measureText(), 640)
    apply(index === undefined ? fitted : widths.map((value, position) => position === index ? fitted[position] ?? value : value))
  }
  function reset() { apply(autoMysqlColumnWidths(result.columns, result.rows, measureText())) }
  function finish(cancel = false) {
    const current = drag.current
    if (!current) return
    drag.current = null; cancelAnimationFrame(frame.current); frame.current = 0
    if (cancel) setState({ identity, widths: current.start })
    else apply(current.next)
    if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer)
  }
  function down(event: PointerEvent<HTMLElement>, index: number) {
    if (event.button !== 0 || drag.current) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    drag.current = { pointer: event.pointerId, index, x: event.clientX, start: widths, next: widths, element: event.currentTarget }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement> | globalThis.PointerEvent) {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    current.next = current.start.map((value, index) => index === current.index ? clampMysqlColumnWidth(value + event.clientX - current.x) : value)
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (drag.current) setState({ identity, widths: drag.current.next }) })
  }
  useEffect(() => {
    // 在窗口层结束拖动，指针越过列边界或离开表格时也不会遗留调整状态。
    const up = (event: globalThis.PointerEvent) => { if (drag.current?.pointer === event.pointerId) { move(event); finish() } }
    const cancel = (event: globalThis.PointerEvent) => { if (drag.current?.pointer === event.pointerId) finish(true) }
    const escape = (event: KeyboardEvent) => { if (drag.current && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(true) } }
    const blur = () => finish(true)
    window.addEventListener("blur", blur)
    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", cancel, true)
    window.addEventListener("keydown", escape, true)
    return () => {
      cancelAnimationFrame(frame.current); frame.current = 0; drag.current = null
      window.removeEventListener("blur", blur)
      window.removeEventListener("pointermove", move, true)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", cancel, true)
      window.removeEventListener("keydown", escape, true)
    }
  }, [identity])
  return { widths, setWidth, fit, reset, down, finish }
}
