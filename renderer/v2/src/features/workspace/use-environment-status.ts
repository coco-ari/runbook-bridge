import { useCallback, useEffect, useRef, useState } from "react"

import {
  getAiOpsV2,
  type AiOpsV2Api,
  type EnvironmentRuntime,
} from "@/bridge/ai-ops-v2"
import {
  createWorkspaceReadError,
  resolveEnvironmentRuntimeEvent,
  resolveEnvironmentRuntimePoll,
  type EnvironmentRuntimeValue,
  type EnvironmentRuntimeReadModel,
  type WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"
import { settleRefresh } from "@/features/workspace/workspace-refresh-coordinator"

type EnvironmentStatusApi = Pick<
  AiOpsV2Api,
  "environmentStatus" | "onEnvironmentStatus"
>

export interface EnvironmentStatusScope {
  readonly environmentId: string
  readonly projectId: string
}

export interface UseEnvironmentStatusOptions {
  readonly getApi?: () => EnvironmentStatusApi
}

export interface EnvironmentStatusReadState {
  readonly data: EnvironmentRuntimeReadModel | null
  readonly error: WorkspaceReadError | null
  readonly loading: boolean
  readonly raw: EnvironmentRuntime | null
  readonly reload: () => void
}

interface EnvironmentStatusSnapshot {
  readonly data: EnvironmentRuntimeReadModel | null
  readonly error: WorkspaceReadError | null
  readonly loading: boolean
  readonly raw: EnvironmentRuntime | null
}

function defaultGetApi(): EnvironmentStatusApi {
  return getAiOpsV2()
}

export function useEnvironmentStatus(
  scope: EnvironmentStatusScope | null,
  options: UseEnvironmentStatusOptions = {},
): EnvironmentStatusReadState {
  const getApi = options.getApi ?? defaultGetApi
  const projectId = scope?.projectId ?? null
  const environmentId = scope?.environmentId ?? null
  const generationRef = useRef(0)
  const latestSequenceRef = useRef(-1)
  const latestScopeRef = useRef<string | null>(null)
  const latestValueRef = useRef<EnvironmentRuntimeValue | null>(null)
  const renderedScopeRef = useRef<string | null>(null)
  const activeScopeRef = useRef<string | null>(
    projectId && environmentId ? projectId + "/" + environmentId : null,
  )
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const [snapshot, setSnapshot] = useState<EnvironmentStatusSnapshot>({
    data: null,
    error: null,
    loading: false,
    raw: null,
  })

  const reload = useCallback(() => {
    generationRef.current += 1
    setReloadGeneration((generation) => generation + 1)
  }, [])

  activeScopeRef.current =
    projectId && environmentId ? projectId + "/" + environmentId : null

  useEffect(() => {
    const generation = ++generationRef.current
    let active = true
    if (!projectId || !environmentId) {
      latestScopeRef.current = null
      latestValueRef.current = null
      renderedScopeRef.current = null
      latestSequenceRef.current = -1
      setSnapshot({ data: null, error: null, loading: false, raw: null })
      return () => {
        active = false
      }
    }

    const scopeKey = projectId + "/" + environmentId
    const sameRenderedScope = renderedScopeRef.current === scopeKey
    renderedScopeRef.current = scopeKey
    if (latestScopeRef.current !== scopeKey) {
      latestScopeRef.current = scopeKey
      latestValueRef.current = null
      latestSequenceRef.current = -1
    }
    const sequenceAtStart = latestSequenceRef.current
    setSnapshot((current) => sameRenderedScope
      ? { ...current, error: null, loading: true }
      : { data: null, error: null, loading: true, raw: null })

    let api: EnvironmentStatusApi
    try {
      api = getApi()
    } catch (error) {
      if (active && generation === generationRef.current) {
        setSnapshot((current) => ({
          data: sameRenderedScope ? current.data : null,
          error: createWorkspaceReadError("environment-status", error),
          loading: false,
          raw: sameRenderedScope ? current.raw : null,
        }))
      }
      return () => {
        active = false
      }
    }

    void api.environmentStatus({ projectId, environmentId }).then(
      (result) => {
        if (
          !active ||
          generation !== generationRef.current ||
          activeScopeRef.current !== scopeKey
        ) return
        if (!result.ok) {
          if (latestSequenceRef.current !== sequenceAtStart) return
          setSnapshot((current) => ({
            data: sameRenderedScope ? current.data : null,
            error: createWorkspaceReadError("environment-status", result.error),
            loading: false,
            raw: sameRenderedScope ? current.raw : null,
          }))
          return
        }
        const resolution = resolveEnvironmentRuntimePoll(
          result.data,
          { projectId, environmentId },
          latestValueRef.current,
          sequenceAtStart,
        )
        if (resolution.reason === "invalid") {
          setSnapshot((current) => ({
            data: sameRenderedScope ? current.data : null,
            error: createWorkspaceReadError("environment-status"),
            loading: false,
            raw: sameRenderedScope ? current.raw : null,
          }))
          return
        }
        if (resolution.reason !== "accepted" || !resolution.value) {
          setSnapshot(settleRefresh)
          return
        }
        latestValueRef.current = resolution.value
        latestSequenceRef.current = resolution.value.data.sequence
        setSnapshot({
          data: resolution.value.data,
          error: null,
          loading: false,
          raw: resolution.value.raw,
        })
      },
      (error: unknown) => {
        if (
          !active ||
          generation !== generationRef.current ||
          activeScopeRef.current !== scopeKey ||
          latestSequenceRef.current !== sequenceAtStart
        ) return
        setSnapshot((current) => ({
          data: sameRenderedScope ? current.data : null,
          error: createWorkspaceReadError("environment-status", error),
          loading: false,
          raw: sameRenderedScope ? current.raw : null,
        }))
      },
    )

    return () => {
      active = false
    }
  }, [environmentId, getApi, projectId, reloadGeneration])

  useEffect(() => {
    if (!projectId || !environmentId) return
    let active = true
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = getApi().onEnvironmentStatus((runtime) => {
        if (
          !active ||
          runtime.projectId !== projectId ||
          runtime.environmentId !== environmentId
        ) {
          return
        }
        const resolution = resolveEnvironmentRuntimeEvent(
          runtime,
          { projectId, environmentId },
          latestValueRef.current,
        )
        if (resolution.reason !== "accepted" || !resolution.value) return
        latestValueRef.current = resolution.value
        latestSequenceRef.current = resolution.value.data.sequence
        setSnapshot({
          data: resolution.value.data,
          error: null,
          loading: false,
          raw: resolution.value.raw,
        })
      })
    } catch {
      return () => {
        active = false
      }
    }
    return () => {
      active = false
      unsubscribe()
    }
  }, [environmentId, getApi, projectId])

  return { ...snapshot, reload }
}
