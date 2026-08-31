import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"

import type {
  AiOpsV2Api,
  EnvironmentScope,
  IpcResult,
  OpaqueData,
  PluginEditPreparation,
  PublicError,
} from "@/bridge/ai-ops-v2"
import {
  editPreparationDescription,
  editPreparationNeedsConfirmation,
  hostKeyChallengeFromError,
  initialPluginEditorState,
  mergeValidationProgress,
  pluginEditorIsDirty,
  pluginEditorReducer,
  normalizePluginSaveOutcome,
  validationMatches,
  type HostKeyChallenge,
  type PluginEditorState,
  type PluginSaveOutcome,
  type PluginValidationState,
} from "@/features/plugins/plugin-editor-model"
import {
  asPluginDraft,
  collectReplacementSecrets,
  connectionPatch,
  credentialMutationFor,
  emptyCredentialDraft,
  emptyPluginDraft,
  normalizePluginDraft,
  pluginDraftFromRecord,
  validatePluginDraft,
  type PluginConfigurationRecord,
  type PluginCredentialDraft,
  type PluginFormDraft,
  type PluginKind,
} from "@/features/plugins/plugin-types"
import {
  connectionRequestWasAccepted,
  editAfterCommitFor,
  pluginSaveStrategyIsAvailable,
  type PluginSaveStrategy,
} from "@/features/plugins/plugin-save-strategy"

export interface UsePluginEditorOptions {
  readonly api: AiOpsV2Api
  readonly open: boolean
  readonly scope: EnvironmentScope
  readonly plugin: PluginConfigurationRecord | null
  readonly initialKind?: PluginKind
  readonly onSaved?: (outcome: PluginSaveOutcome) => void
  readonly onClosed?: () => void
}

export interface UsePluginEditorResult {
  readonly state: PluginEditorState
  readonly isCreating: boolean
  readonly isDirty: boolean
  readonly updateDraft: (updater: (current: PluginFormDraft) => PluginFormDraft) => void
  readonly setPluginKind: (kind: PluginKind) => void
  readonly setCredentials: (credential: PluginCredentialDraft) => void
  readonly refreshCredentialStatus: () => Promise<void>
  readonly acceptEditImpact: () => Promise<void>
  readonly rejectEditImpact: () => Promise<void>
  readonly acceptHostKey: () => Promise<void>
  readonly acceptTlsFallback: () => Promise<void>
  readonly rejectConfirmation: () => void
  readonly validate: (purpose?: "validate" | "tls") => Promise<boolean>
  readonly cancelValidation: () => Promise<void>
  readonly discoverDatabases: () => Promise<void>
  readonly save: (strategy?: PluginSaveStrategy) => Promise<void>
  readonly confirmCredentialReplacement: () => Promise<void>
  readonly cancel: () => Promise<boolean>
}

class RendererApiError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(error: PublicError) {
    super(error.message)
    this.name = "RendererApiError"
    this.code = error.code
    if (error.details !== undefined) this.details = error.details
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw new RendererApiError(result.error)
}

function publicError(error: unknown): PublicError {
  if (error instanceof RendererApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    }
  }
  if (error instanceof Error) return { code: "RENDERER_OPERATION_FAILED", message: error.message }
  return { code: "RENDERER_OPERATION_FAILED", message: "操作失败。" }
}

function randomId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${value}`
}

function ownerKey(scope: EnvironmentScope, plugin: PluginConfigurationRecord | null): string {
  return `${scope.projectId}/${scope.environmentId}/${plugin?.pluginInstanceId ?? "new"}`
}

function draftSignature(draft: PluginFormDraft, credentials: PluginCredentialDraft): string {
  return JSON.stringify({
    draft: normalizePluginDraft(draft),
    credentialPresence: {
      primary: credentials.primary.length > 0,
      proxy: credentials.proxy.length > 0,
    },
  })
}

function pluginValidationPurpose(kind: PluginKind, purpose: "validate" | "tls"): string {
  if (purpose === "tls") return "tls-probe"
  if (kind === "server") return "server-auth"
  return "resource-access"
}

function validationRecord(value: OpaqueData): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>
}

function hostKeyDescription(challenge: HostKeyChallenge): string {
  const algorithm = challenge.algorithm ? `，算法 ${challenge.algorithm}` : ""
  return `主机 ${challenge.host}:${challenge.port}${algorithm}，指纹 ${challenge.fingerprint}。仅在你确认后，指纹才会写入当前草稿。`
}

function editPreparationCounts(preparation: PluginEditPreparation): {
  readonly connected: number
  readonly affected: number
} {
  return {
    connected: Array.isArray(preparation.preEditConnectedSet)
      ? preparation.preEditConnectedSet.length
      : 0,
    affected: Array.isArray(preparation.affectedIds)
      ? preparation.affectedIds.length
      : 0,
  }
}

export function usePluginEditor({
  api,
  open,
  scope,
  plugin,
  initialKind = "server",
  onSaved,
  onClosed,
}: UsePluginEditorOptions): UsePluginEditorResult {
  const currentOwnerKey = ownerKey(scope, plugin)
  const initialDraft = useMemo(
    () => plugin ? pluginDraftFromRecord(plugin) : emptyPluginDraft(initialKind),
    [initialKind, plugin],
  )
  const [state, dispatch] = useReducer(
    pluginEditorReducer,
    initialPluginEditorState(currentOwnerKey, initialDraft),
  )
  const stateRef = useRef(state)
  const epochRef = useRef(0)
  const sequenceRef = useRef(0)
  const preparationRef = useRef<string | null>(null)
  const sessionRef = useRef<string | null>(null)
  const activeValidationRef = useRef<PluginValidationState | null>(null)
  const pendingValidationRequestRef = useRef<string | null>(null)
  const pendingValidationCancellationsRef = useRef(new Map<string, PluginValidationState>())
  const saveInFlightRef = useRef(false)
  const pendingForceSaveRef = useRef(false)
  const pendingSaveStrategyRef = useRef<PluginSaveStrategy>("disconnect")
  const pendingValidationRetryRef = useRef<Readonly<{
    purpose: "validate" | "tls"
    saveAfterValidation: boolean
    saveStrategy: PluginSaveStrategy
  }> | null>(null)
  const isDirty = open
    && state.phase !== "closed"
    && state.ownerKey === currentOwnerKey
    && pluginEditorIsDirty(initialDraft, state.draft, state.credentials)

  useEffect(() => {
    stateRef.current = state
    activeValidationRef.current = state.validation?.state === "running" ? state.validation : null
  }, [state])

  const isCurrent = useCallback((epoch: number, expectedOwner = currentOwnerKey) => (
    epochRef.current === epoch
      && `${scope.projectId}/${scope.environmentId}/${plugin?.pluginInstanceId ?? "new"}` === expectedOwner
  ), [currentOwnerKey, plugin?.pluginInstanceId, scope.environmentId, scope.projectId])

  const beginPreparedEdit = useCallback(async (
    preparation: PluginEditPreparation,
    epoch: number,
  ) => {
    if (!isCurrent(epoch)) return
    const session = unwrap(await api.beginPluginConnectionEdit({ prepareToken: preparation.prepareToken }))
    if (!isCurrent(epoch)) {
      await api.cancelPluginConnectionEdit({
        editSessionId: session.editSessionId,
        restorePreEditConnections: true,
      })
      return
    }
    preparationRef.current = null
    sessionRef.current = session.editSessionId
    dispatch({ type: "edit-started", editSessionId: session.editSessionId })
  }, [api, isCurrent])

  useEffect(() => {
    const epoch = ++epochRef.current
    sequenceRef.current = 0
    activeValidationRef.current = null
    pendingValidationRequestRef.current = null
    pendingValidationCancellationsRef.current.clear()
    saveInFlightRef.current = false
    pendingForceSaveRef.current = false
    pendingSaveStrategyRef.current = "disconnect"
    pendingValidationRetryRef.current = null
    preparationRef.current = null
    sessionRef.current = null

    if (!open) {
      dispatch({ type: "closed" })
      return
    }

    dispatch({ type: "reset", ownerKey: currentOwnerKey, draft: initialDraft })
    if (!plugin) return () => {
      epochRef.current += 1
      pendingValidationRequestRef.current = null
      const active = activeValidationRef.current
      activeValidationRef.current = null
      dispatch({ type: "clear-sensitive" })
      if (active) {
        void api.cancelPluginProbe({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          formInstanceId: currentOwnerKey,
          requestId: active.requestId,
        }).catch(() => undefined)
      }
    }

    const pluginScope = {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
    }
    void api.credentialStatus(pluginScope).then((result) => {
      if (isCurrent(epoch) && result.ok) dispatch({ type: "credential-status", status: result.data })
    })

    dispatch({ type: "preparing" })
    void api.preparePluginConnectionEdit({
      ...pluginScope,
      expectedRevision: plugin.revision,
    }).then(async (result) => {
      const preparation = unwrap(result)
      if (!isCurrent(epoch)) {
        await api.cancelPluginConnectionEdit({ prepareToken: preparation.prepareToken })
        return
      }
      preparationRef.current = preparation.prepareToken
      const needsConfirmation = editPreparationNeedsConfirmation(preparation)
      dispatch({
        type: "prepared",
        preparation,
        needsConfirmation,
        description: editPreparationDescription(preparation, plugin.displayName),
      })
      if (!needsConfirmation) await beginPreparedEdit(preparation, epoch)
    }).catch((error: unknown) => {
      if (isCurrent(epoch)) dispatch({ type: "failure", error: publicError(error) })
    })

    return () => {
      epochRef.current += 1
      activeValidationRef.current = null
      pendingValidationRequestRef.current = null
      pendingValidationCancellationsRef.current.clear()
      const editSessionId = sessionRef.current
      const prepareToken = preparationRef.current
      sessionRef.current = null
      preparationRef.current = null
      dispatch({ type: "clear-sensitive" })
      if (editSessionId) {
        void api.cancelPluginConnectionEdit({
          editSessionId,
          restorePreEditConnections: true,
        })
      } else if (prepareToken) {
        void api.cancelPluginConnectionEdit({ prepareToken })
      }
    }
  }, [api, beginPreparedEdit, currentOwnerKey, initialDraft, isCurrent, open, plugin, scope.environmentId, scope.projectId])

  const cancelValidationOperation = useCallback(async (active: PluginValidationState) => {
    try {
      if (active.editSessionId) {
        if (!active.operationId) return
        unwrap(await api.cancelPluginValidation({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          editSessionId: active.editSessionId,
          operationId: active.operationId,
        }))
      } else {
        unwrap(await api.cancelPluginProbe({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          formInstanceId: stateRef.current.ownerKey,
          requestId: active.requestId,
          ...(active.operationId ? { operationId: active.operationId } : {}),
        }))
      }
    } catch (error) {
      const failure = publicError(error)
      if (["PLUGIN_VALIDATION_STALE", "PLUGIN_EDIT_SESSION_STALE"].includes(failure.code)) return
      if (stateRef.current.validation?.requestId !== active.requestId) return
      activeValidationRef.current = { ...active, state: "running" }
      dispatch({ type: "validation-started", validation: activeValidationRef.current })
      dispatch({ type: "failure", error: failure })
    }
  }, [api, scope.environmentId, scope.projectId])

  useEffect(() => api.onPluginValidationProgress((progress) => {
    const queued = typeof progress.requestId === "string"
      ? pendingValidationCancellationsRef.current.get(progress.requestId)
      : undefined
    if (queued && validationMatches(queued,progress) && typeof progress.operationId === "string") {
      pendingValidationCancellationsRef.current.delete(queued.requestId)
      if (progress.state === "running") {
        void cancelValidationOperation({ ...queued, operationId: progress.operationId })
      }
      return
    }
    const active = activeValidationRef.current
    if (!active) return
    const next = mergeValidationProgress(active, progress)
    if (next === active) return
    activeValidationRef.current = next.state === "running" ? next : null
    dispatch({
      type: next.state === "running" ? "validation-progress" : "validation-finished",
      validation: next,
    })
  }), [api, cancelValidationOperation])

  useEffect(() => api.onPluginProbeProgress((progress) => {
    const active = activeValidationRef.current
    if (!active || active.editSessionId) return
    const next = mergeValidationProgress(active, progress)
    if (next === active) return
    activeValidationRef.current = next.state === "running" ? next : null
    dispatch({
      type: next.state === "running" ? "validation-progress" : "validation-finished",
      validation: next,
    })
  }), [api])

  const updateDraft = useCallback((updater: (current: PluginFormDraft) => PluginFormDraft) => {
    dispatch({ type: "draft", draft: updater(stateRef.current.draft) })
  }, [])

  const setPluginKind = useCallback((kind: PluginKind) => {
    if (plugin || saveInFlightRef.current) return
    dispatch({ type: "draft", draft: emptyPluginDraft(kind) })
    dispatch({ type: "credentials", credentials: emptyCredentialDraft() })
  }, [plugin])

  const setCredentials = useCallback((credentials: PluginCredentialDraft) => {
    dispatch({ type: "credentials", credentials })
  }, [])

  const refreshCredentialStatus = useCallback(async () => {
    if (!plugin) return
    const epoch = epochRef.current
    const expectedOwner = stateRef.current.ownerKey
    const result = await api.credentialStatus({
      projectId: plugin.projectId,
      environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
    })
    if (!isCurrent(epoch, expectedOwner)) return
    if (result.ok) dispatch({ type: "credential-status", status: result.data })
  }, [api, isCurrent, plugin])

  const acceptEditImpact = useCallback(async () => {
    const preparation = stateRef.current.preparation
    if (!preparation || stateRef.current.confirmation?.kind !== "edit-impact") return
    await beginPreparedEdit(preparation, epochRef.current)
  }, [beginPreparedEdit])

  const rejectEditImpact = useCallback(async () => {
    const prepareToken = preparationRef.current
    try {
      if (prepareToken) unwrap(await api.cancelPluginConnectionEdit({ prepareToken }))
      if (preparationRef.current === prepareToken) preparationRef.current = null
      dispatch({ type: "clear-sensitive" })
      dispatch({ type: "closed" })
      onClosed?.()
    } catch (error) {
      dispatch({
        type: "failure",
        error: {
          ...publicError(error),
          message: "无法安全取消编辑准备，请重试。当前准备凭证仍被保留。",
        },
      })
    }
  }, [api, onClosed])

  const rejectConfirmation = useCallback(() => {
    pendingForceSaveRef.current = false
    pendingValidationRetryRef.current = null
    dispatch({ type: "confirmation", confirmation: null })
  }, [])

  const runValidation = useCallback(async (
    purpose: "validate" | "tls" = "validate",
    saveAfterValidation = false,
    saveStrategy: PluginSaveStrategy = "disconnect",
  ): Promise<boolean> => {
    const snapshot = stateRef.current
    if (activeValidationRef.current || pendingValidationRequestRef.current || saveInFlightRef.current || !open) return false
    if (plugin && !sessionRef.current) {
      dispatch({
        type: "failure",
        error: { code: "PLUGIN_EDIT_SESSION_REQUIRED", message: "连接配置编辑会话尚未就绪。" },
      })
      return false
    }
    const issues = validatePluginDraft(snapshot.draft, purpose)
    if (!plugin && snapshot.draft.pluginType === "server"
      && snapshot.draft.auth.type === "password"
      && snapshot.credentials.primary.length === 0) {
      dispatch({ type: "issues", issues: [...issues, { field: "primaryCredential", message: "请为新 Server 输入 SSH 密码。" }] })
      return false
    }
    if (issues.length > 0) {
      dispatch({ type: "issues", issues })
      return false
    }

    const epoch = epochRef.current
    const expectedOwner = snapshot.ownerKey
    const sequence = ++sequenceRef.current
    const requestId = randomId(plugin ? "validation" : "probe")
    pendingValidationRequestRef.current = requestId
    const draftGeneration = snapshot.draftGeneration
    const servicePurpose = pluginValidationPurpose(snapshot.draft.pluginType, purpose)
    const editSessionId = sessionRef.current
    const active: PluginValidationState = {
      requestId,
      purpose: servicePurpose,
      draftGeneration,
      sequence,
      ...(editSessionId ? { editSessionId } : {}),
      state: "running",
    }
    activeValidationRef.current = active
    dispatch({ type: "validation-started", validation: active })

    const normalizedDraft = normalizePluginDraft(snapshot.draft)
    const secrets = collectReplacementSecrets(
      normalizedDraft.pluginType,
      normalizedDraft.auth.type,
      snapshot.credentials,
    )
    const credentialIntent = credentialMutationFor(secrets)
    try {
      const response = plugin && editSessionId
        ? unwrap(await api.validatePluginDraft({
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            pluginInstanceId: plugin.pluginInstanceId,
            editSessionId,
            requestId,
            draft: asPluginDraft(normalizedDraft),
            purpose: servicePurpose,
            credentialIntent,
            discardTemporarySecrets: true,
            ...(Object.keys(secrets).length > 0 ? { temporarySecrets: secrets } : {}),
            draftGeneration,
            sequence,
          }))
        : unwrap(await api.probePluginDraft({
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            ...(normalizedDraft.pluginInstanceId
              ? { pluginInstanceId: normalizedDraft.pluginInstanceId }
              : {}),
            formInstanceId: expectedOwner,
            requestId,
            purpose: servicePurpose,
            draft: asPluginDraft(normalizedDraft),
            draftGeneration,
            sequence,
            ...(Object.keys(secrets).length > 0 ? { temporarySecrets: secrets } : {}),
          }))
      const responseRecord = validationRecord(response)
      const candidate: Readonly<Record<string, unknown>> = {
        ...responseRecord,
        requestId: responseRecord.requestId ?? requestId,
        draftGeneration: responseRecord.draftGeneration ?? draftGeneration,
        sequence: responseRecord.sequence ?? sequence,
        ...(editSessionId
          ? { editSessionId: responseRecord.editSessionId ?? editSessionId }
          : {}),
      }
      if (!isCurrent(epoch, expectedOwner)
        || pendingValidationRequestRef.current !== requestId
        || stateRef.current.draftGeneration !== draftGeneration
        || !validationMatches(active, candidate)) return false
      const finished: PluginValidationState = {
        ...active,
        state: "valid",
        result: response,
        ...(typeof responseRecord.operationId === "string" ? { operationId: responseRecord.operationId } : {}),
        ...(typeof responseRecord.configDigest === "string" ? { configDigest: responseRecord.configDigest } : {}),
      }
      activeValidationRef.current = null
      dispatch({ type: "validation-finished", validation: finished })
      return true
    } catch (error) {
      const apiError = publicError(error)
      if (!isCurrent(epoch, expectedOwner)
        || pendingValidationRequestRef.current !== requestId
        || stateRef.current.draftGeneration !== draftGeneration) return false
      const errorDetails = apiError.details !== null && typeof apiError.details === "object"
        ? (apiError.details as Readonly<Record<string, unknown>>)
        : {}
      const correlatedError: Readonly<Record<string, unknown>> = {
        ...errorDetails,
        requestId: errorDetails.requestId ?? requestId,
        draftGeneration: errorDetails.draftGeneration ?? draftGeneration,
        sequence: errorDetails.sequence ?? sequence,
        ...(editSessionId
          ? { editSessionId: errorDetails.editSessionId ?? editSessionId }
          : {}),
      }
      if (!validationMatches(active, correlatedError)) return false
      const challenge = snapshot.draft.pluginType === "server"
        ? hostKeyChallengeFromError(apiError, normalizedDraft)
        : null
      const failed: PluginValidationState = {
        ...active,
        state: apiError.code === "PLUGIN_VALIDATION_CANCELLED" ? "cancelled" : "failed",
        error: apiError,
      }
      activeValidationRef.current = null
      dispatch({ type: "validation-finished", validation: failed })
      if (challenge) {
        pendingValidationRetryRef.current = { purpose,saveAfterValidation,saveStrategy }
        dispatch({
          type: "confirmation",
          confirmation: {
            kind: "host-key",
            title: "确认服务器指纹",
            description: hostKeyDescription(challenge),
            hostKey: challenge,
          },
        })
      } else if (
        apiError.code === "TLS_UNSUPPORTED"
        && normalizedDraft.pluginType !== "server"
        && normalizedDraft.tls?.mode !== "disabled"
      ) {
        pendingValidationRetryRef.current = { purpose,saveAfterValidation,saveStrategy }
        dispatch({
          type: "confirmation",
          confirmation: {
            kind: "disable-tls",
            title: "目标不支持 TLS",
            description: "仅对此明确的 TLS_UNSUPPORTED 结果，可以把当前草稿改为不使用 TLS 并重新验证。保存前不会修改正式配置。",
          },
        })
      } else {
        pendingValidationRetryRef.current = null
      }
      return false
    } finally {
      if (pendingValidationRequestRef.current === requestId) pendingValidationRequestRef.current = null
      pendingValidationCancellationsRef.current.delete(requestId)
    }
  }, [api, isCurrent, open, plugin, scope.environmentId, scope.projectId])

  const validate = useCallback((purpose: "validate" | "tls" = "validate") => {
    pendingValidationRetryRef.current = null
    return runValidation(purpose,false)
  },[runValidation])

  const cancelValidation = useCallback(async () => {
    const active = activeValidationRef.current
    if (!active) return
    pendingValidationRequestRef.current = null
    activeValidationRef.current = null
    const cancelled = { ...active, state: "cancelled" as const }
    dispatch({ type: "validation-finished", validation: cancelled })
    if (active.editSessionId && !active.operationId) {
      pendingValidationCancellationsRef.current.set(active.requestId,active)
      return
    }
    await cancelValidationOperation(active)
  }, [cancelValidationOperation])

  const discoverDatabases = useCallback(async () => {
    const snapshot = stateRef.current
    if (snapshot.draft.pluginType !== "mysql" || snapshot.databasesLoading) return
    const issues = validatePluginDraft(snapshot.draft, "tls").filter((issue) => issue.field !== "database")
    if (issues.length > 0) {
      dispatch({ type: "issues", issues })
      return
    }
    const epoch = epochRef.current
    const expectedOwner = snapshot.ownerKey
    const draftGeneration = snapshot.draftGeneration
    const expectedSignature = draftSignature(snapshot.draft, snapshot.credentials)
    const secrets = collectReplacementSecrets("mysql", undefined, snapshot.credentials)
    dispatch({ type: "databases-loading" })
    try {
      const result = unwrap(await api.listPluginDatabases({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(plugin?.pluginInstanceId ? { pluginInstanceId: plugin.pluginInstanceId } : {}),
        input: asPluginDraft(normalizePluginDraft(snapshot.draft)),
        ...(Object.keys(secrets).length > 0 ? { temporarySecrets: secrets } : {}),
        credentialIntent: credentialMutationFor(secrets),
        ...(sessionRef.current ? { editSessionId: sessionRef.current } : {}),
        draftGeneration: snapshot.draftGeneration,
      }))
      if (!isCurrent(epoch, expectedOwner)
        || stateRef.current.draftGeneration !== draftGeneration
        || draftSignature(stateRef.current.draft, stateRef.current.credentials) !== expectedSignature) return
      dispatch({ type: "databases", result })
    } catch (error) {
      if (isCurrent(epoch, expectedOwner) && stateRef.current.draftGeneration === draftGeneration) {
        dispatch({ type: "failure", error: publicError(error) })
      }
    }
  }, [api, isCurrent, plugin?.pluginInstanceId, scope.environmentId, scope.projectId])

  const persist = useCallback(async (
    strategy: PluginSaveStrategy,
    forceCredentialReplacement = false,
  ) => {
    const snapshot = stateRef.current
    if (saveInFlightRef.current || !open) return
    const isCreating = plugin === null
    if (!pluginSaveStrategyIsAvailable(strategy,isCreating)) {
      dispatch({
        type: "failure",
        error: {
          code: "PLUGIN_SAVE_STRATEGY_INVALID",
          message: "当前插件不能使用所选保存方式。",
        },
      })
      return
    }
    saveInFlightRef.current = true
    pendingSaveStrategyRef.current = strategy
    dispatch({ type: "saving" })
    const normalizedDraft = normalizePluginDraft(snapshot.draft)
    const secrets = collectReplacementSecrets(
      normalizedDraft.pluginType,
      normalizedDraft.auth.type,
      snapshot.credentials,
    )
    const credentialIntent = credentialMutationFor(secrets)
    const epoch = epochRef.current
    const expectedOwner = snapshot.ownerKey
    try {
      let outcome: PluginSaveOutcome
      if (plugin) {
        const editSessionId = sessionRef.current
        if (!editSessionId) throw new RendererApiError({
          code: "PLUGIN_EDIT_SESSION_REQUIRED",
          message: "连接配置编辑会话已经失效，请重新进入。",
        })
        const value = unwrap(await api.savePluginConnectionEdit({
          editSessionId,
          patch: connectionPatch(normalizedDraft),
          expectedRevision: plugin.revision,
          afterCommit: editAfterCommitFor(strategy),
          credentialIntent,
          discardTemporarySecrets: true,
          ...(Object.keys(secrets).length > 0 ? { temporarySecrets: secrets } : {}),
          ...(forceCredentialReplacement ? { forceCredentialReplacement: true } : {}),
        }))
        outcome = normalizePluginSaveOutcome(value)
      } else {
        outcome = normalizePluginSaveOutcome(unwrap(await api.createPlugin({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          input: asPluginDraft(normalizedDraft),
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        })))
        if (strategy === "connect-current" && outcome.plugin) {
          let connectionAccepted = false
          try {
            const requestId = randomId("plugin-editor-connect")
            const planId = randomId("plugin-editor-plan")
            const connection = await api.requestConnectionIntent({
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              pluginInstanceId: outcome.plugin.pluginInstanceId,
              intent: "connect",
              requestId,
              planId,
              source: "renderer-plugin-editor",
            })
            connectionAccepted = connection.ok
              && connectionRequestWasAccepted(connection.data)
          } catch {
            connectionAccepted = false
          }
          if (!connectionAccepted) {
            outcome = {
              ...outcome,
              manualReconnectRequired: true,
            }
          }
        }
      }
      if (!isCurrent(epoch, expectedOwner)) return
      sessionRef.current = null
      preparationRef.current = null
      pendingForceSaveRef.current = false
      pendingSaveStrategyRef.current = "disconnect"
      dispatch({ type: "clear-sensitive" })
      dispatch({ type: "closed" })
      onSaved?.({ ...outcome, saveStrategy: strategy })
      if (!onSaved) onClosed?.()
    } catch (error) {
      const apiError = publicError(error)
      if (!isCurrent(epoch, expectedOwner)) return
      if (apiError.code === "CREDENTIAL_REPLACEMENT_INCOMPLETE" && Object.keys(secrets).length > 0) {
        pendingForceSaveRef.current = true
        dispatch({
          type: "confirmation",
          confirmation: {
            kind: "credential-replacement",
            title: "确认永久替换不可读取的凭据",
            description: "现有加密凭据无法读取。继续会永久丢弃旧密文，只保存本次明确输入的非空凭据。此操作无法撤销。",
          },
        })
      } else dispatch({ type: "failure", error: apiError })
    } finally {
      saveInFlightRef.current = false
    }
  }, [api, isCurrent, onClosed, onSaved, open, plugin, scope.environmentId, scope.projectId])

  const save = useCallback(async (strategy: PluginSaveStrategy = "disconnect") => {
    pendingValidationRetryRef.current = null
    if (!pluginSaveStrategyIsAvailable(strategy,plugin === null)) {
      dispatch({
        type: "failure",
        error: {
          code: "PLUGIN_SAVE_STRATEGY_INVALID",
          message: "当前插件不能使用所选保存方式。",
        },
      })
      return
    }
    pendingSaveStrategyRef.current = strategy
    if (!(await runValidation("validate",true,strategy))) return
    await persist(strategy,false)
  }, [persist, plugin, runValidation])

  const applyValidationRecovery = useCallback(async (
    kind: "host-key" | "disable-tls",
  ) => {
    const snapshot = stateRef.current
    const confirmation = snapshot.confirmation
    const retry = pendingValidationRetryRef.current
    if (!retry || confirmation?.kind !== kind) return
    const challenge = kind === "host-key" ? confirmation.hostKey : undefined
    if (kind === "host-key" && !challenge) return
    const nextDraft: PluginFormDraft = kind === "host-key"
      ? {
          ...snapshot.draft,
          target: {
            ...snapshot.draft.target,
            hostKeyFingerprint: challenge!.fingerprint,
          },
        }
      : {
          ...snapshot.draft,
          tls: { mode: "disabled" },
        }
    const draftAction = { type: "draft" as const,draft: nextDraft }
    const clearAction = { type: "confirmation" as const,confirmation: null }
    stateRef.current = pluginEditorReducer(
      pluginEditorReducer(snapshot,draftAction),
      clearAction,
    )
    dispatch(draftAction)
    dispatch(clearAction)
    pendingValidationRetryRef.current = null
    const valid = await runValidation(
      retry.purpose,
      retry.saveAfterValidation,
      retry.saveStrategy,
    )
    if (valid && retry.saveAfterValidation) await persist(retry.saveStrategy,false)
  },[persist,runValidation])

  const acceptHostKey = useCallback(
    () => applyValidationRecovery("host-key"),
    [applyValidationRecovery],
  )

  const acceptTlsFallback = useCallback(
    () => applyValidationRecovery("disable-tls"),
    [applyValidationRecovery],
  )

  const confirmCredentialReplacement = useCallback(async () => {
    if (!pendingForceSaveRef.current
      || stateRef.current.confirmation?.kind !== "credential-replacement") return
    dispatch({ type: "confirmation", confirmation: null })
    await persist(pendingSaveStrategyRef.current,true)
  }, [persist])

  const cancel = useCallback(async () => {
    epochRef.current += 1
    const active = activeValidationRef.current
    activeValidationRef.current = null
    pendingValidationRequestRef.current = null
    pendingValidationCancellationsRef.current.clear()
    pendingForceSaveRef.current = false
    pendingSaveStrategyRef.current = "disconnect"
    pendingValidationRetryRef.current = null
    const editSessionId = sessionRef.current
    const prepareToken = preparationRef.current
    try {
      if (editSessionId) {
        unwrap(await api.cancelPluginConnectionEdit({
          editSessionId,
          restorePreEditConnections: true,
        }))
      } else if (prepareToken) {
        unwrap(await api.cancelPluginConnectionEdit({ prepareToken }))
      } else if (active) {
        const result = await api.cancelPluginProbe({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          formInstanceId: stateRef.current.ownerKey,
          requestId: active.requestId,
        })
        if (!result.ok && result.error.code !== "PLUGIN_VALIDATION_STALE") unwrap(result)
      }
      if (sessionRef.current === editSessionId) sessionRef.current = null
      if (preparationRef.current === prepareToken) preparationRef.current = null
      dispatch({ type: "clear-sensitive" })
      dispatch({ type: "closed" })
      return true
    } catch (error) {
      if (active && stateRef.current.validation?.requestId === active.requestId) {
        activeValidationRef.current = active
      }
      dispatch({
        type: "failure",
        error: {
          ...publicError(error),
          message: "无法安全结束编辑会话，请重试。当前连接恢复状态尚未确认。",
        },
      })
      return false
    }
  }, [api, scope.environmentId, scope.projectId])

  return {
    state,
    isCreating: plugin === null,
    isDirty,
    updateDraft,
    setPluginKind,
    setCredentials,
    refreshCredentialStatus,
    acceptEditImpact,
    rejectEditImpact,
    acceptHostKey,
    acceptTlsFallback,
    rejectConfirmation,
    validate,
    cancelValidation,
    discoverDatabases,
    save,
    confirmCredentialReplacement,
    cancel,
  }
}

export const PLUGIN_EDITOR_SECURITY_CONTRACT = Object.freeze({
  revealsStoredCredentials: false,
  sendsOnlyExplicitNonEmptySecrets: true,
  defaultAfterCommit: "stay-disconnected",
  automaticallyConnects: false,
  connectsOnlyWhenExplicitlyRequested: true,
  fencesLateResultsByOwnerGenerationAndCorrelation: true,
})

export const PLUGIN_EDIT_IMPACT_COUNTS = editPreparationCounts
