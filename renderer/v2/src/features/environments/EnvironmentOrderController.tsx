import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  moveEnvironmentByOffset,
  validEnvironmentOrder,
} from "@/features/environments/environment-mutation-model"
import type {
  WorkspaceEnvironmentReadModel,
  WorkspaceProjectReadModel,
} from "@/features/workspace/workspace-read-model"

export interface EnvironmentOrderControllerOptions {
  readonly persistOrder: (
    project: WorkspaceProjectReadModel,
    environmentIds: readonly string[],
  ) => Promise<boolean>
  readonly project: WorkspaceProjectReadModel | null
  readonly resolveFocusTarget?: ((environmentId: string) => HTMLElement | null) | undefined
}

export interface EnvironmentOrderController {
  readonly announcement: string
  readonly moveEnvironment: (environmentId: string, offset: -1 | 1) => Promise<boolean>
  readonly moveEnvironmentRelative: (
    environmentId: string,
    targetEnvironmentId: string,
    after: boolean,
  ) => Promise<boolean>
  readonly onEnvironmentKeyDown: (
    event: React.KeyboardEvent<HTMLElement>,
    environmentId: string,
  ) => void
  readonly orderedEnvironments: readonly WorkspaceEnvironmentReadModel[]
  readonly saving: boolean
}

function moveBeforeOrAfter(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  after: boolean,
): readonly string[] {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return [...ids]
  const next = ids.filter((environmentId) => environmentId !== sourceId)
  const targetIndex = next.indexOf(targetId)
  next.splice(targetIndex + (after ? 1 : 0), 0, sourceId)
  return next
}

export function useEnvironmentOrder({
  persistOrder,
  project,
  resolveFocusTarget,
}: EnvironmentOrderControllerOptions): EnvironmentOrderController {
  const authoritativeOrder = useMemo(
    () => project?.environments.map((environment) => environment.environmentId) ?? [],
    [project],
  )
  const ownerKey = project?.projectId ?? "closed"
  const [announcement, setAnnouncement] = useState("")
  const [order, setOrder] = useState<readonly string[]>(authoritativeOrder)
  const [saving, setSaving] = useState(false)
  const authoritativeOrderRef = useRef(authoritativeOrder)
  const epochRef = useRef(0)
  const focusTargetRef = useRef(resolveFocusTarget)
  const mountedRef = useRef(true)
  const persistRef = useRef(persistOrder)
  const savingRef = useRef(false)

  useEffect(() => {
    focusTargetRef.current = resolveFocusTarget
  }, [resolveFocusTarget])

  useEffect(() => {
    persistRef.current = persistOrder
  }, [persistOrder])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      epochRef.current += 1
      savingRef.current = false
    }
  }, [])

  useEffect(() => {
    authoritativeOrderRef.current = authoritativeOrder
    if (!savingRef.current) setOrder(authoritativeOrder)
  }, [authoritativeOrder])

  useEffect(() => {
    epochRef.current += 1
    savingRef.current = false
    setSaving(false)
    setOrder(authoritativeOrderRef.current)
  }, [ownerKey])

  const commit = useCallback(async (
    next: readonly string[],
    message: string,
    focusEnvironmentId: string,
  ) => {
    if (!project || savingRef.current || !validEnvironmentOrder(project.environments, next)) {
      return false
    }
    const epoch = ++epochRef.current
    savingRef.current = true
    setSaving(true)
    setOrder(next)
    setAnnouncement(message)
    let saved = false
    try {
      saved = await persistRef.current(project, next)
    } catch {
      saved = false
    }
    if (!mountedRef.current || epochRef.current !== epoch) return false
    savingRef.current = false
    setSaving(false)
    if (!saved) {
      setOrder(authoritativeOrderRef.current)
      setAnnouncement("环境顺序保存失败，已恢复原顺序。")
    } else {
      setOrder(next)
    }
    requestAnimationFrame(() => {
      focusTargetRef.current?.(focusEnvironmentId)?.focus({ preventScroll: true })
    })
    return saved
  }, [order, project])

  const moveEnvironment = useCallback(async (environmentId: string, offset: -1 | 1) => {
    if (!project || project.isolated || savingRef.current) return false
    const byId = new Map(project.environments.map((environment) => [environment.environmentId, environment]))
    const ordered = order
      .map((candidate) => byId.get(candidate))
      .filter((environment): environment is WorkspaceEnvironmentReadModel => environment !== undefined)
    const move = moveEnvironmentByOffset(ordered, environmentId, offset)
    setAnnouncement(move.announcement)
    return move.changed ? commit(move.order, move.announcement, environmentId) : false
  }, [commit, order, project])

  const moveEnvironmentRelative = useCallback(async (
    environmentId: string,
    targetEnvironmentId: string,
    after: boolean,
  ) => {
    if (!project || project.isolated || savingRef.current) return false
    const next = moveBeforeOrAfter(order, environmentId, targetEnvironmentId, after)
    if (next.every((value, index) => value === order[index])) return false
    const environment = project.environments.find(
      (candidate) => candidate.environmentId === environmentId,
    )
    if (!environment) return false
    const position = next.indexOf(environmentId) + 1
    return commit(
      next,
      `环境“${environment.name}”已移至第 ${position} 项，共 ${next.length} 项`,
      environmentId,
    )
  }, [commit, order, project])

  const onEnvironmentKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLElement>,
    environmentId: string,
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
    void moveEnvironment(environmentId, event.key === "ArrowUp" ? -1 : 1)
  }, [moveEnvironment])

  const orderedEnvironments = useMemo(() => {
    if (!project) return []
    const byId = new Map(project.environments.map((environment) => [environment.environmentId, environment]))
    return order
      .map((environmentId) => byId.get(environmentId))
      .filter((environment): environment is WorkspaceEnvironmentReadModel => environment !== undefined)
  }, [order, project])

  return {
    announcement,
    moveEnvironment,
    moveEnvironmentRelative,
    onEnvironmentKeyDown,
    orderedEnvironments,
    saving,
  }
}

export function EnvironmentOrderAnnouncement({ announcement }: { readonly announcement: string }) {
  return (
    <p aria-live="polite" className="sr-only" data-testid="environment-order-announcement">
      {announcement}
    </p>
  )
}
