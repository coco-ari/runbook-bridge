import { useCallback, useEffect, useRef, useState } from "react"
import type { AiOpsV2Api, PluginScope } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface StoredCredentialViewerProps {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly field: "password" | "privateKeyPassphrase" | "proxyPassword"
  readonly label: string
  readonly onClose: () => void
  readonly onCloseAutoFocus: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"]
}

export function StoredCredentialViewer({ api, scope, field, label, onClose, onCloseAutoFocus }: StoredCredentialViewerProps) {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef(0)
  const close = useCallback(() => {
    requestRef.current += 1
    setValue("")
    setLoading(false)
    setFailed(false)
    setOpen(false)
    onClose()
  }, [onClose])

  useEffect(() => {
    const hideWhenBackgrounded = () => { if (document.hidden) close() }
    window.addEventListener("blur", close)
    document.addEventListener("visibilitychange", hideWhenBackgrounded)
    return () => {
      // 组件卸载后拒绝迟到的明文结果，不把查看内容交给编辑草稿。
      requestRef.current += 1
      window.removeEventListener("blur", close)
      document.removeEventListener("visibilitychange", hideWhenBackgrounded)
    }
  }, [close])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(close, 30_000)
    return () => window.clearTimeout(timer)
  }, [open, close])

  const reveal = useCallback(async () => {
    if (document.hidden) return
    const request = ++requestRef.current
    setOpen(true)
    setValue("")
    setFailed(false)
    setLoading(true)
    try {
      const result = await api.revealCredential({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        pluginInstanceId: scope.pluginInstanceId,
        field,
      })
      if (requestRef.current !== request) return
      if (result.ok && typeof result.data.value === "string" && result.data.value.length > 0) {
        setValue(result.data.value)
      } else {
        setFailed(true)
      }
    } catch {
      if (requestRef.current === request) setFailed(true)
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }, [api, scope.projectId, scope.environmentId, scope.pluginInstanceId, field])

  useEffect(() => {
    void reveal()
    return () => { requestRef.current += 1 }
  }, [reveal])

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close() }}>
      <DialogContent data-testid="stored-credential-dialog" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>已保存{label}</DialogTitle>
          <DialogDescription>关闭、窗口失焦或 30 秒后自动隐藏。查看不会修改已保存凭据。</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status">正在读取本机凭据…</p> : null}
        {failed ? <p role="alert">无法查看已保存凭据，请检查凭据是否已保存及本机安全存储是否可用。</p> : null}
        {value ? <Input aria-label={`已保存${label}`} autoComplete="off" data-testid="stored-credential-value" readOnly spellCheck={false} type="text" value={value} /> : null}
        <DialogFooter>
          <Button onClick={close} type="button" variant="outline">隐藏并关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
