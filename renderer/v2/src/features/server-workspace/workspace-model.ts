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

const entryNames = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

export function compareServerDirectoryEntries(left: ServerDirectoryEntry, right: ServerDirectoryEntry): number {
  const directoryOrder = Number(serverEntryType(right) === "directory") - Number(serverEntryType(left) === "directory")
  return directoryOrder || entryNames.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

const emptyDirectoryEntries: readonly ServerDirectoryEntry[] = []
const directoryViews = new WeakMap<readonly ServerDirectoryEntry[], {
  readonly all: readonly ServerDirectoryEntry[]
  readonly visible: readonly ServerDirectoryEntry[]
}>()

export function displayServerDirectoryEntries(entries: readonly ServerDirectoryEntry[] | undefined, showHidden: boolean): readonly ServerDirectoryEntry[] {
  if (!entries?.length) return emptyDirectoryEntries
  let views = directoryViews.get(entries)
  if (!views) {
    // 页内容采用不可变更新；只在刷新、分页或链接解析改变条目时排序，折叠和加载状态复用视图。
    const all = [...entries].sort(compareServerDirectoryEntries)
    views = { all, visible: all.filter(entry => !entry.name.startsWith(".")) }
    directoryViews.set(entries, views)
  }
  return showHidden ? views.all : views.visible
}
