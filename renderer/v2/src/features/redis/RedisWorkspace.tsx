import { useId, useRef, useState } from "react"
import { Copy, Database, MagnifyingGlass, PushPin, ShieldCheck } from "@phosphor-icons/react"
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
import { RedisScopePicker } from "./RedisScopePicker"
import "./redis-workspace.css"

interface Props {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly plugin: PluginConfigurationRecord
  readonly projectName: string
  readonly environmentName: string
  readonly visible: boolean
  readonly onBack: () => void
  readonly onClose: () => void
}
async function copy(value: string) {
  try { await copyText(value); toast.success("已复制") }
  catch { toast.error("复制失败，请检查系统剪贴板后重试。") }
}
function time(value: string) { return value ? new Date(value).toLocaleTimeString() : "尚未读取" }

function ValueViewer({ value }: { readonly value: RedisValuePreview }) {
  const [view, setView] = useState<"text" | "json" | "hex">("text")
  let json: string | null = null
  if (!value.truncated && value.text !== null) {
    try { json = JSON.stringify(JSON.parse(value.text), null, 2) } catch { /* 非 JSON 内容继续以原文展示。 */ }
  }
  const active = value.text === null ? "hex" : view === "json" && json === null ? "text" : view
  const shown = active === "json" ? json! : active === "hex" ? value.hex.match(/.{1,32}/gu)?.join("\n") ?? "" : value.text ?? ""
  return <div className="redis-value-viewer">
    <div className="redis-value-toolbar">
      <div className="redis-view-modes" role="group" aria-label="内容显示方式">
        {(["text", "json", "hex"] as const).map((mode) => <Button key={mode} aria-pressed={active === mode} data-testid={"redis-view-" + mode}
          disabled={mode === "text" && value.text === null || mode === "json" && json === null}
          size="xs" variant="ghost" onClick={() => setView(mode)}>{mode === "text" ? "文本" : mode === "json" ? "JSON" : "十六进制"}</Button>)}
      </div>
      <div className="redis-value-actions"><Button size="xs" variant="ghost" className="redis-copy-content" aria-label={value.truncated ? "复制已加载部分" : "复制当前内容"} title={value.truncated ? "复制已加载部分" : "复制当前显示的内容"} data-testid="redis-copy-content" onClick={() => void copy(shown)}><Copy aria-hidden="true" />{value.truncated ? "复制已加载部分" : "复制内容"}</Button></div>
    </div>
    {value.truncated ? <p className="redis-notice" role="status">内容已截断：已显示 {redisBytes(value.shownBytes)} / {redisBytes(value.bytes)}，不能作为完整数据使用。</p> : null}
    {value.text === null ? <p className="redis-muted px-3 pt-2">二进制内容 · 十六进制预览</p> : null}
    <pre tabIndex={0} className="redis-value" data-testid="redis-value">{shown || (value.bytes === 0 ? "（空字符串）" : "（当前预算不足以展示完整字符）")}</pre>
  </div>
}

function KeyDocument({ tab, refresh, more, field, clearField }: {
  readonly tab: RedisTab; readonly refresh: () => void; readonly more: () => void
  readonly field: (name: string) => void; readonly clearField: () => void
}) {
  const [fieldInput, setFieldInput] = useState("")
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const content = tab.content
  const currentRow = selectedRowId ? content?.rows.find((row) => row.id === selectedRowId) : null
  const selectedValue = tab.fieldName !== null ? tab.fieldContent?.value : currentRow?.value
  const metadata = tab.info
  return <div className="redis-document">
    <header className="redis-key-heading">
      <div className="redis-key-title">
        {metadata ? <Badge variant="outline" className="redis-type-badge" title={"数据类型：" + metadata.type}>{metadata.type}</Badge> : null}
        <h2 title={tab.key}>{tab.key}</h2>
        <Button size="icon-xs" variant="ghost" className="redis-inline-action" aria-label="复制 Key" title="复制完整 Key" data-testid="redis-copy-key" onClick={() => void copy(tab.key)}><Copy aria-hidden="true" /></Button>
      </div>
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
    {tab.error ? <div role="alert" className="redis-error" data-testid="redis-key-error">{tab.error}</div> : null}
    {tab.loading ? <p role="status" className="redis-notice">正在读取…</p> : null}
    {metadata && !metadata.exists ? <div className="redis-empty" data-testid="redis-key-missing">Key 已过期或被删除。可刷新重新检查。</div>
      : content?.unsupported ? <div className="redis-empty">暂不支持 {content.type} 类型的内容查看，仍可查看类型与 TTL。</div>
        : content?.value ? <ValueViewer value={content.value} />
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
                : selectedValue ? <ValueViewer value={selectedValue} />
                  : <p className="redis-notice">{tab.fieldContent?.truncated ? "字段值超过读取上限（" + redisBytes(tab.fieldContent.valueBytes ?? 0) + "），未读取正文。" : "正在读取字段…"}</p>}
            </section> : null}
          </> : !tab.loading && !tab.error ? <div className="redis-empty">点击刷新读取内容。</div> : null}
  </div>
}

export function RedisWorkspace({ api, scope, plugin, projectName, environmentName, visible, onBack, onClose }: Props) {
  const state = useRedisWorkspace(api, scope, plugin, visible)
  const [search, setSearch] = useState("")
  const [searchMode, setSearchMode] = useState<"keyword" | "exact">("keyword")
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
  function submitSearch() {
    if (searchMode === "exact") { if (search) state.openKey(search, true) }
    else void state.scan(false, state.patternId, search)
  }
  return <section className="redis-workspace" aria-label="Redis 工作区" data-testid="redis-workspace" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); sidebarRef.current?.expand(); requestAnimationFrame(() => searchRef.current?.focus())
    }
  }}>
    <header className="redis-workspace-header">
      <WorkspaceBackButton label="返回 Redis 详情" testId="redis-workspace-back" onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{plugin.displayName}</h1><Badge variant="success">已连接</Badge><Badge variant="outline"><ShieldCheck className="size-3" />只读</Badge></div>
        <p className="truncate text-[11px] text-muted-foreground" title={projectName + " / " + environmentName}>{projectName} / {environmentName} · DB {String(plugin.target?.db ?? 0)}</p>
      </div>
      <WorkspaceHeaderActions connected busy={disconnecting} onDisconnect={() => void disconnect()} onClose={() => setClosing(true)} prefix="redis-workspace" closeLabel="关闭 Redis 工作区" closeTitle="关闭工作区并清除浏览数据" />
    </header>
    {state.notice ? <div className="redis-notice flex items-center justify-between" role="status" data-testid="redis-notice"><span>{state.notice}</span><WorkspaceIconButton action="close" label="收起提示" onClick={() => state.setNotice("")} /></div> : null}
    <div className="redis-workspace-body">
      <ResizablePanelGroup id={uniqueId + "-panels"} orientation="horizontal" aria-label="Key 目录与内容查看">
        <ResizablePanel id={uniqueId + "-keys"} panelRef={sidebarRef} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size" onResize={(size) => setSidebar(size.inPixels >= 1)} defaultSize="360px" minSize="260px" maxSize="55%">
          <aside className="redis-key-pane" hidden={!sidebar} inert={!sidebar}>
            <RedisKeyBrowser keys={state.keys} activeKey={activeTab?.key} keyword={state.keyword}
              queryKey={JSON.stringify([state.patternId, state.keyword])} loading={state.loading} visible={visible}
              refreshDisabled={!state.patternId} onRefresh={() => void state.scan(false)}
              identity={<RedisScopePicker database={String(plugin.target?.db ?? 0)} patterns={state.patterns} patternId={state.patternId} visible={visible}
                onChange={(value) => { setSearch(""); state.changePattern(value) }} />}
              search={<form className="redis-searchbox" onSubmit={(event) => { event.preventDefault(); submitSearch() }}>
                <Input ref={searchRef} aria-label={searchMode === "exact" ? "完整 Key" : "Key 关键词"} placeholder={searchMode === "exact" ? "输入完整 Key" : "搜索 Key，Enter 查找"}
                  value={search} onChange={(event) => setSearch(event.target.value)} data-testid="redis-search-input" />
                <Button type="submit" size="icon-xs" variant="ghost" aria-label="搜索 Key" title="搜索 Key（Enter）" disabled={!state.patternId || state.loading} data-testid="redis-search-submit"><MagnifyingGlass /></Button>
                <label className="redis-exact-toggle" title="勾选后直接读取完整 Key；未勾选时按关键词查找。">
                  <input type="checkbox" checked={searchMode === "exact"} onChange={(event) => setSearchMode(event.target.checked ? "exact" : "keyword")} aria-label="精确匹配 Key" data-testid="redis-search-exact" />
                  <span>精确匹配</span>
                </label>
              </form>}
              complete={state.complete} error={state.error || (!state.patterns.length ? "没有可用的已登记范围，请检查插件配置。" : "")} onOpen={(key, pinned) => state.openKey(key, pinned)} />
            <div className="redis-key-footer"><span title="目录按 : 分组，数量仅统计已加载的 Key。">{state.keyword ? "包含：" + state.keyword + " · " : ""}已加载 {state.keys.length} 个 Key</span>
              {state.cursor ? <Button size="sm" variant="outline" disabled={state.loading || state.keys.length >= REDIS_MAX_KEYS} onClick={() => void state.scan(true)} data-testid="redis-scan-more">{state.loading ? "读取中…" : "继续扫描"}</Button> : null}
              <span>{state.complete ? "本轮扫描完成" : "扫描未完成"}</span>
            </div>
          </aside>
        </ResizablePanel><ResizableHandle aria-label="调整 Key 列表宽度" withHandle />
        <ResizablePanel id={uniqueId + "-content"} minSize="240px">
          <div className="redis-content-pane">
            <WorkspaceTabBar className="redis-tab-strip">
              <div className="redis-tabs" role="tablist" aria-label="已打开的 Redis Key">
                {state.tabs.map((tab, index) => <div key={tab.id} className="redis-tab" data-active={tab.id === state.activeId}>
                  <button type="button" role="tab" id={uniqueId + "-tab-" + tab.id} aria-controls={uniqueId + "-panel-" + tab.id} aria-selected={tab.id === state.activeId} tabIndex={tab.id === state.activeId ? 0 : -1}
                    title={tab.key + (tab.pinned ? "" : " · 双击固定")} data-testid="redis-key-tab" onClick={() => state.setActiveId(tab.id)} onDoubleClick={() => state.openKey(tab.key, true, tab.patternId)}
                    onKeyDown={(event) => {
                      let next = index
                      if (event.key === "ArrowRight") next = (index + 1) % state.tabs.length
                      else if (event.key === "ArrowLeft") next = (index + state.tabs.length - 1) % state.tabs.length
                      else if (event.key === "Home") next = 0
                      else if (event.key === "End") next = state.tabs.length - 1
                      else if (event.key === "Delete") { event.preventDefault(); state.closeTab(tab.id); return }
                      else return
                      event.preventDefault(); const target = state.tabs[next]!; state.setActiveId(target.id); document.getElementById(uniqueId + "-tab-" + target.id)?.focus()
                    }}>
                    {tab.pinned ? <PushPin size={12} /> : null}<span className={tab.pinned ? "" : "italic"}>{tab.key}</span>
                  </button>
                  <WorkspaceIconButton action="close" label={"关闭 " + tab.key} className="redis-tab-close" onClick={() => state.closeTab(tab.id)} />
                </div>)}
              </div>
              <WorkspaceLayoutControls maximized={!sidebar} onToggle={() => { if (sidebarRef.current?.isCollapsed()) sidebarRef.current.expand(); else sidebarRef.current?.collapse() }} testId="redis-layout-toggle" controls={uniqueId + "-keys"} />
            </WorkspaceTabBar>
            {!state.tabs.length ? <div className="redis-empty redis-welcome"><Database size={36} /><h2>查看 Redis 数据</h2><p>展开左侧目录查找 Key，或输入完整 Key 精确定位。</p><p>单击预览，双击固定标签；数据仅保留在当前会话。</p></div> : null}
            {state.tabs.map((tab) => <div className="redis-tab-panel" key={tab.id} id={uniqueId + "-panel-" + tab.id} role="tabpanel" aria-labelledby={uniqueId + "-tab-" + tab.id} hidden={tab.id !== state.activeId} inert={tab.id !== state.activeId}>
              <KeyDocument tab={tab} refresh={() => void state.readTab(tab.id)} more={() => void state.readTab(tab.id, true)} field={(name) => void state.readTab(tab.id, false, name)} clearField={() => state.clearField(tab.id)} />
            </div>)}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <footer className="redis-workspace-footer"><span><ShieldCheck size={12} />只读 · 固定 DB {String(plugin.target?.db ?? 0)}</span><span>最近扫描 {time(state.readAt)}</span><span>数据可能变化 · 仅会话保留</span></footer>
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>关闭 Redis 工作区</DialogTitle><DialogDescription>将清除搜索条件、标签和浏览数据。Redis 插件连接保持。</DialogDescription></DialogHeader><DialogFooter>
      <Button variant="outline" onClick={() => { setClosing(false); onBack() }}>返回详情并保留</Button><Button data-testid="redis-workspace-confirm-close" onClick={onClose}>关闭工作区</Button>
    </DialogFooter></DialogContent></Dialog>
  </section>
}
