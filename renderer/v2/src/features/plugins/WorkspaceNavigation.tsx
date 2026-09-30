import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { GearSix, Stack } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { PluginWorkspaceEntry } from "./workspace-registry"

const typeLabels: Readonly<Record<string, string>> = {server: "服务器", mysql: "MySQL", redis: "Redis"}

type Actions = {navigate: (action: () => void, reason: "switch" | "configure") => void; close: () => void}
const NavigationContext = createContext<{entries: readonly PluginWorkspaceEntry[]; manage: () => void; configure: (entry: PluginWorkspaceEntry) => void; register: (key: string, actions: Actions | null) => void} | null>(null)
const EntryContext = createContext<PluginWorkspaceEntry | null>(null)

export function WorkspaceEntryProvider({entry, children}: {entry: PluginWorkspaceEntry; children: ReactNode}) {
  return <EntryContext.Provider value={entry}>{children}</EntryContext.Provider>
}

export function useWorkspaceNavigationActions(actions: Actions) {
  const navigation = useContext(NavigationContext), entry = useContext(EntryContext)
  const latest = useRef(actions)
  latest.current = actions
  const register = navigation?.register, key = entry?.key
  useEffect(() => {
    if (!register || !key) return
    register(key, {navigate: (action, reason) => latest.current.navigate(action, reason), close: () => latest.current.close()})
    return () => register(key, null)
  }, [register, key])
}

export function WorkspaceNavigationProvider({entries, activeKey, onSelect, onConfigure, children}: {
  entries: readonly PluginWorkspaceEntry[]; activeKey: string | null
  onSelect: (entry: PluginWorkspaceEntry) => void; onConfigure: (entry: PluginWorkspaceEntry) => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pendingAction = useRef<(() => void) | null>(null)
  const handoff = (action: () => void) => { pendingAction.current = action; setOpen(false) }
  const actions = useRef(new Map<string, Actions>())
  const register = useCallback((key: string, value: Actions | null) => { if (value) actions.current.set(key, value); else actions.current.delete(key) }, [])
  const configure = useCallback((entry: PluginWorkspaceEntry) => {
    actions.current.get(entry.key)?.navigate(() => onConfigure(entry), "configure")
  }, [onConfigure])
  const value = useMemo(() => ({entries, register, configure, manage: () => setOpen(true)}), [entries, register, configure])
  return <NavigationContext.Provider value={value}>{children}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={event => { const action = pendingAction.current; pendingAction.current = null; if (action) { event.preventDefault(); requestAnimationFrame(action) } }} className="sm:max-w-2xl" data-testid="workspace-manager"><DialogHeader><DialogTitle>已打开的工作区（{entries.length}）</DialogTitle><DialogDescription>查看当前应用中保留的工作区。切换不会自动连接；关闭前会提示需要处理的草稿或任务。</DialogDescription></DialogHeader>
      <div className="max-h-[60dvh] space-y-2 overflow-y-auto">
        {!entries.length ? <p className="p-4 text-sm text-muted-foreground">尚未打开工作区，可从插件详情或环境详情打开。</p> : entries.map(entry => <div key={entry.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border p-3" data-workspace-session={entry.key}>
          <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{entry.plugin.displayName}{entry.key === activeKey ? " · 当前" : ""}</p><p className="break-all text-xs text-muted-foreground">{entry.projectName} / {entry.environmentName} · {typeLabels[entry.type] ?? entry.type} · {entry.connected ? "已连接" : "离线"}</p>{entry.dirty ? <p className="text-xs text-warning">有草稿或待处理操作</p> : null}</div>
          <Button size="xs" variant="outline" data-workspace-resume={entry.scope.pluginInstanceId} onClick={() => {
            handoff(() => {
              if (entry.key === activeKey) return
              const run = () => onSelect(entry), current = activeKey ? actions.current.get(activeKey) : null
              if (current) current.navigate(run, "switch"); else run()
            })
          }}>继续工作区</Button>
          <Button size="xs" variant="ghost" aria-label={"关闭 " + entry.plugin.displayName + " 工作区"} data-workspace-close={entry.scope.pluginInstanceId} onClick={() => handoff(() => actions.current.get(entry.key)?.close())}>关闭</Button>
        </div>)}
      </div>
    </DialogContent></Dialog>
  </NavigationContext.Provider>
}

export function WorkspaceSwitcherButton({className, variant = "ghost", labelLayout = variant === "outline" ? "split" : "inline"}: {
  readonly className?: string
  readonly variant?: "ghost" | "outline"
  readonly labelLayout?: "inline" | "split" | "compact"
}) {
  const navigation = useContext(NavigationContext)
  return navigation ? <Button className={className} size="sm" variant={variant} type="button" data-testid="workspace-switcher" aria-label={`管理已打开的工作区，${navigation.entries.length} 项`} title={`查看、切换或关闭已打开的工作区，当前 ${navigation.entries.length} 项`} onClick={navigation.manage}>
    <Stack aria-hidden="true" />
    {labelLayout === "compact" ? <>
      <span data-utility-label>工作区</span>
      {navigation.entries.length > 0 ? <span aria-hidden="true" className="min-w-3.5 shrink-0 rounded-sm bg-muted px-0.5 text-center text-[10px] leading-4 text-muted-foreground tabular-nums" data-utility-count>{navigation.entries.length > 9 ? "9+" : navigation.entries.length}</span> : null}
    </> : labelLayout === "split" ? <><span className="min-w-0 flex-1 truncate text-left">工作区</span><span className="min-w-4 shrink-0 text-center tabular-nums text-muted-foreground">{navigation.entries.length}</span></> : <span className="truncate">工作区 {navigation.entries.length}</span>}
  </Button> : null
}

export function useWorkspaceConfigure() {
  const navigation = useContext(NavigationContext), entry = useContext(EntryContext)
  return navigation && entry ? () => navigation.configure(entry) : undefined
}

export function WorkspaceConfigureButton() {
  const configure = useWorkspaceConfigure()
  return configure ? <Button size="icon-sm" variant="ghost" aria-label="连接配置" title="修改当前插件的连接配置" data-testid="workspace-connection-settings" onClick={configure}><GearSix /></Button> : null
}
