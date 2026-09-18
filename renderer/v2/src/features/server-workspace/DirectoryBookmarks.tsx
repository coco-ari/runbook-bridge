import { useCallback, useEffect, useState } from "react"
import { Star, X } from "@phosphor-icons/react"
import type { PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { DIRECTORY_BOOKMARKS_CHANGED, directoryBookmarksKey, parseDirectoryBookmarks, updateDirectoryBookmark, validBookmarkPath } from "./directory-bookmarks"
import { workspaceErrorMessage } from "./workspace-model"

export function DirectoryBookmarks({ scope, path, connected, visible, onNavigate }: {
  readonly scope: PluginScope
  readonly path: string
  readonly connected: boolean
  readonly visible: boolean
  readonly onNavigate: (path: string) => void
}) {
  const key = directoryBookmarksKey(scope)
  const [open, setOpen] = useState(false)
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState("")
  const refresh = useCallback(() => {
    try { setPaths(parseDirectoryBookmarks(localStorage.getItem(key))); setError("") }
    catch { setError("无法读取本机目录收藏，请检查本地存储后重试。") }
  }, [key])
  useEffect(() => {
    refresh()
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh() }
    const onChanged = (event: Event) => { if ((event as CustomEvent<string>).detail === key) refresh() }
    window.addEventListener("storage", onStorage)
    window.addEventListener(DIRECTORY_BOOKMARKS_CHANGED, onChanged)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(DIRECTORY_BOOKMARKS_CHANGED, onChanged)
    }
  }, [key, refresh])
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  const change = (target: string, add: boolean) => {
    try {
      setPaths(updateDirectoryBookmark(localStorage, key, target, add))
      setError("")
      window.dispatchEvent(new CustomEvent(DIRECTORY_BOOKMARKS_CHANGED, { detail: key }))
    } catch (failure) {
      setError(failure instanceof Error && failure.name === "Error" ? workspaceErrorMessage(failure) : "收藏未保存，请检查本机存储空间或权限后重试。")
    }
  }
  const saved = paths.includes(path)
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value) refresh() }}>
    <PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="常用目录" title="常用目录"><Star weight={saved ? "fill" : "regular"} /></Button></PopoverTrigger>
    <PopoverContent align="end" className="server-directory-bookmarks" aria-label="常用目录">
      <div className="flex items-center justify-between"><PopoverTitle>常用目录</PopoverTitle><span className="text-xs text-muted-foreground">{paths.length} / 20</span></div>
      <div className="server-bookmark-current"><code title={path}>{path}</code>
        <Button size="sm" variant="outline" disabled={!connected || !validBookmarkPath(path)} onClick={() => change(path, !saved)}><Star weight={saved ? "fill" : "regular"} />{saved ? "取消收藏当前目录" : "收藏当前目录"}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger break-words">{error}</p> : null}
      {paths.length ? <ul className="server-bookmark-list">{paths.map(target => <li key={target}>
        <button type="button" className="server-bookmark-link" disabled={!connected} title={target} aria-label={"打开收藏目录 " + target} onClick={() => { setOpen(false); onNavigate(target) }}><code>{target}</code></button>
        <Button size="icon-sm" variant="ghost" aria-label={"移除收藏 " + target} title="移除收藏" onClick={() => change(target, false)}><X /></Button>
      </li>)}</ul> : <p className="py-2 text-xs text-muted-foreground">收藏常用的日志、配置或部署目录，方便下次打开。</p>}
      <p className="text-[11px] text-muted-foreground">{connected ? "收藏仅保存在本机，按服务器分别管理。" : "服务器已断开，重新连接后可打开收藏目录。"}</p>
    </PopoverContent>
  </Popover>
}
