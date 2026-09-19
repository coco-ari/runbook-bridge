import { useEffect, useRef, useState } from "react"
import type { AiOpsV2Api, IpcResult, PluginScope, RedisContentPage, RedisKeyInfo } from "@/bridge/ai-ops-v2"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { mergeRedisRows, redisCacheBytes, redisPatterns, REDIS_CACHE_BYTES, REDIS_MAX_KEYS, REDIS_MAX_TABS } from "./redis-workspace-model"

export interface RedisTab {
  readonly id: string
  readonly key: string
  readonly patternId: string
  readonly pinned: boolean
  readonly loading: boolean
  readonly error: string
  readonly info: RedisKeyInfo | null
  readonly content: RedisContentPage | null
  readonly fieldContent: RedisContentPage | null
  readonly fieldName: string | null
}
function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}
function message(error: unknown): string { return error instanceof Error ? error.message : "读取失败，请重试。" }

export function useRedisWorkspace(api: AiOpsV2Api, scope: PluginScope, plugin: PluginConfigurationRecord, visible: boolean) {
  const patterns = redisPatterns(plugin)
  const [patternId, setPatternId] = useState(patterns[0]?.patternId ?? "")
  const [keys, setKeys] = useState<readonly string[]>([])
  const keysRef = useRef(keys)
  const [cursor, setCursor] = useState<string | null>(null)
  const [complete, setComplete] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [readAt, setReadAt] = useState("")
  const [keyword, setKeyword] = useState("")
  const keywordRef = useRef("")
  const [tabs, setTabs] = useState<readonly RedisTab[]>([])
  const tabsRef = useRef(tabs)
  const [activeId, setActiveId] = useState("")
  const mounted = useRef(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const epoch = useRef(0)
  const scanSequence = useRef(0)
  const tabSequences = useRef(new Map<string, number>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  function updateTabs(transform: (current: readonly RedisTab[]) => readonly RedisTab[]) {
    const next = transform(tabsRef.current)
    if (redisCacheBytes({ keys: keysRef.current, tabs: next }) > REDIS_CACHE_BYTES) {
      setNotice("浏览缓存已达上限，请关闭标签或收窄搜索。")
      return false
    }
    tabsRef.current = next
    setTabs(next)
    return true
  }
  function patchTab(id: string, patch: Partial<RedisTab>) {
    return updateTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab))
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const captured = epoch.current
    const pending = queue.current.catch(() => undefined).then(() => {
      if (!mounted.current || captured !== epoch.current || !visibleRef.current) throw new Error("读取已暂停，返回工作区后可刷新重试。")
      return work()
    })
    queue.current = pending.catch(() => undefined)
    return pending
  }

  async function scan(next = false, selectedPattern = patternId, search = keywordRef.current) {
    if (!selectedPattern) return
    const sequence = ++scanSequence.current
    const captured = epoch.current
    const current = () => mounted.current && captured === epoch.current && sequence === scanSequence.current
    const nextCursor = next ? cursor : null
    setLoading(true); setError(""); setNotice("")
    if (!next) { keysRef.current = []; setKeys([]); setCursor(null); setComplete(false); keywordRef.current = search; setKeyword(search) }
    try {
      const result = await enqueue(() => api.redisWorkspaceScan({ ...scope, patternId: selectedPattern, keyword: search, ...(nextCursor ? { cursor: nextCursor } : {}) }).then(unwrap))
      if (!current()) return
      const combined = [...new Set([...(next ? keysRef.current : []), ...result.keys])]
      const shown = combined.slice(0, REDIS_MAX_KEYS)
      if (redisCacheBytes({ keys: shown, tabs: tabsRef.current }) > REDIS_CACHE_BYTES) {
        setCursor(null); setComplete(false)
        throw new Error("浏览缓存已达上限，请关闭标签或收窄搜索。")
      }
      keysRef.current = shown; setKeys(shown)
      setCursor(result.nextCursor); setComplete(result.complete && combined.length <= REDIS_MAX_KEYS); setReadAt(result.readAt)
      if (combined.length >= REDIS_MAX_KEYS) setNotice("已加载 5,000 个 Key，请收窄搜索后继续。")
      else if (result.unsupportedKeys) setNotice(`本批跳过 ${result.unsupportedKeys} 个不支持的二进制或超长 Key。`)
      if (result.auditWarning) setNotice("本次读取已完成，但操作记录未能保存。")
    } catch (failure) { if (current()) setError(message(failure)) }
    finally { if (current()) setLoading(false) }
  }

  async function readTab(id: string, more = false, field?: string) {
    const tab = tabsRef.current.find((item) => item.id === id)
    if (!tab) return
    const sequence = (tabSequences.current.get(id) ?? 0) + 1
    tabSequences.current.set(id, sequence)
    const captured = epoch.current
    const current = () => mounted.current && captured === epoch.current && tabSequences.current.get(id) === sequence && tabsRef.current.some((item) => item.id === id)
    patchTab(id, { loading: true, error: "", ...(!more && field === undefined ? { content: null, fieldContent: null, fieldName: null, info: null } : {}) })
    try {
      await enqueue(async () => {
        if (!current()) return
        const payload = { ...scope, patternId: tab.patternId, key: tab.key }
        const info = more || field !== undefined ? tab.info : unwrap(await api.redisWorkspaceInspect(payload))
        if (!current()) return
        if (info) patchTab(id, { info })
        if (info?.auditWarning) setNotice("本次读取已完成，但操作记录未能保存。")
        if (!info?.exists || !visibleRef.current) return
        const supported = ["string", "hash", "list", "set", "zset"].includes(info.type)
        if (!supported) {
          patchTab(id, { content: { key: tab.key, type: info.type, exists: true, rows: [], complete: true, nextCursor: null, truncated: false, unsupported: true, readAt: info.readAt } })
          return
        }
        const result = unwrap(await api.redisWorkspaceRead({ ...payload, expectedType: info.type, ...(more && tab.content?.nextCursor ? { cursor: tab.content.nextCursor } : {}), ...(field !== undefined ? { field } : {}) }))
        if (!current()) return
        if (!result.exists) { patchTab(id, { info: { ...info, exists: false, type: "none", ttlSeconds: -2 }, content: null, fieldContent: null, fieldName: null }); return }
        const content = more && tab.content ? { ...result, rows: mergeRedisRows(tab.content.rows, result.rows), truncated: tab.content.truncated || result.truncated } : { ...result, rows: mergeRedisRows([], result.rows) }
        const accepted = patchTab(id, field !== undefined ? { fieldContent: result, fieldName: field } : { content })
        if (!accepted) {
          if (tab.content) patchTab(id, { content: { ...tab.content, nextCursor: null, complete: false } })
          throw new Error("浏览缓存已达上限；本页未保留，请关闭标签后重新读取。")
        }
        if (result.auditWarning || info.auditWarning) setNotice("本次读取已完成，但操作记录未能保存。")
      })
    } catch (failure) {
      if (current()) {
        const code = (failure as { code?: string })?.code
        patchTab(id, { error: message(failure), ...(["REDIS_TYPE_CHANGED", "REDIS_WORKSPACE_STALE", "PLUGIN_NOT_CONNECTED"].includes(code ?? "") ? { info: null, content: null, fieldContent: null } : {}) })
      }
    } finally { if (current()) patchTab(id, { loading: false }) }
  }

  function openKey(key: string, pinned = false, selectedPattern = patternId) {
    const existing = tabsRef.current.find((tab) => tab.key === key && tab.patternId === selectedPattern)
    if (existing) {
      if (pinned) patchTab(existing.id, { pinned: true })
      setActiveId(existing.id)
      return
    }
    const preview = tabsRef.current.find((tab) => !tab.pinned)
    if (!preview && tabsRef.current.length >= REDIS_MAX_TABS) { setNotice("最多打开 8 个标签，请先关闭已有标签。"); return }
    const id = crypto.randomUUID()
    const tab: RedisTab = { id, key, patternId: selectedPattern, pinned, loading: false, error: "", info: null, content: null, fieldContent: null, fieldName: null }
    if (preview) tabSequences.current.delete(preview.id)
    updateTabs((current) => [...current.filter((item) => item.id !== preview?.id), tab])
    setActiveId(id)
    void readTab(id)
  }
  function closeTab(id: string) {
    tabSequences.current.delete(id)
    updateTabs((current) => current.filter((tab) => tab.id !== id))
    if (id === activeId) setActiveId(tabsRef.current.at(-1)?.id ?? "")
  }
  function changePattern(value: string) {
    if (value === patternId) return
    setPatternId(value); tabSequences.current.clear(); updateTabs(() => []); setActiveId("")
    void scan(false, value, "")
  }

  useEffect(() => {
    mounted.current = true
    epoch.current += 1
    void scan(false)
    return () => {
      mounted.current = false
      epoch.current += 1
      scanSequence.current += 1
      tabSequences.current.clear()
      void api.redisWorkspaceRelease(scope)
    }
    // 组件由完整作用域及配置修订作为键创建，返回详情只隐藏而不卸载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { patterns, patternId, changePattern, keys, cursor, complete, loading, error, notice, setNotice, readAt, keyword,
    scan, tabs, activeId, setActiveId, openKey, closeTab, readTab, clearField: (id: string) => patchTab(id, { fieldContent: null, fieldName: null }) }
}
