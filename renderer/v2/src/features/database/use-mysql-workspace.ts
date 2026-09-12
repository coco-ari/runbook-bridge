import { useCallback, useEffect, useRef, useState } from "react"

import type {
  AiOpsV2Api,
  IpcResult,
  MysqlQueryResult,
  MysqlTableDescription,
  MysqlTableSummary,
  PluginScope,
} from "@/bridge/ai-ops-v2"
import { MYSQL_TABLE_PAGE_SIZE } from "@/features/database/mysql-workspace-model"

interface ReadState<T> {
  readonly data: T | null
  readonly loading: boolean
  readonly error: string | null
}

function emptyRead<T>(): ReadState<T> {
  return { data: null, loading: false, error: null }
}

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
  const [selectedTable, setSelectedTable] = useState<MysqlTableSummary | null>(null)
  const [structure, setStructure] = useState<ReadState<MysqlTableDescription>>(emptyRead)
  const [preview, setPreview] = useState<ReadState<MysqlQueryResult>>(emptyRead)
  const active = useRef(false)
  const tickets = useRef({ tables: 0, structure: 0, preview: 0 })
  const busy = useRef({ tables: false, preview: false })
  const tableRef = useRef<MysqlTableSummary | null>(null)
  const { projectId, environmentId, pluginInstanceId } = scope

  const loadTables = useCallback(async (cursor?: string) => {
    if (!active.current || busy.current.tables) return
    const ticket = ++tickets.current.tables
    busy.current.tables = true
    setTablesLoading(true)
    setTablesError(null)
    if (!cursor) {
      ++tickets.current.structure
      ++tickets.current.preview
      busy.current.preview = false
      tableRef.current = null
      setSelectedTable(null)
      setStructure(emptyRead())
      setPreview(emptyRead())
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
      for (const key of ["tables", "structure", "preview"] as const) ++tickets.current[key]
      busy.current = { tables: false, preview: false }
    }
  }, [loadTables])

  const selectTable = async (table: MysqlTableSummary) => {
    if (!active.current || table.queryable !== true) return
    const ticket = ++tickets.current.structure
    ++tickets.current.preview
    busy.current.preview = false
    tableRef.current = table
    setSelectedTable(table)
    setPreview(emptyRead())
    setStructure({ data: null, loading: true, error: null })
    try {
      const data = unwrap(await api.mysqlDescribeTable({ projectId, environmentId, pluginInstanceId, table: table.name }))
      if (active.current && ticket === tickets.current.structure) setStructure({ data, loading: false, error: null })
    } catch (error) {
      if (active.current && ticket === tickets.current.structure) {
        setStructure({ data: null, loading: false, error: readError(error, "表结构读取失败，请重试。") })
      }
    }
  }

  const runPreview = async () => {
    const table = tableRef.current
    if (!active.current || !table || table.queryable !== true || busy.current.preview) return
    const ticket = ++tickets.current.preview
    busy.current.preview = true
    setPreview({ data: null, loading: true, error: null })
    try {
      const data = unwrap(await api.mysqlPreviewTable({ projectId, environmentId, pluginInstanceId, table: table.name }))
      if (active.current && ticket === tickets.current.preview) setPreview({ data, loading: false, error: null })
    } catch (error) {
      if (active.current && ticket === tickets.current.preview) {
        setPreview({ data: null, loading: false, error: readError(error, "数据预览失败，请重试。") })
      }
    } finally {
      if (active.current && ticket === tickets.current.preview) busy.current.preview = false
    }
  }

  return {
    tables, tablesLoading, tablesLoaded, tablesError, tablesTruncated, tablesAuditWarning, nextCursor,
    selectedTable, structure, preview,
    loadTables, selectTable, runPreview,
  }
}
