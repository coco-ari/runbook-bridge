import { useState } from "react"
import { ArrowDown, ArrowRight, Copy, FileCode, FileText, FileXls, FileZip, FolderSimple, HardDrives, Laptop, SpinnerGap, UploadSimple, WarningCircle, X } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { AiOpsV2Api, PluginScope, ServerUploadPreparation } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatTransferBytes } from "./workspace-model"
import { ServerUploadDirectoryPicker } from "./ServerUploadDirectoryPicker"

export function UploadFileIcon({ name }: { readonly name: string }) {
  const Icon = /\.(xlsx?|csv)$/iu.test(name) ? FileXls : /\.(zip|tar|gz|tgz|jar|7z)$/iu.test(name) ? FileZip : /\.(json|ya?ml|conf|xml|sh|js|ts)$/iu.test(name) ? FileCode : FileText
  return <Icon size={23} weight="duotone" />
}

export function CopyUploadPath({ path, label = "复制目标路径" }: { readonly path: string; readonly label?: string }) {
  return <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" title={label} aria-label={label} onClick={() => { void navigator.clipboard.writeText(path).then(() => toast.success("已复制目标路径"), () => toast.error("复制失败，请手动选择路径复制")) }}><Copy size={14} /></Button>
}

interface Props {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly preparation: ServerUploadPreparation
  readonly serverName: string
  readonly projectName: string
  readonly environmentName: string
  readonly identity: string
  readonly busy: boolean
  readonly confirming: boolean
  readonly connected: boolean
  readonly needsReview: boolean
  readonly overwrite: boolean
  readonly error: string
  readonly onOverwrite: (value: boolean) => void
  readonly onRevise: (path: string, names: readonly string[]) => Promise<boolean>
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onReselect: () => void
}

export function ServerUploadDialog({ api, scope, preparation, serverName, projectName, environmentName, identity, busy, confirming, connected, needsReview, overwrite, error, onOverwrite, onRevise, onConfirm, onCancel, onReselect }: Props) {
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const files = preparation.files
  const existing = files.filter((file) => file.exists).length
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const sourcePath = preparation.sourcePath ?? preparation.path
  const revise = async (target: string, names = files.map((file) => file.name)) => {
    if (await onRevise(target, names)) setChoosingDirectory(false)
  }
  return <DialogContent className="server-upload-dialog sm:max-w-[680px]" showCloseButton={!busy} onInteractOutside={(event) => { if (busy) event.preventDefault() }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}>
    <DialogHeader className="pr-7"><DialogTitle>上传到服务器</DialogTitle><DialogDescription>核对文件和目标位置，然后开始上传。</DialogDescription></DialogHeader>
    <div className="server-upload-body">
    <div className="server-upload-route" aria-label="上传方向"><span><Laptop size={16} />本机</span><ArrowRight size={14} /><span><HardDrives size={16} />服务器</span><small>{files.length} 个文件 · {formatTransferBytes(bytes)}</small></div>
    <section className="server-upload-destination" aria-label="上传目标">
      <div className="server-upload-server"><HardDrives size={19} className="text-primary" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong>{serverName}</strong><Badge variant="outline">{environmentName}</Badge></div><p>{projectName} · {identity}</p></div></div>
      <div className="server-upload-folder"><FolderSimple size={24} weight="fill" className="server-icon-folder shrink-0" /><div className="min-w-0 flex-1"><span className="server-upload-field-label">目标文件夹</span><p data-testid="upload-destination-path">{preparation.path}</p></div><CopyUploadPath path={preparation.path} label="复制目标目录" /><Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => setChoosingDirectory((value) => !value)}>更换目录</Button></div>
      {sourcePath !== preparation.path ? <p className="server-upload-link-note">由 {sourcePath} 解析，文件将写入上方实际目录。</p> : null}
      {choosingDirectory ? <ServerUploadDirectoryPicker api={api} scope={scope} initialPath={sourcePath} busy={busy || !connected} onChoose={(target) => { void revise(target) }} onCancel={() => setChoosingDirectory(false)} /> : null}
    </section>
    <section className="server-upload-file-section" aria-label="待上传文件">
      <div className="server-upload-section-heading"><span>本机文件 <small>{files.length}</small></span><span>新增 {files.length - existing} 个{existing ? ` · 同名 ${existing} 个` : ""}</span></div>
      <ul className="server-upload-confirm-files" aria-busy={busy}>
        {files.map((file) => <li key={file.remotePath} className="server-upload-confirm-file" data-testid="upload-file-row"><div className="server-upload-file-icon"><UploadFileIcon name={file.name} /></div><div className="min-w-0 flex-1"><div className="server-upload-file-heading"><strong>{file.name}</strong><span>{formatTransferBytes(file.bytes)}</span><Badge variant={file.exists ? "warning" : "secondary"}>{file.exists ? "同名文件" : "新增"}</Badge></div><div className="server-upload-final-path"><ArrowDown size={12} className="shrink-0" /><span className="shrink-0">上传后</span><code>{file.remotePath}</code><CopyUploadPath path={file.remotePath} label={`复制 ${file.name} 的上传路径`} /></div></div><Button type="button" size="icon-sm" variant="ghost" disabled={busy || !connected} aria-label={`移除 ${file.name}`} title="从本次上传中移除" onClick={() => { void revise(sourcePath, files.filter((item) => item.name !== file.name).map((item) => item.name)) }}><X size={15} /></Button></li>)}
      </ul>
    </section>
    {existing > 0 ? <div className="server-upload-conflict"><WarningCircle size={18} className="shrink-0" /><div><strong>目标目录有 {existing} 个同名文件</strong><label><input type="checkbox" checked={overwrite} disabled={busy || needsReview || choosingDirectory} onChange={(event) => onOverwrite(event.target.checked)} />我确认覆盖这 {existing} 个同名文件的内容</label></div></div> : null}
    {error ? <div className="server-upload-review-error" role="alert"><p>{error}</p>{needsReview && !choosingDirectory ? <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => { void revise(sourcePath) }}>重新检查</Button> : null}{needsReview ? <Button size="sm" variant="ghost" disabled={busy || !connected} onClick={onReselect}>重新选择文件</Button> : null}</div> : null}
    </div>
    <DialogFooter className="server-upload-confirm-footer"><span className="server-upload-total">合计 {formatTransferBytes(bytes)}<small>{existing ? `新增 ${files.length - existing} 个，覆盖 ${existing} 个` : `${files.length} 个文件将上传到上方目录`}</small></span><div className="flex items-center justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button><Button disabled={!connected || busy || needsReview || choosingDirectory || Boolean(existing && !overwrite)} onClick={onConfirm}>{busy ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}{confirming ? "正在提交…" : busy ? "正在检查…" : `开始上传 ${files.length} 个文件`}</Button></div></DialogFooter>
  </DialogContent>
}
