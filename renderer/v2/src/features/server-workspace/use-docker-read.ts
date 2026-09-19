import { useEffect, useState } from "react"
import type { AiOpsV2Api, DockerContainerPage, DockerReadRequest, PluginScope } from "@/bridge/ai-ops-v2"
import { unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

type QueryOf<T> = T extends DockerReadRequest ? Omit<T, keyof PluginScope | "requestId"> : never
type DockerQuery = QueryOf<DockerReadRequest>

export function useDockerRead<T>({ api, scope, query, enabled, binding, interval = 0 }: {
  readonly api:AiOpsV2Api; readonly scope:PluginScope; readonly query:DockerQuery; readonly enabled:boolean; readonly binding:string; readonly interval?:number
}) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [awake, setAwake] = useState(!document.hidden)
  const signature = JSON.stringify(query)
  useEffect(() => {
    const update = () => setAwake(!document.hidden)
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  useEffect(() => { setData(null); setError("") }, [binding, signature])
  useEffect(() => {
    if (!enabled || !awake) { setBusy(false); return }
    let cancelled = false
    let timer:ReturnType<typeof setTimeout>
    const requests = new Set<string>()
    const read = async (value:DockerQuery) => {
      const requestId = crypto.randomUUID()
      requests.add(requestId)
      try { return unwrapWorkspaceResult(await api.serverDockerRead({ ...scope, ...value, requestId })) }
      finally { requests.delete(requestId) }
    }
    const run = async () => {
      setBusy(true)
      try {
        const value = JSON.parse(signature) as DockerQuery
        let result = await read(value)
        if (cancelled) return
        if (value.kind === "list") {
          let page = result as DockerContainerPage
          const items = [...page.items]
          while (page.nextCursor && items.length < 1000 && !cancelled) {
            page = await read({ ...value, cursor:page.nextCursor }) as DockerContainerPage
            items.push(...page.items)
          }
          result = { ...page, items:items.slice(0, 1000) }
        }
        if (!cancelled) { setData(result as T); setError("") }
      } catch (failure) { if (!cancelled) setError(workspaceErrorMessage(failure)) }
      finally {
        if (!cancelled) {
          setBusy(false)
          if (interval) timer = setTimeout(() => { void run() }, interval)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
      clearTimeout(timer)
      for (const requestId of requests) void api.serverDockerCancel({ ...scope, requestId }).catch(() => {})
    }
  }, [api, scope, signature, enabled, awake, binding, refresh, interval])
  return { data, error, busy, refresh:() => setRefresh(value => value + 1) }
}
