import { useEffect, useRef, useState } from "react"

import type { AiOpsV2Api, MysqlQueryResult, MysqlSqlMode, MysqlSqlState, PluginScope, PublicError } from "@/bridge/ai-ops-v2"
import { withMysqlTransactionSummary } from "./mysql-transaction-summary-model"
import { useMysqlEditingGuard } from "./MysqlEditingContext"

export const MYSQL_MAX_QUERY_DOCUMENTS = 6
export const mysqlSqlGuardKey = (id: string) => `sql:${id}`

interface MysqlDocumentRead {
  readonly revision?: number
  readonly writeSummary?: string
  readonly executedSql?: string
  readonly lineOffset?: number
  readonly data: MysqlQueryResult | null
  readonly loading: boolean
  readonly error: string | null
  readonly diagnostic?: PublicError | undefined
}
export interface MysqlQueryDocument {
  readonly id: string
  readonly documentId: string
  readonly name: string
  readonly sql: string
  readonly mode: MysqlSqlMode
  readonly execution: MysqlSqlState | null
  readonly result: MysqlDocumentRead
  readonly confirmation: boolean
}
interface QueryTicket { ticket: number; busy: boolean; released?: boolean }
const createQuery = (number: number): MysqlQueryDocument => ({
  id: `query-${number}`, documentId: `sql-${crypto.randomUUID()}`, name: `SQL 查询 ${number}`, sql: "", mode: "atomic", execution: null,
  result: { data: null, loading: false, error: null }, confirmation: false,
})
const publicError = (error: unknown): PublicError => error && typeof error === "object" && "publicError" in error
  ? error.publicError as PublicError : { code: "UNKNOWN_ERROR", message: error instanceof Error ? error.message : "SQL 执行未完成" }

export function useMysqlQueryDocuments(api: AiOpsV2Api, scope: PluginScope) {
  const [documents, setDocuments] = useState<readonly MysqlQueryDocument[]>(() => [createQuery(1)])
  const documentsRef = useRef(documents)
  const sequence = useRef(1)
  const closing = useRef(false)
  const tickets = useRef(new Map<string, QueryTicket>([["query-1", { ticket: 0, busy: false }]]))
  const active = useRef(false)
  const guard = useMysqlEditingGuard()
  const { projectId, environmentId, pluginInstanceId } = scope
  const scopeRef = { projectId, environmentId, pluginInstanceId }
  function update(id: string, change: (document: MysqlQueryDocument) => MysqlQueryDocument) {
    const next = documentsRef.current.map(document => document.id === id ? change(document) : document)
    documentsRef.current = next
    if (active.current) setDocuments(next)
  }
  const find = (id: string) => documentsRef.current.find(document => document.id === id)
  async function release(id: string) {
    const document = find(id)
    if (!document || tickets.current.get(id)?.released) return
    const response = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "release" })
    if (!response.ok) throw new Error(response.error.message)
    const owner = tickets.current.get(id)
    if (owner) owner.released = true
    update(id, current => ({ ...current, execution: response.data, confirmation: false, result: { ...current.result, loading: false } }))
    guard.setEditing(mysqlSqlGuardKey(id), false)
  }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      for (const ticket of tickets.current.values()) { ticket.ticket++; ticket.busy = false }
      // 通常由关闭守卫先等待释放；卸载兜底只释放会话，绝不提交事务。
      for (const document of documentsRef.current) if (!tickets.current.get(document.id)?.released) void api.mysqlSql({ projectId, environmentId, pluginInstanceId, documentId: document.documentId, operation: "release" }).catch(() => {})
    }
  }, [api, projectId, environmentId, pluginInstanceId])
  useEffect(() => {
    const reading = new Set<string>()
    const timer = window.setInterval(() => {
      for (const document of documentsRef.current) {
        if (tickets.current.get(document.id)?.busy || reading.has(document.id) || !document.execution || (document.execution.transaction === "none" && document.execution.status !== "unknown")) continue
        reading.add(document.id)
        void api.mysqlSql({ projectId, environmentId, pluginInstanceId, documentId: document.documentId, operation: "status" }).then(response => {
          if (!active.current || !response.ok) return
          const previous = find(document.id)?.execution
          if (!previous || tickets.current.get(document.id)?.busy || previous.plan?.planId !== response.data.plan?.planId) return
          // 状态变化更新结果；仅摘要/校时变化保留结果引用和revision，避免重置滚动和选择。
          if (previous.status !== response.data.status || previous.transaction !== response.data.transaction || previous.message !== response.data.message || previous.error?.code !== response.data.error?.code) applyState(document.id, response.data)
          else if (response.data.transactionSummary || previous.transactionSummary) update(document.id, current => {
            if (!current.execution) return current
            return { ...current, execution: withMysqlTransactionSummary(current.execution, response.data.transactionSummary) }
          })
        }).catch(() => {}).finally(() => reading.delete(document.id))
      }
    }, 2500)
    return () => window.clearInterval(timer)
  }, [api, projectId, environmentId, pluginInstanceId])
  const documentIds = documents.map(document => document.id).join("|")
  useEffect(() => {
    const ids = documentIds.split("|")
    const cleanups = ids.map(id => guard.register(mysqlSqlGuardKey(id), () => {
      const current = find(id)
      const transaction = current?.execution?.transaction
      return { busy: Boolean(current?.result.loading), dirty: transaction === "active" || transaction === "unknown" || current?.execution?.status === "unknown", transaction: true, uncertain: transaction === "unknown" || current?.execution?.status === "unknown", discard: () => release(id) }
    }))
    return () => { cleanups.forEach(cleanup => cleanup()); ids.forEach(id => guard.setEditing(mysqlSqlGuardKey(id), false)) }
  }, [api, documentIds, guard.register])
  useEffect(() => {
    documents.forEach(document => guard.setEditing(mysqlSqlGuardKey(document.id), document.result.loading || document.execution?.transaction === "active" || document.execution?.transaction === "unknown" || document.execution?.status === "unknown"))
  }, [documents, guard.setEditing])

  function createDocument(): string | null {
    if (!active.current || tickets.current.size >= MYSQL_MAX_QUERY_DOCUMENTS) return null
    const document = createQuery(++sequence.current)
    tickets.current.set(document.id, { ticket: 0, busy: false })
    documentsRef.current = [...documentsRef.current, document]
    setDocuments(documentsRef.current)
    return document.id
  }
  async function closeDocument(id: string) {
    if (!active.current || closing.current || !tickets.current.has(id) || tickets.current.size <= 1) return false
    // IPC 释放可能等待主进程；串行关闭，防止两个最后标签同时通过数量检查。
    closing.current = true
    try {
      await release(id)
      if (!active.current || !tickets.current.has(id) || tickets.current.size <= 1) return false
      tickets.current.delete(id)
      documentsRef.current = documentsRef.current.filter(document => document.id !== id)
      setDocuments(documentsRef.current)
      return true
    } finally { closing.current = false }
  }

  function updateSql(id: string, sql: string) { if (active.current && tickets.current.has(id)) update(id, current => ({ ...current, sql, confirmation: false })) }
  function updateMode(id: string, mode: MysqlSqlMode) {
    const current = find(id)
    if (!current || current.result.loading || (current.execution?.transaction && current.execution.transaction !== "none")) return
    update(id, document => ({ ...document, mode, confirmation: false }))
  }
  function applyState(id: string, state: MysqlSqlState, loading = false) {
    update(id, current => {
      const single = state.results.length === 1 ? state.results[0] : null
      return { ...current, execution: state, mode: state.mode, result: { ...current.result,
        data: single?.data ?? null, loading, revision: (current.result.revision ?? 0) + (loading ? 0 : 1), error: state.error?.message ?? null,
        ...(state.error ? { diagnostic: state.error } : { diagnostic: undefined }),
      } }
    })
  }
  function fail(id: string, error: unknown) {
    const diagnostic = publicError(error)
    update(id, current => {
      const details = diagnostic.details && typeof diagnostic.details === "object" ? diagnostic.details as { line?: unknown; statementIndex?: unknown } : null
      const line = typeof details?.line === "number" && Number.isInteger(details.line) && details.line > 0 ? details.line + (current.result.lineOffset ?? 0) : null
      const index = typeof details?.statementIndex === "number" && Number.isInteger(details.statementIndex) && details.statementIndex >= 0 ? details.statementIndex + 1 : null
      const location = line ? `${index ? `第 ${index} 条 · ` : ""}行 ${line}：` : ""
      return { ...current, confirmation: false, result: { ...current.result, loading: false, error: location + diagnostic.message, diagnostic } }
    })
  }
  async function execute(id: string, confirmed = false) {
    const owner = tickets.current.get(id), document = find(id), plan = document?.execution?.plan
    if (!owner || !document || !plan || owner.busy) return
    owner.busy = true
    const ticket = ++owner.ticket
    let finished = false
    const isCurrent = () => !finished && active.current && tickets.current.get(id) === owner && ticket === owner.ticket
    update(id, current => ({ ...current, confirmation: false, result: { ...current.result, loading: true, error: null } }))
    let polling = false
    const timer = window.setInterval(() => {
      if (polling || !isCurrent()) return
      polling = true
      void api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "status" }).then(response => {
        if (response.ok && isCurrent()) applyState(id, response.data, true)
      }).catch(() => {}).finally(() => { polling = false })
    }, 750)
    try {
      const response = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "execute", planId: plan.planId, ...(confirmed ? { confirmed: true } : {}) })
      if (!isCurrent()) return
      if (!response.ok) { fail(id, Object.assign(new Error(response.error.message), { publicError: response.error })); return }
      applyState(id, response.data)
    } catch (error) {
      if (isCurrent()) {
        // IPC 中断可能发生在服务器已经写入后。先读取状态，无法核实时锁住重试。
        try {
          const status = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "status" })
          if (status.ok && status.data.status !== "running" && status.data.status !== "prepared") applyState(id, status.data)
          else {
            fail(id, error)
            update(id, current => ({ ...current, execution: { ...(current.execution ?? document.execution!), status: "unknown", transaction: "unknown" } }))
          }
        } catch {
          fail(id, error)
          update(id, current => ({ ...current, execution: { ...(current.execution ?? document.execution!), status: "unknown", transaction: "unknown" } }))
        }
      }
    } finally { window.clearInterval(timer); if (isCurrent()) owner.busy = false; finished = true }
  }
  async function runQuery(id: string, sql: string, summary = "", lineOffset = 0) {
    const owner = tickets.current.get(id), document = find(id)
    if (!active.current || !owner || owner.busy || !document || !sql.trim() || document.execution?.status === "unknown" || document.execution?.transaction === "unknown") return
    owner.busy = true
    update(id, current => ({ ...current, confirmation: false, result: { ...current.result, executedSql: sql, lineOffset: summary ? current.result.lineOffset ?? 0 : lineOffset, writeSummary: summary, loading: true, error: null } }))
    try {
      owner.released = false
      const response = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "prepare", sql, mode: /^(COMMIT|ROLLBACK)$/i.test(sql.trim()) ? "manual" : document.mode })
      if (!active.current || tickets.current.get(id) !== owner) return
      if (!response.ok) throw Object.assign(new Error(response.error.message), { publicError: response.error })
      applyState(id, response.data)
      owner.busy = false
      if (response.data.plan?.requiresConfirmation) update(id, current => ({ ...current, confirmation: true }))
      else await execute(id)
    } catch (error) { if (active.current && tickets.current.get(id) === owner) fail(id, error) }
    finally { owner.busy = false }
  }
  async function checkStatus(id: string) {
    const document = find(id)
    if (!document || tickets.current.get(id)?.busy) return
    try {
      const response = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "status" })
      if (!response.ok) throw Object.assign(new Error(response.error.message), { publicError: response.error })
      applyState(id, response.data.status === "running" ? { ...response.data, status: "unknown", message: "服务器仍在执行，请稍后再次核对状态。" } : response.data)
    } catch (error) { fail(id, error) }
  }
  async function stop(id: string) {
    const document = find(id), planId = document?.execution?.plan?.planId
    if (!document || !planId) return
    try {
      const response = await api.mysqlSql({ ...scopeRef, documentId: document.documentId, operation: "stop", planId })
      if (!response.ok) throw Object.assign(new Error(response.error.message), { publicError: response.error })
      applyState(id, response.data, response.data.status === "running")
    } catch (error) {
      const diagnostic = publicError(error)
      update(id, current => ({ ...current, result: { ...current.result, error: diagnostic.message, diagnostic } }))
    }
  }
  return { documents, createDocument, closeDocument, updateSql, updateMode, runQuery, execute, stop, checkStatus,
    cancelConfirmation: (id: string) => update(id, current => ({ ...current, confirmation: false })),
  }
}
