import type {
  CredentialMutation,
  PluginDraft,
  PluginPatch,
  PluginRecord,
  PluginScope,
  SecretMap,
} from "@/bridge/ai-ops-v2"

export type PluginKind = "server" | "mysql" | "redis"
export type AddressFamily =
  | "ipv4Preferred"
  | "ipv4Only"
  | "ipv6Preferred"
  | "ipv6Only"
export type ServerAuthType = "password" | "privateKey" | "agent"
export type ServerUplinkType = "direct" | "socks5" | "http" | "windowsVpn"
export type DataTransportKind = "direct" | "serverTunnel" | "windowsVpn"
export type TlsMode = "disabled" | "preferred" | "required" | "verifyIdentity"

export interface PluginTargetDraft {
  readonly host: string
  readonly port: number
  readonly addressFamily: AddressFamily
  readonly database?: string
  readonly db?: number
  readonly hostKeyFingerprint?: string
}

export interface PluginAuthDraft {
  readonly username: string
  readonly type?: ServerAuthType
  readonly privateKeyPath?: string
}

export interface ServerUplinkDraft {
  readonly type: ServerUplinkType
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly interfaceAlias?: string
}

export interface DataTransportDraft {
  readonly kind: DataTransportKind
  readonly serverPluginInstanceId?: string
  readonly interfaceAlias?: string
}

export interface PluginTlsDraft {
  readonly mode: TlsMode
}

export interface PluginFormDraft {
  readonly pluginType: PluginKind
  readonly pluginInstanceId?: string
  readonly displayName: string
  readonly target: PluginTargetDraft
  readonly auth: PluginAuthDraft
  readonly uplink?: ServerUplinkDraft
  readonly transport?: DataTransportDraft
  readonly tls?: PluginTlsDraft
  readonly sources?: readonly unknown[]
}

export interface PluginCredentialDraft {
  readonly primary: string
  readonly proxy: string
}

export function emptyServerUplink(type: ServerUplinkType): ServerUplinkDraft {
  if (type === "socks5") return { type, port: 1080 }
  if (type === "http") return { type, port: 8080 }
  return { type }
}

export interface PluginFormIssue {
  readonly field: string
  readonly message: string
}

export interface PluginConfigurationRecord extends PluginRecord {
  readonly target?: Readonly<Record<string, unknown>>
  readonly auth?: Readonly<Record<string, unknown>>
  readonly uplink?: Readonly<Record<string, unknown>>
  readonly transport?: Readonly<Record<string, unknown>>
  readonly tls?: Readonly<Record<string, unknown>>
  readonly limits?: Readonly<Record<string, unknown>>
  readonly sources?: readonly unknown[]
}

export const PLUGIN_KIND_LABELS: Readonly<Record<PluginKind, string>> = {
  server: "Server",
  mysql: "MySQL",
  redis: "Redis",
}

export const DEFAULT_PORTS: Readonly<Record<PluginKind, number>> = {
  server: 22,
  mysql: 3306,
  redis: 6379,
}

const PLUGIN_KINDS = new Set<PluginKind>(["server", "mysql", "redis"])
const ADDRESS_FAMILIES = new Set<AddressFamily>([
  "ipv4Preferred",
  "ipv4Only",
  "ipv6Preferred",
  "ipv6Only",
])
const SERVER_AUTH_TYPES = new Set<ServerAuthType>(["password", "privateKey", "agent"])
const SERVER_UPLINK_TYPES = new Set<ServerUplinkType>(["direct", "socks5", "http", "windowsVpn"])
const DATA_TRANSPORT_KINDS = new Set<DataTransportKind>(["direct", "serverTunnel", "windowsVpn"])
const TLS_MODES = new Set<TlsMode>(["disabled", "preferred", "required", "verifyIdentity"])

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function readString(record: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  const value = record[key]
  return typeof value === "string" ? value : fallback
}

function readInteger(record: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = record[key]
  return typeof value === "number" && Number.isInteger(value) ? value : fallback
}

function readEnum<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: ReadonlySet<T>,
  fallback: T,
): T {
  const value = record[key]
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback
}

export function isPluginKind(value: string): value is PluginKind {
  return PLUGIN_KINDS.has(value as PluginKind)
}

export function createPluginInstanceId(kind: PluginKind): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${kind}-${random}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 63)
}

export function emptyPluginDraft(kind: PluginKind): PluginFormDraft {
  const base = {
    pluginType: kind,
    pluginInstanceId: createPluginInstanceId(kind),
    displayName: "",
    target: {
      host: "",
      port: DEFAULT_PORTS[kind],
      addressFamily: "ipv4Preferred" as const,
    },
    auth: { username: "" },
  }

  if (kind === "server") {
    return {
      ...base,
      auth: { username: "", type: "password" },
      uplink: { type: "direct" },
      sources: [],
    }
  }
  if (kind === "mysql") {
    return {
      ...base,
      target: { ...base.target, database: "" },
      transport: { kind: "direct" },
      tls: { mode: "preferred" },
    }
  }
  return {
    ...base,
    target: { ...base.target, db: 0 },
    transport: { kind: "direct" },
    tls: { mode: "disabled" },
  }
}

export function pluginDraftFromRecord(record: PluginConfigurationRecord): PluginFormDraft {
  const kind = isPluginKind(record.pluginType) ? record.pluginType : "server"
  const target = asRecord(record.target)
  const auth = asRecord(record.auth)
  const common = {
    pluginType: kind,
    pluginInstanceId: record.pluginInstanceId,
    displayName: record.displayName,
    target: {
      host: readString(target, "host"),
      port: readInteger(target, "port", DEFAULT_PORTS[kind]),
      addressFamily: readEnum(target, "addressFamily", ADDRESS_FAMILIES, "ipv4Preferred"),
    },
    auth: { username: readString(auth, "username") },
  }

  if (kind === "server") {
    const uplink = asRecord(record.uplink)
    const authType = readEnum(auth, "type", SERVER_AUTH_TYPES, "password")
    const privateKeyPath = readString(auth, "privateKeyPath")
    const uplinkType = readEnum(uplink, "type", SERVER_UPLINK_TYPES, "direct")
    const hostKeyFingerprint = readString(target, "hostKeyFingerprint")
    return {
      ...common,
      target: {
        ...common.target,
        ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
      },
      auth: {
        ...common.auth,
        type: authType,
        ...(privateKeyPath ? { privateKeyPath } : {}),
      },
      uplink: {
        type: uplinkType,
        ...(["socks5", "http"].includes(uplinkType)
          ? {
              host: readString(uplink, "host"),
              port: readInteger(uplink, "port", uplinkType === "socks5" ? 1080 : 8080),
              username: readString(uplink, "username"),
            }
          : {}),
        ...(uplinkType === "windowsVpn"
          ? { interfaceAlias: readString(uplink, "interfaceAlias") }
          : {}),
      },
      sources: record.sources ?? [],
    }
  }

  const transport = asRecord(record.transport)
  const transportKind = readEnum(transport, "kind", DATA_TRANSPORT_KINDS, "direct")
  const tls = asRecord(record.tls)
  const transportDraft: DataTransportDraft = {
    kind: transportKind,
    ...(transportKind === "serverTunnel"
      ? { serverPluginInstanceId: readString(transport, "serverPluginInstanceId") }
      : {}),
    ...(transportKind === "windowsVpn"
      ? { interfaceAlias: readString(transport, "interfaceAlias") }
      : {}),
  }
  if (kind === "mysql") {
    return {
      ...common,
      target: { ...common.target, database: readString(target, "database") },
      transport: transportDraft,
      tls: { mode: readEnum(tls, "mode", TLS_MODES, "preferred") },
    }
  }
  return {
    ...common,
    target: { ...common.target, db: readInteger(target, "db", 0) },
    transport: transportDraft,
    tls: { mode: readEnum(tls, "mode", TLS_MODES, "disabled") },
  }
}

export function pluginScopeOf(record: PluginRecord): PluginScope {
  return {
    projectId: record.projectId,
    environmentId: record.environmentId,
    pluginInstanceId: record.pluginInstanceId,
  }
}

export function defaultPluginDisplayName(draft: PluginFormDraft): string {
  const host = draft.target.host || "新连接"
  if (draft.pluginType === "server") return `Server · ${host}`.slice(0, 120)
  if (draft.pluginType === "mysql") {
    return `MySQL · ${host} · ${draft.target.database || "未选择数据库"}`.slice(0, 120)
  }
  return `Redis · ${host} · DB ${draft.target.db ?? 0}`.slice(0, 120)
}

export function normalizePluginDraft(draft: PluginFormDraft): PluginFormDraft {
  const displayName = draft.displayName.trim() || defaultPluginDisplayName(draft)
  const target = {
    ...draft.target,
    host: draft.target.host.trim(),
  }
  const auth = {
    ...draft.auth,
    username: draft.auth.username.trim(),
    ...(draft.auth.privateKeyPath !== undefined
      ? { privateKeyPath: draft.auth.privateKeyPath.trim() }
      : {}),
  }
  if (draft.pluginType === "server") {
    const uplink = draft.uplink ?? { type: "direct" as const }
    return {
      ...draft,
      displayName,
      target,
      auth,
      uplink: {
        ...uplink,
        ...(uplink.host !== undefined ? { host: uplink.host.trim() } : {}),
        ...(uplink.username !== undefined ? { username: uplink.username.trim() } : {}),
        ...(uplink.interfaceAlias !== undefined
          ? { interfaceAlias: uplink.interfaceAlias.trim() }
          : {}),
      },
    }
  }
  const transport = draft.transport ?? { kind: "direct" as const }
  return {
    ...draft,
    displayName,
    target,
    auth,
    transport: {
      ...transport,
      ...(transport.serverPluginInstanceId !== undefined
        ? { serverPluginInstanceId: transport.serverPluginInstanceId.trim() }
        : {}),
      ...(transport.interfaceAlias !== undefined
        ? { interfaceAlias: transport.interfaceAlias.trim() }
        : {}),
    },
  }
}

export function validatePluginDraft(draft: PluginFormDraft, purpose = "validate"): readonly PluginFormIssue[] {
  const issues: PluginFormIssue[] = []
  const port = draft.target.port
  if (!draft.target.host.trim()) issues.push({ field: "host", message: "请填写主机地址。" })
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push({ field: "port", message: "端口必须是 1 到 65535 之间的整数。" })
  }
  if (["server", "mysql"].includes(draft.pluginType) && !draft.auth.username.trim()) {
    issues.push({ field: "username", message: "请填写用户名。" })
  }
  if (draft.pluginType === "server") {
    if (draft.auth.type === "privateKey" && !draft.auth.privateKeyPath?.trim()) {
      issues.push({ field: "privateKeyPath", message: "请填写 SSH 私钥文件。" })
    }
    const uplink = draft.uplink ?? { type: "direct" as const }
    if (["socks5", "http"].includes(uplink.type)) {
      if (!uplink.host?.trim()) issues.push({ field: "proxyHost", message: "请填写代理地址。" })
      if (!Number.isInteger(uplink.port) || Number(uplink.port) < 1 || Number(uplink.port) > 65_535) {
        issues.push({ field: "proxyPort", message: "代理端口必须是 1 到 65535 之间的整数。" })
      }
    }
    if (uplink.type === "windowsVpn" && !uplink.interfaceAlias?.trim()) {
      issues.push({ field: "vpnAlias", message: "请填写 Windows VPN 网卡名称。" })
    }
  } else {
    const transport = draft.transport ?? { kind: "direct" as const }
    if (transport.kind === "serverTunnel" && !transport.serverPluginInstanceId?.trim()) {
      issues.push({ field: "tunnelServer", message: "请选择同环境的 Server 隧道。" })
    }
    if (transport.kind === "windowsVpn" && !transport.interfaceAlias?.trim()) {
      issues.push({ field: "vpnAlias", message: "请填写 Windows VPN 网卡名称。" })
    }
  }
  if (draft.pluginType === "mysql" && purpose !== "tls" && !draft.target.database?.trim()) {
    issues.push({ field: "database", message: "请选择或填写固定数据库。" })
  }
  if (draft.pluginType === "redis") {
    const db = draft.target.db
    if (!Number.isInteger(db) || Number(db) < 0 || Number(db) > 15) {
      issues.push({ field: "redisDb", message: "Redis Logical DB 必须是 0 到 15 之间的整数。" })
    }
  }
  return issues
}

export function collectReplacementSecrets(
  kind: PluginKind,
  authType: ServerAuthType | undefined,
  credential: PluginCredentialDraft,
): SecretMap {
  const entries: Array<readonly [string, string]> = []
  if (credential.primary.length > 0) {
    entries.push([
      kind === "server" && authType === "privateKey" ? "privateKeyPassphrase" : "password",
      credential.primary,
    ])
  }
  if (kind === "server" && credential.proxy.length > 0) {
    entries.push(["proxyPassword", credential.proxy])
  }
  return Object.freeze(Object.fromEntries(entries))
}

export function credentialMutationFor(secrets: SecretMap): CredentialMutation {
  return Object.keys(secrets).length > 0 ? "replace" : "unchanged"
}

export function emptyCredentialDraft(): PluginCredentialDraft {
  return { primary: "", proxy: "" }
}

export function asPluginDraft(draft: PluginFormDraft): PluginDraft {
  return draft as unknown as PluginDraft
}

export function connectionPatch(draft: PluginFormDraft): PluginPatch {
  const normalized = normalizePluginDraft(draft)
  const patch: Record<string, unknown> = {
    target: normalized.target,
    auth: normalized.auth,
  }
  if (normalized.pluginType === "server") patch.uplink = normalized.uplink
  else {
    patch.transport = normalized.transport
    patch.tls = normalized.tls
  }
  return patch
}
