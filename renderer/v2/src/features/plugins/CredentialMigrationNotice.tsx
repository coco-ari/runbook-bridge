import { useEffect, useMemo, useRef, useState } from "react"
import { ShieldWarning } from "@phosphor-icons/react"

import type {
  AiOpsV2Api,
  CredentialStatusData,
  PluginRecord,
  PublicError,
} from "@/bridge/ai-ops-v2"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

interface CredentialMigrationNoticeProps {
  readonly api: AiOpsV2Api
  readonly plugin: PluginRecord
  readonly status: CredentialStatusData | null
  readonly onMigrated: () => void
}

interface MigrationData {
  readonly sourceSha256: string
  readonly confirmable: boolean
}

function migrationFromStatus(status: CredentialStatusData | null): MigrationData | null {
  const value = status?.migration
  if (value === null || typeof value !== "object") return null
  const migration = value as Readonly<Record<string, unknown>>
  const sourceSha256 = typeof migration.sourceSha256 === "string"
    ? migration.sourceSha256.trim()
    : ""
  if (!sourceSha256) return null
  return { sourceSha256, confirmable: migration.confirmable === true }
}

function errorValue(error: unknown): PublicError {
  return error instanceof Error
    ? { code: "CREDENTIAL_MIGRATION_FAILED", message: error.message }
    : { code: "CREDENTIAL_MIGRATION_FAILED", message: "凭据迁移失败。" }
}

export function CredentialMigrationNotice({
  api,
  plugin,
  status,
  onMigrated,
}: CredentialMigrationNoticeProps) {
  const migration = useMemo(() => migrationFromStatus(status), [status])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyDialogRef = useBusyDialogFocus(busy)
  const [error, setError] = useState<PublicError | null>(null)
  const generationRef = useRef(0)
  const migrationInFlightRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const ownerKey = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}/${plugin.revision}`

  useEffect(() => {
    generationRef.current += 1
    setConfirming(false)
    setBusy(false)
    setError(null)
  }, [ownerKey, migration?.sourceSha256])

  if (!migration) return null

  const migrate = async () => {
    if (migrationInFlightRef.current || !migration.confirmable) return
    migrationInFlightRef.current = true
    const generation = ++generationRef.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.confirmCredentialMigration({
        projectId: plugin.projectId,
        environmentId: plugin.environmentId,
        pluginInstanceId: plugin.pluginInstanceId,
        expectedRevision: plugin.revision,
        sourceSha256: migration.sourceSha256,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (generationRef.current !== generation) return
      setConfirming(false)
      onMigrated()
    } catch (migrationError) {
      if (generationRef.current === generation) setError(errorValue(migrationError))
    } finally {
      migrationInFlightRef.current = false
      if (generationRef.current === generation) setBusy(false)
    }
  }

  return (
    <>
      <Alert className="border-warning/30 bg-warning/10" data-testid="credential-migration-notice">
        <ShieldWarning aria-hidden="true" className="text-warning" />
        <AlertTitle>检测到旧绑定凭据</AlertTitle>
        <AlertDescription className="space-y-2 text-xs leading-5">
          <span className="block">仅在你确认后，应用才会把现有加密凭据重新绑定到当前插件范围。Renderer 不读取凭据正文。</span>
          <Button
            disabled={!migration.confirmable || busy}
            onClick={() => setConfirming(true)}
            ref={triggerRef}
            size="xs"
            type="button"
            variant="outline"
          >
            沿用旧凭据
          </Button>
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert className="mt-2" variant="destructive">
          <ShieldWarning aria-hidden="true" />
          <AlertTitle>旧凭据重新绑定失败</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      <AlertDialog open={confirming}>
        <AlertDialogContent
          ref={busyDialogRef}
          aria-busy={busy || undefined}
          data-testid="credential-migration-confirmation"
          onEscapeKeyDown={(event) => { event.preventDefault(); if (!busy) setConfirming(false) }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => {
              const target = triggerRef.current?.isConnected ? triggerRef.current : document.getElementById("detail-main")
              focusWorkspaceElement(target)
            })
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-warning"><ShieldWarning /></AlertDialogMedia>
            <AlertDialogTitle>确认重新绑定旧凭据</AlertDialogTitle>
            <AlertDialogDescription>
              此操作只重新绑定应用凭据库中的现有密文，不会向 Renderer 返回明文。请确认旧凭据确实属于当前项目、环境和插件。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <ShieldWarning aria-hidden="true" />
              <AlertTitle>旧凭据尚未重新绑定</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={() => setConfirming(false)}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void migrate()}>
              {busy ? "处理中" : "确认重新绑定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
