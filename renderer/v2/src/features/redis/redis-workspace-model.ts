import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import type { PluginScope, RedisContentRow, RedisValuePreview } from "@/bridge/ai-ops-v2"
import { REDIS_BROWSER_CACHE_BYTES, REDIS_EDITABLE_BYTES } from "./redis-desktop-limits.ts"

export const REDIS_MAX_KEYS = 5000
export const REDIS_MAX_TABS = 8
// 按驻留字符串的 UTF-16 字节估算，主进程分页余项另有独立上限。
export const REDIS_CACHE_BYTES = REDIS_BROWSER_CACHE_BYTES
export interface RedisPattern { readonly patternId: string; readonly pattern: string; readonly displayName: string }

export function redisPatterns(plugin: PluginConfigurationRecord): readonly RedisPattern[] {
  const value = plugin.patterns
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is RedisPattern => Boolean(entry && typeof entry === "object"
    && typeof entry.patternId === "string" && typeof entry.pattern === "string" && typeof entry.displayName === "string"))
}

export function redisWorkspaceSessionKey(scope: PluginScope, plugin: PluginConfigurationRecord): string {
  return JSON.stringify([scope.projectId, scope.environmentId, scope.pluginInstanceId, plugin.revision, plugin.target?.db])
}

export function redisTtl(seconds: number): string {
  if (seconds === -2) return "Key 已不存在"
  if (seconds === -1) return "不过期"
  if (seconds < 60) return `剩余 ${seconds} 秒`
  if (seconds < 3600) return `剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  if (seconds < 86400) return `剩余 ${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
  return `剩余 ${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`
}

export function redisBytes(bytes: number): string {
  return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB"
}

export function mergeRedisRows(previous: readonly RedisContentRow[], incoming: readonly RedisContentRow[]): readonly RedisContentRow[] {
  const result = new Map(previous.map((row) => [row.id, row]))
  for (const row of incoming) result.set(row.id, row)
  return [...result.values()]
}

export function redisCacheBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2
  if (Array.isArray(value)) return value.reduce((total, entry) => total + redisCacheBytes(entry), 32)
  if (value && typeof value === "object") return Object.values(value).reduce<number>((total, entry) => total + redisCacheBytes(entry), 64)
  return 8
}

export function mergeRedisValue(previous: RedisValuePreview, incoming: RedisValuePreview): RedisValuePreview {
  return { ...incoming, text: previous.text === null || incoming.text === null ? null : previous.text + incoming.text,
    hex: previous.hex + incoming.hex, shownBytes: previous.shownBytes + incoming.shownBytes }
}

export function redisValueReadOnlyReason(value: RedisValuePreview | null | undefined): string {
  if (!value) return ""
  if (value.bytes > REDIS_EDITABLE_BYTES) return "超过 20 MiB 在线编辑上限，可分段浏览或导出。"
  if (value.text === null) return "二进制内容暂不支持文本编辑。"
  return ""
}
