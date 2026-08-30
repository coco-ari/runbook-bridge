import { useEffect, useRef, useState } from "react"

import { getAiOpsV2, type AiOpsV2Api } from "@/bridge/ai-ops-v2"
import {
  acceptWorkspaceRuntimeEvent,
  reconcileWorkspaceRuntimeCache,
  type WorkspaceReadModel,
  type WorkspaceRuntimeCache,
} from "@/features/workspace/workspace-read-model"

type WorkspaceRuntimeApi = Pick<AiOpsV2Api, "onEnvironmentStatus">

export interface UseWorkspaceRuntimeCacheOptions {
  readonly getApi?: () => WorkspaceRuntimeApi
}

function defaultGetApi(): WorkspaceRuntimeApi {
  return getAiOpsV2()
}

/**
 * Tracks normalized live status for every environment present in the current
 * workspace. It subscribes only; environment status reads remain owned by the
 * selected-scope hook.
 */
export function useWorkspaceRuntimeCache(
  workspace: WorkspaceReadModel | null,
  options: UseWorkspaceRuntimeCacheOptions = {},
): WorkspaceRuntimeCache {
  const getApi = options.getApi ?? defaultGetApi
  const workspaceRef = useRef(workspace)
  const [cache, setCache] = useState<WorkspaceRuntimeCache>(() =>
    reconcileWorkspaceRuntimeCache(workspace, new Map()),
  )
  workspaceRef.current = workspace

  useEffect(() => {
    setCache((current) => reconcileWorkspaceRuntimeCache(workspace, current))
  }, [workspace])

  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = getApi().onEnvironmentStatus((runtime) => {
        if (!active) return
        setCache((current) =>
          acceptWorkspaceRuntimeEvent(
            workspaceRef.current,
            current,
            runtime,
          ).cache,
        )
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
  }, [getApi])

  return cache
}
