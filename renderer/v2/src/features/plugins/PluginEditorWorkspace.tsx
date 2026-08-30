import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowCounterClockwise,
  ArrowsOutSimple,
  ArrowsInSimple,
  CaretDown,
  CaretLeft,
  CaretRight,
  Database,
  FloppyDisk,
  HardDrives,
  LockKey,
  Plugs,
  PlugsConnected,
  ShieldWarning,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react"
import { toast } from "sonner"
import { focusWorkspaceElement } from "@/lib/workspace-focus"

import type { AiOpsV2Api, EnvironmentScope, PluginRecord } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceLeaveRequest } from "@/components/detail-workspace/detail-work-mode"
import { PluginEditorConfirmations } from "@/features/plugins/PluginEditorConfirmations"
import { PluginValidationProgress } from "@/features/plugins/PluginValidationProgress"
import { CredentialMigrationNotice } from "@/features/plugins/CredentialMigrationNotice"
import type { PluginSaveOutcome } from "@/features/plugins/plugin-editor-model"
import {
  PLUGIN_KIND_LABELS,
  emptyServerUplink,
  type AddressFamily,
  type DataTransportKind,
  type PluginConfigurationRecord,
  type PluginFormDraft,
  type PluginKind,
  type ServerAuthType,
  type ServerUplinkType,
  type TlsMode,
} from "@/features/plugins/plugin-types"
import { usePluginEditor } from "@/features/plugins/use-plugin-editor"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"

interface PluginEditorWorkspaceProps {
  readonly api: AiOpsV2Api
  readonly collapsed: boolean
  readonly expanded: boolean
  readonly scope: EnvironmentScope
  readonly projectName: string
  readonly environmentName: string
  readonly plugin: PluginConfigurationRecord | null
  readonly initialKind?: PluginKind
  readonly availableServers: readonly PluginRecord[]
  readonly onClosed: () => void
  readonly onRegisterLeaveGuard: (request: WorkspaceLeaveRequest | null) => void
  readonly onToggleCollapsed: () => void
  readonly onToggleExpanded: () => void
  readonly onSaved: (outcome: PluginSaveOutcome) => void
}

interface PendingLocalChange {
  readonly kind: "auth" | "tls"
  readonly value: string
}

function issueFor(draftIssues: readonly { readonly field: string; readonly message: string }[], field: string) {
  return draftIssues.find((issue) => issue.field === field)?.message
}

function typeIcon(kind: PluginKind) {
  if (kind === "server") return <HardDrives aria-hidden="true" />
  if (kind === "mysql") return <Database aria-hidden="true" />
  return <Plugs aria-hidden="true" />
}

const SERVER_UPLINK_LABELS: Readonly<Record<ServerUplinkType, string>> = {
  direct: "直接连接",
  socks5: "SOCKS5 代理",
  http: "HTTP 代理",
  windowsVpn: "Windows VPN",
}

const DATA_TRANSPORT_LABELS: Readonly<Record<DataTransportKind, string>> = {
  direct: "直接连接",
  serverTunnel: "Server 隧道",
  windowsVpn: "Windows VPN",
}

const TLS_MODE_LABELS: Readonly<Record<TlsMode, string>> = {
  disabled: "TLS 关闭",
  preferred: "TLS 加密",
  required: "TLS 必须加密",
  verifyIdentity: "TLS 身份校验",
}

function advancedConnectionSummary(draft: PluginFormDraft): string {
  if (draft.pluginType === "server") {
    return SERVER_UPLINK_LABELS[draft.uplink?.type ?? "direct"]
  }
  const transport = DATA_TRANSPORT_LABELS[draft.transport?.kind ?? "direct"]
  const tls = TLS_MODE_LABELS[draft.tls?.mode ?? "disabled"]
  return `${transport}，${tls}`
}

export function PluginEditorWorkspace({
  api,
  collapsed,
  expanded,
  scope,
  projectName,
  environmentName,
  plugin,
  initialKind = "server",
  availableServers,
  onClosed,
  onRegisterLeaveGuard,
  onToggleCollapsed,
  onToggleExpanded,
  onSaved,
}: PluginEditorWorkspaceProps) {
  const editor = usePluginEditor({
    api,
    open: true,
    scope,
    plugin,
    initialKind,
    onSaved,
    onClosed,
  })
  const { state } = editor
  const [pendingLocalChange, setPendingLocalChange] = useState<PendingLocalChange | null>(null)
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false)
  const [discardInFlight, setDiscardInFlight] = useState(false)
  const discardDialogRef = useBusyDialogFocus(discardInFlight)
  const [confirmationInFlight, setConfirmationInFlight] = useState(false)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)
  const pendingLeaveRef = useRef<((allowed: boolean) => void) | null>(null)
  const closingRef = useRef(false)
  const discardAllowedRef = useRef(false)
  const lastEditorFocusRef = useRef<HTMLElement | null>(null)
  const confirmationBusyRef = useRef(false)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const draft = state.draft
  const busy = ["preparing", "validating", "saving"].includes(state.phase) || confirmationInFlight
  const closeBlocked = busy || discardInFlight
  const saveBlocked = closeBlocked || state.confirmation !== null || pendingLocalChange !== null
  const fieldErrors = useMemo(
    () => Object.fromEntries(state.issues.map((issue) => [issue.field, issue.message])),
    [state.issues],
  )

  const cancelSession = useCallback(async () => {
    if (closingRef.current) return false
    closingRef.current = true
    setDiscardInFlight(true)
    const allowed = await editor.cancel()
    closingRef.current = false
    setDiscardInFlight(false)
    return allowed
  }, [editor.cancel])

  const requestLeave = useCallback(async () => {
    if (closeBlocked || closingRef.current || pendingLeaveRef.current) {
      toast.info("请先完成当前检查、保存或离开确认。")
      return false
    }
    if (state.confirmation || pendingLocalChange) {
      toast.info("请先处理当前的安全确认。")
      return false
    }
    if (!editor.isDirty) return cancelSession()
    return new Promise<boolean>((resolve) => {
      discardAllowedRef.current = false
      pendingLeaveRef.current = resolve
      setDiscardConfirmationOpen(true)
    })
  }, [cancelSession, closeBlocked, editor.isDirty, pendingLocalChange, state.confirmation])

  useEffect(() => {
    onRegisterLeaveGuard(requestLeave)
    return () => onRegisterLeaveGuard(null)
  }, [onRegisterLeaveGuard, requestLeave])

  useEffect(() => () => {
    pendingLeaveRef.current?.(false)
    pendingLeaveRef.current = null
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!workspaceRef.current?.contains(document.activeElement)) focusWorkspaceElement(workspaceRef.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const requestClose = () => {
    void requestLeave().then((allowed) => { if (allowed) onClosed() })
  }

  const cancelDiscard = () => {
    if (closingRef.current) return
    setDiscardConfirmationOpen(false)
    pendingLeaveRef.current?.(false)
    pendingLeaveRef.current = null
  }

  const confirmDiscard = async () => {
    if (closeBlocked || !pendingLeaveRef.current) return
    const allowed = await cancelSession()
    discardAllowedRef.current = allowed
    setDiscardConfirmationOpen(false)
    const resolve = pendingLeaveRef.current
    pendingLeaveRef.current = null
    resolve?.(allowed)
  }

  const runConfirmation = async (action: () => Promise<void>) => {
    if (confirmationBusyRef.current) return
    confirmationBusyRef.current = true
    setConfirmationInFlight(true)
    setConfirmationError(null)
    try {
      await action()
    } catch {
      setConfirmationError("无法完成当前确认，请重试；编辑范围和草稿仍被保留。")
    } finally {
      confirmationBusyRef.current = false
      setConfirmationInFlight(false)
    }
  }

  const updateTarget = <K extends keyof PluginFormDraft["target"]>(
    key: K,
    value: PluginFormDraft["target"][K],
  ) => editor.updateDraft((current) => {
    const nextTarget = { ...current.target, [key]: value }
    const addressChanged = (key === "host" || key === "port")
      && value !== current.target[key]
    if (!addressChanged) return { ...current, target: nextTarget }
    const { hostKeyFingerprint: _discardedFingerprint, ...untrustedTarget } = nextTarget
    return { ...current, target: untrustedTarget }
  })
  const updateAuth = <K extends keyof PluginFormDraft["auth"]>(
    key: K,
    value: PluginFormDraft["auth"][K],
  ) => editor.updateDraft((current) => ({
    ...current,
    auth: { ...current.auth, [key]: value },
  }))

  const applyLocalChange = () => {
    if (!pendingLocalChange) return
    if (pendingLocalChange.kind === "auth") {
      updateAuth("type", pendingLocalChange.value as ServerAuthType)
      editor.setCredentials({ ...state.credentials, primary: "" })
    } else {
      editor.updateDraft((current) => ({
        ...current,
        tls: { mode: pendingLocalChange.value as TlsMode },
      }))
    }
    setPendingLocalChange(null)
  }

  const requestAuthChange = (value: string) => {
    const next = value as ServerAuthType
    if (next === draft.auth.type) return
    if (!state.credentials.primary) {
      updateAuth("type", next)
      return
    }
    setPendingLocalChange({ kind: "auth", value: next })
  }
  const requestTlsChange = (value: string) => {
    const next = value as TlsMode
    if (next === draft.tls?.mode) return
    if (next === "disabled" && draft.tls?.mode !== "disabled") {
      setPendingLocalChange({ kind: "tls", value: next })
      return
    }
    editor.updateDraft((current) => ({ ...current, tls: { mode: next } }))
  }

  return (
    <>
      {collapsed ? (
        <aside aria-label="已折叠的插件编辑工作区" className="flex h-full flex-col items-center gap-3 bg-surface py-3">
          <Button aria-label="展开插件编辑工作区" data-testid="detail-expand" onClick={onToggleCollapsed} size="icon-sm" variant="ghost"><CaretLeft /></Button>
          <span className="text-xs text-primary [writing-mode:vertical-rl]">插件编辑{editor.isDirty ? " · 未保存" : ""}</span>
        </aside>
      ) : null}
      <main
          aria-busy={busy || discardInFlight}
          aria-labelledby="plugin-editor-title"
          className="@container/editor flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          data-testid="plugin-editor-workspace"
          data-scope={`${scope.projectId}/${scope.environmentId}`}
          hidden={collapsed}
          id={collapsed ? undefined : "detail-main"}
          ref={workspaceRef}
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLElement && event.target !== event.currentTarget) {
              lastEditorFocusRef.current = event.target
            }
          }}
          style={collapsed ? { display: "none" } : undefined}
          tabIndex={-1}
        >
          <header className="shrink-0 border-b border-border/70 bg-surface px-4 py-3 @min-[640px]/editor:px-6">
            <div className="mb-3 flex min-w-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild><Button aria-label="返回详情" disabled={closeBlocked} onClick={requestClose} size="icon-sm" variant="ghost"><ArrowLeft /></Button></TooltipTrigger>
                <TooltipContent>返回详情，保留原浏览位置</TooltipContent>
              </Tooltip>
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="plugin-editor-scope" title={`${projectName} / ${environmentName}`}>
                {projectName} <span className="px-1 text-muted-foreground/50">/</span> {environmentName}
              </p>
              <Tooltip>
                <TooltipTrigger asChild><Button aria-label={expanded ? "恢复三栏宽度" : "拓宽编辑区"} data-testid="plugin-editor-expand" onClick={onToggleExpanded} size="icon-sm" variant="ghost">{expanded ? <ArrowsInSimple /> : <ArrowsOutSimple />}</Button></TooltipTrigger>
                <TooltipContent>{expanded ? "恢复三栏宽度" : "拓宽编辑区，继续保留环境栏"}</TooltipContent>
              </Tooltip>
              <Button aria-label="折叠详情工作区" data-testid="detail-collapse" onClick={onToggleCollapsed} size="icon-xs" variant="ghost"><CaretRight /></Button>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {typeIcon(draft.pluginType)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h1 className="text-base font-semibold tracking-tight" id="plugin-editor-title">{editor.isCreating ? "新增插件" : "编辑连接配置"}</h1>
                  <Badge variant={editor.isDirty ? "warning" : "outline"}>{editor.isDirty ? "未保存" : "独立编辑工作区"}</Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{editor.isCreating ? "配置新插件，保存后再决定是否连接。" : `${plugin?.displayName} · 修改仅作用于当前插件。`}</p>
              </div>
            </div>
          </header>

          <ScrollArea className="min-h-0 flex-1" data-testid="plugin-editor-scroll">
            <div className="mx-auto w-full max-w-4xl px-4 py-5 @min-[640px]/editor:px-6">
              {state.phase === "preparing" ? (
              <div className="space-y-3" data-testid="plugin-editor-loading">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <form
                className="space-y-5"
                id="plugin-editor-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void editor.save("disconnect")
                }}
              >
                <FieldGroup className="gap-4" inert={saveBlocked}>
                  <FieldSet className="gap-3 rounded-xl border border-border/70 bg-surface/40 p-4" disabled={saveBlocked}>
                    <FieldLegend>基本信息</FieldLegend>
                    {editor.isCreating ? (
                      <Field data-invalid={Boolean(fieldErrors.pluginType)}>
                        <FieldLabel>插件类型</FieldLabel>
                        <Select
                          disabled={busy}
                          onValueChange={(value) => editor.setPluginKind(value as PluginKind)}
                          value={draft.pluginType}
                        >
                          <SelectTrigger className="w-full" aria-label="插件类型">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(PLUGIN_KIND_LABELS) as PluginKind[]).map((kind) => (
                              <SelectItem key={kind} value={kind}>
                                {PLUGIN_KIND_LABELS[kind]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : null}
                    <Field data-invalid={Boolean(fieldErrors.displayName)}>
                      <FieldLabel htmlFor="plugin-display-name">名称</FieldLabel>
                      <Input
                        aria-describedby="plugin-display-name-description"
                        disabled={!editor.isCreating}
                        id="plugin-display-name"
                        maxLength={120}
                        onChange={(event) => editor.updateDraft((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))}
                        placeholder={`例如：生产${PLUGIN_KIND_LABELS[draft.pluginType]}`}
                        value={draft.displayName}
                      />
                      <FieldDescription id="plugin-display-name-description">
                        {editor.isCreating
                          ? "留空时会根据类型和目标自动生成。"
                          : "名称属于独立元数据，不会混入连接配置编辑事务。"}
                      </FieldDescription>
                    </Field>
                    <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
                      <Field data-invalid={Boolean(fieldErrors.host)}>
                        <FieldLabel htmlFor="plugin-host">主机地址</FieldLabel>
                        <Input
                          aria-describedby={fieldErrors.host ? "plugin-host-error" : undefined}
                          aria-invalid={Boolean(fieldErrors.host)}
                          id="plugin-host"
                          onChange={(event) => updateTarget("host", event.target.value)}
                          placeholder="host.internal"
                          value={draft.target.host}
                        />
                        <FieldError id="plugin-host-error">{issueFor(state.issues, "host")}</FieldError>
                      </Field>
                      <Field data-invalid={Boolean(fieldErrors.port)}>
                        <FieldLabel htmlFor="plugin-port">端口</FieldLabel>
                        <Input
                          aria-describedby={fieldErrors.port ? "plugin-port-error" : undefined}
                          aria-invalid={Boolean(fieldErrors.port)}
                          id="plugin-port"
                          inputMode="numeric"
                          max={65535}
                          min={1}
                          onChange={(event) => updateTarget("port", Number(event.target.value))}
                          type="number"
                          value={draft.target.port}
                        />
                        <FieldError id="plugin-port-error">{issueFor(state.issues, "port")}</FieldError>
                      </Field>
                    </div>
                  </FieldSet>

                  <FieldSet className="gap-3 rounded-xl border border-border/70 bg-surface/40 p-4" disabled={saveBlocked}>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLegend>认证</FieldLegend>
                      {state.credentialStatus?.saved ? (
                        <Badge variant="success">已保存凭据</Badge>
                      ) : plugin && state.credentialStatus === null ? (
                        <Badge variant="warning">凭据状态未知</Badge>
                      ) : (
                        <Badge variant="outline">未保存凭据</Badge>
                      )}
                    </div>
                    {draft.pluginType === "server" ? (
                      <Field>
                        <FieldLabel>认证方式</FieldLabel>
                        <Select onValueChange={requestAuthChange} value={draft.auth.type ?? "password"}>
                          <SelectTrigger className="w-full" aria-label="SSH 认证方式">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="password">密码</SelectItem>
                            <SelectItem value="privateKey">私钥</SelectItem>
                            <SelectItem value="agent">SSH Agent</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : null}
                    <Field data-invalid={Boolean(fieldErrors.username)}>
                      <FieldLabel htmlFor="plugin-username">
                        {draft.pluginType === "server" ? "SSH 用户名" : "用户名"}
                      </FieldLabel>
                      <Input
                        aria-describedby={fieldErrors.username ? "plugin-username-error" : undefined}
                        aria-invalid={Boolean(fieldErrors.username)}
                        id="plugin-username"
                        onChange={(event) => updateAuth("username", event.target.value)}
                        value={draft.auth.username}
                      />
                      <FieldError id="plugin-username-error">{issueFor(state.issues, "username")}</FieldError>
                    </Field>
                    {draft.pluginType === "server" && draft.auth.type === "privateKey" ? (
                      <Field data-invalid={Boolean(fieldErrors.privateKeyPath)}>
                        <FieldLabel htmlFor="plugin-private-key">SSH 私钥文件</FieldLabel>
                        <Input
                          aria-describedby={fieldErrors.privateKeyPath ? "plugin-private-key-error" : undefined}
                          aria-invalid={Boolean(fieldErrors.privateKeyPath)}
                          id="plugin-private-key"
                          onChange={(event) => updateAuth("privateKeyPath", event.target.value)}
                          placeholder="C:\\Users\\name\\.ssh\\id_ed25519"
                          value={draft.auth.privateKeyPath ?? ""}
                        />
                        <FieldError id="plugin-private-key-error">
                          {issueFor(state.issues, "privateKeyPath")}
                        </FieldError>
                      </Field>
                    ) : null}
                    {draft.pluginType !== "server" || draft.auth.type !== "agent" ? (
                      <Field data-invalid={Boolean(fieldErrors.primaryCredential)}>
                        <FieldLabel htmlFor="plugin-primary-credential">
                          {draft.pluginType === "server" && draft.auth.type === "privateKey"
                            ? "私钥口令（可选）"
                            : "密码"}
                        </FieldLabel>
                        <Input
                          aria-describedby={
                            fieldErrors.primaryCredential
                              ? "plugin-primary-credential-description plugin-primary-credential-error"
                              : "plugin-primary-credential-description"
                          }
                          aria-invalid={Boolean(fieldErrors.primaryCredential)}
                          autoComplete="new-password"
                          id="plugin-primary-credential"
                          onChange={(event) => editor.setCredentials({
                            ...state.credentials,
                            primary: event.target.value,
                          })}
                          placeholder={state.credentialStatus?.fields.primary
                            ? "已保存；输入新值才会替换"
                            : "输入凭据"}
                          type="password"
                          value={state.credentials.primary}
                        />
                        <FieldDescription id="plugin-primary-credential-description">
                          已保存值不会显示。留空表示保持不变，只有明确输入的非空值会发送。
                        </FieldDescription>
                        <FieldError id="plugin-primary-credential-error">
                          {issueFor(state.issues, "primaryCredential")}
                        </FieldError>
                      </Field>
                    ) : null}
                  </FieldSet>

                  {plugin ? (
                    <CredentialMigrationNotice
                      api={api}
                      onMigrated={() => void editor.refreshCredentialStatus()}
                      plugin={plugin}
                      status={state.credentialStatus}
                    />
                  ) : null}

                  {draft.pluginType === "mysql" ? (
                    <FieldSet className="gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <FieldLegend>固定数据库</FieldLegend>
                        <Button
                          disabled={busy || state.databasesLoading}
                          onClick={() => void editor.discoverDatabases()}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          {state.databasesLoading ? "读取中" : "读取数据库"}
                        </Button>
                      </div>
                      <Field data-invalid={Boolean(fieldErrors.database)}>
                        <FieldLabel htmlFor="plugin-database">数据库名称</FieldLabel>
                        <Input
                          aria-describedby={fieldErrors.database ? "plugin-database-error" : undefined}
                          aria-invalid={Boolean(fieldErrors.database)}
                          id="plugin-database"
                          onChange={(event) => updateTarget("database", event.target.value)}
                          placeholder="orders"
                          value={draft.target.database ?? ""}
                        />
                        <FieldError id="plugin-database-error">
                          {issueFor(state.issues, "database")}
                        </FieldError>
                      </Field>
                      {state.databases.length > 0 ? (
                        <Field>
                          <FieldLabel>可见数据库</FieldLabel>
                          <Select
                            onValueChange={(value) => updateTarget("database", value)}
                            {...(draft.target.database ? { value: draft.target.database } : {})}
                          >
                            <SelectTrigger className="w-full" aria-label="选择可见数据库">
                              <SelectValue placeholder="选择数据库" />
                            </SelectTrigger>
                            <SelectContent>
                              {state.databases.map((database) => (
                                <SelectItem key={database} value={database}>{database}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                      {state.databasesTruncated ? (
                        <FieldDescription>数据库列表仅显示前 200 项；其他数据库可以手动填写名称。</FieldDescription>
                      ) : null}
                    </FieldSet>
                  ) : null}

                  {draft.pluginType === "redis" ? (
                    <Field data-invalid={Boolean(fieldErrors.redisDb)}>
                      <FieldLabel htmlFor="plugin-redis-db">逻辑数据库编号</FieldLabel>
                      <Input
                        aria-describedby={fieldErrors.redisDb ? "plugin-redis-db-error" : undefined}
                        aria-invalid={Boolean(fieldErrors.redisDb)}
                        id="plugin-redis-db"
                        max={15}
                        min={0}
                        onChange={(event) => updateTarget("db", Number(event.target.value))}
                        type="number"
                        value={draft.target.db ?? 0}
                      />
                      <FieldError id="plugin-redis-db-error">
                        {issueFor(state.issues, "redisDb")}
                      </FieldError>
                    </Field>
                  ) : null}

                  <Collapsible defaultOpen={false}>
                    <CollapsibleTrigger asChild>
                      <Button className="group/advanced w-full justify-between" type="button" variant="outline">
                        高级连接设置
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
                          <span className="truncate">{advancedConnectionSummary(draft)}</span>
                          <CaretDown
                            aria-hidden="true"
                            className="shrink-0 transition-transform group-data-[state=open]/advanced:rotate-180"
                          />
                        </span>
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 space-y-4 rounded-lg border border-border bg-surface-inset p-3">
                      <Field>
                        <FieldLabel>地址策略</FieldLabel>
                        <Select
                          onValueChange={(value) => updateTarget("addressFamily", value as AddressFamily)}
                          value={draft.target.addressFamily}
                        >
                          <SelectTrigger className="w-full" aria-label="地址策略">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ipv4Preferred">IPv4 优先</SelectItem>
                            <SelectItem value="ipv4Only">仅 IPv4</SelectItem>
                            <SelectItem value="ipv6Preferred">IPv6 优先</SelectItem>
                            <SelectItem value="ipv6Only">仅 IPv6</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      {draft.pluginType === "server" ? (
                        <ServerUplinkFields
                          draft={draft}
                          errors={fieldErrors}
                          onChange={(uplink) => editor.updateDraft((current) => ({ ...current, uplink }))}
                          onCredentialChange={(proxy) => editor.setCredentials({ ...state.credentials, proxy })}
                          proxyCredential={state.credentials.proxy}
                          proxyStored={Boolean(state.credentialStatus?.fields.proxy)}
                        />
                      ) : (
                        <DataTransportFields
                          availableServers={availableServers}
                          draft={draft}
                          errors={fieldErrors}
                          onChange={(transport) => editor.updateDraft((current) => ({ ...current, transport }))}
                        />
                      )}
                      {draft.pluginType !== "server" ? (
                        <Field>
                          <FieldLabel>TLS</FieldLabel>
                          <Select onValueChange={requestTlsChange} value={draft.tls?.mode ?? "disabled"}>
                            <SelectTrigger className="w-full" aria-label="TLS 模式">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="disabled">关闭</SelectItem>
                              <SelectItem value="preferred">加密，不校验证书</SelectItem>
                              <SelectItem value="required">必须加密</SelectItem>
                              <SelectItem value="verifyIdentity">加密并校验身份</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                    </CollapsibleContent>
                  </Collapsible>
                </FieldGroup>

                <PluginValidationProgress
                  onCancel={() => void editor.cancelValidation()}
                  validation={state.validation}
                />
              </form>
              )}
            </div>
          </ScrollArea>

          <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 @min-[640px]/editor:px-6" data-testid="plugin-editor-footer">
            {state.error ? (
              <Alert className="mx-auto mb-3 max-w-4xl" data-testid="plugin-editor-error" variant="destructive">
                <WarningCircle aria-hidden="true" weight="fill" />
                <AlertTitle>插件配置未保存</AlertTitle>
                <AlertDescription className="max-h-24 overflow-y-auto break-words" tabIndex={0}>{state.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 @min-[560px]/editor:flex-row @min-[560px]/editor:items-center @min-[560px]/editor:justify-between">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={saveBlocked}
                  onClick={() => void editor.validate("validate")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  检查连接
                </Button>
                {draft.pluginType !== "server" ? (
                  <Button
                    disabled={saveBlocked}
                    onClick={() => void editor.validate("tls")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    TLS 探测
                  </Button>
                ) : null}
              </div>
              <div className="flex w-full min-w-0 gap-2 @min-[560px]/editor:w-auto">
                <Button className="shrink-0" data-testid="plugin-editor-cancel" disabled={closeBlocked} onClick={requestClose} size="sm" type="button" variant="outline">
                  {discardInFlight ? "正在结束" : "取消"}
                </Button>
                <ButtonGroup aria-label="插件保存方式" className="min-w-0 flex-1 @min-[560px]/editor:flex-none">
                  <Button
                    className="min-w-0 flex-1 @min-[560px]/editor:flex-none"
                    data-testid="plugin-save-disconnected"
                    disabled={saveBlocked}
                    form="plugin-editor-form"
                    size="sm"
                    type="submit"
                  >
                    <FloppyDisk aria-hidden="true" />
                    <span className="truncate">
                      {state.phase === "saving"
                        ? "保存中"
                        : editor.isCreating
                          ? "添加但不连接"
                          : "保存但不连接"}
                    </span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="选择其他保存方式"
                        className="shrink-0 px-2"
                        data-testid="plugin-save-options"
                        disabled={saveBlocked}
                        size="sm"
                        type="button"
                      >
                        <CaretDown aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuLabel>保存后连接状态</DropdownMenuLabel>
                      <DropdownMenuItem
                        data-testid="plugin-save-and-connect"
                        onSelect={() => void editor.save("connect-current")}
                      >
                        <PlugsConnected aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {editor.isCreating ? "添加并连接" : "保存并连接"}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground">
                            保存成功后，明确发起当前插件连接。
                          </span>
                        </span>
                      </DropdownMenuItem>
                      {!editor.isCreating ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            data-testid="plugin-save-and-restore"
                            onSelect={() => void editor.save("restore-previous")}
                          >
                            <ArrowCounterClockwise aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block font-medium">保存并恢复连接</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground">
                                恢复进入编辑前已连接的插件集合。
                              </span>
                            </span>
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
              </div>
            </div>
          </footer>
      </main>

      <PluginEditorConfirmations
        busy={busy}
        confirmation={state.confirmation}
        error={confirmationError ?? state.error?.message ?? null}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => {
            if (!focusWorkspaceElement(lastEditorFocusRef.current)) {
              focusWorkspaceElement(workspaceRef.current ?? document.getElementById("detail-main"))
            }
          })
        }}
        onAcceptCredentialReplacement={() => void runConfirmation(editor.confirmCredentialReplacement)}
        onAcceptEditImpact={() => void runConfirmation(editor.acceptEditImpact)}
        onAcceptHostKey={() => void runConfirmation(editor.acceptHostKey)}
        onAcceptTlsFallback={() => void runConfirmation(editor.acceptTlsFallback)}
        onRejectCredentialReplacement={editor.rejectConfirmation}
        onRejectEditImpact={() => void runConfirmation(editor.rejectEditImpact)}
        onRejectHostKey={editor.rejectConfirmation}
      />

      <AlertDialog
        onOpenChange={(nextOpen) => {
          if (!nextOpen) cancelDiscard()
        }}
        open={discardConfirmationOpen}
      >
        <AlertDialogContent
          ref={discardDialogRef}
          aria-busy={discardInFlight || undefined}
          data-testid="plugin-unsaved-changes-confirmation"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (discardAllowedRef.current) {
              requestAnimationFrame(() => focusWorkspaceElement(document.getElementById("detail-main")))
              return
            }
            requestAnimationFrame(() => {
              if (!focusWorkspaceElement(lastEditorFocusRef.current)) focusWorkspaceElement(workspaceRef.current)
            })
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-warning">
              <Warning aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              连接配置或替换凭据尚未保存。放弃后将恢复进入编辑前的连接状态，并清除本次输入的临时凭据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardInFlight} onClick={cancelDiscard}>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              disabled={discardInFlight}
              onClick={(event) => {
                event.preventDefault()
                void confirmDiscard()
              }}
              variant="destructive"
            >
              {discardInFlight ? "正在安全结束" : "放弃更改"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={(open) => { if (!open) setPendingLocalChange(null) }} open={pendingLocalChange !== null}>
        <AlertDialogContent
          data-testid="plugin-local-change-confirmation"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => {
              if (!focusWorkspaceElement(lastEditorFocusRef.current)) focusWorkspaceElement(workspaceRef.current)
            })
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-warning">
              {pendingLocalChange?.kind === "auth" ? <LockKey /> : <ShieldWarning />}
            </AlertDialogMedia>
            <AlertDialogTitle>
              {pendingLocalChange?.kind === "auth" ? "切换认证方式？" : "关闭当前草稿的 TLS？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingLocalChange?.kind === "auth"
                ? "认证方式会改变凭据绑定。当前输入的临时凭据将立即从 Renderer 内存中清除，已保存凭据不会显示或自动复制。"
                : "这只修改当前草稿，正式配置在保存前不会改变。关闭 TLS 会降低传输保护。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingLocalChange(null)}>保持当前设置</AlertDialogCancel>
            <AlertDialogAction onClick={applyLocalChange}>确认更改</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface ServerUplinkFieldsProps {
  readonly draft: PluginFormDraft
  readonly errors: Readonly<Record<string, string>>
  readonly proxyCredential: string
  readonly proxyStored: boolean
  readonly onChange: (uplink: NonNullable<PluginFormDraft["uplink"]>) => void
  readonly onCredentialChange: (value: string) => void
}

function ServerUplinkFields({
  draft,
  errors,
  proxyCredential,
  proxyStored,
  onChange,
  onCredentialChange,
}: ServerUplinkFieldsProps) {
  const uplink = draft.uplink ?? { type: "direct" as const }
  return (
    <>
      <Field>
        <FieldLabel>SSH 上行</FieldLabel>
        <Select
          onValueChange={(value) => {
            if (value === uplink.type) return
            onCredentialChange("")
            onChange(emptyServerUplink(value as ServerUplinkType))
          }}
          value={uplink.type}
        >
          <SelectTrigger className="w-full" aria-label="SSH 上行方式"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="direct">直接连接</SelectItem>
            <SelectItem value="socks5">SOCKS5 代理</SelectItem>
            <SelectItem value="http">HTTP 代理</SelectItem>
            <SelectItem value="windowsVpn">Windows VPN</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {["socks5", "http"].includes(uplink.type) ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
            <Field data-invalid={Boolean(errors.proxyHost)}>
              <FieldLabel htmlFor="plugin-proxy-host">代理主机</FieldLabel>
              <Input
                aria-describedby={errors.proxyHost ? "plugin-proxy-host-error" : undefined}
                aria-invalid={Boolean(errors.proxyHost)}
                id="plugin-proxy-host"
                onChange={(event) => onChange({ ...uplink, host: event.target.value })}
                value={uplink.host ?? ""}
              />
              <FieldError id="plugin-proxy-host-error">{errors.proxyHost}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.proxyPort)}>
              <FieldLabel htmlFor="plugin-proxy-port">代理端口</FieldLabel>
              <Input
                aria-describedby={errors.proxyPort ? "plugin-proxy-port-error" : undefined}
                aria-invalid={Boolean(errors.proxyPort)}
                id="plugin-proxy-port"
                max={65535}
                min={1}
                onChange={(event) => onChange({ ...uplink, port: Number(event.target.value) })}
                type="number"
                value={uplink.port ?? (uplink.type === "socks5" ? 1080 : 8080)}
              />
              <FieldError id="plugin-proxy-port-error">{errors.proxyPort}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel>代理用户名（可选）</FieldLabel>
            <Input
              onChange={(event) => onChange({ ...uplink, username: event.target.value })}
              value={uplink.username ?? ""}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="plugin-proxy-credential">代理密码（可选）</FieldLabel>
            <Input
              aria-describedby="plugin-proxy-credential-description"
              autoComplete="new-password"
              id="plugin-proxy-credential"
              onChange={(event) => onCredentialChange(event.target.value)}
              placeholder={proxyStored ? "已保存；输入新值才会替换" : "输入代理密码"}
              type="password"
              value={proxyCredential}
            />
            <FieldDescription id="plugin-proxy-credential-description">
              已保存值不会显示或自动填入。
            </FieldDescription>
          </Field>
        </>
      ) : null}
      {uplink.type === "windowsVpn" ? (
        <Field data-invalid={Boolean(errors.vpnAlias)}>
          <FieldLabel htmlFor="plugin-server-vpn-alias">Windows VPN 网卡</FieldLabel>
          <Input
            aria-describedby={errors.vpnAlias ? "plugin-server-vpn-alias-error" : undefined}
            aria-invalid={Boolean(errors.vpnAlias)}
            id="plugin-server-vpn-alias"
            onChange={(event) => onChange({ ...uplink, interfaceAlias: event.target.value })}
            value={uplink.interfaceAlias ?? ""}
          />
          <FieldError id="plugin-server-vpn-alias-error">{errors.vpnAlias}</FieldError>
        </Field>
      ) : null}
    </>
  )
}

interface DataTransportFieldsProps {
  readonly draft: PluginFormDraft
  readonly errors: Readonly<Record<string, string>>
  readonly availableServers: readonly PluginRecord[]
  readonly onChange: (transport: NonNullable<PluginFormDraft["transport"]>) => void
}

function DataTransportFields({ draft, errors, availableServers, onChange }: DataTransportFieldsProps) {
  const transport = draft.transport ?? { kind: "direct" as const }
  return (
    <>
      <Field>
        <FieldLabel>连接路径</FieldLabel>
        <Select
          onValueChange={(value) => onChange({ kind: value as DataTransportKind })}
          value={transport.kind}
        >
          <SelectTrigger className="w-full" aria-label="连接路径"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="direct">直接连接</SelectItem>
            <SelectItem value="serverTunnel">Server 隧道</SelectItem>
            <SelectItem value="windowsVpn">Windows VPN</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {transport.kind === "serverTunnel" ? (
        <Field data-invalid={Boolean(errors.tunnelServer)}>
          <FieldLabel htmlFor="plugin-tunnel-server">隧道 Server</FieldLabel>
          <Select
            onValueChange={(value) => onChange({ ...transport, serverPluginInstanceId: value })}
            {...(transport.serverPluginInstanceId ? { value: transport.serverPluginInstanceId } : {})}
          >
            <SelectTrigger
              aria-describedby={errors.tunnelServer ? "plugin-tunnel-server-error" : undefined}
              aria-invalid={Boolean(errors.tunnelServer)}
              aria-label="隧道 Server"
              className="w-full"
              id="plugin-tunnel-server"
            >
              <SelectValue placeholder="选择同环境 Server" />
            </SelectTrigger>
            <SelectContent>
              {availableServers.map((server) => (
                <SelectItem key={server.pluginInstanceId} value={server.pluginInstanceId}>
                  {server.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError id="plugin-tunnel-server-error">{errors.tunnelServer}</FieldError>
        </Field>
      ) : null}
      {transport.kind === "windowsVpn" ? (
        <Field data-invalid={Boolean(errors.vpnAlias)}>
          <FieldLabel htmlFor="plugin-data-vpn-alias">Windows VPN 网卡</FieldLabel>
          <Input
            aria-describedby={errors.vpnAlias ? "plugin-data-vpn-alias-error" : undefined}
            aria-invalid={Boolean(errors.vpnAlias)}
            id="plugin-data-vpn-alias"
            onChange={(event) => onChange({ ...transport, interfaceAlias: event.target.value })}
            value={transport.interfaceAlias ?? ""}
          />
          <FieldError id="plugin-data-vpn-alias-error">{errors.vpnAlias}</FieldError>
        </Field>
      ) : null}
    </>
  )
}
