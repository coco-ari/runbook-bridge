import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

interface GuardState { readonly dirty: boolean; readonly busy: boolean; readonly uncertain?: boolean; readonly transaction?: boolean; readonly discard?: () => void | Promise<void> }
interface EditingContext {
  readonly hasEditing: boolean
  setEditing(key: string, value: boolean): void
  readonly connectionEpoch: number
  readonly connected: boolean
  register(key: string, inspect: () => GuardState): () => void
  protect(action: () => void, keys?: readonly string[], options?: { preserveTransactions?: boolean }): void
}
const Context = createContext<EditingContext>({
  connectionEpoch: 0, hasEditing: false, setEditing: () => {}, connected: true,
  register: () => () => {},
  protect: action => action(),
})

export function MysqlEditingProvider({ connected, connectionEpoch, onEditingChange, children }: { readonly connected: boolean; readonly connectionEpoch: number; readonly onEditingChange: (value: boolean) => void; readonly children: ReactNode }) {
  const guards = useRef(new Map<string, () => GuardState>())
  const [editing, setEditing] = useState(new Set<string>())
  const [pending, setPending] = useState<{ action: () => void; count: number; uncertain: boolean; transaction: boolean; discard: () => Promise<void> } | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const methods = useMemo(() => ({
    setEditing(key: string, value: boolean) { setEditing(current => { const next = new Set(current); if (value) next.add(key); else next.delete(key); return next }) },
    register(key: string, inspect: () => GuardState) {
      guards.current.set(key, inspect)
      return () => { if (guards.current.get(key) === inspect) guards.current.delete(key) }
    },
    protect(action: () => void, keys?: readonly string[], options?: { preserveTransactions?: boolean }) {
      const entries = [...guards.current].filter(([key]) => !keys || keys.includes(key)).map(([, inspect]) => inspect()).filter(entry => !options?.preserveTransactions || !entry.transaction)
      if (entries.some(entry => entry.busy)) { toast.info("正在读取或保存数据，请等待结果。"); return }
      const count = entries.filter(entry => entry.dirty).length
      if (count) setPending({ action, count, uncertain: entries.some(entry => entry.uncertain), transaction: entries.some(entry => entry.transaction && entry.dirty), discard: async () => { for (const entry of entries) await entry.discard?.() } })
      else action()
    },
  }), [])
  useEffect(() => { onEditingChange(editing.size > 0); return () => onEditingChange(false) }, [editing.size, onEditingChange])
  const context = { ...methods, connected, connectionEpoch, hasEditing: editing.size > 0 }
  return <Context.Provider value={context}>
    {children}
    <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open && !discarding) setPending(null) }}>
      <DialogContent data-testid="mysql-edit-discard-dialog">
        <DialogHeader><DialogTitle>{pending?.uncertain ? "提交结果尚未确认" : pending?.transaction ? "还有未提交的事务" : "还有未保存的修改"}</DialogTitle><DialogDescription>{pending?.uncertain ? "服务器可能已经完成写入。继续操作会放弃本地草稿并结束本次状态跟踪，不会撤销服务器操作；重新查询后请核实数据，勿直接重复提交。" : pending?.transaction ? "继续操作会回滚未提交的事务，并放弃相关标签的本地修改。已提交的语句不会撤销。" : `${pending?.count} 个数据标签有修改。继续操作会放弃相关草稿，尚未提交的更改不会写入数据库。`}</DialogDescription></DialogHeader>
        <DialogFooter><Button disabled={discarding} variant="outline" onClick={() => setPending(null)}>返回并保留</Button><Button disabled={discarding} variant="destructive" data-testid="mysql-edit-discard-confirm" onClick={() => { if (!pending) return; setDiscarding(true); void pending.discard().then(() => { setPending(null); pending.action() }).catch(error => toast.error(error instanceof Error ? error.message : "释放事务失败，请重试。" )).finally(() => setDiscarding(false)) }}>{discarding ? "正在处理…" : pending?.uncertain ? "结束跟踪并继续" : pending?.transaction ? "回滚并继续" : "放弃修改并继续"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Context.Provider>
}
export const useMysqlEditingGuard = () => useContext(Context)
