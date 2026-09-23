import { WorkspaceNotice } from "@/components/workspace/WorkspaceNotice"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { CaretDown, CaretRight, Crosshair, DotsThree, FolderSimple, FolderOpen, Key, ListBullets, MagnifyingGlass, TreeStructure } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { buildRedisKeyTree, defaultRedisTreeExpansion, redisKeyAncestors, redisKeyTreeRows, type RedisKeyTreeNode } from "./redis-key-tree"

interface Props {
  readonly keys: readonly string[]
  readonly activeKey: string | undefined
  readonly keyword: string
  readonly queryKey: string
  readonly loading: boolean
  readonly complete: boolean
  readonly error: string
  readonly onOpen: (key: string, pinned?: boolean) => void
  readonly identity: ReactNode
  readonly search: ReactNode
  readonly visible: boolean
  readonly refreshDisabled: boolean
  readonly onRefresh: () => void
  readonly onSearchFolder: (prefix: string) => void
}

function Highlight({ text, keyword }: { readonly text: string; readonly keyword: string }) {
  const index = keyword ? text.indexOf(keyword) : -1
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + keyword.length)}</mark>{text.slice(index + keyword.length)}</>
}

export function RedisKeyBrowser({ keys, activeKey, keyword, queryKey, loading, complete, error, onOpen, identity, search, visible, refreshDisabled, onRefresh, onSearchFolder }: Props) {
  const tree = useMemo(() => buildRedisKeyTree(keys), [keys])
  const defaults = useMemo(() => defaultRedisTreeExpansion(tree, Boolean(keyword)), [tree, keyword])
  const [view, setView] = useState<"tree" | "list">("tree")
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [focusedId, setFocusedId] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextFolder, setContextFolder] = useState<string | null>(null)
  const menuAction = useRef<"locate" | "search" | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const scroll = useRef<HTMLDivElement>(null)
  const expanded = (id: string) => overrides.get(id) ?? defaults.has(id)
  const rows = view === "tree" ? redisKeyTreeRows(tree, expanded) : keys.map((key, index) => ({ node: tree.nodes.get("key:" + key)!, position: index + 1, siblingCount: keys.length }))
  const focused = rows.find((row) => row.node.id === focusedId)?.node
  const tabStop = focused?.id ?? rows.find((row) => row.node.key === activeKey)?.node.id ?? rows[0]?.node.id
  const selectedPath = focused?.path ?? activeKey ?? ""
  const canLocate = Boolean(activeKey && tree.nodes.has("key:" + activeKey))

  useEffect(() => { if (!visible) { setMenuOpen(false); setContextFolder(null); menuAction.current = null } }, [visible])

  useEffect(() => {
    setOverrides(new Map())
    setFocusedId("")
    setContextFolder(null)
    if (scroll.current) scroll.current.scrollTop = 0
  }, [queryKey])

  useEffect(() => {
    if (!tree.nodes.size) return
    setOverrides((current) => {
      const retained = new Map([...current].filter(([id]) => tree.nodes.has(id)))
      return retained.size === current.size ? current : retained
    })
  }, [tree])

  function toggle(node: RedisKeyTreeNode) {
    setOverrides((current) => new Map(current).set(node.id, !expanded(node.id)))
  }
  function focus(id: string) {
    setFocusedId(id)
    requestAnimationFrame(() => {
      const button = buttons.current.get(id)
      button?.focus({ preventScroll: true })
      button?.scrollIntoView({ block: "nearest", inline: "nearest" })
    })
  }
  function locate() {
    if (!activeKey || !canLocate) return
    setOverrides((current) => {
      const next = new Map(current)
      for (const id of redisKeyAncestors(tree, activeKey)) next.set(id, true)
      return next
    })
    menuAction.current = "locate"
    setFocusedId("key:" + activeKey)
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, node: RedisKeyTreeNode, index: number) {
    let target: string | undefined
    if (event.key === "ArrowDown") target = rows[Math.min(rows.length - 1, index + 1)]?.node.id
    else if (event.key === "ArrowUp") target = rows[Math.max(0, index - 1)]?.node.id
    else if (event.key === "Home") target = rows[0]?.node.id
    else if (event.key === "End") target = rows.at(-1)?.node.id
    else if (view === "tree" && event.key === "ArrowRight" && node.kind === "folder") {
      if (!expanded(node.id)) toggle(node)
      else target = node.children[0]?.id
    } else if (view === "tree" && event.key === "ArrowLeft") {
      if (node.kind === "folder" && expanded(node.id)) toggle(node)
      else target = node.parentId ?? undefined
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && node.key !== null) onOpen(node.key, true)
    else return
    event.preventDefault()
    if (target) focus(target)
  }

  return <>
    <div className="redis-browser-header" data-testid="redis-browser-header">
      <div className="redis-browser-toolbar">
        {identity}
        <div className="redis-browser-actions">
          <WorkspaceIconButton action="refresh" label="重新扫描 Key" busy={loading} disabled={refreshDisabled} data-testid="redis-refresh-keys" onClick={onRefresh} />
          <Button size="icon-xs" variant="ghost" aria-label={view === "tree" ? "切换为列表视图" : "切换为目录视图"} title={view === "tree" ? "当前按 : 分组，点击显示完整 Key 列表" : "当前为列表，点击按 : 分组"} data-testid="redis-browser-view-toggle" data-view={view} onClick={() => setView(view === "tree" ? "list" : "tree")}>
            {view === "tree" ? <TreeStructure /> : <ListBullets />}
          </Button>
          <DropdownMenu open={menuOpen && visible} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" aria-label="Key 浏览工具" title="Key 浏览工具" data-testid="redis-browser-menu"><DotsThree weight="bold" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent className="w-44" align="end" onCloseAutoFocus={(event) => {
              const action = menuAction.current
              menuAction.current = null
              if (!visible) { event.preventDefault(); return }
              if (action) {
                event.preventDefault()
                if (action === "locate" && activeKey) focus("key:" + activeKey)
              }
            }}>
              <DropdownMenuItem disabled={!canLocate} data-testid="redis-tree-locate" onSelect={locate}><Crosshair />定位当前 Key</DropdownMenuItem>
              <DropdownMenuItem disabled={focused?.kind !== "folder"} data-testid="redis-tree-search-folder" onSelect={() => {
                if (focused?.kind === "folder") { menuAction.current = "search"; onSearchFolder(focused.path) }
              }}><MagnifyingGlass />搜索所选目录</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={view !== "tree" || !tree.folders.length} data-testid="redis-tree-expand-all" onSelect={() => setOverrides(new Map(tree.folders.map((node) => [node.id, true])))}><FolderOpen />展开全部目录</DropdownMenuItem>
              <DropdownMenuItem disabled={view !== "tree" || !tree.folders.length} data-testid="redis-tree-collapse-all" onSelect={() => setOverrides(new Map(tree.folders.map((node) => [node.id, false])))}><FolderSimple />折叠全部目录</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {search}
    </div>
    {error ? <WorkspaceNotice variant="destructive" data-testid="redis-scan-error">{error}</WorkspaceNotice> : null}
    <ContextMenu onOpenChange={(open) => { if (!open) setContextFolder(null) }}>
    <ContextMenuTrigger asChild disabled={!visible}>
    <div ref={scroll} className="redis-key-list" data-testid="redis-key-list" aria-busy={loading}
      onContextMenuCapture={(event) => {
        const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-redis-folder]")?.dataset.redisFolder
        if (folder === undefined) { event.preventDefault(); return }
        setContextFolder(folder); setFocusedId("folder:" + folder)
      }}>
      {rows.length ? <div role="tree" aria-label={view === "tree" ? "Redis Key 目录" : "Redis Key 列表"} className="redis-key-tree">
        {rows.map(({ node, position, siblingCount }, index) => {
          const folder = node.kind === "folder"
          const open = folder && expanded(node.id)
          return <button type="button" role="treeitem" key={node.id} className="redis-key-row redis-tree-row"
            ref={(button) => { if (button) buttons.current.set(node.id, button); else buttons.current.delete(node.id) }}
            aria-level={view === "tree" ? node.depth + 1 : 1} aria-posinset={position} aria-setsize={siblingCount}
            aria-expanded={folder ? open : undefined} aria-selected={node.key !== null && node.key === activeKey}
            aria-label={folder ? node.path + "，已加载 " + node.count + " 个 Key" : node.path}
            tabIndex={node.id === tabStop ? 0 : -1} title={folder ? node.path + " · 已加载 " + node.count + " 个 Key" : node.path}
            style={{ paddingLeft: 12 + (view === "tree" ? Math.min(node.depth, 8) * 18 : 0) }}
            data-redis-key={node.key ?? undefined} data-redis-folder={folder ? node.path : undefined}
            onFocus={() => setFocusedId(node.id)}
            onClick={(event) => { if (event.detail > 1) return; setFocusedId(node.id); if (folder) toggle(node); else if (node.key !== null) onOpen(node.key) }}
            onDoubleClick={() => { if (node.key !== null) onOpen(node.key, true) }}
            onKeyDown={(event) => keyDown(event, node, index)}>
            {folder ? <>{open ? <CaretDown className="redis-tree-chevron" /> : <CaretRight className="redis-tree-chevron" />}{open ? <FolderOpen className="redis-tree-folder" weight="fill" /> : <FolderSimple className="redis-tree-folder" weight="fill" />}</>
              : <><span className="redis-tree-chevron" /><Key className="redis-tree-key" /></>}
            <span className="redis-tree-label"><Highlight text={node.label} keyword={keyword} /></span>
            {folder ? <span className="redis-tree-count" aria-hidden="true">{node.count}</span> : null}
          </button>
        })}
      </div> : <div className="redis-empty">{loading ? "正在扫描…" : error ? "扫描失败，可重新扫描。" : complete ? "本轮扫描没有匹配的 Key" : "尚未找到匹配项，扫描未完成。"}</div>}
    </div>
    </ContextMenuTrigger>
    {visible && contextFolder !== null ? <ContextMenuContent onCloseAutoFocus={(event) => {
      event.preventDefault()
      if (menuAction.current !== "search" && visible) focus("folder:" + contextFolder)
      menuAction.current = null
    }}>
      <ContextMenuItem data-testid="redis-folder-search" onSelect={() => { menuAction.current = "search"; onSearchFolder(contextFolder) }}><MagnifyingGlass />搜索此目录下的 Key</ContextMenuItem>
    </ContextMenuContent> : null}
    </ContextMenu>
    <div className="redis-browser-path" title={selectedPath || "单击目录展开，双击 Key 固定标签"} data-testid="redis-browser-path">{selectedPath || "单击目录展开，双击 Key 固定标签"}</div>
  </>
}
