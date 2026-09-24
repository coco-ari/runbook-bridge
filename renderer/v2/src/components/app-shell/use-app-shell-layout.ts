import { useCallback, useEffect, useRef, useState } from "react"
import { useGroupRef, usePanelRef, type Layout, type LayoutChangedMeta, type PanelSize } from "react-resizable-panels"
import {
  APP_SHELL_PANEL_IDS, persistAppShellLayoutState, projectCollapseIntentAfterResize,
  readAppShellLayoutState, type AppShellLayoutState,
} from "@/state/layout-state"

export function useAppShellLayout(editorOpen: boolean) {
  const [layoutState, setLayoutState] = useState<AppShellLayoutState>(
    readAppShellLayoutState,
  )
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [projectPanelPixels, setProjectPanelPixels] = useState<number | null>(null)
  const [editorExpanded, setEditorExpanded] = useState(false)
  const editorLayoutRef = useRef<Readonly<{ layout: Layout; projectCollapsed: boolean }> | null>(null)
  const panelGroupRef = useGroupRef()
  const panelGroupElementRef = useRef<HTMLDivElement>(null)
  const projectPanelRef = usePanelRef()
  const detailPanelRef = usePanelRef()
  const projectResizeFrameRef = useRef(0)
  const detailResizeFrameRef = useRef(0)
  const stableLayoutRef = useRef(layoutState.layout)
  const latestLayoutStateRef = useRef(layoutState)
  latestLayoutStateRef.current = layoutState
  const lastProjectLayoutPercentageRef = useRef<number | null>(null)
  const suppressLayoutPersistenceRef = useRef(true)

  const commitLayoutState = useCallback(
    (update: (current: AppShellLayoutState) => AppShellLayoutState) => {
      setLayoutState((current) => {
        const next = update(current)
        persistAppShellLayoutState(next)
        return next
      })
    },
    [],
  )

  useEffect(() => {
    if (layoutState.projectCollapsed) projectPanelRef.current?.collapse()
    else if (window.innerWidth >= 720) {
      projectPanelRef.current?.expand()
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
    }
    if (layoutState.detailCollapsed) detailPanelRef.current?.collapse()
    const releaseFrame = requestAnimationFrame(() => requestAnimationFrame(() => {
      suppressLayoutPersistenceRef.current = editorLayoutRef.current !== null
    }))
    return () => cancelAnimationFrame(releaseFrame)
    // 首次挂载恢复折叠状态，同时保留单独持久化的展开布局。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let wasConstraintLimited = window.innerWidth < 960
    let releaseFrame = 0

    const syncViewport = () => {
      const width = window.innerWidth
      const constraintLimited = width < 960
      setViewportWidth(width)

      if (wasConstraintLimited && !constraintLimited) {
        suppressLayoutPersistenceRef.current = true
        cancelAnimationFrame(releaseFrame)
        // 等待 React 更新面板宽度约束后再恢复已保存的布局。
        releaseFrame = requestAnimationFrame(() => {
          if (window.innerWidth >= 960 && !editorLayoutRef.current) {
            panelGroupRef.current?.setLayout(stableLayoutRef.current)
            if (latestLayoutStateRef.current.projectCollapsed) projectPanelRef.current?.collapse()
            else {
              projectPanelRef.current?.expand()
              if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
            }
            if (latestLayoutStateRef.current.detailCollapsed) detailPanelRef.current?.collapse()
          }
          releaseFrame = requestAnimationFrame(() => {
            suppressLayoutPersistenceRef.current = editorLayoutRef.current !== null
          })
        })
      }
      wasConstraintLimited = constraintLimited
    }

    window.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("resize", syncViewport)
    return () => {
      window.removeEventListener("resize", syncViewport)
      window.visualViewport?.removeEventListener("resize", syncViewport)
      cancelAnimationFrame(releaseFrame)
    }
  }, [detailPanelRef, panelGroupRef, projectPanelRef])

  const setProjectCollapsed = useCallback((collapsed: boolean, resetWidth = false) => {
    if (!collapsed && window.innerWidth < 720) return
    if (collapsed) projectPanelRef.current?.collapse()
    else {
      projectPanelRef.current?.expand()
      // 较小窗口的历史宽度可能仍被判定为折叠，先读取面板库状态。
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
      if (resetWidth) projectPanelRef.current?.resize("224px")
    }
    if (editorLayoutRef.current) return
    const layout = window.innerWidth >= 960 ? panelGroupRef.current?.getLayout() : null
    if (layout) stableLayoutRef.current = layout
    commitLayoutState((current) => ({ ...current, projectCollapsed: collapsed, ...(layout ? { layout } : {}) }))
  }, [commitLayoutState, panelGroupRef, projectPanelRef])

  const setDetailCollapsed = useCallback((collapsed: boolean) => {
    if (collapsed) detailPanelRef.current?.collapse()
    else detailPanelRef.current?.expand()
    commitLayoutState((current) => ({ ...current, detailCollapsed: collapsed }))
  }, [commitLayoutState, detailPanelRef])

  const syncProjectSize = useCallback((size: PanelSize) => {
    cancelAnimationFrame(projectResizeFrameRef.current)
    // 在 ResizeObserver 回调周期之外提交响应式内容变化。
    projectResizeFrameRef.current = requestAnimationFrame(() => {
      setProjectPanelPixels(size.inPixels)
    })
  }, [])

  const syncDetailSize = useCallback((size: PanelSize) => {
    cancelAnimationFrame(detailResizeFrameRef.current)
    detailResizeFrameRef.current = requestAnimationFrame(() => {
      if (window.innerWidth < 960) return
      const collapsed = size.inPixels <= 50
      setLayoutState((current) => current.detailCollapsed === collapsed
        ? current
        : { ...current, detailCollapsed: collapsed })
    })
  }, [])

  useEffect(() => () => {
    cancelAnimationFrame(projectResizeFrameRef.current)
    cancelAnimationFrame(detailResizeFrameRef.current)
  }, [])

  const handleLayoutChanged = useCallback((layout: Layout, { isUserInteraction }: LayoutChangedMeta) => {
    // 按新布局百分比和面板总宽计算尺寸，避免读取尚未提交的 DOM 宽度。
    const panelSpace = [...(panelGroupElementRef.current?.children ?? [])]
      .reduce((total, element) => total + (element instanceof HTMLElement && element.hasAttribute("data-panel")
        ? element.offsetWidth : 0), 0)
    const percentage = layout[APP_SHELL_PANEL_IDS.project]
    const inPixels = percentage === undefined || panelSpace <= 0 ? null : percentage / 100 * panelSpace
    const previousPercentage = lastProjectLayoutPercentageRef.current
    const previousPixels = previousPercentage === null ? null : previousPercentage / 100 * panelSpace
    lastProjectLayoutPercentageRef.current = percentage ?? null
    if (suppressLayoutPersistenceRef.current) return
    if (inPixels !== null && isUserInteraction) {
      commitLayoutState((current) => ({
        ...current,
        projectCollapsed: projectCollapseIntentAfterResize(current.projectCollapsed, {
          inPixels, previousPixels, viewportWidth: window.innerWidth, isUserInteraction,
        }),
      }))
    }
    if (suppressLayoutPersistenceRef.current || window.innerWidth < 960) return
    stableLayoutRef.current = layout
    setLayoutState((current) => {
      const next = { ...current, layout }
      persistAppShellLayoutState(next)
      return next
    })
  }, [commitLayoutState])


  const restoreEditorLayout = useCallback(() => {
    const previous = editorLayoutRef.current
    if (!previous) return
    editorLayoutRef.current = null
    suppressLayoutPersistenceRef.current = true
    panelGroupRef.current?.setLayout(previous.layout)
    if (previous.projectCollapsed || window.innerWidth < 720) projectPanelRef.current?.collapse()
    else {
      projectPanelRef.current?.expand()
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
    }
    setLayoutState((current) => ({ ...current, projectCollapsed: previous.projectCollapsed, layout: previous.layout }))
    setEditorExpanded(false)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      suppressLayoutPersistenceRef.current = editorLayoutRef.current !== null
    }))
  }, [panelGroupRef, projectPanelRef])

  useEffect(() => {
    if (!editorOpen) restoreEditorLayout()
  }, [editorOpen, restoreEditorLayout])

  const toggleEditorExpanded = useCallback(() => {
    if (editorLayoutRef.current) {
      restoreEditorLayout()
      return
    }
    editorLayoutRef.current = {
      layout: panelGroupRef.current?.getLayout() ?? layoutState.layout,
      projectCollapsed: layoutState.projectCollapsed,
    }
    suppressLayoutPersistenceRef.current = true
    projectPanelRef.current?.collapse()
    detailPanelRef.current?.resize("70%")
    setEditorExpanded(true)
  }, [detailPanelRef, layoutState.layout, layoutState.projectCollapsed, panelGroupRef, projectPanelRef, restoreEditorLayout])


  return {
    layoutState, viewportWidth, projectPanelPixels, editorExpanded,
    panelGroupRef, panelGroupElementRef, projectPanelRef, detailPanelRef,
    setProjectCollapsed, setDetailCollapsed, syncProjectSize, syncDetailSize,
    handleLayoutChanged, restoreEditorLayout, toggleEditorExpanded,
  }
}
