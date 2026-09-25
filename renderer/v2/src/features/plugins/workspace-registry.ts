import type { ComponentType } from "react"
import type { AiOpsV2Api, EnvironmentRuntime, PluginScope } from "@/bridge/ai-ops-v2"
import type { PluginConfigurationRecord } from "./plugin-types"

export interface PluginWorkspaceEntry {
  readonly key: string
  readonly type: string
  readonly scope: PluginScope
  readonly plugin: PluginConfigurationRecord
  readonly projectName: string
  readonly environmentName: string
  readonly runtime: EnvironmentRuntime | null
  readonly connected: boolean
  readonly dirty: boolean
  readonly connectionEpoch: number
}

export interface PluginWorkspaceProps {
  readonly api: AiOpsV2Api
  readonly entry: PluginWorkspaceEntry
  readonly visible: boolean
  readonly onBack: () => void
  readonly onClose: () => void
  readonly onDirtyChange: (dirty: boolean) => void
}

export interface PluginWorkspaceContribution {
  readonly type: string
  readonly Component: ComponentType<PluginWorkspaceProps>
  readonly sessionKey: (plugin: PluginConfigurationRecord) => string
  readonly canOpen: (plugin: PluginConfigurationRecord) => boolean
  readonly retainAcrossSelection: boolean
  readonly retainOnDisconnect: "always" | "dirty" | "never"
  readonly requiresConnection: boolean
  readonly maxSessions: number
  readonly focusTestId: string
  readonly returnFocusTestId: string
}

export function createWorkspaceRegistry(contributions: readonly PluginWorkspaceContribution[]) {
  const entries = new Map<string, PluginWorkspaceContribution>()
  for (const contribution of contributions) {
    if (!contribution.type || entries.has(contribution.type)
      || !contribution.Component || typeof contribution.sessionKey !== "function"
      || typeof contribution.canOpen !== "function"
      || !Number.isInteger(contribution.maxSessions) || contribution.maxSessions < 1) {
      throw new Error("工作区贡献无效或重复注册。")
    }
    entries.set(contribution.type, Object.freeze({ ...contribution }))
  }
  return Object.freeze({
    get: (type: string) => entries.get(type),
    types: Object.freeze([...entries.keys()]),
  })
}

export type PluginWorkspaceRegistry = ReturnType<typeof createWorkspaceRegistry>

export interface PluginWorkspaceState {
  readonly entries: readonly PluginWorkspaceEntry[]
  readonly activeKey: string | null
}

export const EMPTY_PLUGIN_WORKSPACES: PluginWorkspaceState = { entries: [], activeKey: null }

export function workspaceScopeMatches(scope: PluginScope, plugin: PluginConfigurationRecord) {
  return scope.projectId === plugin.projectId && scope.environmentId === plugin.environmentId
    && scope.pluginInstanceId === plugin.pluginInstanceId
}

export function reconcileWorkspaceSelection(
  state: PluginWorkspaceState,
  selected: PluginWorkspaceEntry | null,
  registry: PluginWorkspaceRegistry,
): PluginWorkspaceState {
  let changed = false
  const entries = state.entries.flatMap((entry) => {
    const definition = registry.get(entry.type)
    if (!definition) { changed = true; return [] }
    // 同一资源的配置身份改变时释放旧会话，不能因跨选择保留而继续使用旧范围。
    if (selected && entry.type === selected.type && workspaceScopeMatches(entry.scope, selected.plugin) && entry.key !== selected.key) { changed = true; return [] }
    if (definition.retainAcrossSelection) return [entry]
    if (!selected || selected.type !== entry.type || selected.key !== entry.key
      || !workspaceScopeMatches(entry.scope, selected.plugin)
      || (!selected.connected && definition.retainOnDisconnect !== "always"
        && !(entry.dirty && definition.retainOnDisconnect === "dirty"))) {
      changed = true
      return []
    }
    if (entry.connected === selected.connected && entry.plugin === selected.plugin) return [entry]
    changed = true
    return [{ ...entry, connected: selected.connected, plugin: selected.plugin }]
  })
  if (!changed) return state
  return { entries, activeKey: entries.some((entry) => entry.key === state.activeKey) ? state.activeKey : null }
}

export function disconnectWorkspaceScope(
  state: PluginWorkspaceState,
  scope: PluginScope,
  registry: PluginWorkspaceRegistry,
): PluginWorkspaceState {
  const entries = state.entries.flatMap((entry) => {
    if (!workspaceScopeMatches(scope, entry.plugin)) return [entry]
    const policy = registry.get(entry.type)?.retainOnDisconnect
    if (policy === "always" || (policy === "dirty" && entry.dirty)) {
      return [{ ...entry, connected: false, connectionEpoch: entry.connectionEpoch + 1 }]
    }
    return []
  })
  return { entries, activeKey: entries.some((entry) => entry.key === state.activeKey) ? state.activeKey : null }
}

export function openWorkspaceSession(
  state: PluginWorkspaceState, entry: PluginWorkspaceEntry, registry: PluginWorkspaceRegistry,
): PluginWorkspaceState {
  const definition = registry.get(entry.type)
  if (!definition || entry.type !== entry.plugin.pluginType || !definition.canOpen(entry.plugin) || !workspaceScopeMatches(entry.scope, entry.plugin)
    || (definition.requiresConnection && !entry.connected)) return state
  const retained = state.entries.find(item => item.key === entry.key)
  if (!retained && state.entries.filter(item => item.type === entry.type).length >= definition.maxSessions) return state
  return {
    entries: retained ? state.entries.map(item => item.key === entry.key
      ? { ...entry, dirty:item.dirty, connectionEpoch:item.connectionEpoch } : item) : [...state.entries, entry],
    activeKey: entry.key,
  }
}
