// 此目录只含展示元数据，不授予后端能力；新增类型仍须注册其实现和安全规则。
export const PLUGIN_CATALOG = {
  server: { label: "Server", defaultPort: 22 },
  mysql: { label: "MySQL", defaultPort: 3306 },
  redis: { label: "Redis", defaultPort: 6379 },
} as const

export type RegisteredPluginType = keyof typeof PLUGIN_CATALOG

export function isRegisteredPluginType(value: unknown): value is RegisteredPluginType {
  return typeof value === "string" && Object.hasOwn(PLUGIN_CATALOG, value)
}
