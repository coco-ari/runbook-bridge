import { useCallback, useEffect, useRef, useState } from "react"

import {
  getAiOpsV2,
  type AiOpsV2Api,
  type PluginRecord,
} from "@/bridge/ai-ops-v2"
import {
  normalizeWorkspacePluginList,
  type WorkspacePluginReadModel,
  type WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"

type EnvironmentPluginsApi = Pick<AiOpsV2Api, "listPlugins" | "onWorkspaceChanged">

export interface EnvironmentPluginsScope {
  readonly environmentId: string
  readonly projectId: string
}

export interface EnvironmentPluginsReadState {
  readonly data: readonly WorkspacePluginReadModel[] | null
  readonly error: WorkspaceReadError | null
  readonly loading: boolean
  readonly records: readonly PluginRecord[] | null
  readonly reload: () => void
  readonly scopeKey: string | null
}

export interface UseEnvironmentPluginsOptions {
  readonly getApi?: () => EnvironmentPluginsApi
}

function defaultGetApi(): EnvironmentPluginsApi {
  return getAiOpsV2()
}

const READ_ERROR: WorkspaceReadError = {
  code: "PLUGIN_LIST_READ_FAILED",
  message: "无法读取插件列表。请重试。",
}

export function useEnvironmentPlugins(
  scope: EnvironmentPluginsScope | null,
  options: UseEnvironmentPluginsOptions = {},
): EnvironmentPluginsReadState {
  const getApi = options.getApi ?? defaultGetApi
  const projectId = scope?.projectId ?? null
  const environmentId = scope?.environmentId ?? null
  const generationRef = useRef(0)
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    data: readonly WorkspacePluginReadModel[] | null
    error: WorkspaceReadError | null
    loading: boolean
    records: readonly PluginRecord[] | null
    scopeKey: string | null
  }>({ data: null, error: null, loading: false, records: null, scopeKey: null })

  const reload = useCallback(() => {
    generationRef.current += 1
    // Invalidate the old snapshot in the same batch as a post-save selection.
    // Waiting until the read effect runs can incorrectly reject a newly created id.
    setSnapshot((current) => ({ ...current, error: null, loading: true }))
    setReloadGeneration((generation) => generation + 1)
  }, [])

  useEffect(() => {
    const generation = ++generationRef.current
    let active = true
    if (!projectId || !environmentId) {
      setSnapshot({ data: null, error: null, loading: false, records: null, scopeKey: null })
      return () => {
        active = false
      }
    }

    const scopeKey = `${projectId}/${environmentId}`
    setSnapshot((current) => current.scopeKey === scopeKey
      ? { ...current, error: null, loading: true }
      : { data: null, error: null, loading: true, records: null, scopeKey })
    let api: EnvironmentPluginsApi
    try {
      api = getApi()
    } catch {
      setSnapshot((current) => current.scopeKey === scopeKey
        ? { ...current, error: READ_ERROR, loading: false }
        : { data: null, error: READ_ERROR, loading: false, records: null, scopeKey })
      return () => {
        active = false
      }
    }

    void api.listPlugins({ projectId, environmentId }).then(
      (result) => {
        if (!active || generation !== generationRef.current) return
        if (!result.ok) {
          setSnapshot((current) => current.scopeKey === scopeKey
            ? { ...current, error: READ_ERROR, loading: false }
            : { data: null, error: READ_ERROR, loading: false, records: null, scopeKey })
          return
        }
        if (!Array.isArray(result.data)) {
          setSnapshot((current) => current.scopeKey === scopeKey
            ? { ...current, error: READ_ERROR, loading: false }
            : { data: null, error: READ_ERROR, loading: false, records: null, scopeKey })
          return
        }
        const data = normalizeWorkspacePluginList(result.data, { projectId, environmentId })
        const allowedIds = new Set(data.map((plugin) => plugin.pluginInstanceId))
        const records = result.data.filter((plugin) =>
          plugin.projectId === projectId
          && plugin.environmentId === environmentId
          && allowedIds.has(plugin.pluginInstanceId),
        )
        setSnapshot({
          data,
          error: null,
          loading: false,
          records,
          scopeKey,
        })
      },
      () => {
        if (!active || generation !== generationRef.current) return
        setSnapshot((current) => current.scopeKey === scopeKey
          ? { ...current, error: READ_ERROR, loading: false }
          : { data: null, error: READ_ERROR, loading: false, records: null, scopeKey })
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
      unsubscribe = getApi().onWorkspaceChanged((change) => {
        if (!active) return
        if (change.projectId && change.projectId !== projectId) return
        if (change.environmentId && change.environmentId !== environmentId) return
        reload()
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
  }, [environmentId, getApi, projectId, reload])

  return { ...snapshot, reload }
}
