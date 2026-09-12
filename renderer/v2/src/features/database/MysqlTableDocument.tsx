import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useEffect, useRef, useState } from "react"
import { Key, ListBullets, Table as TableIcon } from "@phosphor-icons/react"
import type { AiOpsV2Api, MysqlTableDescription, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { mysqlCellText } from "./mysql-workspace-model"
import { MysqlTableBrowser } from "./MysqlTableBrowser"

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

export function MysqlTableDocument({ api, scope, table, visible, dragScope, maxRows }: {
  readonly api: AiOpsV2Api; readonly scope: PluginScope; readonly table: string
  readonly visible: boolean; readonly dragScope: string; readonly maxRows: number
}) {
  const [tab, setTab] = useState("preview")
  const [description, setDescription] = useState<MysqlTableDescription | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const ticket = useRef(0)
  async function refresh() {
    const owner = ++ticket.current
    setLoading(true)
    setError("")
    try {
      const response = await api.mysqlDescribeTable({ ...scope, table })
      if (ticket.current !== owner) return
      if (!response.ok) throw new Error(response.error.message)
      setDescription(response.data)
    } catch (failure) {
      if (ticket.current === owner) setError(failure instanceof Error ? failure.message : "表结构读取失败")
    } finally { if (ticket.current === owner) setLoading(false) }
  }
  useEffect(() => { void refresh(); return () => { ticket.current++ } }, [])
  return <div className="mysql-table-content">
    {visible ? <>
      <div className="mysql-table-toolbar"><Tabs value={tab} onValueChange={setTab}><TabsList aria-label="数据表视图" variant="line"><TabsTrigger data-testid="mysql-table-preview-tab" value="preview"><TableIcon />数据预览</TabsTrigger><TabsTrigger data-testid="mysql-table-structure-tab" value="structure"><ListBullets />表结构</TabsTrigger></TabsList></Tabs><span className="mysql-table-name" title={table}>{table}</span><WorkspaceIconButton action="refresh" label="刷新表结构" busy={loading} onClick={() => void refresh()} /></div>
      {error ? <div role="alert" className="mysql-browser-error" data-testid="mysql-structure-error">{error}<Button onClick={() => void refresh()} size="sm" variant="ghost">重试</Button></div> : null}
      {description?.auditWarning ? <p role="status" className="mysql-browser-error">表结构已读取，但操作记录未能保存。</p> : null}
      {tab === "structure" ? loading ? <p role="status">正在读取表结构…</p> : description ? <TableStructure description={description} /> : null : null}
    </> : null}
    <MysqlTableBrowser api={api} scope={scope} table={table} description={description} maxRows={maxRows} visible={visible && tab === "preview"} dragScope={dragScope} />
  </div>
}
