import { useEffect, useMemo, useRef, useState } from "react"
import { ShieldCheck } from "@phosphor-icons/react"

import type { AiOpsV2Api, IpcResult, PluginRecord, PublicError } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent } from "@/components/ui/card"
import { FeatureToolbar } from "@/components/detail-workspace/FeatureToolbar"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { PluginConfigurationRecord, PluginKind } from "@/features/plugins/plugin-types"

interface PluginAgentAccessProps {
  readonly api: AiOpsV2Api
  readonly onDirtyChange?: ((dirty: boolean) => void) | undefined
  readonly onSavingChange?: ((saving: boolean) => void) | undefined
  readonly plugin: PluginConfigurationRecord
  readonly onUpdated: (plugin: PluginRecord) => void
}

type PermissionMode = "auto" | "confirm" | "strong" | "deny"

interface PermissionRule {
  readonly capability: string
  readonly detail: string
  readonly mode: PermissionMode
}

const RULES: Readonly<Record<PluginKind, readonly PermissionRule[]>> = {
  server: [
    { capability: "读取文件、日志和服务状态", detail: "受路径、大小和资源上限约束", mode: "auto" },
    { capability: "执行只读诊断命令", detail: "必须匹配应用内置命令策略", mode: "auto" },
    { capability: "修改文件与配置", detail: "每次绑定精确参数并确认", mode: "confirm" },
    { capability: "服务控制和高风险命令", detail: "需要强确认，未知操作拒绝", mode: "strong" },
  ],
  mysql: [
    { capability: "SELECT / EXPLAIN SELECT", detail: "固定数据库、单语句、只读", mode: "auto" },
    { capability: "切换数据库", detail: "插件只能访问已固定数据库", mode: "deny" },
    { capability: "INSERT / UPDATE / DELETE / DDL", detail: "Agent 数据库写入不开放", mode: "deny" },
  ],
  redis: [
    { capability: "按允许模式读取 Key", detail: "固定 Logical DB，返回结果有上限", mode: "auto" },
    { capability: "扫描未授权 Key", detail: "模式外访问直接拒绝", mode: "deny" },
    { capability: "写入、删除或切库", detail: "Agent Redis 变更不开放", mode: "deny" },
  ],
}

const MODE_COPY = {
  auto: { label: "自动放行", variant: "success" as const },
  confirm: { label: "每次确认", variant: "warning" as const },
  strong: { label: "强确认", variant: "danger" as const },
  deny: { label: "默认拒绝", variant: "outline" as const },
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  const error = new Error(result.error.message) as Error & { code?: string }
  error.code = result.error.code
  throw error
}

function readNumber(record: Readonly<Record<string, unknown>> | undefined, key: string, fallback: number): number {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function errorValue(error: unknown): PublicError {
  return error instanceof Error
    ? { code: "AGENT_CONFIGURATION_FAILED", message: error.message }
    : { code: "AGENT_CONFIGURATION_FAILED", message: "Agent 配置保存失败。" }
}

export function PluginAgentAccess({
  api,
  onDirtyChange,
  onSavingChange,
  plugin,
  onUpdated,
}: PluginAgentAccessProps) {
  const kind = (plugin.pluginType === "mysql" || plugin.pluginType === "redis")
    ? plugin.pluginType
    : "server"
  const defaultTimeout = kind === "redis" ? 5_000 : 10_000
  const configuredTimeout = readNumber(plugin.limits,"timeoutMs",defaultTimeout)
  const configuredResourceLimit = (
    kind === "mysql"
      ? readNumber(plugin.limits, "maxRows", 100)
      : kind === "redis"
        ? readNumber(plugin.limits, "maxKeys", 100)
        : 0
  )
  const [editing, setEditing] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState(configuredTimeout)
  const [resourceLimit, setResourceLimit] = useState(configuredResourceLimit)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PublicError | null>(null)
  const generationRef = useRef(0)
  const ownerKey = `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}/${plugin.revision}`
  const resourceLimitError = error?.code === "INVALID_RESOURCE_LIMIT" ? error.message : undefined
  const timeoutError = error?.code === "INVALID_TIMEOUT" ? error.message : undefined
  const saveError = error && !resourceLimitError && !timeoutError ? error.message : undefined

  useEffect(() => {
    generationRef.current += 1
    setEditing(false)
    setBusy(false)
    setError(null)
    setTimeoutMs(configuredTimeout)
    setResourceLimit(configuredResourceLimit)
  }, [configuredResourceLimit, configuredTimeout, ownerKey])

  const dirty = editing
    && (timeoutMs !== configuredTimeout || resourceLimit !== configuredResourceLimit)

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  },[dirty,onDirtyChange])

  useEffect(() => {
    onSavingChange?.(busy)
    return () => onSavingChange?.(false)
  },[busy,onSavingChange])

  const limitsSummary = useMemo(() => {
    if (kind === "mysql") return `最多 ${readNumber(plugin.limits, "maxRows", 100)} 行，固定数据库，单语句。`
    if (kind === "redis") return `最多 ${readNumber(plugin.limits, "maxKeys", 100)} 个 Key，固定 Logical DB。`
    return `单次操作超时 ${Math.round(readNumber(plugin.limits, "timeoutMs", 10_000) / 1000)} 秒。`
  }, [kind, plugin.limits])

  const save = async () => {
    const maxTimeout = kind === "redis" ? 30_000 : 60_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > maxTimeout) {
      setError({ code: "INVALID_TIMEOUT", message: `超时必须在 500 到 ${maxTimeout} 毫秒之间。` })
      return
    }
    if (kind !== "server" && (!Number.isInteger(resourceLimit) || resourceLimit < 1 || resourceLimit > 1000)) {
      setError({ code: "INVALID_RESOURCE_LIMIT", message: "资源上限必须在 1 到 1000 之间。" })
      return
    }
    if (busy) return
    const generation = ++generationRef.current
    setBusy(true)
    setError(null)
    try {
      const limits: Record<string, number> = { timeoutMs }
      if (kind === "server") limits.maxBytes = readNumber(plugin.limits, "maxBytes", 262_144)
      if (kind === "mysql") {
        limits.maxRows = resourceLimit
        limits.maxBytes = readNumber(plugin.limits, "maxBytes", 1_048_576)
      }
      if (kind === "redis") {
        limits.maxKeys = resourceLimit
        limits.maxValueBytes = readNumber(plugin.limits, "maxValueBytes", 65_536)
      }
      const updated = unwrap(await api.updatePluginAgentConfiguration({
        projectId: plugin.projectId,
        environmentId: plugin.environmentId,
        pluginInstanceId: plugin.pluginInstanceId,
        expectedRevision: plugin.revision,
        patch: { limits },
      }))
      if (generationRef.current !== generation) return
      setEditing(false)
      onUpdated(updated)
    } catch (saveError) {
      if (generationRef.current === generation) setError(errorValue(saveError))
    } finally {
      if (generationRef.current === generation) setBusy(false)
    }
  }

  return (
    <section aria-labelledby="plugin-agent-access-title" className="space-y-4 @container/agent-access" data-testid="plugin-agent-access">
      <FeatureToolbar
        actions={!editing ? (
          <Button onClick={() => setEditing(true)} size="sm" type="button" variant="outline">
            <ShieldCheck />
            编辑资源上限
          </Button>
        ) : null}
        description="权限由应用策略强制判定，Agent 与插件配置都不能绕过。"
        title="Agent 可执行范围"
        titleId="plugin-agent-access-title"
      />

      {editing ? (
        <Card className="gap-0 bg-surface-inset py-0" size="sm">
          <CardContent className="p-3">
            <FieldGroup className="grid gap-3 @md/agent-access:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {kind !== "server" ? (
                <Field data-invalid={Boolean(resourceLimitError)}>
                  <FieldLabel htmlFor="plugin-agent-resource-limit">
                    {kind === "mysql" ? "最大返回行数" : "最大 Key 数"}
                  </FieldLabel>
                  <Input
                    aria-describedby={resourceLimitError ? "plugin-agent-resource-limit-error" : undefined}
                    aria-invalid={Boolean(resourceLimitError)}
                    id="plugin-agent-resource-limit"
                    max={1000}
                    min={1}
                    onChange={(event) => setResourceLimit(Number(event.target.value))}
                    type="number"
                    value={resourceLimit}
                  />
                  <FieldError id="plugin-agent-resource-limit-error">
                    {resourceLimitError}
                  </FieldError>
                </Field>
              ) : null}
              <Field className={kind === "server" ? "@md/agent-access:col-span-2" : undefined} data-invalid={Boolean(timeoutError)}>
                <FieldLabel htmlFor="plugin-agent-timeout">操作超时（毫秒）</FieldLabel>
                <Input
                  aria-describedby={
                    timeoutError
                      ? "plugin-agent-timeout-description plugin-agent-timeout-error"
                      : "plugin-agent-timeout-description"
                  }
                  aria-invalid={Boolean(timeoutError)}
                  id="plugin-agent-timeout"
                  min={500}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                  type="number"
                  value={timeoutMs}
                />
                <FieldDescription id="plugin-agent-timeout-description">
                  保存会更新后续 Agent context，不主动改变网络连接。
                </FieldDescription>
                <FieldError id="plugin-agent-timeout-error">{timeoutError}</FieldError>
              </Field>
              {saveError ? (
                <div className="@md/agent-access:col-span-2">
                  <Alert variant="destructive">
                    <AlertDescription>{saveError}</AlertDescription>
                  </Alert>
                </div>
              ) : null}
              <ButtonGroup aria-label="Agent 资源上限编辑操作" className="w-full @md/agent-access:col-span-2 @md/agent-access:ml-auto @md/agent-access:w-fit">
                <Button className="flex-1 @md/agent-access:flex-none" disabled={busy} onClick={() => {
                  setTimeoutMs(configuredTimeout)
                  setResourceLimit(configuredResourceLimit)
                  setEditing(false)
                  setError(null)
                }} size="sm" type="button" variant="outline">
                  取消
                </Button>
                <Button className="flex-1 @md/agent-access:flex-none" disabled={busy} onClick={() => void save()} size="sm" type="button">
                  {busy ? "保存中" : "保存 Agent 配置"}
                </Button>
              </ButtonGroup>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : (
        <Alert className="bg-surface-inset py-2">
          <ShieldCheck aria-hidden="true" />
          <AlertDescription>{limitsSummary}</AlertDescription>
        </Alert>
      )}

      <ItemGroup className="gap-2 @md/agent-access:hidden" aria-label="Agent 能力策略">
        {RULES[kind].map((rule) => (
          <Item className="min-w-0 bg-surface-inset" key={rule.capability} role="listitem" size="xs" variant="muted">
            <ItemContent>
              <ItemTitle className="line-clamp-none w-full">{rule.capability}</ItemTitle>
              <ItemDescription className="line-clamp-none">{rule.detail}</ItemDescription>
            </ItemContent>
            <ItemActions className="ml-auto self-start">
              <Badge variant={MODE_COPY[rule.mode].variant}>{MODE_COPY[rule.mode].label}</Badge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <div className="hidden @md/agent-access:block">
        <Table aria-label="Agent 能力策略">
          <TableHeader>
            <TableRow>
              <TableHead>能力</TableHead>
              <TableHead>边界</TableHead>
              <TableHead className="w-28 text-right">策略</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {RULES[kind].map((rule) => (
              <TableRow key={rule.capability}>
                <TableCell className="font-medium whitespace-normal">{rule.capability}</TableCell>
                <TableCell className="text-muted-foreground whitespace-normal">{rule.detail}</TableCell>
                <TableCell className="text-right">
                  <Badge variant={MODE_COPY[rule.mode].variant}>{MODE_COPY[rule.mode].label}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
