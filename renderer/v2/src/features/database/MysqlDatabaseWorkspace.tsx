import { ArrowClockwise, ArrowLeft, CaretDown, CaretUp, Code, Database, Key, ListBullets, MagnifyingGlass, Plugs, Plus, ShieldCheck, SidebarSimple, Table as TableIcon, WarningCircle, X } from "@phosphor-icons/react"
import { toast } from "sonner"
import { MysqlTableBrowser } from "./MysqlTableBrowser"
import { useMysqlSchemaCache } from "./use-mysql-schema-cache"
import { MYSQL_TABLE_DRAG_TYPE, mysqlSelectSnippet } from "./mysql-sql-assist"
import { useId, useState } from "react"
import { usePanelRef } from "react-resizable-panels"

import type { AiOpsV2Api, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"
import { ThemeMenu } from "@/components/app-shell/ThemeMenu"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MysqlQueryResults } from "@/features/database/MysqlQueryResults"
import { MysqlSqlEditor } from "@/features/database/MysqlSqlEditor"
import { mysqlCellText, mysqlDatabaseName, mysqlWorkspaceMatchesScope, mysqlWorkspaceSessionKey } from "@/features/database/mysql-workspace-model"
import { MYSQL_MAX_QUERY_DOCUMENTS, useMysqlQueryDocuments } from "@/features/database/use-mysql-query-documents"
import { useMysqlWorkspace } from "@/features/database/use-mysql-workspace"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { cn } from "@/lib/utils"
import "@/features/database/mysql-database-workspace.css"

export interface MysqlDatabaseWorkspaceProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly plugin: PluginConfigurationRecord
  readonly connected: boolean
  readonly onBack: () => void
  readonly projectName: string
  readonly environmentName: string
}

function ReadError({ message, testId }: { readonly message: string; readonly testId: string }) {
  return <Alert className="rounded-none border-x-0" data-testid={testId} variant="destructive"><WarningCircle aria-hidden="true" /><AlertTitle>读取失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}

function AuditWarning({ testId }: { readonly testId: string }) {
  return <p className="flex items-start gap-1.5 px-3 py-2 text-xs leading-5 text-muted-foreground" data-testid={testId} role="status"><WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />本次读取已完成，但操作记录未能保存。</p>
}

function ReadLoading({ label }: { readonly label: string }) {
  return <div aria-busy="true" aria-label={label} className="space-y-3 p-4" role="status"><p className="text-xs text-muted-foreground">{label}</p><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></div>
}

function TableStructure({ description }: { readonly description: MysqlTableDescription }) {
  return (
    <section aria-label="表结构" className="mysql-structure" data-testid="mysql-table-structure">
      <div className="mysql-structure-summary"><ListBullets aria-hidden="true" />表结构<span>{description.columns.length} 个字段</span></div>
      <div aria-label="表结构，可横向滚动" className="mysql-structure-scroll" role="region" tabIndex={0}>
        <table>
          <colgroup><col style={{ width: 48 }} /><col style={{ width: 200 }} /><col style={{ width: 170 }} /><col style={{ width: 95 }} /><col style={{ width: 95 }} /><col style={{ width: 220 }} /><col /></colgroup>
          <thead><tr>{["#", "字段", "类型", "允许 NULL", "索引", "默认值", "其他"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>
            {description.columns.length ? description.columns.map((column, index) => (
              <tr key={column.name}>
                <td className="mysql-structure-row-number">{index + 1}</td>
                <td className="font-mono" title={column.name}>{column.name}</td>
                <td className="font-mono text-muted-foreground" title={column.type}>{column.type}</td>
                <td>{column.nullable ? "是" : "否"}</td>
                <td><span className="mysql-structure-key">{column.key === "PRI" ? <Key aria-hidden="true" /> : null}{column.key || "无"}</span></td>
                <td className="font-mono" title={mysqlCellText(column.default)}>{mysqlCellText(column.default)}</td>
                <td title={column.extra || "无"}>{column.extra || "无"}</td>
              </tr>
            )) : <tr><td className="text-center text-muted-foreground" colSpan={7}>未返回字段信息。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function WorkspaceHeader({ plugin, connected, onBack, projectName, environmentName }: Pick<MysqlDatabaseWorkspaceProps, "plugin" | "connected" | "onBack" | "projectName" | "environmentName">) {
  const database = mysqlDatabaseName(plugin)
  return (
    <header className="mysql-workspace-header">
      <Button aria-label="返回数据库详情" data-testid="mysql-workspace-back" onClick={onBack} size="sm" type="button" variant="ghost"><ArrowLeft aria-hidden="true" /><span>返回详情</span></Button>
      <span className="mysql-workspace-header-divider" />
      <Database aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <div className="mysql-workspace-identity"><h2 title={database || plugin.displayName}>{database || plugin.displayName}</h2><p title={`${projectName} / ${environmentName} / ${plugin.displayName}`}>{projectName}<span>/</span>{environmentName}<span>/</span>{plugin.displayName}</p></div>
      <Badge className="shrink-0 gap-1 text-[11px]" variant="outline"><ShieldCheck aria-hidden="true" className="size-3" />只读</Badge>
      <span className={cn("mysql-workspace-connection", connected && "is-connected")}><span />{connected ? "已连接" : "未连接"}</span>
      <div className="mysql-workspace-theme"><ThemeMenu /></div>
    </header>
  )
}

function MysqlConnectedWorkspace({ api, scope, plugin }: Pick<MysqlDatabaseWorkspaceProps, "api" | "scope" | "plugin">) {
  const state = useMysqlWorkspace(api, scope)
  const queries = useMysqlQueryDocuments(api, scope)
  const getSchema = useMysqlSchemaCache(api, scope)
  const dragScope = mysqlWorkspaceSessionKey(scope, plugin)
  const [search, setSearch] = useState("")
  const [documentTab, setDocumentTab] = useState("query-1")
  const [activeQueryId, setActiveQueryId] = useState("query-1")
  const [tableTab, setTableTab] = useState("structure")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editorCollapsed, setEditorCollapsed] = useState(false)
  const sidebarRef = usePanelRef()
  const editorRef = usePanelRef()
  const uniqueId = useId()
  const searchHintId = `${uniqueId}-search-hint`
  const database = mysqlDatabaseName(plugin)
  const searchTerm = search.trim().toLocaleLowerCase()
  const visibleTables = state.tables.filter((table) => table.name.toLocaleLowerCase().includes(searchTerm))

  function selectDocument(value: string) {
    setDocumentTab(value)
    if (value !== "table") setActiveQueryId(value)
  }

  function createQuery() {
    const id = queries.createDocument()
    if (id) selectDocument(id)
  }

  function generateQuery(table: string) {
    if (!state.tables.some(item => item.name === table && item.queryable)) return
    const current = queries.documents.find(document => document.id === activeQueryId)
    const id = current && !current.sql.trim() && !current.result.loading ? current.id : queries.createDocument()
    if (!id) { toast.error("最多打开 6 个查询，请先关闭一个标签。现有 SQL 已保留。"); return }
    queries.updateSql(id, mysqlSelectSnippet(table))
    selectDocument(id)
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid="mysql-sql-editor"]')?.focus(), 0)
  }
  function dropTable(data: string) {
    try { const payload = JSON.parse(data); if (payload.scope === dragScope && typeof payload.table === "string") generateQuery(payload.table) } catch { /* 忽略其他窗口或非工作区的拖放内容。 */ }
  }

  function closeQuery(id: string) {
    if (queries.documents.length <= 1) return
    if (id === activeQueryId) {
      const next = queries.documents.find((document) => document.id !== id)!
      setActiveQueryId(next.id)
      if (documentTab !== "table") setDocumentTab(next.id)
    }
    queries.closeDocument(id)
  }

  function toggleSidebar() {
    if (sidebarRef.current?.isCollapsed()) sidebarRef.current.expand()
    else sidebarRef.current?.collapse()
  }

  function toggleEditor() {
    if (editorRef.current?.isCollapsed()) editorRef.current.expand()
    else editorRef.current?.collapse()
  }

  return (
    <>
      <div className="mysql-workspace-body">
        <ResizablePanelGroup aria-label="数据库表列表与查询工作区" id={`${uniqueId}-workspace`} orientation="horizontal">
          <ResizablePanel collapsedSize="48px" collapsible defaultSize="224px" groupResizeBehavior="preserve-pixel-size" id={`${uniqueId}-tables`} maxSize="340px" minSize="180px" onResize={(size) => setSidebarCollapsed(size.inPixels < 80)} panelRef={sidebarRef}>
            <aside aria-label="数据表" className={cn("mysql-table-sidebar", sidebarCollapsed && "is-collapsed")} data-testid="mysql-table-sidebar">
              <div className="mysql-sidebar-heading"><Database aria-hidden="true" /><strong title={database}>{database}</strong><Button aria-label="刷新数据表" data-testid="mysql-tables-refresh" disabled={state.tablesLoading} onClick={() => void state.loadTables()} size="icon-sm" title="刷新数据表" type="button" variant="ghost"><ArrowClockwise aria-hidden="true" className={state.tablesLoading ? "motion-safe:animate-spin" : ""} /></Button></div>
              <div className="mysql-sidebar-search"><MagnifyingGlass aria-hidden="true" /><Input aria-describedby={searchHintId} aria-label="搜索已加载的数据表" data-testid="mysql-table-search" onChange={(event) => setSearch(event.target.value)} placeholder="搜索表名…" value={search} /></div>
              <p className="mysql-sidebar-search-hint" id={searchHintId}>搜索已加载的 {state.tables.length} 张表</p>
              <div className="mysql-sidebar-section-label"><CaretDown aria-hidden="true" />数据表<span>{state.tables.length}</span></div>
              {state.tablesAuditWarning ? <AuditWarning testId="mysql-tables-audit-warning" /> : null}
              {state.tablesError ? <ReadError message={state.tablesError} testId="mysql-tables-error" /> : null}
              <div aria-busy={state.tablesLoading || undefined} className="mysql-sidebar-table-list" data-testid="mysql-table-list">
                {visibleTables.map((table) => (
                  <div className="mysql-table-row" key={table.name}><Button draggable={table.queryable} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData(MYSQL_TABLE_DRAG_TYPE, JSON.stringify({ scope: dragScope, table: table.name })) }} aria-label={table.name} aria-pressed={state.selectedTable?.name === table.name} className={cn("mysql-table-button", state.selectedTable?.name === table.name && "is-selected")} data-table-name={table.name} data-testid="mysql-table-item" disabled={!table.queryable} key={table.name} onClick={() => { setDocumentTab("table"); setTableTab("structure"); void state.selectTable(table) }} title={table.queryable ? table.name : `${table.name}：当前策略不支持读取此表`} type="button" variant="ghost"><TableIcon aria-hidden="true" /><span>{table.name}</span>{table.type === "VIEW" ? <small>视图</small> : null}</Button>{table.queryable ? <Button aria-label={`生成 ${table.name} 查询`} className="mysql-table-generate" data-testid="mysql-table-generate" onClick={() => generateQuery(table.name)} size="icon-sm" title="生成 SELECT 查询，也可将表拖入编辑区" type="button" variant="ghost"><Code /></Button> : null}</div>
                ))}
                {!visibleTables.length && !state.tablesLoading && state.tablesLoaded ? <p className="mysql-sidebar-empty">{searchTerm ? "已加载的表中没有匹配项。" : "当前数据库没有数据表。"}</p> : null}
                {state.tablesLoading ? <p className="mysql-sidebar-empty" role="status">正在读取数据表…</p> : null}
              </div>
              {state.nextCursor ? <div className="mysql-sidebar-more"><Button data-testid="mysql-tables-load-more" disabled={state.tablesLoading} onClick={() => { if (state.nextCursor) void state.loadTables(state.nextCursor) }} size="sm" type="button" variant="ghost">{state.tablesLoading ? "读取中…" : "加载更多数据表"}</Button></div> : null}
              <div className="mysql-sidebar-footer"><span>{state.tables.length} 张表</span><span>{state.tablesTruncated && !state.nextCursor ? "已达读取上限" : state.nextCursor ? "还有更多" : state.tablesLoaded ? "已加载" : "待读取"}</span></div>
            </aside>
          </ResizablePanel>
          <ResizableHandle aria-label="调整数据表列表宽度" data-testid="mysql-sidebar-resizer" id={`${uniqueId}-sidebar-resizer`} onDoubleClick={() => sidebarRef.current?.resize("224px")} withHandle />
          <ResizablePanel className="min-h-0 min-w-0" id={`${uniqueId}-content`} minSize="360px">
            <Tabs className="mysql-document-workspace" onValueChange={selectDocument} value={documentTab}>
              <div className="mysql-document-tabs-row">
                <TabsList aria-label="数据库工作区" className="mysql-document-tabs" variant="line">
                  {queries.documents.map((document, index) => (
                    <div className="mysql-document-tab-group" key={document.id}>
                      <TabsTrigger className="mysql-document-tab" data-query-id={document.id} data-testid={index === 0 ? "mysql-sql-tab" : "mysql-sql-document-tab"} value={document.id}><Code aria-hidden="true" />{document.name}{document.result.loading ? <ArrowClockwise aria-hidden="true" className="size-3 motion-safe:animate-spin" /> : null}</TabsTrigger>
                      {queries.documents.length > 1 ? <Button aria-label={`关闭 ${document.name}`} className="mysql-document-close" data-query-id={document.id} data-testid="mysql-query-close" onClick={() => closeQuery(document.id)} size="icon-sm" title={`关闭 ${document.name}`} type="button" variant="ghost"><X aria-hidden="true" /></Button> : null}
                    </div>
                  ))}
                  <TabsTrigger className="mysql-document-tab" data-testid="mysql-table-document-tab" disabled={!state.selectedTable} title={state.selectedTable?.name} value="table"><TableIcon aria-hidden="true" /><span className="max-w-64 truncate font-mono">{state.selectedTable?.name || "数据表"}</span></TabsTrigger>
                </TabsList>
                <Button aria-label="新建 SQL 查询" className="mysql-new-query" data-testid="mysql-query-new" disabled={queries.documents.length >= MYSQL_MAX_QUERY_DOCUMENTS} onClick={createQuery} size="icon-sm" title={queries.documents.length >= MYSQL_MAX_QUERY_DOCUMENTS ? `最多打开 ${MYSQL_MAX_QUERY_DOCUMENTS} 个查询标签` : "新建 SQL 查询"} type="button" variant="ghost"><Plus aria-hidden="true" /></Button>
                <div className="mysql-layout-controls"><Button aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "展开表列表" : "收起表列表"} data-testid="mysql-sidebar-toggle" onClick={toggleSidebar} size="icon-sm" title={sidebarCollapsed ? "展开表列表" : "收起表列表"} type="button" variant="ghost"><SidebarSimple aria-hidden="true" /></Button><Button aria-expanded={!editorCollapsed} aria-label={editorCollapsed ? "展开 SQL 编辑器" : "收起 SQL 编辑器"} data-testid="mysql-editor-toggle" disabled={documentTab === "table"} onClick={toggleEditor} size="icon-sm" title={editorCollapsed ? "展开 SQL 编辑器" : "收起 SQL 编辑器"} type="button" variant="ghost">{editorCollapsed ? <CaretDown aria-hidden="true" /> : <CaretUp aria-hidden="true" />}</Button></div>
              </div>
              <TabsContent className={cn("mysql-document-content", documentTab === "table" && "hidden")} forceMount value={activeQueryId}>
                <ResizablePanelGroup aria-label="SQL 编辑器与查询结果" id={`${uniqueId}-query`} orientation="vertical">
                  <ResizablePanel collapsedSize="42px" collapsible defaultSize="252px" groupResizeBehavior="preserve-pixel-size" id={`${uniqueId}-editor`} maxSize="70%" minSize="150px" onResize={(size) => setEditorCollapsed(size.inPixels < 80)} panelRef={editorRef}>
                    {queries.documents.map((document) => (
                      <div className="mysql-query-document-view" data-query-document={document.id} hidden={document.id !== activeQueryId} key={document.id}>
                        <MysqlSqlEditor tables={state.tables} getSchema={getSchema} onTableDrop={dropTable} active={document.id === activeQueryId} collapsed={editorCollapsed} loading={document.result.loading} onChange={(sql) => queries.updateSql(document.id, sql)} onRun={() => void queries.runQuery(document.id, document.sql)} value={document.sql} />
                      </div>
                    ))}
                  </ResizablePanel>
                  <ResizableHandle aria-label="调整 SQL 编辑器与结果区高度" data-testid="mysql-editor-resizer" id={`${uniqueId}-editor-resizer`} onDoubleClick={() => editorRef.current?.resize("252px")} withHandle />
                  <ResizablePanel className="min-h-0 min-w-0" id={`${uniqueId}-result`} minSize="150px">
                    {queries.documents.map((document) => (
                      <div className="mysql-query-result-area mysql-query-document-view" data-query-document={document.id} hidden={document.id !== activeQueryId} key={document.id}>
                        {document.result.loading ? <ReadLoading label="正在执行查询…" /> : null}
                        {document.result.error ? <ReadError message={document.result.error} testId={document.id === activeQueryId ? "mysql-query-error" : `mysql-${document.id}-error`} /> : null}
                        {document.result.data ? <MysqlQueryResults kind="query" result={document.result.data} testIdPrefix={document.id === activeQueryId ? "mysql-query" : `mysql-${document.id}`} /> : null}
                        {!document.result.data && !document.result.loading && !document.result.error ? <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><Code aria-hidden="true" /></EmptyMedia><EmptyTitle>编写你的第一条查询</EmptyTitle><EmptyDescription>执行只读 SQL，结果将在此显示。<br />查询受当前连接配置的数量和大小上限约束。</EmptyDescription></EmptyHeader></Empty> : null}
                      </div>
                    ))}
                  </ResizablePanel>
                </ResizablePanelGroup>
              </TabsContent>
              <TabsContent className={cn("mysql-document-content", documentTab !== "table" && "hidden")} forceMount value="table">
                {state.selectedTable ? (
                  <Tabs className="mysql-table-content" onValueChange={setTableTab} value={tableTab}>
                    <div className="mysql-table-toolbar"><TabsList aria-label="数据表视图" variant="line"><TabsTrigger data-testid="mysql-table-preview-tab" value="preview"><TableIcon aria-hidden="true" />数据预览</TabsTrigger><TabsTrigger data-testid="mysql-table-structure-tab" value="structure"><ListBullets aria-hidden="true" />表结构</TabsTrigger></TabsList><span className="mysql-table-name" title={state.selectedTable.name}>{state.selectedTable.name}</span>{tableTab === "structure" ? <Button aria-label="刷新表结构" disabled={state.structure.loading} onClick={() => { if (state.selectedTable) void state.selectTable(state.selectedTable) }} size="icon-sm" title="刷新结构" type="button" variant="ghost"><ArrowClockwise aria-hidden="true" /></Button> : null}</div>
                    <TabsContent className={cn("mysql-table-view", tableTab !== "structure" && "hidden")} forceMount value="structure">
                      {state.structure.loading ? <ReadLoading label="正在读取表结构…" /> : null}
                      {state.structure.error ? <ReadError message={state.structure.error} testId="mysql-structure-error" /> : null}
                      {state.structure.data?.auditWarning ? <AuditWarning testId="mysql-structure-audit-warning" /> : null}
                      {state.structure.data ? <TableStructure description={state.structure.data} /> : null}
                    </TabsContent>
                    <TabsContent className={cn("mysql-table-view", tableTab !== "preview" && "hidden")} forceMount value="preview">
                      <MysqlTableBrowser api={api} scope={scope} table={state.selectedTable.name} description={state.structure.data} maxRows={typeof plugin.limits?.maxRows === "number" ? plugin.limits.maxRows : 100} key={state.selectedTable.name} />
                    </TabsContent>
                  </Tabs>
                ) : <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><TableIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>选择一张数据表</EmptyTitle><EmptyDescription>查看字段结构，或筛选、排序并分批浏览数据。</EmptyDescription></EmptyHeader></Empty>}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <footer className="mysql-workspace-status"><span><ShieldCheck aria-hidden="true" />只读连接</span><span className="font-mono" title={database}>{database}</span><span className="mysql-workspace-status-note">SQL 与查询结果仅保留在当前会话</span></footer>
    </>
  )
}

export function MysqlDatabaseWorkspace(props: MysqlDatabaseWorkspaceProps) {
  const { api, scope, plugin, connected } = props
  const database = mysqlDatabaseName(plugin)
  const matchesScope = mysqlWorkspaceMatchesScope(scope, plugin)
  const ready = connected && plugin.pluginType === "mysql" && Boolean(database) && matchesScope
  return (
    <section aria-label="数据库工作区" className="mysql-workspace h-full min-h-0" data-testid="mysql-database-workspace">
      <WorkspaceHeader {...props} connected={ready} />
      {ready ? (
        // 用完整作用域和配置版本隔离数据；断连时卸载会话并清除查询结果。
        <MysqlConnectedWorkspace api={api} key={mysqlWorkspaceSessionKey(scope, plugin)} plugin={plugin} scope={scope} />
      ) : (
        <Empty className="min-h-0 flex-1" data-testid="mysql-database-offline"><EmptyHeader><EmptyMedia variant="icon"><Plugs aria-hidden="true" /></EmptyMedia><EmptyTitle>{!matchesScope ? "正在切换数据库" : plugin.pluginType !== "mysql" ? "仅 MySQL 支持数据库查询" : !database ? "尚未配置数据库" : "连接后即可查询数据库"}</EmptyTitle><EmptyDescription>{!matchesScope ? "等待当前插件配置载入。" : !database ? "请在连接配置中选择一个数据库。" : "返回详情连接此 MySQL 插件，即可浏览数据表、查看结构和执行只读查询。"}</EmptyDescription></EmptyHeader></Empty>
      )}
    </section>
  )
}
