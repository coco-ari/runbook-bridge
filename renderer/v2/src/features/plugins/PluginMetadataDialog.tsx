import { useEffect, useRef, useState } from "react"

import type { AiOpsV2Api, PluginRecord, PublicError } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

interface PluginMetadataDialogProps {
  readonly api: AiOpsV2Api
  readonly open: boolean
  readonly plugin: PluginRecord
  readonly onOpenChange: (open: boolean) => void
  readonly onUpdated: (plugin: PluginRecord) => void
}

function errorValue(error: unknown): PublicError {
  return error instanceof Error
    ? { code: "PLUGIN_METADATA_UPDATE_FAILED", message: error.message }
    : { code: "PLUGIN_METADATA_UPDATE_FAILED", message: "插件名称保存失败。" }
}

export function PluginMetadataDialog({
  api,
  open,
  plugin,
  onOpenChange,
  onUpdated,
}: PluginMetadataDialogProps) {
  const [name, setName] = useState(plugin.displayName)
  const [busy, setBusy] = useState(false)
  const busyDialogRef = useBusyDialogFocus(busy)
  const [error, setError] = useState<PublicError | null>(null)
  const generationRef = useRef(0)
  const saveInFlightRef = useRef(false)
  const ownerKey = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}/${plugin.revision}`

  useEffect(() => {
    generationRef.current += 1
    setName(plugin.displayName)
    setBusy(false)
    setError(null)
  }, [open, ownerKey, plugin.displayName])

  const save = async () => {
    const displayName = name.trim()
    if (!displayName) {
      setError({ code: "INVALID_PLUGIN_NAME", message: "插件名称不能为空。" })
      return
    }
    if (saveInFlightRef.current) return
    saveInFlightRef.current = true
    const generation = ++generationRef.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.updatePluginMetadata({
        projectId: plugin.projectId,
        environmentId: plugin.environmentId,
        pluginInstanceId: plugin.pluginInstanceId,
        expectedRevision: plugin.revision,
        patch: { displayName },
      })
      if (!result.ok) throw new Error(result.error.message)
      if (generationRef.current !== generation) return
      onUpdated(result.data)
      onOpenChange(false)
    } catch (saveError) {
      if (generationRef.current === generation) setError(errorValue(saveError))
    } finally {
      saveInFlightRef.current = false
      if (generationRef.current === generation) setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={(nextOpen) => {
      if (!busy) onOpenChange(nextOpen)
    }} open={open}>
      <DialogContent
        ref={busyDialogRef}
        aria-busy={busy || undefined}
        data-testid="plugin-metadata-dialog"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => {
            const target = document.querySelector<HTMLElement>('[aria-label="当前范围更多操作"]')
              ?? document.getElementById("detail-main")
            focusWorkspaceElement(target)
          })
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>修改插件名称</DialogTitle>
          <DialogDescription>
            此操作只更新显示名称，不修改连接、凭据、权限或运行状态。
          </DialogDescription>
        </DialogHeader>
        <form
          id="plugin-metadata-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="plugin-metadata-name">名称</FieldLabel>
            <Input
              aria-describedby={`plugin-metadata-name-description${error ? " plugin-metadata-name-error" : ""}`}
              aria-errormessage={error ? "plugin-metadata-name-error" : undefined}
              aria-invalid={Boolean(error) || undefined}
              autoFocus
              disabled={busy}
              id="plugin-metadata-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <FieldDescription id="plugin-metadata-name-description">名称仅用于当前工作台中的识别。</FieldDescription>
            <FieldError id="plugin-metadata-name-error">{error?.message}</FieldError>
          </Field>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} type="button" variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={busy} form="plugin-metadata-form" type="submit">
            {busy ? "保存中" : "保存名称"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
