import { useEffect, useRef, useState } from "react"
import type { IpcResult, PluginEditPreparation } from "@/bridge/ai-ops-v2"
import type { PluginEditorContributionProps } from "../plugins/plugin-ui-registry"
import { editPreparationNeedsConfirmation, editPreparationDescription, normalizePluginSaveOutcome } from "../plugins/plugin-editor-model"
import { useUnsavedWork } from "@/hooks/use-unsaved-work"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

function unwrap<T>(result: IpcResult<T>) { if (!result.ok) throw new Error(result.error.message); return result.data }
export function CodexEditor(props: PluginEditorContributionProps) {
  const { api, plugin, scope, onRegisterLeaveGuard } = props
  const [name, setName] = useState(plugin?.displayName ?? "Codex Agent")
  const [url, setUrl] = useState(String(plugin?.target?.baseUrl ?? ""))
  const [authMode, setAuthMode] = useState(String(plugin?.target?.authMode ?? "chatgpt"))
  const [executable, setExecutable] = useState(String(plugin?.target?.executable ?? ""))
  const [project, setProject] = useState(String(plugin?.target?.model ?? ""))
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
  const dirty = authMode !== String(plugin?.target?.authMode ?? "chatgpt") || executable !== String(plugin?.target?.executable ?? "") || name !== (plugin?.displayName ?? "Codex Agent") || url !== String(plugin?.target?.baseUrl ?? "") || project !== String(plugin?.target?.model ?? "") || Boolean(password)
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
  const draft = { pluginType: "codex", displayName: name, target: { baseUrl: url, model: project, authMode, executable } }
  const secrets = password ? { apiKey: password } : {}
  const credentialIntent = password ? "replace" : reuse ? "rebind-existing" : "unchanged"
  async function validate() {
    setBusy(true); setError(""); setMessage("")
    const version = ++generation.current, requestId = crypto.randomUUID()
    try {
      const result = session.current
        ? await api.validatePluginDraft({ ...scope, editSessionId: session.current, draft, requestId, purpose: "recodex-access", temporarySecrets: secrets, credentialIntent, draftGeneration: version, sequence: version })
        : await api.probePluginDraft({ ...scope, formInstanceId: formInstanceId.current, draft, requestId, purpose: "recodex-access", temporarySecrets: secrets, draftGeneration: version, sequence: version })
      unwrap(result); if (alive.current) setMessage("Codex CLI 验证通过。保存并连接后，可在工作区登录或提问。")
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
  return <section className="flex h-full min-h-0 flex-col" data-testid="codex-editor">
    <header className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold">{plugin ? "修改Codex Agent插件" : "添加Codex Agent插件"}</h2><p className="text-xs text-muted-foreground">{props.projectName} / {props.environmentName}</p></div><Button variant="ghost" onClick={props.onClosed} disabled={busy}>返回</Button></header>
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-6">
      {!plugin && <label className="block text-sm">插件类型<select className="ml-3 rounded border bg-background p-2" value="codex" onChange={e => props.onChoosePluginType(e.target.value)}>{props.pluginTypeOptions.map(p => <option key={p.type} value={p.type}>{p.label}</option>)}</select></label>}
      {preparation && <div role="alert" className="rounded border p-4"><p>{editPreparationDescription(preparation, plugin?.displayName ?? "Codex Agent")}</p><Button className="mt-3" disabled={busy} onClick={() => void begin(preparation)}>断开并进入编辑</Button></div>}
      <fieldset disabled={!ready || busy} className="max-w-2xl space-y-4">
        <label className="block space-y-2 text-sm"><span>插件名称</span><Input value={name} onChange={e => setName(e.target.value)} maxLength={80} /></label>
        <label className="block space-y-2 text-sm"><span>认证方式</span><select className="w-full rounded border bg-background p-2" value={authMode} onChange={e => setAuthMode(e.target.value)} data-testid="codex-auth-mode"><option value="chatgpt">ChatGPT 登录</option><option value="custom">兼容 Responses 模型服务</option></select></label>
        <label className="block space-y-2 text-sm"><span>Codex CLI 可执行文件</span><Input value={executable} onChange={e => setExecutable(e.target.value)} placeholder="留空自动查找；也可填写绝对路径" /><span className="text-xs text-muted-foreground">需要 0.159.0 或更新版本。Windows 使用原生 codex.exe。</span></label>
        {authMode === "custom" && <label className="block space-y-2 text-sm"><span>模型服务地址</span><Input value={url} onChange={e => setUrl(e.target.value)} placeholder="包含协议的 Responses API 基础地址" data-testid="codex-service-url" /></label>}
        <label className="block space-y-2 text-sm"><span>模型 ID</span><Input value={project} onChange={e => setProject(e.target.value)} placeholder={authMode === "chatgpt" ? "留空使用 Codex 默认模型" : "服务商提供的模型 ID"} data-testid="codex-model" /></label>
        {authMode === "custom" && <label className="block space-y-2 text-sm"><span>API Key</span><Input type="password" autoComplete="new-password" placeholder={plugin ? "留空保留已保存的密钥" : "请输入模型服务密钥"} value={password} onChange={e => setPassword(e.target.value)} data-testid="codex-api-key" /></label>}
        {plugin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)} />更换配置时，明确保留并沿用已保存的 API Key（ChatGPT 模式不会使用）</label>}
        <p className="text-sm text-muted-foreground">ChatGPT 登录在对话工作区中完成。源码来自同环境的源码插件，创建对话时选择绑定版本。</p>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
    </div>
    <footer className="flex justify-end gap-3 border-t p-4"><Button variant="outline" onClick={() => void validate()} disabled={!ready || busy || (authMode === "custom" && (!url || !project))}>验证连接</Button><Button onClick={() => void save()} disabled={!ready || busy || !name || (authMode === "custom" && (!url || !project || (!plugin && !password)))} data-testid="codex-save">{busy ? "处理中…" : "保存"}</Button></footer>
    <Dialog open={leaving} onOpenChange={open => { if (!open) { setLeaving(false); pendingLeave.current?.(false); pendingLeave.current = null } }}><DialogContent><DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前表单和新输入的API Key尚未保存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setLeaving(false); pendingLeave.current?.(false); pendingLeave.current = null }}>继续编辑</Button><Button onClick={() => { setLeaving(false); pendingLeave.current?.(true); pendingLeave.current = null }}>放弃修改</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
