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
  // 窗口压缩和其他面板调整不能把临时紧凑布局保存为项目栏折叠偏好。
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

export function createDefaultAppShellLayout(viewportWidth = 1280): Layout {
  // 窄窗只临时压缩，持久化初始布局仍按可正常展开的窗口计算。
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.max(960, viewportWidth)
    : 1280
  const panelSpace = width - 2
  const project = 224 / panelSpace * 100
  const resource = 320 / panelSpace * 100
  return {
    [APP_SHELL_PANEL_IDS.project]: project,
    [APP_SHELL_PANEL_IDS.resource]: resource,
    [APP_SHELL_PANEL_IDS.detail]: 100 - project - resource,
  }
}

export const DEFAULT_APP_SHELL_LAYOUT: Layout = createDefaultAppShellLayout()

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
  const defaultState: AppShellLayoutState = {
    ...DEFAULT_APP_SHELL_LAYOUT_STATE,
    layout: createDefaultAppShellLayout(typeof window === "undefined" ? 1280 : window.innerWidth),
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaultState
    const parsed = JSON.parse(stored) as Record<string, unknown>

    if (isAppShellLayout(parsed.layout)) {
      return {
        layout: parsed.layout,
        projectCollapsed: parsed.projectCollapsed === true,
        detailCollapsed: parsed.detailCollapsed === true,
      }
    }

    // 迁移旧版离散布局时保留折叠偏好，再由面板组管理精确比例。
    return {
      ...defaultState,
      projectCollapsed: parsed.projectSize === "collapsed",
      detailCollapsed: parsed.detailSize === "collapsed",
    }
  } catch {
    return defaultState
  }
}

export function persistAppShellLayoutState(state: AppShellLayoutState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 布局保存失败不能阻止工作台继续使用。
  }
}

export const APP_SHELL_LAYOUT_STORAGE_KEY = STORAGE_KEY
