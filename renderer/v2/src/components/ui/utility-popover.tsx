import { useCallback, useId, useRef, useState, type ReactNode } from "react"
import { X } from "@phosphor-icons/react"
import { Button } from "./button"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"

export function useUtilityPopover(triggerSelector: string) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement | null>(null)
  const id = useId()
  const show = useCallback((trigger?: HTMLElement) => {
    anchor.current = trigger ?? Array.from(document.querySelectorAll<HTMLElement>(triggerSelector)).find(element => element.checkVisibility() && !element.closest('[hidden],[inert]')) ?? null
    setOpen(true)
  }, [triggerSelector])
  const toggle = useCallback((trigger: HTMLElement) => {
    if (open && anchor.current === trigger) setOpen(false)
    else show(trigger)
  }, [open, show])
  return { open, setOpen, anchor, id, show, toggle, triggerSelector }
}

export function UtilityPopover({ controller, title, summary, description, actions, footer, children, testId, closeTestId, onCloseAutoFocus, wide = false }: {
  readonly wide?: boolean
  readonly controller: ReturnType<typeof useUtilityPopover>
  readonly title: string
  readonly summary?: ReactNode
  readonly description: string
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly children: ReactNode
  readonly testId: string
  readonly closeTestId?: string
  readonly onCloseAutoFocus?: (event: Event) => void
}) {
  const outside = useRef(false)
  const { open, setOpen, anchor, id, triggerSelector } = controller
  return <Popover open={open} onOpenChange={setOpen} modal={false}>
    <PopoverAnchor virtualRef={anchor} />
    <PopoverContent id={id} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} side="top" align="start" sideOffset={10} collisionPadding={12}
      className={`${wide ? "max-h-[min(760px,var(--radix-popover-content-available-height))] w-[720px]" : "max-h-[min(520px,var(--radix-popover-content-available-height))] w-[360px]"} max-w-[calc(100dvw-24px)] gap-0 overflow-hidden p-0`} data-testid={testId} data-utility-popover
      onOpenAutoFocus={event => { outside.current = false; event.preventDefault(); document.getElementById(id)?.focus() }}
      onInteractOutside={event => {
        if (event.target instanceof Element && event.target.closest(triggerSelector)) { event.preventDefault(); return }
        outside.current = true
      }}
      onCloseAutoFocus={event => {
        onCloseAutoFocus?.(event)
        const prevented = event.defaultPrevented
        event.preventDefault()
        if (!prevented && !outside.current && anchor.current?.isConnected && anchor.current.checkVisibility() && !anchor.current.closest('[hidden],[inert]')) anchor.current.focus()
      }}>
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <h2 id={`${id}-title`} className="text-sm font-semibold">{title}</h2>
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{summary}</span>
        {actions}
        <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`关闭${title}`} onClick={() => setOpen(false)} data-testid={closeTestId ?? `${testId}-close`}><X /></Button>
      </div>
      <p id={`${id}-description`} className="sr-only">{description}</p>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-1" data-utility-popover-list>{children}</div>
      {footer ? <div className="shrink-0 border-t px-4 py-2 text-[11px] text-muted-foreground">{footer}</div> : null}
    </PopoverContent>
  </Popover>
}
