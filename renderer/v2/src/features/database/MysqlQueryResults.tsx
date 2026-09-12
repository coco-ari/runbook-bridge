import { CaretLeft, CaretRight, WarningCircle } from "@phosphor-icons/react"
import { useState } from "react"

import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MYSQL_RESULT_PAGE_SIZE, mysqlByteSize, mysqlCellText } from "@/features/database/mysql-workspace-model"

interface MysqlQueryResultsProps {
  readonly result: MysqlQueryResult
  readonly kind: "query" | "preview"
}

export function MysqlQueryResults({ result, kind }: MysqlQueryResultsProps) {
  const [page, setPage] = useState(0)
  const lastPage = Math.max(0, Math.ceil(result.rows.length / MYSQL_RESULT_PAGE_SIZE) - 1)
  const visiblePage = Math.min(page, lastPage)
  const start = visiblePage * MYSQL_RESULT_PAGE_SIZE
  const rows = result.rows.slice(start, start + MYSQL_RESULT_PAGE_SIZE)
  const prefix = `mysql-${kind}`
  const duplicateColumns = new Set(result.columns.map((column) => column.name)).size !== result.columns.length

  return (
    <section aria-label={kind === "preview" ? "数据预览结果" : "SQL 查询结果"} className="min-w-0 space-y-3" data-testid={`${prefix}-result`}>
      <p aria-live="polite" className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground" data-testid={`${prefix}-summary`}>
        <span>返回 {result.rowCount} 行</span>
        <span>耗时 {Math.round(result.durationMs)} ms</span>
        <span>{mysqlByteSize(result.bytes)}</span>
      </p>
      {result.truncated ? (
        <Alert data-testid={`${prefix}-truncated`}>
          <WarningCircle aria-hidden="true" />
          <AlertTitle>结果已截断</AlertTitle>
          <AlertDescription>
            仅展示已返回的数据。当前最多返回 {result.limitsApplied.maxRows} 行、{mysqlByteSize(result.limitsApplied.maxBytes)}；可使用 WHERE 条件缩小查询范围。
          </AlertDescription>
        </Alert>
      ) : null}
      {result.auditWarning ? (
        <Alert data-testid={`${prefix}-audit-warning`}>
          <WarningCircle aria-hidden="true" />
          <AlertTitle>操作记录写入失败</AlertTitle>
          <AlertDescription>查询已完成，但本次操作记录未能保存。请检查本机存储空间和权限。</AlertDescription>
        </Alert>
      ) : null}
      {duplicateColumns ? (
        <Alert data-testid={`${prefix}-duplicate-columns`}>
          <WarningCircle aria-hidden="true" />
          <AlertTitle>查询返回了重名列</AlertTitle>
          <AlertDescription>重名列的数据无法完整区分，暂不展示表格。请使用 AS 为每一列设置不同的别名后重新查询。</AlertDescription>
        </Alert>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-lg border">
          <div aria-label="查询结果表格，可横向滚动" className="max-h-[30rem] overflow-auto" role="region" tabIndex={0}>
            <Table className="text-xs">
              <TableHeader className="sticky top-0 z-10 bg-surface-inset">
                <TableRow>
                  <TableHead className="w-12 text-right text-muted-foreground" scope="col"><span className="sr-only">行号</span>#</TableHead>
                  {result.columns.map((column, index) => (
                    <TableHead key={`${column.name}:${index}`} scope="col" title={column.table ? `${column.table}.${column.name}` : column.name}>
                      <span className="font-mono">{column.name}</span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? rows.map((row, rowIndex) => (
                  <TableRow key={start + rowIndex}>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{start + rowIndex + 1}</TableCell>
                    {result.columns.map((column, columnIndex) => (
                      <TableCell className="align-top font-mono" key={`${column.name}:${columnIndex}`}>
                        <span className={`block max-h-28 max-w-96 overflow-auto whitespace-pre-wrap break-all ${row[column.name] === null || row[column.name] === undefined ? "text-muted-foreground italic" : ""}`}>
                          {mysqlCellText(row[column.name])}
                        </span>
                      </TableCell>
                    ))}
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell className="h-24 text-center text-muted-foreground" colSpan={Math.max(1, result.columns.length + 1)}>
                      查询成功，没有符合条件的数据。
                    </TableCell>
                  </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      )}
      {!duplicateColumns && lastPage > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>显示第 {start + 1} 至 {start + rows.length} 行，共返回 {result.rows.length} 行</span>
          <div className="flex items-center gap-2">
            <Button aria-label="上一页结果" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)} size="sm" type="button" variant="outline">
              <CaretLeft aria-hidden="true" />上一页
            </Button>
            <Button aria-label="下一页结果" data-testid={`${prefix}-next-page`} disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)} size="sm" type="button" variant="outline">
              下一页<CaretRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
