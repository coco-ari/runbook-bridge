import { ArrowClockwise, Database, MagnifyingGlass, Play, Plugs, Table as TableIcon, WarningCircle } from "@phosphor-icons/react"
import { useId, useState } from "react"

import type { AiOpsV2Api, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { MysqlQueryResults } from "@/features/database/MysqlQueryResults"
import { mysqlCellText, mysqlDatabaseName, mysqlWorkspaceMatchesScope, mysqlWorkspaceSessionKey } from "@/features/database/mysql-workspace-model"
import { useMysqlWorkspace } from "@/features/database/use-mysql-workspace"
import type { PluginConfigurationRecord } from "@/features/plugins/plugin-types"
import { cn } from "@/lib/utils"

export interface MysqlDatabaseWorkspaceProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly plugin: PluginConfigurationRecord
  readonly connected: boolean
}

function ReadError({ message, testId }: { readonly message: string; readonly testId: string }) {
  return (
    <Alert data-testid={testId} variant="destructive">
      <WarningCircle aria-hidden="true" />
      <AlertTitle>读取失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function AuditWarning({ testId }: { readonly testId: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground" data-testid={testId} role="status">
      <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      本次读取已完成，但操作记录未能保存。
    </p>
  )
}

function ReadLoading({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-3 py-3" role="status">
      <p className="text-xs text-muted-foreground">{label}</p>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function TableSelectionEmpty() {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon"><TableIcon aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>选择一张数据表</EmptyTitle>
        <EmptyDescription>查看字段结构，或按需预览最多 100 行数据。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function TableStructure({ description }: { readonly description: MysqlTableDescription }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border" data-testid="mysql-table-structure">
      <div aria-label="表结构，可横向滚动" className="max-h-[32rem] overflow-auto" role="region" tabIndex={0}>
        <Table className="text-xs">
          <TableHeader className="sticky top-0 z-10 bg-surface-inset">
            <TableRow>
              {["字段", "类型", "允许 NULL", "索引", "默认值", "其他"].map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {description.columns.length ? description.columns.map((column) => (
              <TableRow key={column.name}>
                <TableCell className="font-mono font-medium">{column.name}</TableCell>
                <TableCell className="font-mono">{column.type}</TableCell>
                <TableCell>{column.nullable ? "是" : "否"}</TableCell>
                <TableCell className="font-mono">{column.key || "无"}</TableCell>
                <TableCell className="max-w-56 whitespace-pre-wrap break-all font-mono">{mysqlCellText(column.default)}</TableCell>
                <TableCell className="max-w-56 whitespace-pre-wrap break-all">{column.extra || "无"}</TableCell>
              </TableRow>
            )) : (
              <TableRow><TableCell className="h-24 text-center text-muted-foreground" colSpan={6}>未返回字段信息。</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MysqlConnectedWorkspace({ api, scope, plugin }: Omit<MysqlDatabaseWorkspaceProps, "connected">) {
  const state = useMysqlWorkspace(api, scope)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState("structure")
  const [sql, setSql] = useState("")
  const uniqueId = useId()
  const headingId = `${uniqueId}-heading`
  const editorId = `${uniqueId}-sql`
  const searchHintId = `${uniqueId}-search-hint`
  const sqlHintId = `${uniqueId}-sql-hint`
  const database = mysqlDatabaseName(plugin)
  const searchTerm = search.trim().toLocaleLowerCase()
  const visibleTables = state.tables.filter((table) => table.name.toLocaleLowerCase().includes(searchTerm))

  return (
    <section aria-labelledby={headingId} className="min-w-0 @container/database" data-testid="mysql-database-workspace">
      <FeatureToolbar
        description={<span>当前数据库 <span className="break-all font-mono text-foreground">{database}</span>，查询仅在此数据库内执行。</span>}
        meta={<Badge variant="outline">只读</Badge>}
        title="数据库查询"
        titleId={headingId}
      />
      <div className="grid min-w-0 gap-4 @2xl/database:grid-cols-[13rem_minmax(0,1fr)]">
        <aside aria-label="数据表" className="min-w-0 rounded-lg border bg-surface-inset/30">
          <div className="space-y-3 border-b p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium"><Database aria-hidden="true" />数据表</h3>
              <Button aria-label="刷新数据表" data-testid="mysql-tables-refresh" disabled={state.tablesLoading} onClick={() => void state.loadTables()} size="icon-sm" title="刷新数据表" type="button" variant="ghost">
                <ArrowClockwise aria-hidden="true" className={state.tablesLoading ? "motion-safe:animate-spin" : ""} />
              </Button>
            </div>
            <div className="relative">
              <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-describedby={searchHintId} aria-label="搜索已加载的数据表" className="pl-8" data-testid="mysql-table-search" onChange={(event) => setSearch(event.target.value)} placeholder="搜索表名" value={search} />
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground" id={searchHintId}>搜索仅筛选已加载的 {state.tables.length} 张表。</p>
          </div>
          {state.tablesAuditWarning ? <div className="px-3 py-2"><AuditWarning testId="mysql-tables-audit-warning" /></div> : null}
          {state.tablesError ? <div className="p-2"><ReadError message={state.tablesError} testId="mysql-tables-error" /></div> : null}
          <div aria-busy={state.tablesLoading || undefined} className="max-h-52 overflow-y-auto p-1.5 @2xl/database:max-h-[35rem]" data-testid="mysql-table-list">
            {visibleTables.map((table) => (
              <Button
                aria-pressed={state.selectedTable?.name === table.name}
                className={cn("h-auto min-h-9 w-full justify-start gap-2 rounded-md px-2 py-2 text-left font-normal", state.selectedTable?.name === table.name && "bg-surface-selected text-primary")}
                data-table-name={table.name}
                data-testid="mysql-table-item"
                disabled={!table.queryable}
                key={table.name}
                onClick={() => { setTab("structure"); void state.selectTable(table) }}
                title={table.queryable ? table.name : `${table.name}：当前策略不支持读取此表`}
                type="button"
                variant="ghost"
              >
                <TableIcon aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{table.name}</span>
                {table.type === "VIEW" ? <span className="shrink-0 text-[10px] text-muted-foreground">视图</span> : null}
              </Button>
            ))}
            {!visibleTables.length && !state.tablesLoading && state.tablesLoaded ? (
              <p className="px-2 py-7 text-center text-xs leading-5 text-muted-foreground">{searchTerm ? "已加载的表中没有匹配项。" : "当前数据库没有数据表。"}</p>
            ) : null}
            {state.tablesLoading ? <p className="px-2 py-4 text-center text-xs text-muted-foreground" role="status">正在读取数据表…</p> : null}
          </div>
          {state.nextCursor ? (
            <div className="border-t p-2">
              <Button className="w-full" data-testid="mysql-tables-load-more" disabled={state.tablesLoading} onClick={() => { if (state.nextCursor) void state.loadTables(state.nextCursor) }} size="sm" type="button" variant="outline">
                {state.tablesLoading ? "读取中…" : "加载更多数据表"}
              </Button>
            </div>
          ) : state.tablesTruncated ? <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">表列表已达到读取上限。</p> : null}
        </aside>
        <Tabs className="min-w-0 gap-4" onValueChange={setTab} value={tab}>
          <div className="min-w-0 overflow-x-auto pb-1">
            <TabsList aria-label="数据库工作区" variant="segmented">
              <TabsTrigger className="px-3 text-xs" data-testid="mysql-table-structure-tab" value="structure">表结构</TabsTrigger>
              <TabsTrigger className="px-3 text-xs" data-testid="mysql-table-preview-tab" value="preview">数据预览</TabsTrigger>
              <TabsTrigger className="px-3 text-xs" data-testid="mysql-sql-tab" value="sql">SQL 查询</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent className="min-w-0 space-y-3" value="structure">
            {state.selectedTable ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all font-mono text-sm font-medium">{state.selectedTable.name}</h3>
                  <Button disabled={state.structure.loading} onClick={() => { if (state.selectedTable) void state.selectTable(state.selectedTable) }} size="sm" type="button" variant="ghost"><ArrowClockwise aria-hidden="true" />刷新结构</Button>
                </div>
                {state.structure.loading ? <ReadLoading label="正在读取表结构…" /> : null}
                {state.structure.error ? <ReadError message={state.structure.error} testId="mysql-structure-error" /> : null}
                {state.structure.data?.auditWarning ? <AuditWarning testId="mysql-structure-audit-warning" /> : null}
                {state.structure.data ? <TableStructure description={state.structure.data} /> : null}
              </>
            ) : <TableSelectionEmpty />}
          </TabsContent>
          <TabsContent className="min-w-0 space-y-3" value="preview">
            {state.selectedTable ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all font-mono text-sm font-medium">{state.selectedTable.name}</h3>
                  <Button data-testid="mysql-preview-run" disabled={state.preview.loading} onClick={() => void state.runPreview()} size="sm" type="button"><Play aria-hidden="true" />{state.preview.loading ? "查询中…" : "预览前 100 行"}</Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">最多读取 100 行，仍受此连接配置的数量和大小上限约束。未指定排序，返回顺序可能变化。</p>
                {state.preview.loading ? <ReadLoading label="正在读取预览数据…" /> : null}
                {state.preview.error ? <ReadError message={state.preview.error} testId="mysql-preview-error" /> : null}
                {state.preview.data ? <MysqlQueryResults kind="preview" result={state.preview.data} /> : null}
                {!state.preview.data && !state.preview.loading && !state.preview.error ? <p className="py-12 text-center text-xs text-muted-foreground">点击“预览前 100 行”读取数据。</p> : null}
              </>
            ) : <TableSelectionEmpty />}
          </TabsContent>
          <TabsContent className="min-w-0 space-y-4" value="sql">
            <div className="space-y-2">
              <label className="text-xs font-medium" htmlFor={editorId}>SQL 语句</label>
              <Textarea
                aria-describedby={sqlHintId}
                className="min-h-36 resize-y whitespace-pre font-mono text-xs leading-6"
                data-testid="mysql-sql-editor"
                disabled={state.query.loading}
                id={editorId}
                onChange={(event) => setSql(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault()
                    void state.runQuery(sql)
                  }
                }}
                placeholder="SELECT 1"
                spellCheck={false}
                value={sql}
              />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground" id={sqlHintId}>支持单条 SELECT。Ctrl / ⌘ + Enter 执行，结果受连接配置的上限约束。</p>
                <Button data-testid="mysql-query-run" disabled={state.query.loading || !sql.trim()} onClick={() => void state.runQuery(sql)} size="sm" type="button"><Play aria-hidden="true" />{state.query.loading ? "查询中…" : "执行查询"}</Button>
              </div>
            </div>
            {state.query.loading ? <ReadLoading label="正在执行查询…" /> : null}
            {state.query.error ? <ReadError message={state.query.error} testId="mysql-query-error" /> : null}
            {state.query.data ? <MysqlQueryResults kind="query" result={state.query.data} /> : null}
            {!state.query.data && !state.query.loading && !state.query.error ? <p className="py-12 text-center text-xs text-muted-foreground">输入 SQL 后执行查询，结果会显示在这里。</p> : null}
          </TabsContent>
        </Tabs>
      </div>
    </section>
  )
}

export function MysqlDatabaseWorkspace(props: MysqlDatabaseWorkspaceProps) {
  const { api, scope, plugin, connected } = props
  const database = mysqlDatabaseName(plugin)
  const matchesScope = mysqlWorkspaceMatchesScope(scope, plugin)
  if (!connected || plugin.pluginType !== "mysql" || !database || !matchesScope) {
    return (
      <section aria-label="数据库查询" data-testid="mysql-database-workspace">
        <Empty className="min-h-72" data-testid="mysql-database-offline">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Plugs aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{!matchesScope ? "正在切换数据库" : plugin.pluginType !== "mysql" ? "仅 MySQL 支持数据库查询" : !database ? "尚未配置数据库" : "连接后即可查询数据库"}</EmptyTitle>
            <EmptyDescription>{!matchesScope ? "等待当前插件配置载入。" : !database ? "请在连接配置中选择一个数据库。" : "在概览中连接此 MySQL 插件，即可浏览数据表、查看结构和执行只读查询。"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    )
  }
  // 用完整作用域和配置版本隔离数据；断连时卸载会话并清除查询结果。
  return <MysqlConnectedWorkspace api={api} key={mysqlWorkspaceSessionKey(scope, plugin)} plugin={plugin} scope={scope} />
}
