import { DiagnosticDetails } from "@/features/connections/DiagnosticDetails"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { TerminalConnection } from "./terminal-recovery"

export function ServerConnectionNotice({ connection, busy, error, onRetry, onSettings }: {
  readonly connection: TerminalConnection
  readonly busy: boolean
  readonly error?: string
  readonly onRetry: () => void
  readonly onSettings: () => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (connection.phase !== "waiting" || !connection.nextRetryAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [connection.phase, connection.nextRetryAt])
  if (connection.connected && !error) return null
  const attempt = connection.attempt ? "（" + connection.attempt + "/" + connection.maxAttempts + "）" : ""
  const countdown = Math.max(0, Math.ceil(((connection.nextRetryAt ?? now) - now) / 1000))
  const message = connection.connected ? "当前服务器仍保持连接。" : connection.phase === "waiting" ? "连接中断，等待自动重连" + attempt
    : connection.phase === "connecting" ? "正在连接服务器" + attempt + "…"
    : connection.phase === "exhausted" ? "自动重连未成功，可重新连接。"
    : connection.phase === "action-required" ? "连接需要处理，请检查身份或连接设置。"
    : "服务器已断开，终端历史仍可查看。"
  const detail = error || connection.message
  return <div className="server-workspace-connection-notice flex-wrap" data-testid="server-connection-notice">
    <div className="min-w-0 flex-1">
      <p role="status" aria-live="polite">{message}</p>
      {connection.phase === "waiting" ? <p className="text-xs text-muted-foreground">{countdown > 0 ? countdown + " 秒后重试" : "等待重试开始…"}</p> : null}
      {detail ? <details className="mt-1 text-xs"><summary className="cursor-pointer">查看原因</summary><p className="mt-1 break-words">{detail}</p><DiagnosticDetails error={{ code: connection.reason || "UNKNOWN_ERROR", message: detail }} /></details> : null}
    </div>
    {connection.phase === "action-required"
      ? <Button size="sm" variant="outline" onClick={onSettings}>连接设置</Button>
      : !connection.connected ? <Button size="sm" variant="outline" disabled={busy || connection.phase === "connecting"} onClick={onRetry}>{connection.phase === "waiting" ? "立即重试" : "重新连接"}</Button> : null}
  </div>
}
