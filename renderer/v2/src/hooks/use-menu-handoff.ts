import { useLayoutEffect, useMemo } from "react"

interface MenuHandoffRuntime {
  readonly cancelFrame: (frame: number) => void
  readonly mayRun: () => boolean
  readonly requestFrame: (callback: () => void) => number
}

/** An action belongs to one mounted menu generation, never to its successor. */
export function createMenuHandoffController(runtime: MenuHandoffRuntime) {
  let mounted = false
  let open = false
  let generation = 0
  let frame = 0
  let pending: { action: () => void; generation: number } | null = null

  const invalidate = () => {
    generation += 1
    pending = null
    runtime.cancelFrame(frame)
    frame = 0
  }

  return {
    mount() {
      mounted = true
      invalidate()
    },
    dispose() {
      mounted = false
      invalidate()
    },
    invalidate,
    onOpenChange(next: boolean) {
      open = next
      if (next) invalidate()
    },
    queueAction(action: () => void) {
      if (mounted && open) pending = { action, generation }
    },
    onCloseAutoFocus() {
      const task = pending
      pending = null
      if (!mounted || open || !task) return
      // Preserve Radix's normal trigger restoration; only then start the next
      // task, after the menu's modal scope and aria-hidden owners are released.
      frame = runtime.requestFrame(() => {
        frame = 0
        if (mounted && !open && task.generation === generation && runtime.mayRun()) task.action()
      })
    },
  }
}

export function useMenuHandoff(scopeKey: string) {
  const handoff = useMemo(() => createMenuHandoffController({
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    requestFrame: (callback) => requestAnimationFrame(callback),
    mayRun: () => ![...document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    )].some((element) => element.getClientRects().length > 0 && element.dataset.state !== "closed"),
  }), [])

  useLayoutEffect(() => {
    handoff.mount()
    return () => handoff.dispose()
  }, [handoff])
  useLayoutEffect(() => handoff.invalidate(), [handoff, scopeKey])

  return handoff
}
