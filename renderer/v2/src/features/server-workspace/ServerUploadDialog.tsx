import { ArrowRight, Copy, FileCode, FileText, FileXls, FileZip, SpinnerGap, UploadSimple, WarningCircle, X } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { ServerUploadReview } from "@/bridge/ai-ops-v2"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { copyText } from "@/lib/clipboard"
import { formatTransferBytes } from "./workspace-model"

export function UploadFileIcon({ name }: { readonly name: string }) {
  const Icon = /\.(xlsx?|csv)$/iu.test(name) ? FileXls : /\.(zip|tar|gz|tgz|jar|7z)$/iu.test(name) ? FileZip : /\.(json|ya?ml|conf|xml|sh|js|ts)$/iu.test(name) ? FileCode : FileText
  return <Icon size={23} weight="duotone" />
}

export function CopyUploadPath({ path, label = "复制目标路径" }: { readonly path: string; readonly label?: string }) {
  return <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" title={label} aria-label={label} onClick={() => { void copyText(path).then(() => toast.success("已复制路径"), () => toast.error("复制失败，请手动选择路径复制")) }}><Copy size={14} /></Button>
}

interface Props {
  readonly preparation: ServerUploadReview
  readonly serverName: string
  readonly environmentName: string
  readonly identity: string
  readonly busy: boolean
  readonly confirming: boolean
  readonly removing: boolean
  readonly connected: boolean
  readonly needsReview: boolean
  readonly overwrite: boolean
  readonly error: string
  readonly onOverwrite: (value: boolean) => void
  readonly onRevise: (names: readonly string[]) => Promise<boolean>
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onReselect: () => void
}

export function ServerUploadDialog({ preparation, serverName, environmentName, identity, busy, confirming, removing, connected, needsReview, overwrite, error, onOverwrite, onRevise, onConfirm, onCancel, onReselect }: Props) {
  const checking = preparation.status === "checking"
  const ready = preparation.status === "ready" && Boolean(preparation.preparationId)
  const progress = preparation.progress
  const files = preparation.files
  const existing = files.filter((file) => file.exists).length
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const sourcePath = preparation.sourcePath ?? preparation.path
  return <DialogContent className="server-upload-dialog sm:max-w-[780px]" showCloseButton={!busy} onInteractOutside={(event) => { if (busy) event.preventDefault() }} onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}>
    <DialogHeader className="pr-7">
      <DialogTitle>{preparation.resume ? "继续上传" : "上传到服务器"}</DialogTitle>
      <DialogDescription className="server-upload-context"><span>{serverName} · {environmentName}</span><span>{identity}</span></DialogDescription>
    </DialogHeader>
    <div className="server-upload-body">
      <ul className="server-upload-confirm-files" aria-label="待上传文件" aria-busy={busy || checking}>
        {files.map((file) => <li key={file.remotePath} className="server-upload-confirm-file" data-testid="upload-file-row">
          <div className="server-upload-file-route">
            <div className="server-upload-path"><span className="server-upload-field-label">本地文件</span><div><code data-testid="upload-source-path">{file.localPath}</code><CopyUploadPath path={file.localPath} label={`复制 ${file.name} 的本地路径`} /></div></div>
            <ArrowRight size={20} className="server-upload-path-arrow" aria-label="上传到" />
            <div className="server-upload-path server-upload-target-path"><span className="server-upload-field-label">目标目录</span><div><code data-testid="upload-destination-path">{preparation.path}</code><CopyUploadPath path={preparation.path} label={`复制 ${file.name} 的目标目录`} /></div></div>
          </div>
          <div className="server-upload-file-meta"><strong>{formatTransferBytes(file.bytes)}</strong>{file.exists ? <Badge variant="warning">同名文件</Badge> : null}<Button type="button" size="icon-sm" variant="ghost" disabled={busy || checking || !connected || Boolean(preparation.resume)} aria-label={`移除 ${file.name}`} title="从本次上传中移除" onClick={() => { void onRevise(files.filter((item) => item.name !== file.name).map((item) => item.name)) }}><X size={15} /></Button></div>
        </li>)}
      </ul>
      {preparation.resume ? <p className="text-sm text-muted-foreground" role="status">已确认传输 {formatTransferBytes(preparation.resume.bytes)} / {formatTransferBytes(bytes)}。继续前会校验本地文件和已传内容。</p> : null}
      {checking ? <div className="server-upload-checking" role="status" data-testid="upload-review-progress"><SpinnerGap className="animate-spin shrink-0" size={16} /><span>{progress.phase === "remote" ? "检查目标" : "校验文件"} {progress.completedFiles}/{progress.totalFiles}{progress.phase === "hashing" ? ` · ${formatTransferBytes(progress.hashedBytes)} / ${formatTransferBytes(progress.totalBytes)}` : ""}</span></div> : null}
      {sourcePath !== preparation.path ? <div className="server-upload-link-note"><span>目录链接 <code>{sourcePath}</code> → 上方实际目录</span><CopyUploadPath path={sourcePath} label="复制目录链接路径" /></div> : null}
      {existing > 0 ? <label className="server-upload-conflict"><WarningCircle size={17} aria-hidden="true" /><input type="checkbox" checked={overwrite} disabled={busy || checking || needsReview || !ready} onChange={(event) => onOverwrite(event.target.checked)} /><span>确认覆盖目标目录中的 {existing} 个同名文件</span></label> : null}
      {error ? <div className="server-upload-review-error" role="alert"><p>{error}</p>{needsReview && !preparation.resume ? <><Button size="sm" variant="outline" disabled={busy || checking || !connected} onClick={() => { void onRevise(files.map((file) => file.name)) }}>重新检查</Button><Button size="sm" variant="ghost" disabled={busy || checking || !connected} onClick={onReselect}>重新选择文件</Button></> : null}</div> : null}
    </div>
    <DialogFooter className="server-upload-confirm-footer"><span className="server-upload-total">{files.length} 个文件 · 合计 {formatTransferBytes(bytes)}</span><div className="flex items-center justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button><Button data-testid="upload-confirm-submit" disabled={!connected || !ready || busy || needsReview || Boolean(existing && !overwrite)} onClick={onConfirm}>{busy ? <SpinnerGap className="animate-spin" /> : <UploadSimple />}{confirming ? "正在提交…" : removing ? "正在移除…" : busy || checking ? "正在检查…" : preparation.resume ? "确认继续上传" : `开始上传 ${files.length} 个文件`}</Button></div></DialogFooter>
  </DialogContent>
}
