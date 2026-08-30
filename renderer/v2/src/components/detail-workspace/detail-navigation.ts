export type DetailTabId =
  | "overview"
  | "agent"
  | "runbook"
  | "questions"
  | "audit"
  | "confirmations"

export type DetailSelectionKind =
  | "project"
  | "environment"
  | "plugin"
  | "unknown-plugin"

export interface DetailTabDescriptor {
  readonly label: string
  readonly value: DetailTabId
}

const PROJECT_TABS: readonly DetailTabDescriptor[] = [
  { value: "overview", label: "项目概览" },
]

const ENVIRONMENT_TABS: readonly DetailTabDescriptor[] = [
  { value: "overview", label: "环境详情" },
  { value: "runbook", label: "运维说明" },
  { value: "questions", label: "快捷提问" },
  { value: "audit", label: "环境记录" },
  { value: "confirmations", label: "操作确认" },
]

const PLUGIN_TABS: readonly DetailTabDescriptor[] = [
  { value: "overview", label: "插件详情" },
  { value: "agent", label: "Agent 权限" },
  { value: "audit", label: "插件记录" },
  { value: "confirmations", label: "操作确认" },
]

const UNKNOWN_PLUGIN_TABS: readonly DetailTabDescriptor[] = [
  { value: "overview", label: "插件详情" },
  { value: "audit", label: "插件记录" },
  { value: "confirmations", label: "操作确认" },
]

export function detailTabsForSelection(
  kind: DetailSelectionKind,
): readonly DetailTabDescriptor[] {
  if (kind === "environment") return ENVIRONMENT_TABS
  if (kind === "plugin") return PLUGIN_TABS
  if (kind === "unknown-plugin") return UNKNOWN_PLUGIN_TABS
  return PROJECT_TABS
}

export function isDetailTabAllowed(
  kind: DetailSelectionKind,
  value: string,
): value is DetailTabId {
  return detailTabsForSelection(kind).some((tab) => tab.value === value)
}

export function detailSelectionKind(
  hasEnvironment: boolean,
  pluginType: string | null,
): DetailSelectionKind {
  if (pluginType === "unknown") return "unknown-plugin"
  if (pluginType) return "plugin"
  return hasEnvironment ? "environment" : "project"
}
