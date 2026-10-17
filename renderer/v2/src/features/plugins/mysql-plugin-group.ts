export interface MysqlPluginGroup {
  readonly id: string
  readonly name: string
}

export function mysqlPluginGroup(plugin: { readonly pluginType: string; readonly tags?: unknown; readonly mysqlConnectionId?: unknown; readonly mysqlConnectionName?: unknown } | null): MysqlPluginGroup | null {
  if (plugin?.pluginType === "mysql" && typeof plugin.mysqlConnectionId === "string") return { id: plugin.mysqlConnectionId, name: typeof plugin.mysqlConnectionName === "string" ? plugin.mysqlConnectionName : "MySQL 连接" }
  if (plugin?.pluginType !== "mysql" || !Array.isArray(plugin.tags)) return null
  const tags = plugin.tags.filter((tag): tag is string => typeof tag === "string")
  const ids = tags.filter(tag => tag.startsWith("rbb:mysql-group:"))
  const names = tags.filter(tag => tag.startsWith("rbb:mysql-name:"))
  if (ids.length !== 1 || !/^rbb:mysql-group:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(ids[0]!)) return null
  return { id: ids[0]!.slice(16), name: names.length === 1 ? names[0]!.slice(15) : "MySQL 插件组" }
}
