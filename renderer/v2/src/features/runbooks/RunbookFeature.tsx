import {
  ArrowClockwise,
  FloppyDisk,
  NotePencil,
  WarningCircle,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  getAiOpsV2,
  type IpcResult,
  type PublicError,
} from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  RUNBOOK_MAX_BYTES,
  beginRunbookRead,
  decideRunbookRead,
  revisionFromEnvironments,
  runbookByteLength,
  runbookContent,
  runbookScopeKey,
  savedEnvironmentRevision,
} from "@/features/runbooks/runbook-model"

class FeatureApiError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(error: PublicError) {
    super(error.message)
    this.name = "FeatureApiError"
    this.code = error.code
    if (error.details !== undefined) this.details = error.details
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new FeatureApiError(result.error)
  return result.data
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取运维说明失败。"
}

export interface RunbookFeatureProps {
  readonly projectId: string
  readonly environmentId: string
  readonly environmentRevision: number
  readonly projectName?: string
  readonly environmentName?: string
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly onSavingChange?: (saving: boolean) => void
  readonly onEnvironmentRevisionChange?: (revision: number) => void
}

export function RunbookFeature({
  projectId,
  environmentId,
  environmentRevision,
  projectName = "当前项目",
  environmentName = "当前环境",
  onDirtyChange,
  onSavingChange,
  onEnvironmentRevisionChange,
}: RunbookFeatureProps) {
  const [content, setContent] = useState("")
  const [draft, setDraft] = useState("")
  const [revision, setRevision] = useState(environmentRevision)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const scopeKey = runbookScopeKey(projectId, environmentId)
  const scopeEpochRef = useRef(0)
  const scopeKeyRef = useRef(scopeKey)
  const draftGenerationRef = useRef(0)
  const revisionHintRef = useRef(environmentRevision)
  const revisionChangeRef = useRef(onEnvironmentRevisionChange)

  const draftBytes = runbookByteLength(draft)
  const dirty = editing && draft !== content
  const tooLarge = draftBytes > RUNBOOK_MAX_BYTES
  const contentNeedsScroll = runbookByteLength(content) > 4_096
    || content.split(/\r?\n/u).length > 24

  useEffect(() => {
    revisionHintRef.current = environmentRevision
  }, [environmentRevision])

  useEffect(() => {
    revisionChangeRef.current = onEnvironmentRevisionChange
  }, [onEnvironmentRevisionChange])

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    onSavingChange?.(saving)
    return () => onSavingChange?.(false)
  },[onSavingChange,saving])

  const readLatest = useCallback(async (
    epoch: number,
    preserveDraft: boolean,
  ) => {
    const token = beginRunbookRead(scopeKey, epoch, draftGenerationRef.current)
    setLoading(true)
    setError(null)
    try {
      const api = getAiOpsV2()
      const [runbookResult, environmentsResult] = await Promise.all([
        api.readRunbook({ projectId, environmentId }),
        api.listEnvironments(projectId),
      ])
      const runbook = unwrap(runbookResult)
      const environments = unwrap(environmentsResult)
      const decision = decideRunbookRead(token, {
        scopeKey: scopeKeyRef.current,
        epoch: scopeEpochRef.current,
        draftGeneration: draftGenerationRef.current,
      }, preserveDraft)
      if (!decision.accept) return

      const nextContent = runbookContent(runbook)
      const nextRevision = revisionFromEnvironments(environments, environmentId)
        ?? savedEnvironmentRevision(runbook)
        ?? revisionHintRef.current
      setContent(nextContent)
      if (decision.replaceDraft) {
        draftGenerationRef.current += 1
        setDraft(nextContent)
      }
      setRevision(nextRevision)
      if (nextRevision !== revisionHintRef.current) {
        revisionHintRef.current = nextRevision
        revisionChangeRef.current?.(nextRevision)
      }
    } catch (caught) {
      if (scopeEpochRef.current === epoch) setError(errorMessage(caught))
    } finally {
      if (scopeEpochRef.current === epoch) setLoading(false)
    }
  }, [environmentId, projectId, scopeKey])

  useEffect(() => {
    const epoch = ++scopeEpochRef.current
    scopeKeyRef.current = scopeKey
    draftGenerationRef.current += 1
    setContent("")
    setDraft("")
    setRevision(revisionHintRef.current)
    setEditing(false)
    setConflict(null)
    void readLatest(epoch, false)
    return () => {
      scopeEpochRef.current += 1
    }
  }, [environmentId, projectId, readLatest, scopeKey])

  async function save() {
    if (saving || loading || !dirty || tooLarge) return
    const epoch = scopeEpochRef.current
    setSaving(true)
    setError(null)
    setConflict(null)
    try {
      const result = await getAiOpsV2().saveRunbook({
        projectId,
        environmentId,
        content: draft,
        expectedRevision: revision,
      })
      const saved = unwrap(result)
      if (scopeEpochRef.current !== epoch) return
      const nextRevision = savedEnvironmentRevision(saved) ?? revision + 1
      setContent(draft)
      draftGenerationRef.current += 1
      setRevision(nextRevision)
      revisionHintRef.current = nextRevision
      setEditing(false)
      revisionChangeRef.current?.(nextRevision)
      toast.success("运维说明已保存。")
    } catch (caught) {
      if (scopeEpochRef.current !== epoch) return
      if (caught instanceof FeatureApiError && caught.code === "CONFIG_REVISION_CONFLICT") {
        setConflict("环境已在其他窗口更新。你的草稿已保留，请核对最新内容后再次保存。")
        await readLatest(epoch, true)
      } else {
        setError(errorMessage(caught))
      }
    } finally {
      if (scopeEpochRef.current === epoch) setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="runbook-feature-title"
      className="min-h-0"
      data-feature="runbook"
    >
      <FeatureToolbar
        actions={(
          <ButtonGroup aria-label="运维说明操作">
          {!editing ? (
            <>
              <Button
                aria-label="重新读取运维说明"
                disabled={loading}
                onClick={() => void readLatest(scopeEpochRef.current, false)}
                size="icon-xs"
                title="重新读取"
                variant="outline"
              >
                <ArrowClockwise className={loading ? "animate-spin" : ""} />
              </Button>
              <Button disabled={loading} onClick={() => setEditing(true)} size="xs">
                <NotePencil />
                编辑
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={saving}
                onClick={() => {
                  draftGenerationRef.current += 1
                  setDraft(content)
                  setEditing(false)
                  setConflict(null)
                }}
                size="xs"
                variant="outline"
              >
                取消
              </Button>
              <Button
                disabled={saving || loading || !dirty || tooLarge}
                onClick={() => void save()}
                size="xs"
              >
                <FloppyDisk />
                {saving ? "保存中" : "保存"}
              </Button>
            </>
          )}
          </ButtonGroup>
        )}
        description="说明保存在当前环境中，保存时使用配置修订号防止覆盖其他窗口的修改。"
        meta={(
          <Badge variant={tooLarge ? "danger" : "outline"}>
            {draftBytes.toLocaleString("zh-CN")} / 65,536 字节
          </Badge>
        )}
        title={`${projectName} / ${environmentName} 运维说明`}
        titleId="runbook-feature-title"
      />

      {(error || conflict || tooLarge) && (
        <Alert className="mb-3 w-auto" variant="destructive">
          <WarningCircle aria-hidden="true" weight="fill" />
          <AlertTitle>{conflict ? "运维说明已在其他位置更新" : "无法保存运维说明"}</AlertTitle>
          <AlertDescription>
            {tooLarge
              ? "运维说明不能超过 64 KiB。请缩短内容后再保存。"
              : conflict ?? error}
          </AlertDescription>
        </Alert>
      )}

      <div className="min-h-0">
        {loading && !editing ? (
          <div className="space-y-2" aria-label="正在读取运维说明">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : editing ? (
          <Textarea
            aria-describedby={tooLarge ? "runbook-size-error" : undefined}
            aria-invalid={tooLarge}
            aria-label="当前环境运维说明"
            autoFocus
            className="h-[min(58dvh,32rem)] min-h-72 resize-none font-mono text-xs leading-6"
            onChange={(event) => {
              draftGenerationRef.current += 1
              setDraft(event.target.value)
            }}
            spellCheck={false}
            value={draft}
          />
        ) : !content.trim() ? (
          <Empty className="min-h-44 rounded-lg border border-dashed bg-surface-inset/45">
            <EmptyHeader>
              <EmptyMedia variant="icon"><NotePencil /></EmptyMedia>
              <EmptyTitle>暂未填写运维说明</EmptyTitle>
              <EmptyDescription>添加环境边界、排障入口和日常操作约定。</EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setEditing(true)} size="sm" type="button">
              <NotePencil />
              开始编写
            </Button>
          </Empty>
        ) : contentNeedsScroll ? (
          <ScrollArea className="h-[min(58dvh,32rem)] rounded-lg border border-border bg-surface-inset/55">
            <pre className="whitespace-pre-wrap break-words p-4 font-sans text-sm leading-6 text-foreground">
              {content}
            </pre>
          </ScrollArea>
        ) : (
          <article className="rounded-lg border border-border bg-surface-inset/55 p-4">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
              {content}
            </pre>
          </article>
        )}
        {tooLarge && <span className="sr-only" id="runbook-size-error">内容超过 64 KiB。</span>}
      </div>
    </section>
  )
}
