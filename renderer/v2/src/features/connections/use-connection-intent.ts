import { useCallback, useEffect, useRef, useState } from "react"

import type {
  AiOpsV2Api,
  ConnectionIntent,
  ConnectionIntentResult,
  EnvironmentRuntime,
  IpcResult,
  PublicError,
} from "@/bridge/ai-ops-v2"
import {
  connectionPlanFromChallengeConfirmation,
  connectionOperationIsCurrent,
  connectionOwnerKey,
  connectionPhaseFromRuntime,
  connectionResultMatches,
  initialConnectionState,
  runtimeHostKeyChallenge,
  runtimeMatchesEnvironmentScope,
  supersedeWithConnectionCancel,
  type ConnectionOperation,
  type ConnectionScope,
  type ConnectionState,
} from "@/features/connections/connection-model"

type StartableConnectionIntent = Exclude<ConnectionIntent, "cancel">

export interface UseConnectionIntentControllerOptions extends ConnectionScope {
  readonly api: AiOpsV2Api
  readonly pluginInstanceId?: string
  readonly expectedRevision?: number
  readonly runtime?: EnvironmentRuntime | null
  readonly source: string
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
}

export interface UseConnectionIntentControllerResult {
  readonly state: ConnectionState
  readonly connect: () => Promise<void>
  readonly retry: () => Promise<void>
  readonly disconnect: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly trustHostKey: () => Promise<void>
  readonly rejectHostKey: () => void
  readonly refresh: () => Promise<void>
}

class ConnectionApiError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(error: PublicError) {
    super(error.message)
    this.name = "ConnectionApiError"
    this.code = error.code
    if (error.details !== undefined) this.details = error.details
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw new ConnectionApiError(result.error)
}

function publicError(error: unknown): PublicError {
  if (error instanceof ConnectionApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    }
  }
  if (error instanceof Error) return { code: "CONNECTION_FAILED", message: error.message }
  return { code: "CONNECTION_FAILED", message: "连接操作失败。" }
}

function randomId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${value}`
}

function correlationError(): ConnectionApiError {
  return new ConnectionApiError({
    code: "CONNECTION_CORRELATION_MISMATCH",
    message: "连接操作返回了不匹配的关联标识。",
  })
}

function scopeError(): ConnectionApiError {
  return new ConnectionApiError({
    code: "CONNECTION_SCOPE_MISMATCH",
    message: "连接状态范围不匹配。",
  })
}

function runtimeIsCurrent(next: EnvironmentRuntime, current: EnvironmentRuntime | null): boolean {
  return Number.isSafeInteger(next.sequence) && next.sequence >= 0
    && (!current || next.sequence >= current.sequence)
}

export function useConnectionIntentController({
  api,
  projectId,
  environmentId,
  pluginInstanceId,
  expectedRevision,
  runtime = null,
  source,
  onRuntime,
}: UseConnectionIntentControllerOptions): UseConnectionIntentControllerResult {
  const scope = { projectId, environmentId }
  const ownerKey = connectionOwnerKey(scope, pluginInstanceId)
  const initialRuntime = runtimeMatchesEnvironmentScope(runtime, scope) ? runtime : null
  const [state, setState] = useState<ConnectionState>(() => ({
    ...initialConnectionState(ownerKey),
    runtime: initialRuntime,
    phase: connectionPhaseFromRuntime(initialRuntime, pluginInstanceId),
  }))
  const ownerRef = useRef(ownerKey)
  const runtimeRef = useRef<EnvironmentRuntime | null>(initialRuntime)
  const operationRef = useRef<ConnectionOperation | null>(null)
  const sequenceRef = useRef(0)
  const refreshSequenceRef = useRef(0)

  useEffect(() => {
    ownerRef.current = ownerKey
    runtimeRef.current = null
    operationRef.current = null
    sequenceRef.current = 0
    setState(initialConnectionState(ownerKey))
  }, [ownerKey])

  useEffect(() => {
    if (!runtimeMatchesEnvironmentScope(runtime, scope) || ownerRef.current !== ownerKey
      || !runtimeIsCurrent(runtime, runtimeRef.current)) return
    runtimeRef.current = runtime
    setState((current) => ({
      ...current,
      runtime,
      error: null,
      phase: operationRef.current
        ? current.phase
        : connectionPhaseFromRuntime(runtime, pluginInstanceId),
    }))
  }, [environmentId, ownerKey, pluginInstanceId, projectId, runtime])

  const acceptRuntime = useCallback((nextRuntime: EnvironmentRuntime) => {
    const expectedScope = { projectId, environmentId }
    if (ownerRef.current !== ownerKey
      || !runtimeMatchesEnvironmentScope(nextRuntime, expectedScope)
      || !runtimeIsCurrent(nextRuntime, runtimeRef.current)) return false
    runtimeRef.current = nextRuntime
    setState((current) => ({
      ...current,
      runtime: nextRuntime,
      error: null,
      phase: operationRef.current
        ? current.phase
        : connectionPhaseFromRuntime(nextRuntime, pluginInstanceId),
    }))
    onRuntime?.(nextRuntime)
    return true
  }, [environmentId, onRuntime, ownerKey, pluginInstanceId, projectId])

  const refresh = useCallback(async () => {
    const expectedOwner = ownerKey
    if (ownerRef.current !== expectedOwner) return
    const refreshSequence = ++refreshSequenceRef.current
    const runtimeAtStart = runtimeRef.current
    const operationAtStart = operationRef.current
    try {
      const nextRuntime = unwrap(await api.environmentStatus({ projectId, environmentId }))
      if (ownerRef.current === expectedOwner
        && refreshSequenceRef.current === refreshSequence) acceptRuntime(nextRuntime)
    } catch (error) {
      if (ownerRef.current === expectedOwner
        && refreshSequenceRef.current === refreshSequence
        && runtimeRef.current === runtimeAtStart
        && operationRef.current === operationAtStart) {
        setState((current) => ({ ...current, error: publicError(error), phase: "error" }))
      }
    }
  }, [acceptRuntime, api, environmentId, ownerKey, projectId])

  const finish = useCallback((
    operation: ConnectionOperation,
    result: ConnectionIntentResult,
    allowChallenge: boolean,
  ) => {
    const expectedScope = { projectId, environmentId }
    if (ownerRef.current !== operation.ownerKey
      || !connectionOperationIsCurrent(operationRef.current, operation)) return false
    if (!connectionResultMatches(operation, result, operation.ownerKey)) throw correlationError()
    if (!runtimeMatchesEnvironmentScope(result.snapshot, expectedScope)) throw scopeError()
    const accepted = runtimeIsCurrent(result.snapshot, runtimeRef.current)
    const nextRuntime = accepted ? result.snapshot : runtimeRef.current
    const challenge = allowChallenge && accepted
      ? runtimeHostKeyChallenge(result, pluginInstanceId)
      : null
    operationRef.current = null
    runtimeRef.current = nextRuntime
    setState((current) => ({
      ...current,
      runtime: nextRuntime,
      phase: connectionPhaseFromRuntime(nextRuntime, pluginInstanceId),
      operation: null,
      actions: accepted ? result.actions : [],
      challenge,
      error: null,
    }))
    if (accepted) onRuntime?.(result.snapshot)
    return true
  }, [environmentId, onRuntime, pluginInstanceId, projectId])

  const fail = useCallback((operation: ConnectionOperation, error: unknown) => {
    if (ownerRef.current !== operation.ownerKey
      || !connectionOperationIsCurrent(operationRef.current, operation)) return
    operationRef.current = null
    setState((current) => ({
      ...current,
      operation: null,
      phase: "error",
      error: publicError(error),
    }))
  }, [])

  const request = useCallback(async (intent: StartableConnectionIntent) => {
    if (operationRef.current) return
    const expectedOwner = ownerRef.current
    const planId = intent === "connect" || intent === "retry"
      ? randomId(pluginInstanceId ? "plugin-plan" : "environment-plan")
      : null
    const operation: ConnectionOperation = {
      ownerKey: expectedOwner,
      requestId: randomId(pluginInstanceId ? "plugin-connection" : "environment-connection"),
      intent,
      sequence: ++sequenceRef.current,
      planId,
      operationId: null,
    }
    operationRef.current = operation
    setState((current) => ({
      ...current,
      operation,
      challenge: null,
      error: null,
      phase: intent === "disconnect" ? "disconnecting" : "connecting",
    }))
    try {
      const result = unwrap(await api.requestConnectionIntent({
        projectId,
        environmentId,
        ...(pluginInstanceId ? { pluginInstanceId } : {}),
        intent,
        requestId: operation.requestId,
        source,
        ...(planId ? { planId } : {}),
        ...((intent === "connect" || intent === "retry") && expectedRevision !== undefined
          ? { expectedRevision }
          : {}),
      }))
      finish(operation, result, intent !== "disconnect")
    } catch (error) {
      fail(operation, error)
    }
  }, [
    api,
    environmentId,
    expectedRevision,
    fail,
    finish,
    pluginInstanceId,
    projectId,
    source,
  ])

  const cancel = useCallback(async () => {
    const active = operationRef.current
    if (active?.intent === "cancel") return
    const operation = supersedeWithConnectionCancel({
      active,
      runtime: runtimeRef.current,
      scope: { projectId, environmentId },
      ...(pluginInstanceId ? { pluginInstanceId } : {}),
      requestId: randomId(pluginInstanceId ? "plugin-cancel" : "environment-cancel"),
      sequence: ++sequenceRef.current,
    })
    if (!operation) {
      setState((current) => ({
        ...current,
        error: {
          code: "CONNECTION_OPERATION_NOT_OWNED",
          message: "未找到属于当前范围的活动连接操作。",
        },
      }))
      return
    }
    operationRef.current = operation
    setState((current) => ({
      ...current,
      operation,
      challenge: null,
      error: null,
    }))
    try {
      const result = unwrap(await api.requestConnectionIntent({
        projectId,
        environmentId,
        ...(pluginInstanceId ? { pluginInstanceId } : {}),
        intent: "cancel",
        requestId: operation.requestId,
        source,
        planId: operation.planId,
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
      }))
      finish(operation, result, false)
    } catch (error) {
      fail(operation, error)
    }
  }, [api, environmentId, fail, finish, pluginInstanceId, projectId, source])

  const trustHostKey = useCallback(async () => {
    const challenge = state.challenge
    if (!challenge || operationRef.current) return
    const operation: ConnectionOperation = {
      ownerKey: ownerRef.current,
      requestId: randomId("host-key-confirmation"),
      intent: "connect",
      sequence: ++sequenceRef.current,
      planId: challenge.planId,
      operationId: challenge.operationId,
    }
    operationRef.current = operation
    setState((current) => ({ ...current, operation, error: null }))
    try {
      const confirmation = unwrap(await api.confirmConnectionChallenge({
        challengeId: challenge.challengeId,
        planId: challenge.planId,
        operationId: challenge.operationId,
        expectedRevision: challenge.expectedRevision,
        decision: "trust-host-key",
      }))
      if (!connectionOperationIsCurrent(operationRef.current, operation)) return
      const connectionPlan = connectionPlanFromChallengeConfirmation(confirmation)
      if (connectionPlan) {
        if (connectionPlan.planId !== challenge.planId) throw correlationError()
        if (!runtimeMatchesEnvironmentScope(connectionPlan.snapshot, { projectId, environmentId })) {
          throw scopeError()
        }
        const accepted = runtimeIsCurrent(connectionPlan.snapshot, runtimeRef.current)
        const nextRuntime = accepted ? connectionPlan.snapshot : runtimeRef.current
        operationRef.current = null
        runtimeRef.current = nextRuntime
        setState((current) => ({
          ...current,
          runtime: nextRuntime,
          phase: connectionPhaseFromRuntime(nextRuntime, pluginInstanceId),
          operation: null,
          actions: accepted ? connectionPlan.actions : [],
          challenge: accepted ? runtimeHostKeyChallenge(connectionPlan, pluginInstanceId) : null,
          error: null,
        }))
        if (accepted) onRuntime?.(connectionPlan.snapshot)
        return
      }
      operationRef.current = null
      setState((current) => ({ ...current, operation: null, challenge: null }))
      await refresh()
    } catch (error) {
      fail(operation, error)
    }
  }, [
    api,
    environmentId,
    fail,
    onRuntime,
    pluginInstanceId,
    projectId,
    refresh,
    state.challenge,
  ])

  const rejectHostKey = useCallback(() => {
    if (operationRef.current) return
    setState((current) => ({ ...current, challenge: null }))
  }, [])

  return {
    state,
    connect: () => request("connect"),
    retry: () => request("retry"),
    disconnect: () => request("disconnect"),
    cancel,
    trustHostKey,
    rejectHostKey,
    refresh,
  }
}

export const CONNECTION_INTENT_CONTROLLER_SECURITY_CONTRACT = Object.freeze({
  usesConnectionIntentCoordinator: true,
  automaticallyConnects: false,
  cancelRequiresOwnedPlan: true,
  hostKeysRequireExplicitConfirmation: true,
  fencesLateResultsByScopeAndOperation: true,
  sendsCredentials: false,
})
