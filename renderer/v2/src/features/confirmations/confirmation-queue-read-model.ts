export interface ConfirmationQueueReadState {
  readonly scopeKey: string
  readonly loading: boolean
  readonly hasSnapshot: boolean
  readonly error: string | null
}

export function confirmationQueueInitial(scopeKey: string): ConfirmationQueueReadState {
  return { scopeKey, loading: true, hasSnapshot: false, error: null }
}

export function confirmationQueueForScope(
  state: ConfirmationQueueReadState,
  scopeKey: string,
): ConfirmationQueueReadState {
  return state.scopeKey === scopeKey ? state : confirmationQueueInitial(scopeKey)
}

export function confirmationQueueReading(
  state: ConfirmationQueueReadState,
  scopeKey: string,
): ConfirmationQueueReadState {
  return { ...confirmationQueueForScope(state, scopeKey), loading: true, error: null }
}

export function confirmationQueueReceived(scopeKey: string): ConfirmationQueueReadState {
  return { scopeKey, loading: false, hasSnapshot: true, error: null }
}

export function confirmationQueueFailed(
  state: ConfirmationQueueReadState,
  scopeKey: string,
  error: string,
): ConfirmationQueueReadState {
  return { ...confirmationQueueForScope(state, scopeKey), loading: false, error }
}

export function confirmationQueuePresentation(state: ConfirmationQueueReadState, count: number) {
  if (!state.hasSnapshot) return state.loading
    ? { phase: "loading", label: "正在读取队列", variant: "outline", stale: false } as const
    : { phase: "unavailable", label: "队列不可用", variant: "warning", stale: false } as const
  if (state.loading || state.error) return {
    phase: state.loading ? "refreshing" : "stale",
    label: `上次读取：${count} 项`,
    variant: state.error ? "warning" : "outline",
    stale: true,
  } as const
  return { phase: "ready", label: `${count} 项待处理`, variant: count ? "warning" : "success", stale: false } as const
}
