import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import type { PluginScope, RedisContentRow } from "@/bridge/ai-ops-v2"

export const REDIS_MAX_KEYS = 5000
export const REDIS_MAX_TABS = 8
// 另有 4 MiB 预算分配给主进程游标余项，合计 16 MiB。
export const REDIS_CACHE_BYTES = 12 * 1024 * 1024
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
  return new TextEncoder().encode(JSON.stringify(value)).length
}
