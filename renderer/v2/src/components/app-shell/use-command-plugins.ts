import { useEffect, useState } from "react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { normalizeWorkspacePluginList, type WorkspacePluginReadModel, type WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"

export function useCommandPlugins(api: AiOpsV2Api, open: boolean, projects: readonly WorkspaceProjectReadModel[]) {
  const [lists, setLists] = useState<ReadonlyMap<string, readonly WorkspacePluginReadModel[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const scopesKey = JSON.stringify(projects.filter(project => !project.isolated).flatMap(project => project.environments
    .filter(environment => environment.resourcePreviewTruncated || environment.pluginCount > environment.resourcePreview.length)
    .map(environment => ({projectId: project.projectId, environmentId: environment.environmentId}))))
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const scopes = JSON.parse(scopesKey) as {projectId: string; environmentId: string}[]
    const next = new Map<string, readonly WorkspacePluginReadModel[]>()
    let index = 0, failures = false
    setLists(new Map()); setLoading(scopes.length > 0); setFailed(false)
    // 只读取本地插件列表，限制并发；关闭搜索后丢弃迟到结果。
    const worker = async () => {
      while (!cancelled && index < scopes.length) {
        const scope = scopes[index++]!
        try {
          const result = await api.listPlugins(scope)
          if (!result.ok) throw new Error("插件列表读取失败")
          next.set(scope.projectId + "/" + scope.environmentId, normalizeWorkspacePluginList(result.data, scope))
        } catch { failures = true }
        if (!cancelled) setLists(new Map(next))
      }
    }
    void Promise.all(Array.from({length: Math.min(3, scopes.length)}, worker)).then(() => {
      if (!cancelled) { setLoading(false); setFailed(failures) }
    })
    return () => { cancelled = true }
  }, [api, open, scopesKey, attempt])
  return {lists, loading, failed, retry: () => setAttempt(value => value + 1)}
}
