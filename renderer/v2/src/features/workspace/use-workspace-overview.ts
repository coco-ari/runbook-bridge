import { useCallback, useEffect, useRef, useState } from "react"

import { getAiOpsV2, type AiOpsV2Api } from "@/bridge/ai-ops-v2"
import {
  createWorkspaceReadError,
  normalizeWorkspaceOverview,
  type WorkspaceReadError,
  type WorkspaceReadModel,
} from "@/features/workspace/workspace-read-model"
import {
  beginStaleRefresh,
  createWorkspaceRefreshCoordinator,
  failStaleRefresh,
  type WorkspaceRefreshCoordinator,
} from "@/features/workspace/workspace-refresh-coordinator"

type WorkspaceOverviewApi = Pick<
  AiOpsV2Api,
  "workspaceOverview" | "onWorkspaceChanged"
>

export interface UseWorkspaceOverviewOptions {
  readonly getApi?: () => WorkspaceOverviewApi
}

export interface WorkspaceOverviewReadState {
  readonly data: WorkspaceReadModel | null
  readonly error: WorkspaceReadError | null
  readonly loading: boolean
  readonly reload: () => void
}

interface WorkspaceOverviewSnapshot {
  readonly data: WorkspaceReadModel | null
  readonly error: WorkspaceReadError | null
  readonly loading: boolean
}

function defaultGetApi(): WorkspaceOverviewApi {
  return getAiOpsV2()
}

const INITIAL_SNAPSHOT: WorkspaceOverviewSnapshot = {
  data: null,
  error: null,
  loading: true,
}

export function useWorkspaceOverview(
  options: UseWorkspaceOverviewOptions = {},
): WorkspaceOverviewReadState {
  const getApi = options.getApi ?? defaultGetApi
  const getApiRef = useRef(getApi)
  const generationRef = useRef(0)
  const apiEpochRef = useRef(0)
  const mountedRef = useRef(false)
  const refreshRef = useRef<() => Promise<boolean>>(async () => false)
  const coordinatorRef = useRef<WorkspaceRefreshCoordinator | null>(null)
  const [snapshot, setSnapshot] = useState<WorkspaceOverviewSnapshot>(INITIAL_SNAPSHOT)
  getApiRef.current = getApi
  if (!coordinatorRef.current) {
    coordinatorRef.current = createWorkspaceRefreshCoordinator(
      () => refreshRef.current(),
    )
  }

  refreshRef.current = async () => {
    const epoch = apiEpochRef.current
    const generation = ++generationRef.current
    if (mountedRef.current) {
      setSnapshot(beginStaleRefresh)
    }

    let api: WorkspaceOverviewApi
    try {
      api = getApiRef.current()
    } catch (error) {
      if (
        mountedRef.current
        && epoch === apiEpochRef.current
        && generation === generationRef.current
      ) {
        setSnapshot((current) => failStaleRefresh(
          current,
          createWorkspaceReadError("workspace", error),
        ))
      }
      return false
    }

    try {
      const result = await api.workspaceOverview()
      if (
        !mountedRef.current
        || epoch !== apiEpochRef.current
        || generation !== generationRef.current
      ) return true
      if (!result.ok || !Array.isArray(result.data)) {
        setSnapshot((current) => failStaleRefresh(
          current,
          createWorkspaceReadError(
            "workspace",
            result.ok ? undefined : result.error,
          ),
        ))
        return false
      }
      setSnapshot({
        data: normalizeWorkspaceOverview(result.data),
        error: null,
        loading: false,
      })
      return true
    } catch (error) {
      if (
        mountedRef.current
        && epoch === apiEpochRef.current
        && generation === generationRef.current
      ) {
        setSnapshot((current) => failStaleRefresh(
          current,
          createWorkspaceReadError("workspace", error),
        ))
      }
      return false
    }
  }

  const reload = useCallback(() => {
    if (mountedRef.current) setSnapshot(beginStaleRefresh)
    void coordinatorRef.current?.request()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      apiEpochRef.current += 1
      generationRef.current += 1
    }
  }, [])

  useEffect(() => {
    const epoch = ++apiEpochRef.current
    let active = true
    let unsubscribe: () => void = () => undefined
    void coordinatorRef.current?.request()
    try {
      unsubscribe = getApi().onWorkspaceChanged(() => {
        if (active && epoch === apiEpochRef.current) reload()
      })
    } catch {
      return () => {
        active = false
      }
    }
    return () => {
      active = false
      unsubscribe()
      if (apiEpochRef.current === epoch) apiEpochRef.current += 1
    }
  }, [getApi, reload])

  return { ...snapshot, reload }
}
