import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface FeatureToolbarProps {
  readonly actions?: ReactNode
  readonly className?: string
  readonly description?: ReactNode
  readonly meta?: ReactNode
  readonly title: string
  readonly titleId: string
}

/**
 * Compact, in-context controls for a WorkspaceDetail tab.
 *
 * WorkspaceDetail already owns the visible scope title and tab navigation, so
 * feature pages keep their accessible heading without repeating that chrome.
 */
export function FeatureToolbar({
  actions,
  className,
  description,
  meta,
  title,
  titleId,
}: FeatureToolbarProps) {
  return (
    <div
      className={cn("mb-4 min-w-0 @container/feature-toolbar", className)}
      data-slot="feature-toolbar"
    >
      <h2 className="sr-only" id={titleId}>{title}</h2>
      <div className="flex min-w-0 flex-col gap-2 @lg/feature-toolbar:flex-row @lg/feature-toolbar:items-center">
        {description ? (
          <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : <span className="min-w-0 flex-1" />}
        {meta || actions ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 @sm/feature-toolbar:justify-between @lg/feature-toolbar:w-auto @lg/feature-toolbar:shrink-0 @lg/feature-toolbar:justify-start">
            {meta ? <div className="flex min-w-0 items-center gap-2">{meta}</div> : null}
            {actions ? <div className="flex min-w-0 max-w-full items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
