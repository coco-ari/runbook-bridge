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
  const [detailCollapsed, setDetailCollapsedDisplay] = useState(layoutState.detailCollapsed)
  const [editorExpanded, setEditorExpanded] = useState(false)
  const editorLayoutRef = useRef<Readonly<{ layout: Layout; viewportWidth: number }> | null>(null)
  const panelGroupRef = useGroupRef()
  const panelGroupElementRef = useRef<HTMLDivElement>(null)
  const projectPanelRef = usePanelRef()
  const detailPanelRef = usePanelRef()
  const projectResizeFrameRef = useRef(0)
  const detailResizeFrameRef = useRef(0)
  const layoutRestoreFrameRef = useRef(0)
  const layoutGenerationRef = useRef(0)
  const stableLayoutRef = useRef(layoutState.layout)
  const stableNavigationPixelsRef = useRef({
    project: layoutState.layout[APP_SHELL_PANEL_IDS.project]! / 100 * (Math.max(960, window.innerWidth) - 2),
    resource: layoutState.layout[APP_SHELL_PANEL_IDS.resource]! / 100 * (Math.max(960, window.innerWidth) - 2),
  })
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

  const beginLayoutRestore = useCallback(() => {
    const ticket = { generation: ++layoutGenerationRef.current, viewportWidth: window.innerWidth }
    suppressLayoutPersistenceRef.current = true
    cancelAnimationFrame(layoutRestoreFrameRef.current)
    cancelAnimationFrame(detailResizeFrameRef.current)
    return ticket
  }, [])

  const layoutTicketCurrent = useCallback((ticket: Readonly<{ generation: number; viewportWidth: number }>) => (
    ticket.generation === layoutGenerationRef.current && ticket.viewportWidth === window.innerWidth
  ), [])

  const finishLayoutRestore = useCallback((ticket: Readonly<{ generation: number; viewportWidth: number }>, onSettled?: () => void) => {
    layoutRestoreFrameRef.current = requestAnimationFrame(() => {
      if (!layoutTicketCurrent(ticket)) return
      layoutRestoreFrameRef.current = requestAnimationFrame(() => {
        if (!layoutTicketCurrent(ticket)) return
        setProjectPanelPixels(projectPanelRef.current?.getSize().inPixels ?? null)
        setDetailCollapsedDisplay(detailPanelRef.current?.isCollapsed() ?? latestLayoutStateRef.current.detailCollapsed)
        suppressLayoutPersistenceRef.current = editorLayoutRef.current !== null
        onSettled?.()
      })
    })
  }, [detailPanelRef, layoutTicketCurrent, projectPanelRef])

  const rememberUserLayout = useCallback((layout: Layout) => {
    const panelSpace = [...(panelGroupElementRef.current?.children ?? [])]
      .reduce((total, element) => total + (element instanceof HTMLElement && element.hasAttribute("data-panel") ? element.offsetWidth : 0), 0)
    stableLayoutRef.current = layout
    if (panelSpace > 0) stableNavigationPixelsRef.current = {
      project: layout[APP_SHELL_PANEL_IDS.project]! / 100 * panelSpace,
      resource: layout[APP_SHELL_PANEL_IDS.resource]! / 100 * panelSpace,
    }
    commitLayoutState((current) => ({ ...current, layout }))
  }, [commitLayoutState])

  const restoreUserLayout = useCallback(() => {
    const panelSpace = Math.max(0, window.innerWidth - 2)
    const pixels = stableNavigationPixelsRef.current
    // 窗口恢复只投影用户导航宽度，不改写已保存的比例；空间不足由面板库临时约束。
    const layout = panelSpace > pixels.project + pixels.resource + 48 ? {
      [APP_SHELL_PANEL_IDS.project]: pixels.project / panelSpace * 100,
      [APP_SHELL_PANEL_IDS.resource]: pixels.resource / panelSpace * 100,
      [APP_SHELL_PANEL_IDS.detail]: (panelSpace - pixels.project - pixels.resource) / panelSpace * 100,
    } : stableLayoutRef.current
    panelGroupRef.current?.setLayout(layout)
    if (latestLayoutStateRef.current.projectCollapsed) projectPanelRef.current?.collapse()
    else {
      projectPanelRef.current?.expand()
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
    }
    if (latestLayoutStateRef.current.detailCollapsed) detailPanelRef.current?.collapse()
    else detailPanelRef.current?.expand()
  }, [detailPanelRef, panelGroupRef, projectPanelRef])

  useEffect(() => {
    const ticket = beginLayoutRestore()
    if (layoutState.projectCollapsed) projectPanelRef.current?.collapse()
    else if (window.innerWidth >= 720) {
      projectPanelRef.current?.expand()
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
    }
    if (layoutState.detailCollapsed) detailPanelRef.current?.collapse()
    else detailPanelRef.current?.expand()
    finishLayoutRestore(ticket)
    return () => cancelAnimationFrame(layoutRestoreFrameRef.current)
    // 首次挂载恢复折叠状态，同时保留单独持久化的展开布局。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let previousWidth = window.innerWidth

    const syncViewport = () => {
      const width = window.innerWidth
      if (width === previousWidth) return
      previousWidth = width
      const ticket = beginLayoutRestore()
      setViewportWidth(width)
      // 约束更新后恢复显示，旧尺寸回调与旧解除抑制任务均不能跨窗口代次交付。
      layoutRestoreFrameRef.current = requestAnimationFrame(() => {
        if (!layoutTicketCurrent(ticket)) return
        // 先让当前绘制和面板库 ResizeObserver 更新尺寸，避免旧约束再次投影导航宽度。
        layoutRestoreFrameRef.current = requestAnimationFrame(() => {
          if (!layoutTicketCurrent(ticket)) return
          if (width >= 960) {
            if (editorLayoutRef.current) {
              projectPanelRef.current?.collapse()
              if (latestLayoutStateRef.current.detailCollapsed) detailPanelRef.current?.collapse()
              else detailPanelRef.current?.resize("70%")
            } else restoreUserLayout()
          }
          finishLayoutRestore(ticket)
        })
      })
    }

    window.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("resize", syncViewport)
    return () => {
      window.removeEventListener("resize", syncViewport)
      window.visualViewport?.removeEventListener("resize", syncViewport)
      cancelAnimationFrame(layoutRestoreFrameRef.current)
    }
  }, [beginLayoutRestore, detailPanelRef, finishLayoutRestore, layoutTicketCurrent, projectPanelRef, restoreUserLayout])

  const setProjectCollapsed = useCallback((collapsed: boolean, resetWidth = false) => {
    if (!collapsed && window.innerWidth < 720) return
    const ticket = beginLayoutRestore()
    if (collapsed) projectPanelRef.current?.collapse()
    else {
      projectPanelRef.current?.expand()
      // 较小窗口的历史宽度可能仍被判定为折叠，先读取面板库状态。
      if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
      if (resetWidth) projectPanelRef.current?.resize("224px")
    }
    if (!editorLayoutRef.current) commitLayoutState((current) => ({ ...current, projectCollapsed: collapsed }))
    finishLayoutRestore(ticket, () => {
      if (window.innerWidth < 960 || editorLayoutRef.current) return
      const layout = panelGroupRef.current?.getLayout()
      if (layout) rememberUserLayout(layout)
    })
  }, [beginLayoutRestore, commitLayoutState, finishLayoutRestore, panelGroupRef, projectPanelRef, rememberUserLayout])

  const setDetailCollapsed = useCallback((collapsed: boolean, resetWidth = false) => {
    const ticket = beginLayoutRestore()
    if (collapsed) detailPanelRef.current?.collapse()
    else {
      detailPanelRef.current?.expand()
      if (resetWidth) detailPanelRef.current?.resize("48%")
    }
    setDetailCollapsedDisplay(collapsed)
    commitLayoutState((current) => ({ ...current, detailCollapsed: collapsed }))
    finishLayoutRestore(ticket, () => {
      // 双击是明确的用户重置；普通折叠按钮保留之前的展开比例。
      if (!resetWidth || window.innerWidth < 960 || editorLayoutRef.current) return
      const layout = panelGroupRef.current?.getLayout()
      if (layout) rememberUserLayout(layout)
    })
  }, [beginLayoutRestore, commitLayoutState, detailPanelRef, finishLayoutRestore, panelGroupRef, rememberUserLayout])

  const syncProjectSize = useCallback((size: PanelSize) => {
    const ticket = { generation: layoutGenerationRef.current, viewportWidth: window.innerWidth }
    cancelAnimationFrame(projectResizeFrameRef.current)
    // 在 ResizeObserver 回调周期之外提交响应式内容变化。
    projectResizeFrameRef.current = requestAnimationFrame(() => {
      if (!layoutTicketCurrent(ticket)) return
      setProjectPanelPixels(size.inPixels)
    })
  }, [layoutTicketCurrent])

  const syncDetailSize = useCallback((size: PanelSize) => {
    cancelAnimationFrame(detailResizeFrameRef.current)
    if (suppressLayoutPersistenceRef.current) return
    const ticket = { generation: layoutGenerationRef.current, viewportWidth: window.innerWidth }
    detailResizeFrameRef.current = requestAnimationFrame(() => {
      if (!layoutTicketCurrent(ticket) || suppressLayoutPersistenceRef.current) return
      // 约束折叠仅影响当前显示，用户偏好由明确操作或用户分隔线事件保存。
      setDetailCollapsedDisplay(size.inPixels <= 50)
    })
  }, [layoutTicketCurrent])

  useEffect(() => () => {
    cancelAnimationFrame(projectResizeFrameRef.current)
    cancelAnimationFrame(detailResizeFrameRef.current)
    cancelAnimationFrame(layoutRestoreFrameRef.current)
    layoutGenerationRef.current++
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
    if (suppressLayoutPersistenceRef.current || !isUserInteraction) return
    const canSaveLayout = window.innerWidth >= 960 && panelSpace > 0
    if (canSaveLayout) {
      stableLayoutRef.current = layout
      stableNavigationPixelsRef.current = {
        project: layout[APP_SHELL_PANEL_IDS.project]! / 100 * panelSpace,
        resource: layout[APP_SHELL_PANEL_IDS.resource]! / 100 * panelSpace,
      }
    }
    const detailPixels = layout[APP_SHELL_PANEL_IDS.detail]! / 100 * panelSpace
    commitLayoutState((current) => ({
      ...current,
      projectCollapsed: inPixels === null ? current.projectCollapsed : projectCollapseIntentAfterResize(current.projectCollapsed, {
        inPixels, previousPixels, viewportWidth: window.innerWidth, isUserInteraction,
      }),
      ...(canSaveLayout ? { layout, detailCollapsed: detailPixels <= 50 } : {}),
    }))
  }, [commitLayoutState])


  const restoreEditorLayout = useCallback(() => {
    const previous = editorLayoutRef.current
    if (!previous) return
    const ticket = beginLayoutRestore()
    editorLayoutRef.current = null
    // 临时编辑器布局只恢复显示，不能作为下一次用户操作的持久化比例。
    if (window.innerWidth >= 960 && window.innerWidth !== previous.viewportWidth) restoreUserLayout()
    else {
      panelGroupRef.current?.setLayout(previous.layout)
      if (latestLayoutStateRef.current.projectCollapsed || window.innerWidth < 720) projectPanelRef.current?.collapse()
      else {
        projectPanelRef.current?.expand()
        if (projectPanelRef.current?.isCollapsed()) projectPanelRef.current?.resize("176px")
      }
      if (latestLayoutStateRef.current.detailCollapsed) detailPanelRef.current?.collapse()
      else detailPanelRef.current?.expand()
    }
    setEditorExpanded(false)
    finishLayoutRestore(ticket)
  }, [beginLayoutRestore, detailPanelRef, finishLayoutRestore, panelGroupRef, projectPanelRef, restoreUserLayout])

  useEffect(() => {
    if (!editorOpen) restoreEditorLayout()
  }, [editorOpen, restoreEditorLayout])

  const toggleEditorExpanded = useCallback(() => {
    if (editorLayoutRef.current) {
      restoreEditorLayout()
      return
    }
    const ticket = beginLayoutRestore()
    editorLayoutRef.current = {
      layout: panelGroupRef.current?.getLayout() ?? layoutState.layout,
      viewportWidth: window.innerWidth,
    }
    projectPanelRef.current?.collapse()
    detailPanelRef.current?.resize("70%")
    setEditorExpanded(true)
    finishLayoutRestore(ticket)
  }, [beginLayoutRestore, detailPanelRef, finishLayoutRestore, layoutState.layout, panelGroupRef, projectPanelRef, restoreEditorLayout])


  return {
    layoutState, viewportWidth, projectPanelPixels, detailCollapsed, editorExpanded,
    panelGroupRef, panelGroupElementRef, projectPanelRef, detailPanelRef,
    setProjectCollapsed, setDetailCollapsed, syncProjectSize, syncDetailSize,
    handleLayoutChanged, restoreEditorLayout, toggleEditorExpanded,
  }
}
