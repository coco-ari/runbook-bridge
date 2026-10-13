import { useEffect, useRef, useState } from "react"
import type { IpcResult, PluginEditPreparation } from "@/bridge/ai-ops-v2"
import type { PluginEditorContributionProps } from "../plugins/plugin-ui-registry"
import { editPreparationNeedsConfirmation, editPreparationDescription, normalizePluginSaveOutcome } from "../plugins/plugin-editor-model"
import { useUnsavedWork } from "@/hooks/use-unsaved-work"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

function unwrap<T>(result: IpcResult<T>) { if (!result.ok) throw new Error(result.error.message); return result.data }
export function SourceEditor(props: PluginEditorContributionProps) {
  const { api, plugin, scope, onRegisterLeaveGuard } = props
  const [name, setName] = useState(plugin?.displayName ?? "源码")
  const [url, setUrl] = useState(String(plugin?.target?.serviceUrl ?? ""))
  const [project, setProject] = useState(String(plugin?.target?.remoteProjectId ?? ""))
  const [password, setPassword] = useState("")
  const [reuse, setReuse] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(Boolean(plugin))
  const [preparation, setPreparation] = useState<PluginEditPreparation | null>(null)
  const [ready, setReady] = useState(!plugin)
  const [leaving, setLeaving] = useState(false)
  const formInstanceId = useRef(crypto.randomUUID())
  const session = useRef<string | null>(null), prepare = useRef<string | null>(null), generation = useRef(0)
  const alive = useRef(true), pendingLeave = useRef<((leave: boolean) => void) | null>(null)
  const dirty = name !== (plugin?.displayName ?? "源码") || url !== String(plugin?.target?.serviceUrl ?? "") || project !== String(plugin?.target?.remoteProjectId ?? "") || Boolean(password)
  const current = useRef({ dirty, busy }); current.current = { dirty, busy }
  useUnsavedWork(dirty || busy)
  async function begin(value: PluginEditPreparation) {
    setBusy(true); setError("")
    try {
      const result = unwrap(await api.beginPluginConnectionEdit({ prepareToken: value.prepareToken }))
      prepare.current = null
      if (!alive.current) { await api.cancelPluginConnectionEdit({ editSessionId: result.editSessionId, restorePreEditConnections: true }); return }
      session.current = result.editSessionId; setPreparation(null); setReady(true)
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "无法开始编辑") }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    let cancelled = false
    if (plugin) void api.preparePluginConnectionEdit({ ...scope, pluginInstanceId: plugin.pluginInstanceId, expectedRevision: plugin.revision }).then(async result => {
      const value = unwrap(result)
      if (cancelled) { await api.cancelPluginConnectionEdit({ prepareToken: value.prepareToken }); return }
      prepare.current = value.prepareToken
      if (editPreparationNeedsConfirmation(value)) { setPreparation(value); setBusy(false) }
      else await begin(value)
    }).catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : "无法准备编辑"); setBusy(false) } })
    return () => {
      cancelled = true; alive.current = false; pendingLeave.current?.(false)
      if (session.current) void api.cancelPluginConnectionEdit({ editSessionId: session.current, restorePreEditConnections: true })
      else if (prepare.current) void api.cancelPluginConnectionEdit({ prepareToken: prepare.current })
    }
  }, [api, plugin, scope.projectId, scope.environmentId])
  useEffect(() => {
    onRegisterLeaveGuard(async () => {
      if (current.current.busy) return false
      if (!current.current.dirty) return true
      setLeaving(true); return new Promise<boolean>(resolve => { pendingLeave.current = resolve })
    })
    return () => onRegisterLeaveGuard(null)
  }, [onRegisterLeaveGuard])
  const draft = { pluginType: "source", displayName: name, target: { serviceUrl: url, remoteProjectId: project } }
  const secrets = password ? { password } : {}
  const credentialIntent = password ? "replace" : reuse ? "rebind-existing" : "unchanged"
  async function validate() {
    setBusy(true); setError(""); setMessage("")
    const version = ++generation.current, requestId = crypto.randomUUID()
    try {
      const result = session.current
        ? await api.validatePluginDraft({ ...scope, editSessionId: session.current, draft, requestId, purpose: "resource-access", temporarySecrets: secrets, credentialIntent, draftGeneration: version, sequence: version })
        : await api.probePluginDraft({ ...scope, formInstanceId: formInstanceId.current, draft, requestId, purpose: "resource-access", temporarySecrets: secrets, draftGeneration: version, sequence: version })
      unwrap(result); if (alive.current) setMessage("连接验证通过，尚未下载或更新源码。")
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "验证失败") }
    finally { if (alive.current) setBusy(false) }
  }
  async function save() {
    setBusy(true); setError("")
    try {
      const result = plugin
        ? unwrap(await api.savePluginConnectionEdit({ editSessionId: session.current!, patch: { displayName: name, target: draft.target }, expectedRevision: plugin.revision, temporarySecrets: secrets, credentialIntent, discardTemporarySecrets: true, afterCommit: "stay-disconnected" }))
        : unwrap(await api.createPlugin({ ...scope, input: draft, secrets }))
      session.current = null; prepare.current = null
      if (alive.current) { setPassword(""); props.onSaved(normalizePluginSaveOutcome(result)) }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "保存失败") }
    finally { if (alive.current) setBusy(false) }
  }
  return <section className="flex h-full min-h-0 flex-col" data-testid="source-editor">
    <header className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">{plugin ? "修改源码插件" : "添加源码插件"}</h2><p className="text-xs text-muted-foreground">{props.projectName} / {props.environmentName}</p></div><Button variant="ghost" onClick={props.onClosed} disabled={busy}>返回</Button></header>
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-6">
      {!plugin && <label className="block text-sm">插件类型<select className="ml-3 rounded border bg-background p-2" value="source" onChange={e => props.onChoosePluginType(e.target.value)}>{props.pluginTypeOptions.map(p => <option key={p.type} value={p.type}>{p.label}</option>)}</select></label>}
      {preparation && <div role="alert" className="rounded border p-4"><p>{editPreparationDescription(preparation, plugin?.displayName ?? "源码")}</p><Button className="mt-3" disabled={busy} onClick={() => void begin(preparation)}>断开并进入编辑</Button></div>}
      <fieldset disabled={!ready || busy} className="max-w-2xl space-y-4">
        <label className="block space-y-2 text-sm"><span>插件名称</span><Input value={name} onChange={e => setName(e.target.value)} maxLength={80} /></label>
        <label className="block space-y-2 text-sm"><span>源码服务地址</span><Input placeholder="完整服务地址（包含协议和端口）" value={url} onChange={e => setUrl(e.target.value)} data-testid="source-service-url" /><span className="text-xs text-muted-foreground">填写独立源码服务的地址，支持内网 HTTP；无需安装 Git。</span></label>
        <label className="block space-y-2 text-sm"><span>项目 ID</span><Input value={project} onChange={e => setProject(e.target.value)} data-testid="source-project-id" /></label>
        <label className="block space-y-2 text-sm"><span>项目下载密码</span><Input type="password" autoComplete="new-password" placeholder={plugin ? "留空保留已有密码" : "从源码服务管理端获取"} value={password} onChange={e => setPassword(e.target.value)} data-testid="source-password" /></label>
        {plugin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)} />更换来源时，明确沿用已保存的下载密码</label>}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
    </div>
    <footer className="flex justify-end gap-3 border-t p-4"><Button variant="outline" onClick={() => void validate()} disabled={!ready || busy || !url || !project}>验证连接</Button><Button onClick={() => void save()} disabled={!ready || busy || !name || !url || !project || (!plugin && !password)} data-testid="source-save">{busy ? "处理中…" : "保存"}</Button></footer>
    <Dialog open={leaving} onOpenChange={open => { if (!open) { setLeaving(false); pendingLeave.current?.(false); pendingLeave.current = null } }}><DialogContent><DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前表单和新输入的下载密码尚未保存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setLeaving(false); pendingLeave.current?.(false); pendingLeave.current = null }}>继续编辑</Button><Button onClick={() => { setLeaving(false); pendingLeave.current?.(true); pendingLeave.current = null }}>放弃修改</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
