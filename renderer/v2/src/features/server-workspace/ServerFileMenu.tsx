import { cloneElement, useEffect, useRef, useState, type HTMLAttributes, type ReactElement } from "react"
import { toast } from "sonner"
import type { AiOpsV2Api, PluginScope, ServerDirectoryEntry, ServerFileInfo, ServerFileActionPreparation, ServerFileActionResult } from "@/bridge/ai-ops-v2"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { copyText } from "@/lib/clipboard"
import { formatTransferBytes, parentRemotePath, serverEntryType, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"

type MenuTarget = { entry: ServerDirectoryEntry | null; directory: string }
type Action = { kind: "mkdir" | "rename"; path: string; name: string }
interface Props {
  api: AiOpsV2Api
  scope: PluginScope
  connected: boolean
  visible: boolean
  resolveTarget: (element: Element) => MenuTarget
  onSelect: (entry: ServerDirectoryEntry) => void
  onDownload: (entry: ServerDirectoryEntry) => void
  downloadBusy: boolean
  onRefresh: (path: string) => void
  onChanged: (result: ServerFileActionResult) => void
  children: ReactElement<HTMLAttributes<HTMLDivElement>>
}
const modified = (seconds: number) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(seconds * 1000)
const typeNames = { file: "文件", directory: "文件夹", symlink: "符号链接", special: "特殊文件" }

export function ServerFileMenu({ api, scope, connected, visible, resolveTarget, onSelect, onDownload, downloadBusy, onRefresh, onChanged, children }: Props) {
  const [target, setTarget] = useState<MenuTarget>({ entry: null, directory: "/" })
  const [dialog, setDialog] = useState<"info" | "action" | null>(null)
  const [info, setInfo] = useState<ServerFileInfo | null>(null)
  const [infoPath, setInfoPath] = useState("")
  const [action, setAction] = useState<Action | null>(null)
  const [prepared, setPrepared] = useState<ServerFileActionPreparation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const sequence = useRef(0)
  const busyRef = useRef(false)
  const preparedRef = useRef<ServerFileActionPreparation | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const cancelPrepared = () => {
    const current = preparedRef.current
    preparedRef.current = null
    if (current) void api.serverWorkspaceCancelFileAction({ ...scope, operationId: current.operationId }).catch(() => undefined)
  }
  const close = () => {
    sequence.current += 1
    cancelPrepared()
    setPrepared(null); setDialog(null); setError(""); setBusy(false); busyRef.current = false
  }
  useEffect(() => { if (!connected || !visible) close() }, [connected, visible])
  useEffect(() => () => { sequence.current += 1; cancelPrepared() }, [api, scope])
  const copy = (value: string) => { void copyText(value).then(() => toast.success("已复制"), () => toast.error("复制失败，请重试")) }
  const readInfo = async (selectedPath: string) => {
    const version = ++sequence.current
    setDialog("info"); setInfo(null); setInfoPath(selectedPath); setError(""); setBusy(true)
    try {
      const result = unwrapWorkspaceResult(await api.serverWorkspaceFileInfo({ ...scope, path: selectedPath }))
      if (sequence.current === version) setInfo(result)
    } catch (failure) { if (sequence.current === version) setError(workspaceErrorMessage(failure)) }
    finally { if (sequence.current === version) setBusy(false) }
  }
  const beginAction = (kind: Action["kind"]) => {
    close()
    setAction({ kind, path: kind === "rename" ? target.entry!.path : target.directory, name: kind === "rename" ? target.entry!.name : "" })
    setDialog("action")
  }
  const submit = async () => {
    if (!action || busyRef.current || !connected) return
    busyRef.current = true; setBusy(true); setError("")
    const version = ++sequence.current
    try {
      if (!prepared) {
        const result = unwrapWorkspaceResult(await api.serverWorkspacePrepareFileAction({ ...scope, ...action }))
        if (sequence.current !== version) {
          void api.serverWorkspaceCancelFileAction({ ...scope, operationId: result.operationId }).catch(() => undefined)
          return
        }
        preparedRef.current = result
        setPrepared(result)
      } else {
        const result = unwrapWorkspaceResult(await api.serverWorkspaceConfirmFileAction({ ...scope, operationId: prepared.operationId }))
        preparedRef.current = null
        if (sequence.current !== version) return
        close()
        onChanged(result)
        toast.success(result.kind === "mkdir" ? "已新建文件夹" : "已重命名")
      }
    } catch (failure) {
      if (sequence.current === version) {
        cancelPrepared(); setPrepared(null); setError(workspaceErrorMessage(failure))
        if (action) onRefresh(action.kind === "mkdir" ? action.path : parentRemotePath(action.path))
      }
    } finally { if (sequence.current === version) { busyRef.current = false; setBusy(false) } }
  }
  const selectTarget = (element: Element) => {
    const next = resolveTarget(element)
    setTarget(next)
    if (next.entry) onSelect(next.entry)
  }
  const trigger = cloneElement(children, {
    onContextMenuCapture: event => selectTarget(event.target as Element),
    onKeyDownCapture: event => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
      event.preventDefault(); event.stopPropagation()
      const element = event.target as HTMLElement
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 24, clientY: rect.top + Math.min(20, rect.height) }))
    },
  })
  const entry = target.entry
  return <>
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent aria-label="文件操作" onCloseAutoFocus={event => { if (dialogRef.current) event.preventDefault() }}>
        {entry ? <>
          <ContextMenuItem onSelect={() => copy(entry.name)}>复制名称</ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(entry.path)}>复制完整路径</ContextMenuItem>
          <ContextMenuItem disabled={!connected || downloadBusy || entry.type !== "file"} onSelect={() => onDownload(entry)}>下载</ContextMenuItem>
          <ContextMenuItem disabled={!connected} onSelect={() => { void readInfo(entry.path) }}>查看属性</ContextMenuItem>
          <ContextMenuSeparator />
        </> : <ContextMenuItem onSelect={() => copy(target.directory)}>复制当前目录路径</ContextMenuItem>}
        <ContextMenuItem disabled={!connected} onSelect={() => onRefresh(entry ? parentRemotePath(entry.path) : target.directory)}>刷新所在目录</ContextMenuItem>
        <ContextMenuItem disabled={!connected || Boolean(entry && !["directory", "file"].includes(serverEntryType(entry)))} onSelect={() => beginAction("mkdir")}>新建文件夹</ContextMenuItem>
        {entry ? <ContextMenuItem disabled={!connected || !["file", "directory"].includes(entry.type) || entry.path === "/"} onSelect={() => beginAction("rename")}>重命名</ContextMenuItem> : null}
      </ContextMenuContent>
    </ContextMenu>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !busyRef.current) close() }}>
      <DialogContent className="sm:max-w-[580px]" showCloseButton={!busyRef.current} onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault() }} onInteractOutside={event => { if (busyRef.current) event.preventDefault() }}>
        <DialogHeader><DialogTitle>{dialog === "info" ? "文件属性" : action?.kind === "mkdir" ? "新建文件夹" : "重命名"}</DialogTitle><DialogDescription>{dialog === "info" ? "显示服务器当前返回的属性，文件夹不递归计算总大小。" : prepared ? "请核对最终目标后确认。" : "名称仅用于当前目录，同名目标不会被覆盖。"}</DialogDescription></DialogHeader>
        {dialog === "info" ? <>
          <p className="break-all font-mono text-xs">{infoPath}</p>
          {busy ? <p role="status">正在读取属性…</p> : null}
          {info ? <dl className="server-file-properties">
            <dt>名称</dt><dd>{info.name}</dd><dt>类型</dt><dd>{typeNames[info.type]}</dd>
            <dt>大小</dt><dd>{info.type === "directory" ? "未计算目录总大小" : formatTransferBytes(info.size)}</dd>
            <dt>修改时间</dt><dd>{modified(info.mtime)}</dd><dt>权限</dt><dd>{(info.mode & 0o7777).toString(8).padStart(4, "0")}</dd>
            <dt>实际路径</dt><dd>{info.canonicalPath ?? "无法解析"}</dd>
            {info.type === "symlink" ? <><dt>链接状态</dt><dd>{info.linkTargetType === "unavailable" ? "目标不可用" : info.linkTargetType ? typeNames[info.linkTargetType] : "未知"}</dd></> : null}
          </dl> : null}
        </> : action ? <form id="server-file-action-form" className="space-y-3" onSubmit={event => { event.preventDefault(); void submit() }}>
          <p className="break-all font-mono text-xs">{action.path}</p>
          <label className="block space-y-2 text-sm"><span>{action.kind === "mkdir" ? "文件夹名称" : "新名称"}</span><Input aria-label={action.kind === "mkdir" ? "文件夹名称" : "新名称"} name="entry-name" autoComplete="off" spellCheck={false} autoFocus value={action.name} disabled={busy || Boolean(prepared)} onChange={event => setAction({ ...action, name: event.target.value })} /></label>
          {prepared ? <div className="space-y-2 text-sm"><p>目标：<code className="break-all">{prepared.destinationPath}</code></p>{prepared.canonicalDestination !== prepared.destinationPath ? <p>实际目标：<code className="break-all">{prepared.canonicalDestination}</code></p> : null}<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { cancelPrepared(); setPrepared(null) }}>修改名称</Button></div> : null}
        </form> : null}
        {error ? <p role="alert" className="text-sm text-danger break-words">{error}</p> : null}
        <DialogFooter><Button variant="outline" disabled={busyRef.current} onClick={close}>{dialog === "info" ? "关闭" : "取消"}</Button>{dialog === "info" ? <Button disabled={!connected || busy} onClick={() => { void readInfo(infoPath) }}>刷新属性</Button> : <Button form="server-file-action-form" type="submit" disabled={!connected || busy || !action?.name}>{busy ? "正在处理…" : !prepared ? "检查并继续" : action?.kind === "mkdir" ? "确认新建" : "确认重命名"}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
