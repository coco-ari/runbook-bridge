import { useCallback, useEffect, useRef, useState } from "react"

import type {
  AiOpsV2Api,
  IpcResult,
  MysqlTableSummary,
  PluginScope,
} from "@/bridge/ai-ops-v2"
import { MYSQL_TABLE_PAGE_SIZE } from "@/features/database/mysql-workspace-model"

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function readError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function useMysqlWorkspace(api: AiOpsV2Api, scope: PluginScope) {
  const [tables, setTables] = useState<readonly MysqlTableSummary[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [tablesLoaded, setTablesLoaded] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [tablesTruncated, setTablesTruncated] = useState(false)
  const [tablesAuditWarning, setTablesAuditWarning] = useState(false)
  const active = useRef(false)
  const tickets = useRef({ tables: 0 })
  const busy = useRef({ tables: false })
  const { projectId, environmentId, pluginInstanceId } = scope

  const loadTables = useCallback(async (cursor?: string) => {
    if (!active.current || busy.current.tables) return
    const ticket = ++tickets.current.tables
    busy.current.tables = true
    setTablesLoading(true)
    setTablesError(null)
    if (!cursor) {
      setTables([])
      setTablesLoaded(false)
      setNextCursor(null)
      setTablesTruncated(false)
      setTablesAuditWarning(false)
    }
    try {
      const result = unwrap(await api.mysqlListTables({
        projectId,
        environmentId,
        pluginInstanceId,
        limit: MYSQL_TABLE_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }))
      if (!active.current || ticket !== tickets.current.tables) return
      setTables((current) => {
        if (!cursor) return result.tables
        const existing = new Set(current.map((table) => table.name))
        return [...current, ...result.tables.filter((table) => !existing.has(table.name))]
      })
      setNextCursor(result.nextCursor)
      setTablesTruncated(result.truncated)
      setTablesAuditWarning((current) => current || result.auditWarning === true)
      setTablesLoaded(true)
    } catch (error) {
      if (active.current && ticket === tickets.current.tables) setTablesError(readError(error, "数据表读取失败，请重试。"))
    } finally {
      if (active.current && ticket === tickets.current.tables) {
        busy.current.tables = false
        setTablesLoading(false)
      }
    }
  }, [api, projectId, environmentId, pluginInstanceId])

  useEffect(() => {
    active.current = true
    void loadTables()
    return () => {
      // 断连、切换作用域或配置后，旧请求不得回填到新的数据库会话。
      active.current = false
      for (const key of ["tables"] as const) ++tickets.current[key]
      busy.current = { tables: false }
    }
  }, [loadTables])

  return {
    tables, tablesLoading, tablesLoaded, tablesError, tablesTruncated, tablesAuditWarning, nextCursor,
    loadTables,
  }
}
