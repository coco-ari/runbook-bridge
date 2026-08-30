import type { PluginEditAfterCommit } from "@/bridge/ai-ops-v2"

export type PluginSaveStrategy =
  | "disconnect"
  | "connect-current"
  | "restore-previous"

export const NEW_PLUGIN_SAVE_STRATEGIES = Object.freeze([
  "disconnect",
  "connect-current",
] as const satisfies readonly PluginSaveStrategy[])

export const EXISTING_PLUGIN_SAVE_STRATEGIES = Object.freeze([
  "disconnect",
  "connect-current",
  "restore-previous",
] as const satisfies readonly PluginSaveStrategy[])

const EDIT_AFTER_COMMIT_BY_STRATEGY = Object.freeze({
  disconnect: "stay-disconnected",
  "connect-current": "connect-current",
  "restore-previous": "restore-pre-edit-set",
} as const satisfies Readonly<Record<PluginSaveStrategy, PluginEditAfterCommit>>)

export function editAfterCommitFor(
  strategy: PluginSaveStrategy,
): PluginEditAfterCommit {
  return EDIT_AFTER_COMMIT_BY_STRATEGY[strategy]
}

export function pluginSaveStrategyIsAvailable(
  strategy: PluginSaveStrategy,
  isCreating: boolean,
): boolean {
  return !isCreating || strategy !== "restore-previous"
}

export function connectionRequestWasAccepted(
  value: Readonly<{ readonly outcome?: unknown }>,
): boolean {
  return value.outcome === "started"
}
