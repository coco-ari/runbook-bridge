import { useEffect, useRef, type PointerEvent, type MouseEvent, type RefObject } from "react"
import { toast } from "sonner"
import type { MysqlInlineEditing } from "./MysqlInlineEditingContext"
import type { MysqlDisplayedRow } from "./mysql-inline-edit-model"
import { paintMysqlRows } from "./mysql-row-selection"

interface Row { row: MysqlDisplayedRow; index: number }
interface Drag {
  pointer: number; start: number; last: number; x: number; y: number; currentY: number
  checked: boolean; moved: boolean; warned: boolean
  initial: ReadonlySet<MysqlDisplayedRow>; selected: ReadonlySet<MysqlDisplayedRow>
}
export function useMysqlRowSelection(rows: readonly Row[], editing: MysqlInlineEditing | null, scroll: RefObject<HTMLDivElement | null>) {
  const current = useRef({rows, editing})
  current.current = {rows, editing}
  const dragging = useRef<Drag | null>(null)
  const anchor = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const animation = useRef(0)

  function finish(cancel = false) {
    const drag = dragging.current
    dragging.current = null
    cancelAnimationFrame(animation.current)
    if (!drag) return
    if (cancel) current.current.editing?.replaceSelection(drag.initial)
    else anchor.current = current.current.rows[drag.start]?.index ?? null
    if (scroll.current?.hasPointerCapture(drag.pointer)) scroll.current.releasePointerCapture(drag.pointer)
  }
  function paint(position: number) {
    const drag = dragging.current
    if (!drag || position < 0) return
    const result = paintMysqlRows(drag.selected, current.current.rows.map(item => item.row), drag.last, position, drag.checked)
    drag.last = position; drag.selected = result.selection
    current.current.editing?.replaceSelection(result.selection)
    if (result.limited && !drag.warned) { drag.warned = true; toast.info("每批最多选择 100 行。") }
  }
  function atPointer() {
    const drag = dragging.current, element = scroll.current
    if (!drag || !element) return
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(drag.x, Math.max(rect.top + 34, Math.min(rect.bottom - 16, drag.currentY)))
    const index = Number(hit?.closest("tr[data-row-index]")?.getAttribute("data-row-index") ?? -1)
    const position = current.current.rows.findIndex(item => item.index === index)
    if (position >= 0 && position !== drag.last) paint(position)
  }
  function tick() {
    const drag = dragging.current, element = scroll.current
    if (!drag || !element) return
    if (drag.moved) {
      const rect = element.getBoundingClientRect()
      const direction = drag.currentY < rect.top + 55 ? -1 : drag.currentY > rect.bottom - 35 ? 1 : 0
      if (direction) { element.scrollTop += direction * 10; atPointer() }
    }
    animation.current = requestAnimationFrame(tick)
  }
  function down(event: PointerEvent, index: number) {
    const control = current.current.editing
    if (event.button !== 0 || !control || control.locked) return
    event.preventDefault(); event.stopPropagation()
    control.finish()
    const position = current.current.rows.findIndex(item => item.index === index)
    const row = current.current.rows[position]?.row
    if (!row) return
    const initial = new Set(control.selection), checked = !initial.has(row)
    const start = event.shiftKey && anchor.current !== null ? current.current.rows.findIndex(item => item.index === anchor.current) : position
    dragging.current = {pointer:event.pointerId,start:position,last:start >= 0 ? start : position,x:event.clientX,y:event.clientY,currentY:event.clientY,checked,moved:false,warned:false,initial,selected:initial}
    suppressClick.current = true
    scroll.current?.setPointerCapture(event.pointerId)
    paint(position)
    animation.current = requestAnimationFrame(tick)
  }
  function move(event: PointerEvent) {
    const drag = dragging.current
    if (!drag || drag.pointer !== event.pointerId) return
    drag.currentY = event.clientY
    if (Math.abs(event.clientY - drag.y) + Math.abs(event.clientX - drag.x) >= 4) drag.moved = true
    if (drag.moved) { event.preventDefault(); atPointer() }
  }
  function click(event: MouseEvent) {
    if (!suppressClick.current) return
    event.preventDefault(); event.stopPropagation(); suppressClick.current = false
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && dragging.current) { event.preventDefault(); event.stopPropagation(); finish(true) } }
    window.addEventListener("keydown", escape, true)
    return () => { cancelAnimationFrame(animation.current); dragging.current = null; window.removeEventListener("keydown", escape, true) }
  }, [])
  return {dragging, down, move, click, finish, pointerStart: () => { suppressClick.current = false }}
}
