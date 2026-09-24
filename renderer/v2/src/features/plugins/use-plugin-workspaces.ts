import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, EnvironmentRuntime, PluginScope } from "@/bridge/ai-ops-v2"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import { normalizeEnvironmentRuntime } from "@/features/workspace/workspace-read-model"
import type { PluginConfigurationRecord } from "./plugin-types"
import { pluginWorkspaces } from "./workspace-contributions"
import {
  EMPTY_PLUGIN_WORKSPACES, openWorkspaceSession, disconnectWorkspaceScope, reconcileWorkspaceSelection, workspaceScopeMatches,
  type PluginWorkspaceEntry,
} from "./workspace-registry"

export function usePluginWorkspaceSessions(api: AiOpsV2Api) {
  const [state, setState] = useState(EMPTY_PLUGIN_WORKSPACES)
  const current = useRef(state)
  current.current = state
  const sequences = useRef(new Map<string, number>())
  useEffect(() => {
    const activeScopes = new Set(state.entries.map(entry => JSON.stringify([entry.scope.projectId, entry.scope.environmentId])))
    for (const key of sequences.current.keys()) if (!activeScopes.has(key)) sequences.current.delete(key)
  }, [state.entries])
  const removeScope = useCallback((scope: { projectId: string; environmentId?: string; pluginInstanceId?: string }) => {
    setState((value) => {
      const entries = value.entries.filter((entry) => !(entry.scope.projectId === scope.projectId
        && (!scope.environmentId || entry.scope.environmentId === scope.environmentId)
        && (!scope.pluginInstanceId || entry.scope.pluginInstanceId === scope.pluginInstanceId)))
      return { entries, activeKey: entries.some((entry) => entry.key === value.activeKey) ? value.activeKey : null }
    })
  }, [])
  useEffect(() => api.onWorkspaceChanged((change) => {
    if (["project-deleted", "environment-deleted", "plugin-deleted"].includes(change.type) && change.projectId) {
      removeScope({ projectId: change.projectId,
        ...(change.environmentId ? { environmentId: change.environmentId } : {}),
        ...(change.pluginInstanceId ? { pluginInstanceId: change.pluginInstanceId } : {}) })
    }
  }), [api, removeScope])

  useEffect(() => api.onEnvironmentStatus((event) => {
    const scopes = new Map(current.current.entries.map((entry) => [
      JSON.stringify([entry.scope.projectId, entry.scope.environmentId]), entry.scope,
    ]))
    for (const [key, scope] of scopes) {
      const runtime = normalizeEnvironmentRuntime(event, scope)
      if (!runtime || runtime.sequence <= (sequences.current.get(key) ?? -1)) continue
      sequences.current.set(key, runtime.sequence)
      setState((value) => {
        let next = value
        for (const entry of value.entries) {
          if (entry.scope.projectId !== scope.projectId || entry.scope.environmentId !== scope.environmentId) continue
          const status = runtime.plugins.find((plugin) => plugin.pluginInstanceId === entry.scope.pluginInstanceId)
          if (status ? status.status !== "connected" : !runtime.pluginsPartial) {
            // 按事件顺序使旧内容失效，快速断重连不能复用旧游标；草稿由插件保留策略决定。
            next = disconnectWorkspaceScope(next, entry.scope, pluginWorkspaces)
          }
        }
        return next
      })
    }
  }), [api])

  const previousActive = useRef<PluginWorkspaceEntry | null>(null)
  useEffect(() => {
    const entry = current.current.entries.find((item) => item.key === state.activeKey) ?? null
    const previous = previousActive.current
    previousActive.current = entry
    const definition = pluginWorkspaces.get((entry ?? previous)?.type ?? "")
    if (!definition || entry?.key === previous?.key) return
    const testId = entry ? definition.focusTestId : definition.returnFocusTestId
    const timer = window.setTimeout(() => focusWorkspaceElement(document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)), 0)
    return () => window.clearTimeout(timer)
  }, [state.activeKey])

  const open = useCallback((entry: PluginWorkspaceEntry) => {
    const definition = pluginWorkspaces.get(entry.type)
    if (!definition || !definition.canOpen(entry.plugin) || !workspaceScopeMatches(entry.scope, entry.plugin)
      || (definition.requiresConnection && !entry.connected)) return
    const retained = current.current.entries.find((item) => item.key === entry.key)
    if (!retained && current.current.entries.filter((item) => item.type === entry.type).length >= definition.maxSessions) {
      toast.error(`最多保留 ${definition.maxSessions} 个同类工作区，请先关闭一个工作区。`)
      return
    }
    const scopeKey = JSON.stringify([entry.scope.projectId, entry.scope.environmentId])
    sequences.current.set(scopeKey, Math.max(sequences.current.get(scopeKey) ?? -1, entry.runtime?.sequence ?? -1))
    setState((value) => openWorkspaceSession(value, entry, pluginWorkspaces))
  }, [])
  const back = useCallback(() => setState((value) => ({ ...value, activeKey:null })), [])
  const close = useCallback((key: string) => setState((value) => ({
    entries:value.entries.filter((entry) => entry.key !== key), activeKey:value.activeKey === key ? null : value.activeKey,
  })), [])
  const setDirty = useCallback((key: string, dirty: boolean) => setState((value) => {
    if (!value.entries.some((entry) => entry.key === key && entry.dirty !== dirty)) return value
    return { ...value, entries:value.entries.map((entry) => entry.key === key ? { ...entry, dirty } : entry) }
  }), [])
  return { state, setState, removeScope, open, back, close, setDirty }
}

interface SelectedWorkspace {
  readonly plugin: PluginConfigurationRecord | null
  readonly scope: PluginScope | null
  readonly connected: boolean
  readonly projectName: string
  readonly environmentName: string
  readonly runtime: EnvironmentRuntime | null
}

export function useSelectedPluginWorkspace(sessions: ReturnType<typeof usePluginWorkspaceSessions>, selected: SelectedWorkspace) {
  const definition = pluginWorkspaces.get(selected.plugin?.pluginType ?? "")
  const candidate: PluginWorkspaceEntry | null = definition && selected.plugin && selected.scope
    && workspaceScopeMatches(selected.scope, selected.plugin) && definition.canOpen(selected.plugin)
    ? { ...selected, plugin:selected.plugin, scope:selected.scope, type:definition.type,
        key:JSON.stringify([definition.type, definition.sessionKey(selected.plugin)]), dirty:false, connectionEpoch:0 }
    : null
  const state = reconcileWorkspaceSelection(sessions.state, candidate, pluginWorkspaces)
  const { setState } = sessions
  useEffect(() => {
    setState((value) => reconcileWorkspaceSelection(value, candidate, pluginWorkspaces))
    // 候选对象每次渲染会重建，仅实际身份、连接或配置快照变化时同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState, candidate?.key, candidate?.connected, candidate?.plugin])
  return {
    ...sessions, state,
    visible:state.activeKey !== null,
    retained:Boolean(candidate && state.entries.some((entry) => entry.key === candidate.key)),
    openSelected:() => { if (candidate) sessions.open(candidate) },
  }
}
