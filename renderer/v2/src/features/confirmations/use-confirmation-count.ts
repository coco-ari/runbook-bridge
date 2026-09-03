import { useEffect, useRef, useState } from "react"

import {
  getAiOpsV2,
  type AiOpsV2Api,
  type ConfirmationRecord,
} from "@/bridge/ai-ops-v2"
import { countActiveConfirmations } from "@/features/confirmations/confirmation-count-model"

type ConfirmationCountApi = Pick<AiOpsV2Api, "listConfirmations" | "onConfirmations">

interface ConfirmationCountScope {
  readonly projectId: string | null
  readonly environmentId: string | null
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
    let latestItems: readonly ConfirmationRecord[] = []
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
        latestItems = result.ok ? result.data : []
        setState({ count: countActiveConfirmations(latestItems, scope), loading: false })
      },
      () => {
        if (active && generation === generationRef.current) setState({ count: 0, loading: false })
      },
    )

    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = api.onConfirmations((items) => {
        if (active && generation === generationRef.current) {
          latestItems = items
          setState({ count: countActiveConfirmations(latestItems, scope), loading: false })
        }
      })
    } catch {
      // The initial read remains authoritative when subscription setup fails.
    }

    const timer = window.setInterval(() => {
      if (!active || generation !== generationRef.current) return
      const count = countActiveConfirmations(latestItems, scope)
      setState((current) => current.loading || current.count === count
        ? current
        : { count, loading: false })
    }, 1_000)

    return () => {
      active = false
      generationRef.current += 1
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [getApi, scope.environmentId, scope.projectId])

  return state
}
