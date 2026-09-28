import type { ServerUploadJob } from "@/bridge/ai-ops-v2"

export const ACTIVE_TRANSFER_STATUSES = new Set<ServerUploadJob["status"]>(["queued", "running", "verifying", "pausing"])

export function transferProgress(job: Pick<ServerUploadJob, "bytes" | "transferred" | "status">) {
  const bytes = Number.isFinite(job.bytes) ? Math.max(0, job.bytes) : 0
  const transferred = job.status === "completed" ? bytes : Math.min(bytes, Math.max(0, Number.isFinite(job.transferred) ? job.transferred : 0))
  const value = job.status === "completed" && bytes === 0 ? 1 : transferred
  const max = bytes || 1
  return { bytes, transferred, value, max, percent: Math.round(value / max * 100) }
}

export function activeTransferProgress(jobs: readonly ServerUploadJob[]) {
  // 总进度仅统计当前活动任务；已结束记录不影响新任务的进度。
  const active = jobs.filter(job => ACTIVE_TRANSFER_STATUSES.has(job.status))
  const totals = active.reduce((sum, job) => {
    const progress = transferProgress(job)
    return { bytes: sum.bytes + progress.bytes, transferred: sum.transferred + progress.transferred }
  }, { bytes: 0, transferred: 0 })
  return transferProgress({ ...totals, status: "running" })
}
