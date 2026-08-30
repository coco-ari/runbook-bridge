/** Do not let delayed workspace focus escape a newer modal's focus scope. */
export function focusWorkspaceElement(target: HTMLElement | null): boolean {
  if (!target?.isConnected || target.getClientRects().length === 0) return false
  const modals = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
    .filter((element) => element.getClientRects().length > 0 && element.dataset.state !== "closed")
  const activeModal = modals.at(-1)
  if (activeModal && !activeModal.contains(target)) return false
  if (target.closest('[inert], [aria-hidden="true"]')) return false
  target.focus({ preventScroll: true })
  return document.activeElement === target
}
