import {
  useCallback,
  useMemo,
  type FocusEvent,
  type KeyboardEvent,
} from "react"

const navigationKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"])
const navigationItemSelector = "[data-shell-nav-item]"

function navigationItemFromTarget(
  container: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  const item = target.closest<HTMLElement>(navigationItemSelector)
  return item && container.contains(item) ? item : null
}

function navigationItemIsVisible(item: HTMLElement, container: HTMLElement): boolean {
  if (item.matches("[disabled], [aria-hidden='true']")) return false
  if (item.getClientRects().length === 0) return false

  let ancestor = item.parentElement
  while (ancestor && ancestor !== container) {
    if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true") return false
    if (
      ancestor.getAttribute("data-slot") === "accordion-content"
      && (
        ancestor.getAttribute("data-state") === "closed"
        || ancestor.hasAttribute("data-closed")
      )
    ) {
      return false
    }
    ancestor = ancestor.parentElement
  }

  return true
}

function visibleNavigationItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(navigationItemSelector),
  ).filter((item) => navigationItemIsVisible(item, container))
}

function setSingleTabStop(container: HTMLElement, current: HTMLElement): void {
  for (const item of container.querySelectorAll<HTMLElement>(navigationItemSelector)) {
    item.tabIndex = item === current ? 0 : -1
  }
}

export function useRovingNavigation<T extends HTMLElement>() {
  const onFocusCapture = useCallback((event: FocusEvent<T>) => {
    const current = navigationItemFromTarget(event.currentTarget, event.target)
    if (current) setSingleTabStop(event.currentTarget, current)
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (
      event.defaultPrevented
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return
    if (!navigationKeys.has(event.key)) return

    const current = navigationItemFromTarget(event.currentTarget, event.target)
    if (!current) return

    const items = visibleNavigationItems(event.currentTarget)
    if (items.length === 0) return

    const currentIndex = items.indexOf(current)
    let nextIndex = currentIndex

    if (event.key === "Home") nextIndex = 0
    if (event.key === "End") nextIndex = items.length - 1
    if (event.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, items.length - 1)
    if (event.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0)

    if (currentIndex === -1) {
      nextIndex = event.key === "End" || event.key === "ArrowUp" ? items.length - 1 : 0
    }

    event.preventDefault()
    event.stopPropagation()
    const next = items[nextIndex]
    if (!next) return
    setSingleTabStop(event.currentTarget, next)
    next.focus()
  }, [])

  return useMemo(() => ({ onFocusCapture, onKeyDown }), [onFocusCapture, onKeyDown])
}
