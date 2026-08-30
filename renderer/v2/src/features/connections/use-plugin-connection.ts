import type {
  AiOpsV2Api,
  EnvironmentRuntime,
} from "@/bridge/ai-ops-v2"
import {
  normalizeConnectionPhase,
  type PluginConnectionState,
} from "@/features/connections/connection-model"
import { useConnectionIntentController } from "@/features/connections/use-connection-intent"

export interface UsePluginConnectionOptions {
  readonly api: AiOpsV2Api
  readonly plugin: PluginConnectionTarget
  readonly runtime?: EnvironmentRuntime | null
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
}

export interface PluginConnectionTarget {
  readonly projectId: string
  readonly environmentId: string
  readonly pluginInstanceId: string
}

export interface UsePluginConnectionResult {
  readonly state: PluginConnectionState
  readonly connect: () => Promise<void>
  readonly retry: () => Promise<void>
  readonly disconnect: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly trustHostKey: () => Promise<void>
  readonly rejectHostKey: () => void
  readonly refresh: () => Promise<void>
}

export function usePluginConnection({
  api,
  plugin,
  runtime = null,
  onRuntime,
}: UsePluginConnectionOptions): UsePluginConnectionResult {
  return useConnectionIntentController({
    api,
    projectId: plugin.projectId,
    environmentId: plugin.environmentId,
    pluginInstanceId: plugin.pluginInstanceId,
    runtime,
    source: "renderer-plugin",
    ...(onRuntime ? { onRuntime } : {}),
  })
}

export const PLUGIN_CONNECTION_SECURITY_CONTRACT = Object.freeze({
  usesConnectionIntentCoordinator: true,
  automaticallyConnects: false,
  cancelRequiresOwnedPlan: true,
  hostKeysRequireExplicitConfirmation: true,
  fencesLateResultsByScopeAndOperation: true,
  sendsCredentials: false,
  unknownPhase: normalizeConnectionPhase("unsupported"),
})
