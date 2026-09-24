import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

interface GuardState { readonly dirty: boolean; readonly busy: boolean; readonly discard?: () => void }
interface EditingContext {
  readonly hasEditing: boolean
  setEditing(key: string, value: boolean): void
  readonly connectionEpoch: number
  readonly connected: boolean
  register(key: string, inspect: () => GuardState): () => void
  protect(action: () => void, keys?: readonly string[]): void
}
const Context = createContext<EditingContext>({
  connectionEpoch: 0, hasEditing: false, setEditing: () => {}, connected: true,
  register: () => () => {},
  protect: action => action(),
})

export function MysqlEditingProvider({ connected, connectionEpoch, onEditingChange, children }: { readonly connected: boolean; readonly connectionEpoch: number; readonly onEditingChange: (value: boolean) => void; readonly children: ReactNode }) {
  const guards = useRef(new Map<string, () => GuardState>())
  const [editing, setEditing] = useState(new Set<string>())
  const [pending, setPending] = useState<{ action: () => void; count: number; discard: () => void } | null>(null)
  const methods = useMemo(() => ({
    setEditing(key: string, value: boolean) { setEditing(current => { const next = new Set(current); if (value) next.add(key); else next.delete(key); return next }) },
    register(key: string, inspect: () => GuardState) {
      guards.current.set(key, inspect)
      return () => { if (guards.current.get(key) === inspect) guards.current.delete(key) }
    },
    protect(action: () => void, keys?: readonly string[]) {
      const entries = [...guards.current].filter(([key]) => !keys || keys.includes(key)).map(([, inspect]) => inspect())
      if (entries.some(entry => entry.busy)) { toast.info("正在读取或保存数据，请等待结果。"); return }
      const count = entries.filter(entry => entry.dirty).length
      if (count) setPending({ action, count, discard: () => entries.forEach(entry => entry.discard?.()) })
      else action()
    },
  }), [])
  useEffect(() => { onEditingChange(editing.size > 0); return () => onEditingChange(false) }, [editing.size, onEditingChange])
  const context = { ...methods, connected, connectionEpoch, hasEditing: editing.size > 0 }
  return <Context.Provider value={context}>
    {children}
    <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open) setPending(null) }}>
      <DialogContent data-testid="mysql-edit-discard-dialog">
        <DialogHeader><DialogTitle>还有未保存的修改</DialogTitle><DialogDescription>{pending?.count} 个数据标签有修改。继续操作会放弃相关草稿，数据库中的数据尚未改变。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setPending(null)}>保留修改</Button><Button variant="destructive" data-testid="mysql-edit-discard-confirm" onClick={() => { const action = pending?.action; pending?.discard(); setPending(null); action?.() }}>放弃修改并继续</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Context.Provider>
}
export const useMysqlEditingGuard = () => useContext(Context)
