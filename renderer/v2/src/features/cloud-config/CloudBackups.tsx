import { useCallback, useEffect, useRef, useState } from "react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useCloudConfig } from "./CloudConfigProvider"
import type { CloudBackup } from "./cloud-types"

export function CloudBackups({ api }: { api: AiOpsV2Api }) {
  const cloud = useCloudConfig()
  const [backups, setBackups] = useState<readonly CloudBackup[]>([])
  const [unreadable, setUnreadable] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const revision = useRef(0)
  const load = useCallback(async (offset: number) => {
    const request = ++revision.current
    setLoading(true); setError("")
    try {
      const result = await api.cloudConfig({ action: "backups", offset, limit: 20 })
      if (request !== revision.current) return
      if (!result.ok) { setError(result.error.message); return }
      setBackups(previous => [...new Map([...(offset ? previous : []), ...(result.data.backups ?? [])].map(item => [item.backupId, item])).values()])
      setUnreadable(previous => (offset ? previous : 0) + (result.data.unreadableBackups ?? 0))
      setNext(result.data.nextBackupOffset ?? null)
    } catch { if (request === revision.current) setError("无法读取本机备份，请重试。") }
    finally { if (request === revision.current) setLoading(false) }
  }, [api])
  useEffect(() => { void load(0); return () => { revision.current++ } }, [load])
  return <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-0.5" data-testid="cloud-backups">
    <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">覆盖前自动保存，按需加载备份。</p><Button size="xs" variant="ghost" disabled={loading || cloud.busy} onClick={() => void load(0)}>刷新</Button></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {unreadable ? <p role="status" className="text-xs text-muted-foreground" data-testid="cloud-backup-warning">已跳过 {unreadable} 份无法读取的备份，原文件保留，其他备份可正常恢复。</p> : null}
    {backups.map(backup => <Card key={backup.backupId} size="sm"><CardContent className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="break-words text-xs font-medium">{backup.name}</p><p className="text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</p></div><Button size="xs" variant="outline" disabled={cloud.busy} onClick={() => void cloud.run({ action: "prepareRestore", backupId: backup.backupId })}>恢复备份</Button></CardContent></Card>)}
    {loading ? <p role="status" className="p-4 text-center text-xs text-muted-foreground">正在读取备份…</p> : next !== null ? <Button size="xs" variant="outline" onClick={() => void load(next)}>加载更多</Button> : !backups.length && !error && !unreadable ? <p className="p-8 text-center text-xs text-muted-foreground">暂无本机备份，覆盖项目配置前会自动保存。</p> : null}
  </div>
}
