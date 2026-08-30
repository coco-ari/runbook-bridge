import type { Layout } from "react-resizable-panels"

const STORAGE_KEY = "runbook-bridge:app-shell-layout:v1"

export const PROJECT_RAIL_COLLAPSED_WIDTH = 128
export const PROJECT_RAIL_COLLAPSED_SIZE = `${PROJECT_RAIL_COLLAPSED_WIDTH}px` as const
export const PROJECT_RAIL_COLLAPSE_THRESHOLD = PROJECT_RAIL_COLLAPSED_WIDTH + 2

export function projectCollapseIntentAfterResize(
  current: boolean,
  { inPixels, previousPixels, viewportWidth, isUserInteraction }: Readonly<{
    inPixels: number
    previousPixels: number | null
    viewportWidth: number
    isUserInteraction: boolean
  }>,
): boolean {
  // Automatic viewport compression and resizes of another panel must not turn
  // temporary compact geometry into a saved preference to collapse the rail.
  if (
    !isUserInteraction
    || viewportWidth < 720
    || (previousPixels !== null && Math.abs(inPixels - previousPixels) <= 1)
  ) return current
  return inPixels <= PROJECT_RAIL_COLLAPSE_THRESHOLD
}

export const APP_SHELL_PANEL_IDS = {
  project: "project-panel",
  resource: "resource-panel",
  detail: "detail-panel",
} as const

export interface AppShellLayoutState {
  readonly detailCollapsed: boolean
  readonly layout: Layout
  readonly projectCollapsed: boolean
}

export const DEFAULT_APP_SHELL_LAYOUT: Layout = {
  [APP_SHELL_PANEL_IDS.project]: 20,
  [APP_SHELL_PANEL_IDS.resource]: 32,
  [APP_SHELL_PANEL_IDS.detail]: 48,
}

export const DEFAULT_APP_SHELL_LAYOUT_STATE: AppShellLayoutState = {
  detailCollapsed: false,
  layout: DEFAULT_APP_SHELL_LAYOUT,
  projectCollapsed: false,
}

const LAYOUT_TOTAL = 100
const LAYOUT_TOTAL_TOLERANCE = 0.1

export function isAppShellLayout(candidate: unknown): candidate is Layout {
  if (!candidate || typeof candidate !== "object") return false
  const record = candidate as Record<string, unknown>
  const panelIds = Object.values(APP_SHELL_PANEL_IDS)
  const keys = Object.keys(record)
  if (
    keys.length !== panelIds.length
    || !panelIds.every((panelId) => Object.prototype.hasOwnProperty.call(record, panelId))
  ) {
    return false
  }

  const values = panelIds.map((panelId) => record[panelId])
  if (
    !values.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    )
  ) {
    return false
  }

  const total = values.reduce<number>((sum, value) => sum + value, 0)
  return Math.abs(total - LAYOUT_TOTAL) <= LAYOUT_TOTAL_TOLERANCE
}

export function readAppShellLayoutState(): AppShellLayoutState {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return DEFAULT_APP_SHELL_LAYOUT_STATE
    const parsed = JSON.parse(stored) as Record<string, unknown>

    if (isAppShellLayout(parsed.layout)) {
      return {
        layout: parsed.layout,
        projectCollapsed: parsed.projectCollapsed === true,
        detailCollapsed: parsed.detailCollapsed === true,
      }
    }

    // Preserve collapse intent from the discrete phase 2 schema once, then
    // allow the Radix-compatible panel group to own exact percentages.
    return {
      ...DEFAULT_APP_SHELL_LAYOUT_STATE,
      projectCollapsed: parsed.projectSize === "collapsed",
      detailCollapsed: parsed.detailSize === "collapsed",
    }
  } catch {
    return DEFAULT_APP_SHELL_LAYOUT_STATE
  }
}

export function persistAppShellLayoutState(state: AppShellLayoutState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Layout persistence is optional and must never block the workbench.
  }
}

export const APP_SHELL_LAYOUT_STORAGE_KEY = STORAGE_KEY
