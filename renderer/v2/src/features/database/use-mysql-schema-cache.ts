import { useCallback, useEffect, useRef } from "react"
import type { AiOpsV2Api, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"

export function useMysqlSchemaCache(api: AiOpsV2Api, scope: PluginScope) {
  const cache = useRef(new Map<string, Promise<MysqlTableDescription>>())
  useEffect(() => () => cache.current.clear(), [api, scope.projectId, scope.environmentId, scope.pluginInstanceId])
  return useCallback((table: string) => {
    const existing = cache.current.get(table)
    if (existing) return existing
    if (cache.current.size >= 32) cache.current.delete(cache.current.keys().next().value!)
    const request = api.mysqlDescribeTable({ ...scope, table }).then(result => {
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    }).catch(error => { if (cache.current.get(table) === request) cache.current.delete(table); throw error })
    cache.current.set(table, request)
    return request
  }, [api, scope.projectId, scope.environmentId, scope.pluginInstanceId])
}
