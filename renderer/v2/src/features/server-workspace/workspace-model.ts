import type { IpcResult, PluginScope, ServerDirectoryEntry } from "@/bridge/ai-ops-v2"

export function serverWorkspaceKey(scope: PluginScope): string {
  return JSON.stringify([scope.projectId, scope.environmentId, scope.pluginInstanceId])
}

export function unwrapWorkspaceResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}

export function isWorkspacePathStale(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["SOURCE_NOT_FOUND", "PATH_INVALID", "WORKSPACE_PATH_CHANGED", "SOURCE_CHANGED"].includes(String(error.code))
}

export function workspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。"
}

export function quoteRemotePath(path: string): string {
  return `'${path.replace(/'/gu, `'"'"'`)}'`
}

export function parentRemotePath(path: string): string {
  return path.replace(/\/+$/gu, "").replace(/\/[^/]*$/u, "") || "/"
}

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatTransferEta(seconds: number): string {
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`
  return `约 ${(seconds / 3600).toFixed(1)} 小时`
}

export function serverEntryType(entry: ServerDirectoryEntry) {
  return entry.type === "symlink" ? entry.linkTargetType ?? "unavailable" : entry.type
}
