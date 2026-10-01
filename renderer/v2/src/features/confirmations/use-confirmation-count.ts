import { useCallback, useEffect, useRef, useState } from "react"

import {
  getAiOpsV2,
  type AiOpsV2Api,
  type ConfirmationRecord,
} from "@/bridge/ai-ops-v2"
import {
  ConfirmationCountReadCoordinator,
  confirmationCountForScope,
  confirmationCountLoading,
  confirmationCountScopeKey,
  confirmationCountSnapshot,
  type ConfirmationCountSnapshot,
  type ScopedConfirmationCountSnapshot,
} from "@/features/confirmations/confirmation-count-model"

type ConfirmationCountApi = Pick<AiOpsV2Api, "listConfirmations" | "onConfirmations">

interface ConfirmationCountScope {
  readonly projectId: string | null
  readonly environmentId: string | null
}

export function useConfirmationCount(
  scope: ConfirmationCountScope,
  getApi: () => ConfirmationCountApi = getAiOpsV2,
): ConfirmationCountSnapshot & { readonly retry: () => void } {
  const coordinatorRef = useRef(new ConfirmationCountReadCoordinator())
  const [retryEpoch, setRetryEpoch] = useState(0)
  const retry = useCallback(() => setRetryEpoch((current) => current + 1), [])
  const [state, setState] = useState<ScopedConfirmationCountSnapshot>({ scopeKey: confirmationCountScopeKey(scope), ...confirmationCountLoading(scope) })

  useEffect(() => {
    const coordinator = coordinatorRef.current
    const ticket = coordinator.activateScope(scope)
    const commit = (snapshot: ConfirmationCountSnapshot) => setState({ scopeKey: ticket.scopeKey, ...snapshot })
    if (!scope.projectId || !scope.environmentId) {
      commit(confirmationCountSnapshot(null, scope))
      return () => coordinator.deactivateScope(ticket)
    }
    commit(confirmationCountLoading(scope))
    let latestItems: readonly ConfirmationRecord[] = []
    let api: ConfirmationCountApi
    try {
      api = getApi()
    } catch {
      commit(confirmationCountSnapshot(null, scope))
      return () => coordinator.deactivateScope(ticket)
    }

    void Promise.resolve().then(() => api.listConfirmations()).then(
      (result) => {
        if (!coordinator.isReadCurrent(ticket)) return
        if (result.ok) latestItems = result.data
        commit(confirmationCountSnapshot(result.ok ? latestItems : null, scope))
      },
      () => {
        if (coordinator.isReadCurrent(ticket)) commit(confirmationCountSnapshot(null, scope))
      },
    )

    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = api.onConfirmations((items) => {
        if (coordinator.acceptSubscription(ticket)) {
          latestItems = items
          commit(confirmationCountSnapshot(latestItems, scope))
        }
      })
    } catch {
      // 订阅建立失败时仍以首次读取结果为准。
    }

    const timer = window.setInterval(() => {
      if (!coordinator.isScopeCurrent(ticket)) return
      const snapshot = confirmationCountSnapshot(latestItems, scope)
      setState((current) => current.loading || current.unavailable || current.count === snapshot.count
        ? current
        : { scopeKey: ticket.scopeKey, ...snapshot })
    }, 1_000)

    return () => {
      coordinator.deactivateScope(ticket)
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [getApi, retryEpoch, scope.environmentId, scope.projectId])

  return { ...confirmationCountForScope(state, scope), retry }
}
