import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { WorkspaceSwitcherButton, useWorkspaceNavigationActions } from "../plugins/WorkspaceNavigation"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowLeft, ChatCircle, Plus, X } from "@phosphor-icons/react"
import type { CodexApproval, CodexConversation, CodexRequest, CodexResults, CodexStatus, PluginRecord } from "@/bridge/ai-ops-v2"
import type { PluginWorkspaceProps } from "../plugins/workspace-registry"
import { usePluginConnection } from "../connections/use-plugin-connection"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { UpdatesButton, ConfirmationNotice } from "../updates/UpdateCenter"
import "./codex-workspace.css"

const statusLabel: Record<string,string> = { idle: "待提问", running: "回答中", completed: "已完成", interrupted: "已停止", failed: "失败" }
function QuestionCard({ approval, disabled, answer }: { readonly approval: CodexApproval; readonly disabled: boolean; readonly answer: (answers: Record<string,string>) => void }) {
  const [answers, setAnswers] = useState<Record<string,string>>({})
  return <form className="codex-question" onSubmit={e => { e.preventDefault(); answer(answers) }}><h3>Codex 需要你补充信息</h3>{approval.questions.map(q => <fieldset key={q.id} disabled={disabled}><legend>{q.question}</legend>{q.options.map(o => <label key={o.label} className="flex items-start gap-2 py-1"><input type="radio" name={`${approval.id}-${q.id}`} checked={answers[q.id] === o.label} onChange={() => setAnswers(v => ({ ...v, [q.id]: o.label }))} /><span>{o.label}<small className="block text-muted-foreground">{o.description}</small></span></label>)}<Input aria-label={q.header || q.question} value={answers[q.id] ?? ""} onChange={e => setAnswers(v => ({ ...v, [q.id]: e.target.value }))} placeholder="也可以直接输入回答" maxLength={4000} /></fieldset>)}<Button size="sm" disabled={disabled || approval.questions.some(q => !answers[q.id]?.trim())}>提交回答</Button></form>
}
export function CodexWorkspace({ api, entry, visible, onBack, onClose, onDirtyChange }: PluginWorkspaceProps) {
  const [status, setStatus] = useState<CodexStatus | null>(null), [conversation, setConversation] = useState<CodexConversation | null>(null)
  const [selected, setSelected] = useState(""), [sources, setSources] = useState<readonly PluginRecord[]>([]), [selectedSources, setSelectedSources] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string,string>>({}), [model, setModel] = useState(String(entry.plugin.target?.model ?? ""))
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [deleting, setDeleting] = useState(false), [creating, setCreating] = useState(false)
  const alive = useRef(true), selectedRef = useRef(selected), requestSequence = useRef(0), scroller = useRef<HTMLDivElement>(null), following = useRef(true)
  selectedRef.current = selected
  const connection = usePluginConnection({ api, plugin: entry.plugin, runtime: entry.runtime })
  const invoke = useCallback(async <K extends keyof CodexResults>(operation: K, extra: Omit<CodexRequest<K>, "operation" | "projectId" | "environmentId" | "pluginInstanceId" | "expectedRevision"> = {}) => {
    const result = await api.codexWorkspace({ ...entry.scope, expectedRevision: entry.plugin.revision, operation, ...extra })
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }, [api, entry.scope, entry.plugin.revision])
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current, id = selectedRef.current
    try {
      const [state, current] = await Promise.all([invoke("status"), id ? invoke("read", { sessionId: id }) : Promise.resolve(null)])
      if (!alive.current || sequence !== requestSequence.current) return
      setStatus(state); if (id === selectedRef.current) setConversation(current)
    } catch (e) { if (alive.current && sequence === requestSequence.current) setError(e instanceof Error ? e.message : "工作区刷新失败") }
  }, [invoke])
  useEffect(() => {
    alive.current = true; void refresh()
    const unsubscribe = api.onCodexChanged(scope => { if (scope.projectId === entry.scope.projectId && scope.environmentId === entry.scope.environmentId && scope.pluginInstanceId === entry.scope.pluginInstanceId) void refresh() })
    return () => { alive.current = false; unsubscribe() }
  }, [api, entry.scope, refresh])
  useEffect(() => { void refresh() }, [selected, entry.connected, visible, refresh])
  useEffect(() => { let cancelled = false; void api.listPlugins(entry.scope).then(result => { if (!cancelled && result.ok) setSources(result.data.filter(p => p.pluginType === "source")) }); return () => { cancelled = true } }, [api, entry.scope])
  useEffect(() => { onDirtyChange(Object.values(drafts).some(v => Boolean(v.trim())) || Boolean(status?.sessions.some(s => s.status === "running"))) }, [drafts, status, onDirtyChange])
  useEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight }, [conversation, visible])
  async function action(name: string, run: () => Promise<unknown>) {
    if (busy) return
    setBusy(name); setError("")
    try { await run(); if (alive.current) await refresh() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "操作失败") }
    finally { if (alive.current) setBusy("") }
  }
  async function newSession() {
    const record = await invoke("new", { sourcePluginIds: selectedSources, model }); setSelected(record.id); setConversation(null); setCreating(false); following.current = true
  }
  const draft = drafts[selected || "new"] ?? "", running = conversation?.status === "running", connected = status?.connected === true
  async function send() {
    if (!selected || !draft.trim()) return
    const id = selected, value = draft; following.current = true
    await invoke("send", { sessionId: id, text: value }); setDrafts(v => ({ ...v, [id]: v[id] === value ? "" : v[id]! }))
  }
  const requestClose = () => { if (status?.sessions.some(s => s.status === "running") || busy) { toast.info("请先停止回答或等待当前操作完成"); return }; onClose() }
  useWorkspaceNavigationActions({ close: requestClose, navigate: (action, reason) => { if (reason === "configure" && status?.sessions.some(s => s.status === "running")) { toast.info("请先停止回答，再修改配置"); return }; action() } })
  const connectedBusy = ["connecting", "disconnecting", "reconnecting"].includes(connection.state.phase)
  return <section className="codex-workspace absolute inset-0 z-40 bg-background" hidden={!visible} inert={!visible} data-testid="codex-workspace">
    <header className="codex-header"><Button size="icon-sm" variant="ghost" aria-label="返回资源" onClick={onBack} data-testid="codex-workspace-back"><ArrowLeft /></Button><div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{entry.plugin.displayName}</h2><p className="truncate text-xs text-muted-foreground">{entry.projectName} / {entry.environmentName} · {connected ? status?.version : "离线记录"}</p></div><Button variant="outline" size="sm" disabled={connectedBusy || Boolean(busy)} onClick={() => void action("connect", () => connected ? connection.disconnect() : connection.connect())}>{connected ? "断开" : "连接 Codex"}</Button><WorkspaceSwitcherButton labelLayout="compact" /><UpdatesButton iconOnly /><Button size="icon-sm" variant="ghost" aria-label="关闭 Agent 工作区" onClick={requestClose}><X /></Button></header>
    <div className="codex-auth"><span>{entry.plugin.target?.authMode === "custom" ? "兼容 Responses 服务" : status?.account?.authenticated ? `ChatGPT · ${status.account.email ?? "已登录"}` : "尚未登录 ChatGPT"}</span>{entry.plugin.target?.authMode !== "custom" && <Button variant="link" size="sm" disabled={!connected || Boolean(busy) || running} onClick={() => void action("auth", () => invoke(status?.login?.pending ? "cancel-login" : status?.account?.authenticated ? "logout" : "login"))}>{status?.login?.pending ? "取消登录" : status?.account?.authenticated ? "退出登录" : "登录 ChatGPT"}</Button>}{status?.login?.pending && <span role="status">请在浏览器完成登录</span>}</div>
    {(error || status?.loginError || connection.state.error) && <p className="codex-error" role="alert">{error || status?.loginError || connection.state.error?.message}</p>}
    <div className="codex-body"><aside className="codex-sidebar"><Button disabled={!connected || Boolean(busy)} onClick={() => setCreating(true)} data-testid="codex-new"><Plus />新建对话</Button><nav aria-label="Agent 会话">{status?.sessions.map(session => <button key={session.id} className="codex-session" data-active={session.id === selected} onClick={() => { setSelected(session.id); setConversation(null); setError(""); following.current = true }}><span>{session.title}</span><small>{statusLabel[session.status] ?? session.status}</small></button>)}</nav></aside>
      <main className="codex-chat">{selected && conversation ? <><div className="codex-context"><div><strong>{conversation.title}</strong><span>{conversation.model || "默认模型"} · {statusLabel[conversation.status] ?? conversation.status}</span></div><Button size="xs" variant="ghost" disabled={running || Boolean(busy)} onClick={() => setDeleting(true)}>删除会话</Button>{conversation.sources.map(source => <p key={source.pluginInstanceId} title={source.directory}>{source.pluginName} · {source.revision.slice(0, 12)} · 固定快照 {source.snapshotId.slice(0, 8)}</p>)}</div>
        <div className="codex-messages" ref={scroller} onScroll={() => { const el = scroller.current; if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }} aria-label="对话记录">{conversation.messages.map(message => message.role === "tool" ? <details key={message.id} className="codex-tool"><summary>工具执行</summary><pre>{message.text}</pre></details> : <article key={message.id} className={`codex-message codex-${message.role}`}><small>{message.role === "user" ? "你" : message.role === "assistant" ? "Codex" : "工作台"}</small><div className="codex-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{message.text}</ReactMarkdown></div></article>)}{conversation.approvals.map(approval => <QuestionCard key={approval.id} approval={approval} disabled={!connected || Boolean(busy)} answer={answers => void action("answer", () => invoke("answer", { sessionId: selected, approvalId: approval.id, answers }))} />)}{running && <p className="codex-thinking" role="status">Codex 正在处理…</p>}{!conversation.messages.length && <div className="codex-empty"><ChatCircle size={36} /><p>可以提问了</p><small>{conversation.sources.length ? "Codex 会读取上方固定版本的本地源码" : "本对话未绑定源码，可使用当前环境的运维工具"}</small></div>}</div>
        <form className="codex-composer" onSubmit={e => { e.preventDefault(); void action("send", send) }}><textarea aria-label="向 Codex 提问" data-testid="codex-input" value={draft} onChange={e => setDrafts(v => ({ ...v, [selected]: e.target.value }))} maxLength={32768} placeholder="描述需要排查的问题…" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !running && connected && !busy) { e.preventDefault(); void action("send", send) } }} /><div><span><ConfirmationNotice inline /><small>运维变更通过消息中心审批。</small></span>{running ? <Button type="button" variant="outline" disabled={!connected || Boolean(busy)} onClick={() => void action("stop", () => invoke("stop", { sessionId: selected }))} data-testid="codex-stop">停止</Button> : <Button disabled={!connected || Boolean(busy) || !draft.trim()} data-testid="codex-send">{conversation.status === "interrupted" ? "继续提问" : "发送"}</Button>}</div></form>
      </> : <div className="codex-empty"><ChatCircle size={40} /><h3>Codex Agent 工作区</h3><p>创建对话，选择源码，然后开始排查。</p><small>会话与登录状态仅保存在本机。</small>{connected && <Button variant="outline" onClick={() => setCreating(true)}>创建第一个对话</Button>}</div>}</main>
    </div>
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>新建对话</DialogTitle><DialogDescription>选择要分析的源码。已有对话保持原版本，更新后可创建新对话。</DialogDescription></DialogHeader><label className="space-y-2 text-sm"><span>模型 ID</span><Input list="codex-model-options" value={model} onChange={e => setModel(e.target.value)} placeholder="留空使用插件默认模型" /><datalist id="codex-model-options">{status?.models.map(m => <option key={m.id} value={m.model}>{m.name}</option>)}</datalist></label><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void action("models", () => invoke("models"))}>读取可用模型</Button><fieldset className="max-h-48 space-y-2 overflow-auto"><legend className="mb-2 text-sm font-medium">同环境源码（可选，需已下载）</legend>{sources.length ? sources.map(source => <label className="flex items-center gap-2 text-sm" key={source.pluginInstanceId}><input type="checkbox" checked={selectedSources.includes(source.pluginInstanceId)} onChange={e => setSelectedSources(v => e.target.checked ? [...v, source.pluginInstanceId] : v.filter(id => id !== source.pluginInstanceId))} />{source.displayName}</label>) : <p className="text-sm text-muted-foreground">当前环境还没有源码插件</p>}</fieldset><DialogFooter><Button variant="outline" onClick={() => setCreating(false)}>取消</Button><Button disabled={!connected || Boolean(busy)} onClick={() => void action("new", newSession)} data-testid="codex-create-session">创建对话</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent><DialogHeader><DialogTitle>删除这个会话？</DialogTitle><DialogDescription>删除工作台中的对话记录，并释放它引用的源码版本。Codex CLI 自身的本机历史仍由 CLI 管理。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleting(false)}>取消</Button><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void action("delete", async () => { await invoke("delete", { sessionId: selected }); setDeleting(false); setDrafts(v => { const next = { ...v }; delete next[selected]; return next }); setSelected(""); setConversation(null) })}>删除会话</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
