import type { PluginScope } from "@/bridge/ai-ops-v2"

export const MAX_DIRECTORY_BOOKMARKS = 20
export const DIRECTORY_BOOKMARKS_CHANGED = "runbook-bridge:directory-bookmarks-changed"
export function directoryBookmarksKey(scope: PluginScope): string {
  return "runbook-bridge:directory-bookmarks:v1:" + JSON.stringify([scope.projectId, scope.environmentId, scope.pluginInstanceId])
}

export function validBookmarkPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function parseDirectoryBookmarks(raw: string | null): string[] {
  if (!raw) return []
  if (raw.length > 512 * 1024) throw new Error("目录收藏数据过大，无法读取。")
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error("目录收藏数据无法读取。") }
  if (!Array.isArray(parsed) || parsed.length > MAX_DIRECTORY_BOOKMARKS || parsed.some(value => !validBookmarkPath(value))) throw new Error("目录收藏数据格式无效。")
  return [...new Set(parsed)]
}

export function updateDirectoryBookmark(storage: Pick<Storage, "getItem" | "setItem">, key: string, path: string, add: boolean): string[] {
  if (!validBookmarkPath(path)) throw new Error("只支持收藏长度不超过 4096 字符的绝对目录路径。")
  const previous = parseDirectoryBookmarks(storage.getItem(key))
  const next = add ? [...new Set([...previous, path])] : previous.filter(value => value !== path)
  if (next.length > MAX_DIRECTORY_BOOKMARKS) throw new Error("每台服务器最多收藏 20 个目录，请先移除不再使用的收藏。")
  storage.setItem(key, JSON.stringify(next))
  return next
}
