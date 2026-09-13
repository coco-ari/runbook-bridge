import { useEffect, useRef, useState } from "react"
import { ArrowUp, CaretRight, FolderSimple, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerDirectoryPage } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { parentRemotePath, serverEntryType, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

interface Props {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly initialPath: string
  readonly busy: boolean
  readonly onChoose: (path: string) => void
  readonly onCancel: () => void
}

export function ServerUploadDirectoryPicker({ api, scope, initialPath, busy, onChoose, onCancel }: Props) {
  const [draft, setDraft] = useState(initialPath)
  const [page, setPage] = useState<ServerDirectoryPage | null>(null)
  const [cursor, setCursor] = useState("0")
  const [history, setHistory] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const sequence = useRef(0)
  const load = async (target: string, nextCursor?: string, previous = false) => {
    const request = ++sequence.current
    setLoading(true); setError("")
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceListDirectory({ ...scope, path: target.trim(), ...(nextCursor !== undefined ? { cursor: nextCursor, ...(page?.snapshotId ? { snapshotId: page.snapshotId } : {}) } : {}) }))
      if (sequence.current !== request) return
      setPage(result)
      setHistory(nextCursor !== undefined ? previous ? history.slice(0, -1) : [...history, cursor] : [])
      setCursor(nextCursor ?? "0")
      setDraft(result.path)
    } catch (failure) { if (sequence.current === request) { setError(workspaceErrorMessage(failure)); setPage(null) } }
    finally { if (sequence.current === request) setLoading(false) }
  }
  useEffect(() => { void load(initialPath); return () => { sequence.current += 1 } }, [])
  const directories = page?.entries.filter((entry) => serverEntryType(entry) === "directory") ?? []
  return <div className="server-upload-directory-picker" aria-label="选择上传目录">
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (!busy && !loading) void load(draft) }}>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="上传目录的上一级" disabled={busy || loading || !page || page.path === "/"} onClick={() => { if (page) void load(parentRemotePath(page.path)) }}><ArrowUp /></Button>
      <Input aria-label="上传目标目录路径" className="min-w-0 flex-1 font-mono text-xs" value={draft} disabled={busy || loading} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={busy || loading || !draft.trim().startsWith("/")}>转到</Button>
    </form>
    <div className="server-upload-directory-list" aria-busy={loading}>
      {directories.map((entry) => <button type="button" key={entry.path} disabled={busy || loading} className="server-upload-directory-option" onClick={() => { void load(entry.path) }}><FolderSimple size={18} weight="fill" className="server-icon-folder" /><span className="min-w-0 flex-1 break-all text-left">{entry.name}{entry.linkTarget ? <small className="ml-2 text-muted-foreground">→ {entry.linkTarget}</small> : null}</span><CaretRight size={12} /></button>)}
      {loading ? <p role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"><SpinnerGap size={15} className="animate-spin" />正在读取目录…</p> : error ? <p role="alert" className="p-3 text-xs text-danger">{error}</p> : !directories.length ? <p className="p-3 text-xs text-muted-foreground">可直接使用当前目录，也可输入其他路径。</p> : null}
      {!loading && page && history.length ? <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { void load(page.path, history.at(-1), true) }}>上一页目录</Button> : null}
      {!loading && page?.nextCursor ? <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { void load(page.path, page.nextCursor ?? undefined) }}>继续查看子目录</Button> : null}
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消更换</Button><Button size="sm" disabled={busy || loading || !page || draft.trim() !== page.path} onClick={() => { if (page) onChoose(page.path) }}>{busy ? <SpinnerGap className="animate-spin" /> : <FolderSimple />}使用此目录</Button></div>
  </div>
}
