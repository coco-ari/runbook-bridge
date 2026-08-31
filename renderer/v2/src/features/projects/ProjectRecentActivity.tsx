import {
  ArrowClockwise,
  CheckCircle,
  ClockCounterClockwise,
  WarningCircle,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useRef, useState } from "react"

import { getAiOpsV2, type IpcResult, type PublicError } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { auditOperationLabel, auditResult, auditResultLabel, auditResultVariant } from "@/lib/operation-copy"

type UnknownRecord = Record<string, unknown>

interface ProjectAuditEntry extends UnknownRecord {
  readonly auditId?: string
  readonly result?: string
  readonly time?: string | number
  readonly type: string
}

class ProjectActivityError extends Error {
  readonly code: string

  constructor(error: PublicError) {
    super(error.message)
    this.name = "ProjectActivityError"
    this.code = error.code
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new ProjectActivityError(result.error)
  return result.data
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? value as UnknownRecord : {}
}

function normalizeProjectAudit(value: unknown): readonly ProjectAuditEntry[] {
  const page = asRecord(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(page.entries)
      ? page.entries
      : []
  return source.flatMap((candidate) => {
    const entry = asRecord(candidate)
    if (typeof entry.type !== "string" || !entry.type) return []
    return [{ ...entry, type: entry.type } satisfies ProjectAuditEntry]
  }).slice(0, 6)
}

function timeLabel(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "时间未记录"
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return "时间未记录"
  return instant.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export interface ProjectRecentActivityProps {
  readonly projectId: string
  readonly projectName: string
}

export function ProjectRecentActivity({
  projectId,
  projectName,
}: ProjectRecentActivityProps) {
  const generationRef = useRef(0)
  const mountedRef = useRef(false)
  const [entries, setEntries] = useState<readonly ProjectAuditEntry[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(false)
    try {
      const value = unwrap(await getAiOpsV2().listAudit({ projectId, limit: 6 }) as IpcResult<unknown>)
      if (!mountedRef.current || generation !== generationRef.current) return
      setEntries(normalizeProjectAudit(value))
    } catch {
      if (!mountedRef.current || generation !== generationRef.current) return
      setError(true)
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [load])

  return (
    <Card className="mt-4 gap-0 py-0 @container/project-activity" data-testid="project-recent-activity" size="sm">
      <CardHeader className="border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <CardTitle>
            <h3 className="flex items-center gap-2 text-xs font-semibold">
              <ClockCounterClockwise aria-hidden="true" className="text-primary" size={14} />
              近期操作
            </h3>
          </CardTitle>
          {loading ? <Badge variant="info">正在读取</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="p-2">
        {loading && entries.length === 0 ? (
          <div aria-label="正在读取近期操作" className="space-y-2 p-1">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-4/5 rounded-lg" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <WarningCircle aria-hidden="true" />
            <AlertTitle>近期操作不可用</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>项目概览仍可使用，操作记录可单独重试。</span>
              <Button onClick={() => void load()} size="xs" type="button" variant="outline">
                <ArrowClockwise aria-hidden="true" size={13} />
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : entries.length === 0 ? (
          <Empty className="min-h-28 bg-surface/30">
            <EmptyHeader className="gap-1">
              <EmptyMedia variant="icon"><ClockCounterClockwise /></EmptyMedia>
              <EmptyTitle>还没有操作记录</EmptyTitle>
              <EmptyDescription className="text-xs">{projectName} 的近期操作会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup aria-label={`${projectName}的近期操作`} className="gap-1">
            {entries.map((entry, index) => {
              const result = auditResult(entry)
              return (
                <Item className="min-w-0 items-start @sm/project-activity:items-center" key={entry.auditId ?? `${entry.type}-${String(entry.time)}-${index}`} role="listitem" size="xs" variant="default">
                  <ItemMedia className={result === "success" ? "text-success" : "text-muted-foreground"} variant="icon">
                    {result === "success"
                      ? <CheckCircle aria-hidden="true" weight="fill" />
                      : <WarningCircle aria-hidden="true" weight="fill" />}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{auditOperationLabel(entry.type)}</ItemTitle>
                    <ItemDescription>{timeLabel(entry.time)}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="ml-auto self-start @sm/project-activity:self-center">
                    <Badge variant={auditResultVariant(result)}>{auditResultLabel(result)}</Badge>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}
