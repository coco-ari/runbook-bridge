import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import {
  moveProjectByOffset,
  moveProjectBeforeOrAfter,
  normalizeProjectOrder,
  parseStoredProjectOrder,
  PROJECT_ORDER_STORAGE_KEY,
} from "@/features/projects/project-mutation-model"

export interface ProjectOrderControllerOptions {
  readonly projects: readonly WorkspaceProjectReadModel[]
  readonly projectsReady: boolean
  readonly resolveFocusTarget?: ((projectId: string) => HTMLElement | null) | undefined
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined
}

export interface ProjectOrderController {
  readonly announcement: string
  readonly moveProject: (projectId: string, offset: -1 | 1) => boolean
  readonly moveProjectRelative: (
    projectId: string,
    targetProjectId: string,
    after: boolean,
  ) => boolean
  readonly onProjectKeyDown: (
    event: React.KeyboardEvent<HTMLElement>,
    projectId: string,
  ) => void
  readonly orderedProjects: readonly WorkspaceProjectReadModel[]
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function useProjectOrder({
  projects,
  projectsReady,
  resolveFocusTarget,
  storage = defaultStorage(),
}: ProjectOrderControllerOptions): ProjectOrderController {
  const [announcement, setAnnouncement] = useState("")
  const [order, setOrder] = useState<readonly string[]>(() => {
    try {
      return parseStoredProjectOrder(storage?.getItem(PROJECT_ORDER_STORAGE_KEY) ?? null)
    } catch {
      return []
    }
  })
  const focusTargetRef = useRef(resolveFocusTarget)
  const projectIds = useMemo(() => projects.map((project) => project.projectId), [projects])
  const normalizedOrder = useMemo(
    () => normalizeProjectOrder(projectIds, order),
    [order, projectIds],
  )

  useEffect(() => {
    focusTargetRef.current = resolveFocusTarget
  }, [resolveFocusTarget])

  useEffect(() => {
    // An empty list before the first successful workspace read is not a
    // deletion of every project. Keep the saved preference until data arrives.
    if (!projectsReady) return
    if (sameOrder(order, normalizedOrder)) return
    setOrder(normalizedOrder)
    try {
      storage?.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(normalizedOrder))
    } catch {
      // Project order is a local navigation preference. Storage failures must
      // never prevent the workspace from opening.
    }
  }, [normalizedOrder, order, projectsReady, storage])

  const commit = useCallback((next: readonly string[], message: string, focusProjectId: string) => {
    if (!projectsReady) return false
    if (sameOrder(normalizedOrder, next)) return false
    try {
      if (!storage) throw new Error("Project order storage is unavailable")
      storage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(next))
    } catch {
      const failureMessage = "项目顺序保存失败，已恢复原顺序。"
      setAnnouncement(failureMessage)
      toast.error(failureMessage)
      return false
    }
    setOrder(next)
    setAnnouncement(message)
    requestAnimationFrame(() => {
      focusTargetRef.current?.(focusProjectId)?.focus({ preventScroll: true })
    })
    return true
  }, [normalizedOrder, projectsReady, storage])

  const moveProject = useCallback((projectId: string, offset: -1 | 1) => {
    const project = projects.find((candidate) => candidate.projectId === projectId)
    if (!project || project.isolated) return false
    const move = moveProjectByOffset(normalizedOrder, projectId, offset, project.name)
    setAnnouncement(move.announcement)
    return move.changed ? commit(move.order, move.announcement, projectId) : false
  }, [commit, normalizedOrder, projects])

  const moveProjectRelative = useCallback((
    projectId: string,
    targetProjectId: string,
    after: boolean,
  ) => {
    const project = projects.find((candidate) => candidate.projectId === projectId)
    const target = projects.find((candidate) => candidate.projectId === targetProjectId)
    if (!project || !target || project.isolated || target.isolated) return false
    const next = moveProjectBeforeOrAfter(normalizedOrder, projectId, targetProjectId, after)
    const position = next.indexOf(projectId) + 1
    return commit(
      next,
      `项目“${project.name}”已移至第 ${position} 项，共 ${next.length} 项`,
      projectId,
    )
  }, [commit, normalizedOrder, projects])

  const onProjectKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLElement>,
    projectId: string,
  ) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return
    }
    event.preventDefault()
    moveProject(projectId, event.key === "ArrowUp" ? -1 : 1)
  }, [moveProject])

  const orderedProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.projectId, project]))
    return normalizedOrder
      .map((projectId) => byId.get(projectId))
      .filter((project): project is WorkspaceProjectReadModel => project !== undefined)
  }, [normalizedOrder, projects])

  return {
    announcement,
    moveProject,
    moveProjectRelative,
    onProjectKeyDown,
    orderedProjects,
  }
}

export function ProjectOrderAnnouncement({ announcement }: { readonly announcement: string }) {
  return (
    <p aria-live="polite" className="sr-only" data-testid="project-order-announcement">
      {announcement}
    </p>
  )
}
