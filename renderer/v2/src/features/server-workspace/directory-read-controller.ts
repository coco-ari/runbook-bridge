import type { AiOpsV2Api, PluginScope } from "@/bridge/ai-ops-v2"

type DirectoryInput = Omit<Parameters<AiOpsV2Api["serverWorkspaceListDirectory"]>[0], keyof PluginScope | "requestId">
const cancelled = () => Object.assign(new Error("目录读取已取消。"), { code: "WORKSPACE_READ_CANCELLED" })

// 取消只引用本控制器发出的请求，等主进程读取结束后才归还共享队列名额。
export function createDirectoryReader(api: Pick<AiOpsV2Api, "serverWorkspaceListDirectory" | "serverWorkspaceCancelDirectoryRead">, scope: PluginScope) {
  const active = new Map<string, { path: string; cancelled: boolean }>()
  return {
    async read(input: DirectoryInput) {
      const requestId = crypto.randomUUID()
      const record = { path: input.path, cancelled: false }
      active.set(requestId, record)
      try {
        const result = await api.serverWorkspaceListDirectory({ ...input, ...scope, requestId })
        if (record.cancelled) throw cancelled()
        return result
      } catch (error) { if (record.cancelled) throw cancelled(); throw error }
      finally { active.delete(requestId) }
    },
    cancel(matches: (path: string) => boolean = () => true) {
      for (const [requestId, record] of active) if (!record.cancelled && matches(record.path)) {
        record.cancelled = true
        void api.serverWorkspaceCancelDirectoryRead({ ...scope, requestId }).catch(() => undefined)
      }
    },
  }
}
