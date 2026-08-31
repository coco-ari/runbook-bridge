import { useCallback, useEffect, useRef, useState } from "react"

import type { ProjectOrderController } from "@/features/projects/ProjectOrderController"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"

const PROJECT_DRAG_TYPE = "application/x-runbook-bridge-project"

interface ProjectDropTarget {
  readonly projectId: string
  readonly after: boolean
}

export function useProjectDragOrder({
  disabled,
  onMoveProjectRelative,
  projects,
  query,
}: {
  readonly disabled: boolean
  readonly onMoveProjectRelative: ProjectOrderController["moveProjectRelative"] | undefined
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly query: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<string | null>(null)
  const scrollFrameRef = useRef(0)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ProjectDropTarget | null>(null)
  const enabled = !disabled && !!onMoveProjectRelative
    && projects.filter((project) => !project.isolated).length > 1

  const stopScrolling = useCallback(() => {
    cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = 0
    pointerRef.current = null
  }, [])

  const clearDrag = useCallback(() => {
    sourceRef.current = null
    stopScrolling()
    setDraggingProjectId(null)
    setDropTarget(null)
  }, [stopScrolling])

  useEffect(() => {
    clearDrag()
  }, [clearDrag, query])

  useEffect(() => {
    if (!enabled || (sourceRef.current && !projects.some(
      (project) => project.projectId === sourceRef.current && !project.isolated,
    ))) clearDrag()
  }, [clearDrag, enabled, projects])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDrag()
    }
    window.addEventListener("blur", clearDrag)
    window.addEventListener("dragend", clearDrag)
    window.addEventListener("drop", clearDrag)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("blur", clearDrag)
      window.removeEventListener("dragend", clearDrag)
      window.removeEventListener("drop", clearDrag)
      window.removeEventListener("keydown", onKeyDown)
      stopScrolling()
    }
  }, [clearDrag, stopScrolling])

  function canDrag(project: WorkspaceProjectReadModel) {
    return enabled && !project.isolated
  }

  function resolveDropTarget(element: EventTarget | null, clientY: number): ProjectDropTarget | null {
    if (!enabled || !sourceRef.current || !(element instanceof Element)) return null
    const row = element.closest<HTMLElement>("[data-project-drop-id]")
    const projectId = row?.dataset.projectDropId
    if (!row || !projectId || projectId === sourceRef.current
      || !viewportRef.current?.contains(row)
      || !projects.some((project) => project.projectId === projectId && !project.isolated)) return null
    const rect = row.getBoundingClientRect()
    return { projectId, after: clientY >= rect.top + rect.height / 2 }
  }

  function showDropTarget(target: ProjectDropTarget | null) {
    setDropTarget((current) => current?.projectId === target?.projectId && current?.after === target?.after
      ? current : target)
  }

  function startScrolling() {
    if (scrollFrameRef.current) return
    const scroll = () => {
      const viewport = viewportRef.current
      const pointer = pointerRef.current
      if (!viewport || !pointer || !sourceRef.current) {
        scrollFrameRef.current = 0
        return
      }
      const rect = viewport.getBoundingClientRect()
      const edge = Math.min(40, rect.height / 4)
      const distance = pointer.y < rect.top + edge
        ? pointer.y - rect.top - edge
        : pointer.y > rect.bottom - edge ? pointer.y - rect.bottom + edge : 0
      if (distance !== 0) {
        viewport.scrollTop += Math.sign(distance) * Math.min(10, Math.abs(distance) / 4)
        showDropTarget(resolveDropTarget(document.elementFromPoint(pointer.x, pointer.y), pointer.y))
      }
      scrollFrameRef.current = requestAnimationFrame(scroll)
    }
    scrollFrameRef.current = requestAnimationFrame(scroll)
  }

  function onDragStart(event: React.DragEvent<HTMLElement>, project: WorkspaceProjectReadModel) {
    if (!canDrag(project)) {
      event.preventDefault()
      return
    }
    sourceRef.current = project.projectId
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.projectId)
    setDraggingProjectId(project.projectId)
  }

  function onDragOver(event: React.DragEvent<HTMLElement>) {
    // Only a drag started by this rail can reorder projects; ignore external data.
    if (!enabled || !sourceRef.current) return
    const target = resolveDropTarget(event.target, event.clientY)
    showDropTarget(target)
    event.preventDefault()
    event.dataTransfer.dropEffect = target ? "move" : "none"
    pointerRef.current = { x: event.clientX, y: event.clientY }
    startScrolling()
  }

  function onDragLeave(event: React.DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    stopScrolling()
    setDropTarget(null)
  }

  function onDrop(event: React.DragEvent<HTMLElement>) {
    const sourceId = sourceRef.current
    const target = resolveDropTarget(event.target, event.clientY)
    if (sourceId) event.preventDefault()
    clearDrag()
    if (sourceId && target) onMoveProjectRelative?.(sourceId, target.projectId, target.after)
  }

  return {
    canDrag,
    clearDrag,
    draggingProjectId,
    dropTarget,
    enabled,
    onDragLeave,
    onDragOver,
    onDragStart,
    onDrop,
    viewportRef,
  }
}
