import { EnvironmentTypeBadge } from "@/features/environments/EnvironmentTypeBadge"
import { OperationMessage, OperationSpinner, useOperationLabel } from "@/components/workspace/OperationFeedback"
import { RedisWriteEditor } from "./RedisWriteEditor"
import { useRedisEditing } from "./use-redis-editing"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { lazy, Suspense, useId, useRef, useState, type ReactNode } from "react"
import { Copy, Database, PushPin, ShieldCheck, Plus, PencilSimple, Trash } from "@phosphor-icons/react"
import { toast } from "sonner"
import { usePanelRef } from "react-resizable-panels"
import type { AiOpsV2Api, PluginScope, RedisValuePreview } from "@/bridge/ai-ops-v2"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { WorkspaceBackButton, WorkspaceHeaderActions, WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { WorkspaceLayoutControls, WorkspaceTabBar } from "@/components/workspace/WorkspaceLayoutControls"
import { copyText } from "@/lib/clipboard"
import { redisBytes, redisTtl, REDIS_MAX_KEYS } from "./redis-workspace-model"
import { useRedisWorkspace, type RedisTab } from "./use-redis-workspace"
import { RedisKeyBrowser } from "./RedisKeyBrowser"
import { RedisKeySearch, type RedisSearchEntry, type RedisSearchMode } from "./RedisKeySearch"
import { redisFolderSearch } from "./redis-key-tree"
import { RedisScopePicker } from "./RedisScopePicker"
import "./redis-workspace.css"

const ValueViewer = lazy(async () => ({ default: (await import("./RedisValueViewer")).RedisValueViewer }))

function RedisValueViewer({ value }: { readonly value: RedisValuePreview }) {
  return <Suspense fallback={<div className="redis-empty">正在准备内容视图…</div>}><ValueViewer value={value} /></Suspense>
}

interface Props {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly plugin: PluginConfigurationRecord
  readonly projectName: string
  readonly environmentName: string
  readonly visible: boolean
  readonly connected?: boolean
  readonly connectionEpoch?: number
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly onBack: () => void
  readonly onClose: () => void
}
async function copy(value: string) {
  try { await copyText(value); toast.success("已复制") }
  catch { toast.error("复制失败，请检查系统剪贴板后重试。") }
}
function time(value: string) { return value ? new Date(value).toLocaleTimeString() : "尚未读取" }

function KeyDocument({ tab, refresh, more, field, clearField, actions, editor }: {
  readonly actions?: ReactNode; readonly editor?: ReactNode
  readonly tab: RedisTab; readonly refresh: () => void; readonly more: () => void
  readonly field: (name: string) => void; readonly clearField: () => void
}) {
  const [fieldInput, setFieldInput] = useState("")
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const content = tab.content
  const currentRow = selectedRowId ? content?.rows.find((row) => row.id === selectedRowId) : null
  const selectedValue = tab.fieldName !== null ? tab.fieldContent?.value : currentRow?.value
  const metadata = tab.info
  const waiting = useOperationLabel(tab.loading, "正在刷新内容…")
  return <div className="redis-document">
    <header className="redis-key-heading">
      <div className="redis-key-title">
        {metadata ? <Badge variant="outline" className="redis-type-badge" title={"数据类型：" + metadata.type}>{metadata.type}</Badge> : null}
        <h2 title={tab.key} tabIndex={0} aria-label="完整 Key">{tab.creating ? "新增 Key" : tab.key}</h2>
        <Button size="icon-xs" variant="ghost" className="redis-inline-action" aria-label="复制 Key" title="复制完整 Key" data-testid="redis-copy-key" onClick={() => void copy(tab.key)}><Copy aria-hidden="true" /></Button>
      </div>
      {actions ? <div className="redis-key-actions">{actions}</div> : null}
      <div className="redis-key-meta" data-testid="redis-key-meta">
        {metadata ? <>
          {metadata.length !== null ? <span className="redis-meta-item"><span className="redis-meta-label">大小</span><span>{redisBytes(metadata.length)}</span></span>
            : metadata.cardinality !== null ? <span className="redis-meta-item"><span className="redis-meta-label">成员</span><span>{metadata.cardinality} 个</span></span> : null}
          <span className="redis-meta-item" title="TTL 为最近一次读取时的剩余时间"><span className="redis-meta-label">TTL</span><span>{redisTtl(metadata.ttlSeconds)}</span></span>
        </> : <span className="redis-meta-label">按需读取内容与过期时间</span>}
        <span className="redis-sample-group">
          {metadata ? <span className="redis-meta-label">读取于 <time dateTime={metadata.readAt} title={new Date(metadata.readAt).toLocaleString()}>{time(metadata.readAt)}</time></span> : null}
          <WorkspaceIconButton action="refresh" size="icon-xs" className="redis-inline-action" label="刷新 Key 内容" busy={tab.loading} data-testid="redis-refresh-key" onClick={() => { setSelectedRowId(null); refresh() }} />
        </span>
      </div>
    </header>
    {editor ? editor : metadata && !metadata.exists ? <div className="redis-empty" data-testid="redis-key-missing">Key 已过期或被删除。可刷新重新检查。</div>
      : content?.unsupported ? <div className="redis-empty">暂不支持 {content.type} 类型的内容查看，仍可查看类型与 TTL。</div>
        : content?.value ? <RedisValueViewer value={content.value} />
          : content && ["hash", "list", "set", "zset"].includes(content.type) ? <>
            {content.type === "hash" ? <form className="redis-field-search" onSubmit={(event) => { event.preventDefault(); if (fieldInput) field(fieldInput) }}>
              <Input aria-label="精确 Hash 字段" placeholder="输入完整字段名" value={fieldInput} onChange={(event) => setFieldInput(event.target.value)} data-testid="redis-field-input" />
              <Button size="sm" variant="outline" disabled={tab.loading || !fieldInput} data-testid="redis-field-search" type="submit">定位字段</Button>
            </form> : null}
            <div className="redis-rows-scroll" data-testid="redis-content-scroll">
              <table className="redis-rows" data-testid="redis-rows"><thead><tr>
                {content.type === "hash" ? <th>字段</th> : content.type !== "set" ? <th>{content.type === "zset" ? "排名（从 0 开始）" : "索引"}</th> : null}
                <th>{content.type === "hash" || content.type === "list" ? "值" : "成员"}</th>{content.type === "zset" ? <th>Score</th> : null}
              </tr></thead><tbody>{content.rows.map((row) => <tr key={row.id}>
                {content.type === "hash" ? <td title={row.fieldLabel}>{row.fieldLabel}</td> : content.type !== "set" ? <td>{row.index}</td> : null}
                <td><button type="button" className="redis-cell" onClick={() => { setSelectedRowId(row.id); if (content.type === "hash" && row.field) field(row.field); else clearField() }}>
                  {row.value.text === "" ? "（空字符串）" : row.value.text ?? "[二进制] " + row.value.hex.slice(0, 80)}{row.value.truncated ? " …（已截断）" : ""}
                </button></td>{content.type === "zset" ? <td>{row.score}</td> : null}
              </tr>)}</tbody></table>
              {!content.rows.length ? <p className="redis-empty">{content.complete ? "当前没有成员" : "本批未返回成员，可继续扫描。"}</p> : null}
            </div>
            <div className="redis-toolbar redis-page-status"><span>已加载 {content.rows.length} 个成员 · {content.complete ? "本轮读取完成" : "读取未完成"}</span>
              {content.nextCursor ? <Button size="xs" variant="outline" disabled={tab.loading} onClick={more} data-testid="redis-content-more">{["hash", "set"].includes(content.type) ? "继续扫描" : "加载更多"}</Button> : null}</div>
            {tab.fieldName !== null || currentRow ? <section className="redis-member-preview" aria-label="成员内容">
              <div className="redis-toolbar"><span className="truncate">{tab.fieldName !== null ? "字段：" + tab.fieldName : "成员内容"}</span><WorkspaceIconButton action="close" label="关闭成员预览" onClick={() => { setSelectedRowId(null); clearField() }} /></div>
              {tab.fieldContent?.fieldExists === false ? <p className="redis-notice">字段不存在或已被删除。</p>
                : selectedValue ? <RedisValueViewer value={selectedValue} />
                  : <p className="redis-notice">{tab.fieldContent?.truncated ? "字段值超过读取上限（" + redisBytes(tab.fieldContent.valueBytes ?? 0) + "），未读取正文。" : "正在读取字段…"}</p>}
            </section> : null}
          </> : !tab.loading && !tab.error ? <div className="redis-empty">点击刷新读取内容。</div> : null}
    {!editor ? <div className="redis-document-status" data-testid="redis-key-error"><OperationMessage message={tab.error || (tab.writeSummary ? tab.writeSummary + (waiting ? " · " + waiting : "") : waiting)} error={Boolean(tab.error)} /></div> : null}
  </div>
}

const ignoreDirty = (_dirty: boolean) => {}

export function RedisWorkspace({ api, scope, plugin, projectName, environmentName, visible, onBack, onClose, connected = true, connectionEpoch = 0, onDirtyChange = ignoreDirty }: Props) {
  const state = useRedisWorkspace(api, scope, plugin, visible)
  const editing = useRedisEditing(api,scope,connected,connectionEpoch,onDirtyChange,state.written)
  const openingLabel = useOperationLabel(Boolean(editing.opening), editing.opening?.mode === "delete" ? "正在读取待删除 Key…" : "正在读取编辑内容…")
  const deletionLabel = useOperationLabel(Boolean(editing.deletion?.busy), editing.deletion?.phase === "check" ? "正在检查删除状态…" : editing.deletion?.phase === "read" ? "正在读取数据核实…" : "正在删除 Key…")
  const [search, setSearch] = useState("")
  const [searchMode, setSearchMode] = useState<RedisSearchMode>("keyword")
  const [searchHistory, setSearchHistory] = useState<readonly RedisSearchEntry[]>([])
  const searchScope = JSON.stringify([scope.projectId, scope.environmentId, scope.pluginInstanceId, plugin.revision, plugin.target?.db, state.patternId])
  const [closing, setClosing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const sidebarRef = usePanelRef()
  const searchRef = useRef<HTMLInputElement>(null)
  const uniqueId = useId()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId)
  async function disconnect() {
    setDisconnecting(true)
    try {
      const result = await api.disconnectPlugin(scope)
      if (!result.ok) throw new Error(result.error.message)
      onBack()
    } catch (error) { toast.error(error instanceof Error ? error.message : "断开失败") }
    finally { setDisconnecting(false) }
  }
  function createKey() {
    if (!connected || editing.busy) return
    const id = state.createTab()
    if (id) editing.create(id)
  }
  function closeKey(id: string) { editing.protect(() => state.closeTab(id),[id]) }
  function keyEditor(tab: RedisTab) {
    const draft = editing.drafts[tab.id]
    return draft ? <RedisWriteEditor draft={draft} connected={connected} onChange={patch=>editing.update(tab.id,patch)} onSave={()=>void editing.save(tab.id,tab.patternId)} onCheck={()=>void editing.save(tab.id,tab.patternId,true)} onRecheck={()=>void editing.recheck(tab.id,tab.patternId)} onVerify={()=>void editing.verify(tab.id,tab.patternId)} onCancel={()=>editing.protect(()=>{if(tab.creating)state.closeTab(tab.id)},[tab.id])} /> : null
  }
  function submitSearch(query = search, mode = searchMode) {
    if (!state.patternId || !visible) return
    setSearch(query); setSearchMode(mode)
    if (query && query.length <= 1024) {
      // 搜索记录仅驻留当前工作区内存，按已登记范围隔离，并限制总条数。
      setSearchHistory((current) => [{ scope: searchScope, query, mode }, ...current.filter((entry) => entry.scope !== searchScope || entry.query !== query || entry.mode !== mode)].slice(0, 20))
    }
    if (mode === "exact") { state.stopScan(); if (query) state.openKey(query, true) }
    else void state.scan(false, state.patternId, query)
  }
  function searchFolder(prefix: string) {
    submitSearch(redisFolderSearch(prefix), "keyword")
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  return <section className="redis-workspace" aria-label="Redis 工作区" data-testid="redis-workspace" onKeyDown={(event) => {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); sidebarRef.current?.expand(); requestAnimationFrame(() => searchRef.current?.focus())
    }
  }}>
    <header className="redis-workspace-header">
      <WorkspaceBackButton label="返回 Redis 详情" testId="redis-workspace-back" onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-base font-semibold">{plugin.displayName}</h1><EnvironmentTypeBadge /><StatusIndicator appearance="badge" status={connected ? "connected" : "disconnected"} /></div>
        <p className="truncate text-xs text-muted-foreground" title={projectName + " / " + environmentName}>{projectName} / {environmentName} · DB {String(plugin.target?.db ?? 0)}</p>
      </div>
      <WorkspaceHeaderActions connected={connected} busy={disconnecting} disabled={editing.busy} onDisconnect={() => editing.protect(() => void disconnect())} onClose={() => { if (editing.deletion?.uncertain || Object.values(editing.drafts).some(draft => draft.uncertain)) editing.protect(() => setClosing(true)); else if (!editing.busy) setClosing(true) }} prefix="redis-workspace" closeLabel="关闭 Redis 工作区" closeTitle="关闭工作区并清除浏览数据" />
    </header>

    <div className="redis-workspace-body">
      <ResizablePanelGroup id={uniqueId + "-panels"} orientation="horizontal" aria-label="Key 目录与内容查看">
        <ResizablePanel id={uniqueId + "-keys"} panelRef={sidebarRef} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size" onResize={(size) => setSidebar(size.inPixels >= 1)} defaultSize="360px" minSize="260px" maxSize="55%">
          <aside className="redis-key-pane" hidden={!sidebar} inert={!sidebar}>
            <RedisKeyBrowser keys={state.keys} activeKey={activeTab?.key} keyword={state.keyword}
              queryKey={JSON.stringify([state.patternId, state.keyword])} loading={state.loading} visible={visible}
              refreshDisabled={!state.patternId || !connected} onRefresh={() => void state.scan(false)}
              createAction={<Button size="xs" variant="outline" disabled={!connected || !state.patternId || editing.busy} onClick={createKey} data-testid="redis-create-key"><Plus />新增 Key</Button>}
              identity={<RedisScopePicker database={String(plugin.target?.db ?? 0)} patterns={state.patterns} patternId={state.patternId} visible={visible}
                onChange={(value) => editing.protect(() => { setSearch(""); state.changePattern(value) })} />}
              onSearchFolder={searchFolder}
              search={<RedisKeySearch key={searchScope} value={search} mode={searchMode} inputRef={searchRef} visible={visible && sidebar} disabled={!state.patternId}
                history={searchHistory.filter((entry) => entry.scope === searchScope)}
                onChange={(value) => { state.stopScan(); setSearch(value) }} onModeChange={(mode) => { state.stopScan(); setSearchMode(mode) }}
                onSubmit={submitSearch} onClearHistory={() => setSearchHistory((current) => current.filter((entry) => entry.scope !== searchScope))} />}
              complete={state.complete} error={state.error || (!state.patterns.length ? "没有可用的已登记范围，请检查插件配置。" : "")} onOpen={(key, pinned) => state.openKey(key, pinned)} />
            <div className="redis-key-footer"><span title="目录按 : 分组，数量仅统计已加载的 Key。">{state.keyword ? "搜索：" + state.keyword + " · " : ""}已加载 {state.keys.length} 个 Key</span>
              {state.loading ? <Button size="sm" variant="outline" disabled={state.stopping} onClick={state.stopScan} data-testid="redis-scan-stop">{state.stopping ? "正在停止…" : "停止搜索"}</Button>
                : state.cursor ? <Button size="sm" variant="outline" disabled={state.keys.length >= REDIS_MAX_KEYS} onClick={() => void state.scan(true)} data-testid="redis-scan-more">继续搜索</Button> : null}
              <span role="status" data-testid="redis-scan-status">{state.scanStatus}</span>
            </div>
          </aside>
        </ResizablePanel><ResizableHandle aria-label="调整 Key 列表宽度" withHandle />
        <ResizablePanel id={uniqueId + "-content"} minSize="240px">
          <div className="redis-content-pane">
            <WorkspaceTabBar className="redis-tab-strip">
              <div className="redis-tabs" role="tablist" aria-label="已打开的 Redis Key">
                {state.tabs.map((tab, index) => <div key={tab.id} className="redis-tab" data-active={tab.id === state.activeId}>
                  <button type="button" role="tab" id={uniqueId + "-tab-" + tab.id} aria-controls={uniqueId + "-panel-" + tab.id} aria-selected={tab.id === state.activeId} tabIndex={tab.id === state.activeId ? 0 : -1}
                    title={(tab.creating ? "新增 Key" : tab.key) + (tab.pinned ? "" : " · 双击固定")} data-testid="redis-key-tab" onClick={() => state.setActiveId(tab.id)} onDoubleClick={() => state.pin(tab.id)}
                    onKeyDown={(event) => {
                      let next = index
                      if (event.key === "ArrowRight") next = (index + 1) % state.tabs.length
                      else if (event.key === "ArrowLeft") next = (index + state.tabs.length - 1) % state.tabs.length
                      else if (event.key === "Home") next = 0
                      else if (event.key === "End") next = state.tabs.length - 1
                      else if (event.key === "Delete") { event.preventDefault(); closeKey(tab.id); return }
                      else return
                      event.preventDefault(); const target = state.tabs[next]!; state.setActiveId(target.id); document.getElementById(uniqueId + "-tab-" + target.id)?.focus()
                    }}>
                    {tab.pinned ? <PushPin size={12} /> : null}<span className={tab.pinned ? "" : "italic"}>{tab.creating ? "新增 Key" : tab.key}{editing.drafts[tab.id]?.uncertain ? " · 待核实" : editing.drafts[tab.id]?.busy ? " · 处理中" : editing.drafts[tab.id] ? " · 未保存" : ""}</span>
                  </button>
                  <WorkspaceIconButton action="close" label={"关闭 " + tab.key} className="redis-tab-close" onClick={() => closeKey(tab.id)} />
                </div>)}
              </div>
              <WorkspaceLayoutControls maximized={!sidebar} onToggle={() => { if (sidebarRef.current?.isCollapsed()) sidebarRef.current.expand(); else sidebarRef.current?.collapse() }} testId="redis-layout-toggle" controls={uniqueId + "-keys"} />
            </WorkspaceTabBar>
            {!state.tabs.length ? <Empty className="redis-welcome"><EmptyHeader><EmptyMedia variant="icon"><Database /></EmptyMedia><EmptyTitle>查看 Redis 数据</EmptyTitle><EmptyDescription>展开左侧目录查找 Key，或输入完整 Key 精确定位。<br />单击预览，双击固定标签；数据仅保留在当前会话。</EmptyDescription></EmptyHeader><Button variant="outline" disabled={!connected || !state.patternId} onClick={createKey}><Plus />新增 Key</Button></Empty> : null}
            {state.tabs.map((tab) => <div className="redis-tab-panel" key={tab.id} id={uniqueId + "-panel-" + tab.id} role="tabpanel" aria-labelledby={uniqueId + "-tab-" + tab.id} hidden={tab.id !== state.activeId} inert={tab.id !== state.activeId}>
              <KeyDocument tab={tab} editor={keyEditor(tab)} actions={!tab.creating ? <><Button size="xs" variant="outline" disabled={!connected || tab.loading || editing.busy || Boolean(editing.drafts[tab.id]) || tab.info?.type !== "string" || !tab.content?.value || tab.content.value.truncated || tab.content.value.text === null} title={tab.info?.type !== "string" ? "当前仅支持编辑 String / JSON 文本" : tab.content?.value?.truncated || tab.content?.value?.text === null ? "需要完整 UTF-8 文本才能编辑" : "编辑当前值"} data-testid="redis-edit-value" onClick={()=>{state.pin(tab.id);void editing.open(tab,"update")}}>{editing.opening?.id === tab.id && editing.opening.mode === "update" ? <OperationSpinner /> : <PencilSimple />}编辑值</Button><Button size="xs" variant="ghost" className="text-danger" disabled={!connected || tab.loading || editing.busy || !["string","hash","list","set","zset"].includes(tab.info?.type ?? "")} data-testid="redis-delete-key" onClick={()=>{state.pin(tab.id);void editing.open(tab,"delete")}}>{editing.opening?.id === tab.id && editing.opening.mode === "delete" ? <OperationSpinner /> : <Trash />}删除 Key</Button>{tab.info?.type === "string" && (tab.content?.value?.truncated || tab.content?.value?.text === null) ? <span className="text-xs text-muted-foreground">内容未完整读取或不是文本，仅支持查看。</span> : null}</> : null} refresh={() => editing.protect(()=>void state.readTab(tab.id),[tab.id])} more={() => void state.readTab(tab.id, true)} field={(name) => void state.readTab(tab.id, false, name)} clearField={() => state.clearField(tab.id)} />
            </div>)}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <footer className="redis-workspace-footer"><span className="shrink-0"><ShieldCheck size={12} />固定 DB {String(plugin.target?.db ?? 0)}</span><div className="min-w-0 flex-1" data-testid="redis-operation-status"><div data-testid="redis-notice"><OperationMessage message={openingLabel || (editing.deletion?.uncertain ? "删除结果尚未确认：" + editing.deletion.session.key : state.notice || editing.notice) || "最近扫描 " + time(state.readAt)} /></div></div><Button size="xs" variant="ghost" className={editing.deletion?.uncertain ? "" : "invisible"} disabled={!editing.deletion?.uncertain} onClick={editing.resumeDeletion} data-testid="redis-resume-delete">核实删除结果</Button></footer>
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>关闭 Redis 工作区</DialogTitle><DialogDescription>{Object.keys(editing.drafts).length ? "还有未保存的修改。关闭将放弃草稿并清除浏览数据。" : "将清除搜索条件、搜索历史、标签和浏览数据。Redis 插件连接保持。"}</DialogDescription></DialogHeader><DialogFooter>
      <Button variant="outline" onClick={() => { setClosing(false); if (!Object.keys(editing.drafts).length) onBack() }}>{Object.keys(editing.drafts).length ? "继续编辑" : "返回详情并保留"}</Button><Button data-testid="redis-workspace-confirm-close" disabled={editing.busy} onClick={onClose}>{Object.keys(editing.drafts).length ? "放弃更改并关闭" : "关闭工作区"}</Button>
    </DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(editing.pending)} onOpenChange={open=>{if(!open)editing.cancelPending()}}><DialogContent><DialogHeader><DialogTitle>还有未保存的修改</DialogTitle><DialogDescription>继续操作将放弃相关草稿，服务器数据不会改变。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={editing.cancelPending}>继续编辑</Button><Button variant="destructive" data-testid="redis-discard-confirm" onClick={editing.confirmPending}>放弃更改</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(editing.deletion && editing.deletionVisible && !editing.verification)} onOpenChange={open=>{if(!open)editing.cancelDelete()}}><DialogContent className="redis-delete-dialog"><DialogHeader><EnvironmentTypeBadge /><DialogTitle>{editing.deletion?.uncertain ? "核实删除结果" : "删除 Key？"}</DialogTitle><DialogDescription>DB {String(plugin.target?.db ?? 0)} · {editing.deletion?.session.type} · 删除后无法撤销{editing.deletion && editing.drafts[editing.deletion.id] ? "，该 Key 的未保存草稿也将丢弃" : ""}。</DialogDescription></DialogHeader>
      <p className="redis-delete-key" title={editing.deletion?.session.key}>{editing.deletion?.session.key}</p>
      <div className="redis-delete-feedback"><OperationMessage diagnostic={editing.deletion?.uncertain ? { code: "REDIS_WRITE_OUTCOME_UNKNOWN", message: editing.deletion?.error ?? "" } : undefined} message={deletionLabel || editing.deletion?.error || "确认后执行删除；操作完成前请等待。"} error={!editing.deletion?.busy && Boolean(editing.deletion?.error)} /></div>
      <DialogFooter className="redis-delete-actions"><Button variant="outline" disabled={editing.deletion?.busy} onClick={editing.cancelDelete}>{editing.deletion?.uncertain ? "暂不处理" : "取消"}</Button><Button className={editing.deletion?.uncertain ? "" : "invisible"} variant="outline" disabled={!editing.deletion?.uncertain || !connected || editing.deletion.busy} onClick={()=>{const item=editing.deletion;if(item)void editing.verify(item.id,item.patternId,true)}} data-testid="redis-verify-delete">读取核实</Button>
      <Button className="redis-delete-submit" variant={editing.deletion?.uncertain ? "default" : "destructive"} disabled={Boolean(editing.deletion?.busy) || (!editing.deletion?.uncertain && (!connected || Boolean(editing.deletion?.error)))} onClick={()=>void editing.confirmDelete(Boolean(editing.deletion?.uncertain))} data-testid={editing.deletion?.uncertain ? "redis-check-delete" : "redis-confirm-delete"}>{editing.deletion?.busy ? <OperationSpinner /> : null}{editing.deletion?.uncertain ? "检查状态" : editing.deletion?.busy ? "删除中…" : "删除 Key"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(editing.verification)} onOpenChange={open=>{if(!open)editing.finishVerification(false)}}><DialogContent><DialogHeader><DialogTitle>核实服务器当前数据</DialogTitle><DialogDescription>本次只读取数据，不会再次提交。当前内容不能单独证明此前操作是否成功，也可能受过期或其他客户端修改影响。</DialogDescription></DialogHeader><p className="truncate font-mono text-xs" title={editing.verification?.key}>{editing.verification?.key}</p><textarea readOnly className="redis-review-value" aria-label="核实读取结果" value={!editing.verification?.exists ? "Key 当前不存在。" : editing.verification.complete ? editing.verification.value : "Key 当前存在，类型为 " + editing.verification.type + "；值未完整读取，请在详情中进一步核实。"} /><DialogFooter><Button variant="outline" onClick={()=>editing.finishVerification(false)}>保留待核实</Button><Button data-testid="redis-finish-verification" onClick={()=>editing.finishVerification(true)}>已核实，结束本次操作</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(editing.review)} onOpenChange={open=>{if(!open)editing.finishReview(false)}}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>核对当前值与保留的草稿</DialogTitle><DialogDescription>重新读取不会自动覆盖服务器。请核对差异后继续编辑。</DialogDescription></DialogHeader><div className="grid min-h-0 gap-3 sm:grid-cols-2"><label>服务器当前值<textarea readOnly className="redis-review-value" value={editing.review?.session.value ?? ""}/></label><label>本地草稿<textarea readOnly className="redis-review-value" value={editing.review ? editing.drafts[editing.review.id]?.value ?? "" : ""}/></label></div><DialogFooter><Button variant="outline" onClick={()=>editing.finishReview(false)}>返回</Button><Button onClick={()=>editing.finishReview(true)}>已核对，保留草稿继续编辑</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
