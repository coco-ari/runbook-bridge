import type {
  AiOpsV2Api,
  EnvironmentRuntime,
} from "@/bridge/ai-ops-v2"
import {
  normalizeConnectionPhase,
  type EnvironmentConnectionState,
} from "@/features/connections/connection-model"
import { useConnectionIntentController } from "@/features/connections/use-connection-intent"

export interface EnvironmentConnectionTarget {
  readonly projectId: string
  readonly environmentId: string
  readonly name: string
  readonly revision: number
}

export interface UseEnvironmentConnectionOptions {
  readonly api: AiOpsV2Api
  readonly environment: EnvironmentConnectionTarget
  readonly runtime?: EnvironmentRuntime | null
  readonly onRuntime?: (runtime: EnvironmentRuntime) => void
}

export interface UseEnvironmentConnectionResult {
  readonly state: EnvironmentConnectionState
  readonly connect: () => Promise<void>
  readonly retry: () => Promise<void>
  readonly disconnect: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly trustHostKey: () => Promise<void>
  readonly rejectHostKey: () => void
  readonly refresh: () => Promise<void>
}

export function useEnvironmentConnection({
  api,
  environment,
  runtime = null,
  onRuntime,
}: UseEnvironmentConnectionOptions): UseEnvironmentConnectionResult {
  return useConnectionIntentController({
    api,
    projectId: environment.projectId,
    environmentId: environment.environmentId,
    expectedRevision: environment.revision,
    runtime,
    source: "renderer-environment",
    ...(onRuntime ? { onRuntime } : {}),
  })
}

export const ENVIRONMENT_CONNECTION_SECURITY_CONTRACT = Object.freeze({
  usesConnectionIntentCoordinator: true,
  automaticallyConnects: false,
  cancelRequiresOwnedPlan: true,
  hostKeysRequireExplicitConfirmation: true,
  fencesLateResultsByScopeAndOperation: true,
  sendsCredentials: false,
  unknownPhase: normalizeConnectionPhase("unsupported"),
})
