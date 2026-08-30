import { useCallback, useLayoutEffect, useRef } from "react"

import { focusWorkspaceElement } from "../lib/workspace-focus.ts"

/** Keep a pending modal focusable when its last enabled control is disabled. */
export function focusBusyDialog(dialog: HTMLElement | null, busy: boolean): boolean {
  if (!busy || dialog?.dataset.state !== "open") return false
  const role = dialog.getAttribute("role")
  if (role !== "dialog" && role !== "alertdialog") return false
  return focusWorkspaceElement(dialog)
}

export function useBusyDialogFocus(busy: boolean) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    focusBusyDialog(dialogRef.current, busy)
  }, [busy])

  // A Radix Portal may mount after the owner's layout effect. Cover that
  // commit too, without a delayed callback that could steal successor focus.
  return useCallback((dialog: HTMLDivElement | null) => {
    dialogRef.current = dialog
    focusBusyDialog(dialog, busy)
  }, [busy])
}
