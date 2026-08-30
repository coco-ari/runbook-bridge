import { useEffect, useRef, useState } from "react"

import {
  getAiOpsV2,
  type AiOpsV2Api,
  type ConfirmationRecord,
} from "@/bridge/ai-ops-v2"

type ConfirmationCountApi = Pick<AiOpsV2Api, "listConfirmations" | "onConfirmations">

interface ConfirmationCountScope {
  readonly projectId: string | null
  readonly environmentId: string | null
}

function countValid(
  items: readonly ConfirmationRecord[],
  scope: ConfirmationCountScope,
): number {
  if (!scope.projectId || !scope.environmentId) return 0
  const ids = new Set<string>()
  for (const item of items) {
    if (
      typeof item.requestId === "string"
      && item.requestId.length > 0
      && item.projectId === scope.projectId
      && item.environmentId === scope.environmentId
    ) ids.add(item.requestId)
  }
  return ids.size
}

export function useConfirmationCount(
  scope: ConfirmationCountScope,
  getApi: () => ConfirmationCountApi = getAiOpsV2,
): Readonly<{ count: number; loading: boolean }> {
  const generationRef = useRef(0)
  const [state, setState] = useState({ count: 0, loading: true })

  useEffect(() => {
    const generation = ++generationRef.current
    let active = true
    if (!scope.projectId || !scope.environmentId) {
      setState({ count: 0, loading: false })
      return () => {
        active = false
        generationRef.current += 1
      }
    }
    setState({ count: 0, loading: true })
    let api: ConfirmationCountApi
    try {
      api = getApi()
    } catch {
      setState({ count: 0, loading: false })
      return () => {
        active = false
      }
    }

    void api.listConfirmations().then(
      (result) => {
        if (!active || generation !== generationRef.current) return
        setState({ count: result.ok ? countValid(result.data, scope) : 0, loading: false })
      },
      () => {
        if (active && generation === generationRef.current) setState({ count: 0, loading: false })
      },
    )

    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = api.onConfirmations((items) => {
        if (active && generation === generationRef.current) {
          setState({ count: countValid(items, scope), loading: false })
        }
      })
    } catch {
      // The initial read remains authoritative when subscription setup fails.
    }

    return () => {
      active = false
      generationRef.current += 1
      unsubscribe()
    }
  }, [getApi, scope.environmentId, scope.projectId])

  return state
}
