import type { PluginScope } from "@/bridge/ai-ops-v2"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"

export const MYSQL_TABLE_PAGE_SIZE = 100
export const MYSQL_RESULT_PAGE_SIZE = 100

export function mysqlDatabaseName(plugin: PluginConfigurationRecord): string {
  return typeof plugin.target?.database === "string" ? plugin.target.database : ""
}

export function mysqlWorkspaceMatchesScope(scope: PluginScope, plugin: PluginConfigurationRecord): boolean {
  return scope.projectId === plugin.projectId
    && scope.environmentId === plugin.environmentId
    && scope.pluginInstanceId === plugin.pluginInstanceId
}

export function mysqlWorkspaceSessionKey(scope: PluginScope, plugin: PluginConfigurationRecord): string {
  return JSON.stringify([
    scope.projectId,
    scope.environmentId,
    scope.pluginInstanceId,
    plugin.revision,
    mysqlDatabaseName(plugin),
  ])
}

export function mysqlCellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (value === "") return "（空字符串）"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export function mysqlByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
