import type { ServerUploadJob } from "@/bridge/ai-ops-v2"
import { formatTransferBytes, formatTransferEta } from "./workspace-model"
import { transferProgress } from "./transfer-progress"

export function TransferProgressBar({ progress, label, className = "" }: {
  readonly progress: ReturnType<typeof transferProgress>
  readonly label: string
  readonly className?: string
}) {
  return <progress className={`server-transfer-meter ${className}`} aria-label={label} aria-valuetext={`${progress.percent}%`} value={progress.value} max={progress.max} />
}

export function TransferProgress({ job }: { readonly job: ServerUploadJob }) {
  const progress = transferProgress(job)
  const transferring = job.status === "running" && job.phase !== "preparing"
  const detail = transferring
    ? job.bytesPerSecond == null ? "正在估算速度…" : job.bytesPerSecond === 0 ? "等待服务器响应…" : `${formatTransferBytes(job.bytesPerSecond)}/s · 剩余${job.etaSeconds == null ? "估算中" : formatTransferEta(job.etaSeconds)}`
    : job.status === "completed" ? "传输完成"
    : job.status === "verifying" ? "正在校验文件"
    : job.status === "queued" ? "排队中"
    : job.status === "running" ? "检查文件"
    : job.status === "pausing" ? "正在暂停…"
    : job.status === "paused" || job.status === "interrupted" ? "可继续上传"
    : job.status === "error" ? "传输失败" : "已取消"
  return <div className="server-upload-progress">
    <div className="server-transfer-amount"><span>{formatTransferBytes(progress.transferred)} / {formatTransferBytes(progress.bytes)}</span><strong>{progress.percent}%</strong></div>
    <TransferProgressBar progress={progress} label={`${job.name} 传输进度`} />
    <span className="server-transfer-detail" data-testid={transferring ? "upload-speed" : undefined}>{detail}</span>
  </div>
}
