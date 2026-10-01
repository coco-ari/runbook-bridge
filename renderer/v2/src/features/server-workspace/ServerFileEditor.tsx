import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowCounterClockwise, ArrowUp, ArrowDown, FloppyDisk, SpinnerGap } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope, ServerFileEditPlan, ServerFileEditRequest, ServerFileEditState } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fileChangeBlocks, textFormat } from "./file-editor-model"
import { RemoteTextCode } from "./RemoteTextCode"
import { ServerFilePath } from "./ServerFilePath"
import { EnvironmentTypeBadge } from "@/features/environments/EnvironmentTypeBadge"
import { formatTransferBytes, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

export function ServerFileEditor({ api, scope, path, connected, targetLabel, onState, onExit, onSaved, onLocate }: {
  api: AiOpsV2Api; scope: PluginScope; path: string; connected: boolean; targetLabel: string
  onState: (path: string, dirty: boolean, busy: boolean) => void; onExit: () => void; onSaved: (path: string) => void
  onLocate: (path: string) => void
}) {
  const [edit, setEdit] = useState<ServerFileEditState | null>(null)
  const [draft, setDraft] = useState("")
  const [format, setFormat] = useState(() => textFormat(""))
  const [plan, setPlan] = useState<ServerFileEditPlan | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState("")
  const [discard, setDiscard] = useState<"exit" | "reload" | null>(null)
  const [changeIndex, setChangeIndex] = useState(0)
  const mounted = useRef(true), busyRef = useRef(true), editRef = useRef(edit), sequence = useRef(0)
  const dirtyRequest = useRef<Promise<unknown>>(Promise.resolve())
  const opening = useRef(0)
  const refs = useRef({ onState, onExit, onSaved }); refs.current = { onState, onExit, onSaved }
  const dirty = Boolean(edit && (draft !== edit.content || edit.status === "unknown"))
  const call = useCallback(async (request: ServerFileEditRequest) => unwrapWorkspaceResult(await api.serverWorkspaceEditFile({ ...scope, ...request })), [api, scope])
  const markDirty = useCallback((value: boolean) => {
    const current = editRef.current
    if (!current) return
    const pending = call({ operation: "dirty", editId: current.editId, dirty: value, sequence: ++sequence.current })
    dirtyRequest.current = pending
    void pending.catch(failure => { if (mounted.current) setError(workspaceErrorMessage(failure)) })
  }, [call])
  const open = useCallback(async () => {
    const generation = ++opening.current
    const result = await call({ operation: "open", path })
    if (!result.edit) throw new Error("未能读取完整文件。")
    if (!mounted.current || opening.current !== generation) { await call({ operation: "close", editId: result.edit.editId }); return }
    editRef.current = result.edit
    const nextFormat = textFormat(result.edit.content)
    setFormat(nextFormat); setEdit(result.edit); setDraft(result.edit.content); sequence.current = 0
  }, [call, path])
  useEffect(() => {
    mounted.current = true
    void open().catch(failure => { if (mounted.current) setError(workspaceErrorMessage(failure)) }).finally(() => { if (mounted.current) { busyRef.current = false; setBusy(false) } })
    return () => {
      mounted.current = false
      opening.current++
      if (editRef.current) void call({ operation: "close", editId: editRef.current.editId }).catch(() => {})
    }
  }, [open, call])
  useEffect(() => { refs.current.onState(path, dirty, busy) }, [path, dirty, busy])
  const action = async (fn: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError("")
    try { await fn() }
    catch (failure) { if (mounted.current) setError(workspaceErrorMessage(failure)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const prepare = () => {
    if (!edit || !dirty || !connected || plan || edit.status === "unknown") return
    void action(async () => {
      await dirtyRequest.current
      const result = await call({ operation: "prepare", editId: edit.editId, content: draft })
      if (!result.plan) throw new Error("保存检查未完成，请重试。")
      if (mounted.current) { setChangeIndex(0); setPlan(result.plan) }
    })
  }
  const accept = (next: ServerFileEditState) => {
    if (!mounted.current) return
    editRef.current = next; setEdit(next)
    if (next.status === "ready" && next.content === draft) { markDirty(false); refs.current.onSaved(path) }
  }
  const save = () => {
    if (!edit || !plan || !connected) return
    void action(async () => {
      try { const result = await call({ operation: "commit", editId: edit.editId, planId: plan.planId }); if (result.edit) accept(result.edit) }
      finally { if (mounted.current) setPlan(null) }
    })
  }
  const cancelPlan = () => {
    if (busyRef.current || !edit) return
    setPlan(null); void call({ operation: "cancel", editId: edit.editId }).catch(failure => setError(workspaceErrorMessage(failure)))
  }
  const exitOrReload = (kind: "exit" | "reload") => {
    if (busyRef.current) return
    if (dirty) { setDiscard(kind); return }
    finish(kind)
  }
  const finish = (kind: "exit" | "reload") => {
    setDiscard(null)
    if (kind === "exit") { refs.current.onExit(); return }
    void action(async () => {
      if (editRef.current) await call({ operation: "close", editId: editRef.current.editId })
      editRef.current = null; setEdit(null); setDraft(""); dirtyRequest.current = Promise.resolve()
      await open()
    })
  }
  const change = (value: string) => {
    const raw = format.bom + value; setDraft(raw)
    if (raw !== draft) {
      if (editRef.current?.status === "ready" && editRef.current.message) {
        const { message: _message, ...current } = editRef.current
        editRef.current = current; setEdit(current)
      }
      markDirty(raw !== editRef.current?.content)
    }
  }
  const difference = useMemo(() => plan ? fileChangeBlocks(plan.before, plan.content) : null, [plan])
  const beforeRanges = useMemo(() => difference?.blocks.map(block => ({ ...block.before, kind: "before" as const })), [difference])
  const afterRanges = useMemo(() => difference?.blocks.map(block => ({ ...block.after, kind: "after" as const })), [difference])
  const activeChange = difference?.blocks[changeIndex]
  return <div className="server-file-editor" data-testid="server-file-editor">
    <div className="server-workspace-toolbar server-edit-toolbar"><ServerFilePath path={path} connected={connected} onLocate={onLocate} /><div className="flex shrink-0 items-center gap-1">
      <Button size="sm" disabled={!connected || busy || !dirty || Boolean(plan) || edit?.status === "unknown"} onClick={prepare} title="Ctrl / ⌘ + S"><FloppyDisk />检查并保存</Button>
      <Button size="sm" variant="ghost" disabled={busy || Boolean(plan)} onClick={() => exitOrReload("exit")}>结束编辑</Button>
    </div></div>
    {!connected ? <div className="server-workspace-error" role="status">连接已断开，草稿保留在此标签。重连后可检查并保存。</div> : null}
    {error ? <div className="server-workspace-error" role="alert">{error}</div> : null}
    {edit?.message ? <div className="server-edit-message" role="status">{edit.message}</div> : null}
    {busy && !edit ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><SpinnerGap className="animate-spin" />读取完整文件并校验编码…</div> : null}
    {edit ? <RemoteTextCode value={draft.slice(format.bom.length)} separator={format.separator} label="远程文件内容" readOnly={busy || Boolean(plan) || edit.status === "unknown"} onChange={change} onSave={prepare} onLimit={() => setError("内容过大，无法加入这段文本；文件编辑上限为 1 MiB。")} /> : null}
    <div className="server-preview-footer server-edit-footer"><span>{busy ? "正在处理…" : edit?.status === "unknown" ? "保存结果待核实" : dirty ? "未保存" : "未修改"}{edit ? ` · UTF-8${format.bom ? " BOM" : ""} · ${format.label} · ${formatTransferBytes(new TextEncoder().encode(draft).length)}` : ""}</span><div className="flex items-center gap-1">
      {edit?.canRestore ? <Button size="sm" variant="ghost" disabled={busy || Boolean(plan) || edit.status === "unknown"} title="载入本次编辑会话中上一次保存前的内容；检查并保存后才会写回服务器" onClick={() => { void action(async () => { const result = await call({ operation: "restore", editId: edit.editId }); if (typeof result.restoreContent === "string") change(result.restoreContent.slice(format.bom.length)) }) }}><ArrowCounterClockwise />恢复上次版本</Button> : null}
      {edit?.status === "unknown" ? <Button size="sm" variant="outline" disabled={!connected || busy} onClick={() => { void action(async () => { const result = await call({ operation: "verify", editId: edit.editId }); if (result.edit) accept(result.edit) }) }}>检查保存结果</Button> : null}
      <Button size="sm" variant="ghost" disabled={!connected || busy || Boolean(plan)} onClick={() => exitOrReload("reload")}>重新读取</Button>
    </div></div>
    <Dialog open={Boolean(plan)} onOpenChange={value => { if (!value) cancelPlan() }}><DialogContent className="server-edit-review" showCloseButton={!busy}><DialogHeader><DialogTitle className="flex items-center gap-2">确认保存远程文件<EnvironmentTypeBadge /></DialogTitle><DialogDescription>{targetLabel}<br /><span className="break-all font-mono">{path}</span><br />{difference?.mode === "range" ? "文件行数或差异复杂度超过预览预算，显示完整前后范围对照；高亮范围可能包含未改动行。" : "逐行高亮实际新增和删除的内容。"}保存前会再次核对远端内容。</DialogDescription></DialogHeader>
      {difference ? <div className="server-edit-diff-summary" data-testid="server-edit-diff-summary"><span role="status">{difference.mode === "range" ? "范围对照" : `${difference.blocks.length} 处变更 · 新增 ${difference.added} 行 · 删除 ${difference.removed} 行`}</span><div className="flex items-center gap-1"><Button size="icon-sm" variant="ghost" aria-label="上一处文件变更" title="上一处文件变更" disabled={changeIndex === 0 || !difference.blocks.length} onClick={() => setChangeIndex(index => index - 1)}><ArrowUp /></Button><span className="tabular-nums">{difference.blocks.length ? changeIndex + 1 : 0} / {difference.blocks.length}</span><Button size="icon-sm" variant="ghost" aria-label="下一处文件变更" title="下一处文件变更" disabled={changeIndex >= difference.blocks.length - 1} onClick={() => setChangeIndex(index => index + 1)}><ArrowDown /></Button></div></div> : null}
      {plan ? <div className="server-edit-comparison"><section><h4>保存前</h4><RemoteTextCode value={plan.before} separator={format.separator} label="保存前文件内容" readOnly ranges={beforeRanges} revealLine={activeChange?.before.start} /></section><section><h4>保存后</h4><RemoteTextCode value={plan.content} separator={format.separator} label="保存后文件内容" readOnly ranges={afterRanges} revealLine={activeChange?.after.start} /></section></div> : null}
      <DialogFooter><span className="mr-auto text-xs text-muted-foreground">仅保存文件，不重启服务。恢复版本仅保留在当前编辑会话。</span><Button variant="outline" disabled={busy} onClick={cancelPlan}>返回编辑</Button><Button disabled={!connected || busy} onClick={save}>{busy ? "正在保存…" : "确认保存"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(discard)} onOpenChange={value => { if (!value) setDiscard(null) }}><DialogContent><DialogHeader><DialogTitle>放弃当前文件草稿？</DialogTitle><DialogDescription>未保存的修改会丢失，会话内的恢复版本也会清除。{edit?.status === "unknown" ? "上次保存结果尚待核实，远端可能已经更新。" : "已保存的远端文件不会撤销。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(null)}>保留草稿</Button><Button variant="destructive" onClick={() => { if (discard) finish(discard) }}>{discard === "reload" ? "放弃并重新读取" : "放弃并结束编辑"}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
