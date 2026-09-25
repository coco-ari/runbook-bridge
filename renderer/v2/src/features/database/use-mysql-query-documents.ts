import { useEffect, useRef, useState } from "react"

import type { AiOpsV2Api, MysqlQueryResult, PluginScope } from "@/bridge/ai-ops-v2"

export const MYSQL_MAX_QUERY_DOCUMENTS = 6

interface MysqlDocumentRead {
  readonly revision?: number
  readonly writeSummary?: string
  readonly executedSql?: string
  readonly data: MysqlQueryResult | null
  readonly loading: boolean
  readonly error: string | null
}

interface MysqlQueryDocument {
  readonly id: string
  readonly name: string
  readonly sql: string
  readonly result: MysqlDocumentRead
}

interface QueryTicket {
  ticket: number
  busy: boolean
}

const emptyResult = (): MysqlDocumentRead => ({ data: null, loading: false, error: null })

export function useMysqlQueryDocuments(api: AiOpsV2Api, scope: PluginScope) {
  const [documents, setDocuments] = useState<readonly MysqlQueryDocument[]>([{ id: "query-1", name: "SQL 查询 1", sql: "", result: emptyResult() }])
  const sequence = useRef(1)
  const tickets = useRef(new Map<string, QueryTicket>([["query-1", { ticket: 0, busy: false }]]))
  const active = useRef(false)
  const { projectId, environmentId, pluginInstanceId } = scope

  useEffect(() => {
    active.current = true
    return () => {
      // 会话卸载后清空请求归属，旧查询不得回填到任何新的标签页。
      active.current = false
      for (const ticket of tickets.current.values()) { ticket.ticket++; ticket.busy = false }
    }
  }, [api, projectId, environmentId, pluginInstanceId])

  function createDocument(): string | null {
    if (!active.current || tickets.current.size >= MYSQL_MAX_QUERY_DOCUMENTS) return null
    const number = ++sequence.current
    const id = `query-${number}`
    tickets.current.set(id, { ticket: 0, busy: false })
    setDocuments((current) => [...current, { id, name: `SQL 查询 ${number}`, sql: "", result: emptyResult() }])
    return id
  }

  function closeDocument(id: string) {
    if (!active.current || tickets.current.size <= 1) return
    // 删除原始请求令牌，关闭后即使请求成功也不再显示结果。
    tickets.current.delete(id)
    setDocuments((current) => current.filter((document) => document.id !== id))
  }

  function updateSql(id: string, sql: string) {
    if (!active.current || !tickets.current.has(id)) return
    setDocuments((current) => current.map((document) => document.id === id ? { ...document, sql } : document))
  }

  async function runQuery(id: string, sql: string, summary?: string) {
    const owner = tickets.current.get(id)
    if (!active.current || !owner || owner.busy || !sql.trim()) return
    const ticket = ++owner.ticket
    owner.busy = true
    const currentRequest = () => active.current && tickets.current.get(id) === owner && owner.ticket === ticket
    const setResult = (result: MysqlDocumentRead) => setDocuments((current) => current.map((document) => document.id === id ? { ...document, result } : document))
    const previous = documents.find(document => document.id === id)?.result
    const writeSummary = summary ?? previous?.writeSummary ?? ""
    const retained = writeSummary ? previous?.data ?? null : null
    setResult({ data: retained, revision: previous?.revision ?? 0, executedSql: sql, writeSummary, loading: true, error: null })
    try {
      const response = await api.mysqlQueryReadonly({ projectId, environmentId, pluginInstanceId, sql })
      if (!currentRequest()) return
      if (!response.ok) throw new Error(response.error.message)
      setResult({ data: response.data, revision: ticket, executedSql: sql, writeSummary, loading: false, error: null })
    } catch (error) {
      if (currentRequest()) setResult({ data: retained, revision: previous?.revision ?? 0, executedSql: sql, writeSummary, loading: false, error: (writeSummary ? writeSummary + " 刷新失败，可重新刷新。" : "") + (error instanceof Error ? error.message : "SQL 查询失败，请重试。") })
    } finally {
      if (currentRequest()) owner.busy = false
    }
  }

  return { documents, createDocument, closeDocument, updateSql, runQuery }
}
