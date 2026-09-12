import { Copy, X } from "@phosphor-icons/react"
import { useEffect, useRef } from "react"

import type { MysqlQueryResult } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { mysqlCellText } from "@/features/database/mysql-workspace-model"

interface MysqlResultRowDetailProps {
  readonly columns: MysqlQueryResult["columns"]
  readonly row: Readonly<Record<string, unknown>>
  readonly rowNumber: number
  readonly prefix: string
  readonly id: string
  readonly onClose: () => void
  readonly onCopy: (text: string, description: string) => void
}

export function mysqlCopyCellText(value: unknown): string {
  return typeof value === "string" ? value : mysqlCellText(value)
}

export function MysqlResultRowDetail({ columns, row, rowNumber, prefix, id, onClose, onCopy }: MysqlResultRowDetailProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [rowNumber])

  function copyRow() {
    const values = Object.fromEntries(columns.map((column) => [column.name, row[column.name]]))
    onCopy(JSON.stringify(values, null, 2), "整行 JSON 已复制")
  }

  return (
    <aside
      aria-labelledby={`${id}-heading`}
      className="absolute inset-y-0 right-0 z-20 flex h-full min-h-0 w-[21.5rem] max-w-[80%] min-w-60 flex-col border-l bg-surface shadow-xl"
      data-testid={`${prefix}-row-detail`}
      id={id}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        onClose()
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <h3 className="text-xs font-medium" id={`${id}-heading`}>行详情</h3>
        <span className="text-xs tabular-nums text-muted-foreground">第 {rowNumber} 行</span>
        <Button aria-label="关闭行详情" className="ml-auto" data-testid={`${prefix}-close-detail`} onClick={onClose} ref={closeRef} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </header>
      <dl className="min-h-0 flex-1 overflow-auto px-3">
        {columns.map((column) => (
          <div className="border-b border-border/70 py-3 last:border-b-0" key={column.name}>
            <dt className="mb-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">{column.name}</span>
              <Button
                aria-label={`复制 ${column.name} 单元格`}
                className="shrink-0"
                data-column-name={column.name}
                data-testid={`${prefix}-copy-cell`}
                onClick={() => onCopy(mysqlCopyCellText(row[column.name]), "单元格已复制")}
                size="icon-xs"
                title="复制完整单元格"
                type="button"
                variant="ghost"
              >
                <Copy aria-hidden="true" className="size-3.5" />
              </Button>
            </dt>
            <dd className={`select-text whitespace-pre-wrap break-words font-mono text-xs leading-5 [overflow-wrap:anywhere] ${row[column.name] === null || row[column.name] === undefined ? "italic text-muted-foreground" : ""}`}>
              {mysqlCellText(row[column.name])}
            </dd>
          </div>
        ))}
      </dl>
      <footer className="shrink-0 border-t p-3">
        <Button className="w-full" data-testid={`${prefix}-copy-row`} onClick={copyRow} size="sm" title="复制整行 JSON" type="button" variant="outline">
          <Copy aria-hidden="true" className="size-3.5" />复制整行
        </Button>
      </footer>
    </aside>
  )
}
