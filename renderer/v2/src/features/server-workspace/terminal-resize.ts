interface TerminalSize { readonly sessionId: string; readonly cols: number; readonly rows: number }
const sameSize = (left: TerminalSize | null, right: TerminalSize | null) => Boolean(left && right && left.sessionId === right.sessionId && left.cols === right.cols && left.rows === right.rows)

// 本地排版按帧更新；远端尺寸按时间窗口合并，慢请求期间只保留最后一次尺寸。
export function createTerminalResizeScheduler(send: (size: TerminalSize) => Promise<boolean>, interval = 80) {
  let latest: TerminalSize | null = null
  let acknowledged: TerminalSize | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let disposed = false
  let epoch = 0
  const schedule = () => {
    if (disposed || running || timer !== undefined || !latest || sameSize(latest, acknowledged)) return
    timer = setTimeout(() => { timer = undefined; void flush() }, interval)
  }
  const flush = async () => {
    if (disposed || running || !latest || sameSize(latest, acknowledged)) return
    const size = latest, generation = epoch
    running = true
    try {
      if (await send(size) && !disposed && generation === epoch) acknowledged = size
    } catch {
      // 失败不记为已同步，后续尺寸事件仍可重试；不启动无限后台重试。
    } finally {
      running = false
      if (generation !== epoch || !sameSize(latest, size)) schedule()
    }
  }
  const reset = () => {
    epoch += 1
    latest = null
    acknowledged = null
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return {
    update(size: TerminalSize) { if (disposed) return; latest = { ...size }; schedule() },
    reset,
    dispose() { disposed = true; reset() },
  }
}
