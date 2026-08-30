import type { PublicError } from "@/bridge/ai-ops-v2"
import type {
  WorkspaceEnvironmentReadModel,
  WorkspaceProjectReadModel,
} from "@/features/workspace/workspace-read-model"

export const ENVIRONMENT_NAME_MAX_LENGTH = 120

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const DISPLAYABLE_ERROR_CODES = new Set([
  "CONFIG_REVISION_CONFLICT",
  "DUPLICATE_ENVIRONMENT_NAME",
  "ENVIRONMENT_CONNECTED",
  "ENVIRONMENT_NOT_EMPTY",
  "ENVIRONMENT_NOT_FOUND",
  "INVALID_ARGUMENT",
  "POLICY_DENIED",
  "PROJECT_NOT_FOUND",
  "RESULT_LIMIT_EXCEEDED",
  "SCOPE_MISMATCH",
])

export type EnvironmentNameValidationResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ message: string; ok: false }>

export interface EnvironmentDeleteAssessment {
  readonly allowed: boolean
  readonly message: string
}

export interface EnvironmentOrderMove {
  readonly announcement: string
  readonly changed: boolean
  readonly order: readonly string[]
}

export function normalizeEnvironmentName(value: string): EnvironmentNameValidationResult {
  const name = value.normalize("NFKC").trim()
  if (!name) return { message: "请输入环境名称。", ok: false }
  if (name.length > ENVIRONMENT_NAME_MAX_LENGTH) {
    return { message: `环境名称不能超过 ${ENVIRONMENT_NAME_MAX_LENGTH} 个字符。`, ok: false }
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { message: "环境名称不能包含控制字符。", ok: false }
  }
  return { ok: true, value: name }
}

export function environmentNameIsDuplicate(
  project: WorkspaceProjectReadModel,
  name: string,
  exceptEnvironmentId?: string,
): boolean {
  const nameKey = name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
  return project.environments.some(
    (environment) =>
      environment.environmentId !== exceptEnvironmentId &&
      environment.name.normalize("NFKC").toLocaleLowerCase("zh-CN") === nameKey,
  )
}

export function environmentBelongsToProject(
  project: WorkspaceProjectReadModel,
  environment: WorkspaceEnvironmentReadModel,
): boolean {
  return (
    environment.projectId === project.projectId &&
    project.environments.some(
      (candidate) =>
        candidate.projectId === project.projectId &&
        candidate.environmentId === environment.environmentId,
    )
  )
}

export function assessEnvironmentDeletion(
  project: WorkspaceProjectReadModel,
  environment: WorkspaceEnvironmentReadModel,
): EnvironmentDeleteAssessment {
  const current = project.environments.find(
    (candidate) =>
      candidate.projectId === project.projectId &&
      candidate.environmentId === environment.environmentId,
  )
  if (
    project.isolated ||
    environment.projectId !== project.projectId ||
    !current
  ) {
    return { allowed: false, message: "环境范围无效，无法删除。" }
  }
  if (project.environments.length <= 1) {
    return { allowed: false, message: "项目至少需要保留一个环境。" }
  }
  if (current.pluginCount > 0) {
    return {
      allowed: false,
      message: `请先处理该环境的 ${current.pluginCount} 个插件。`,
    }
  }
  if (
    current.runtime.desiredConnected ||
    current.runtime.phase !== "disconnected"
  ) {
    return { allowed: false, message: "请先断开该环境。" }
  }
  return {
    allowed: true,
    message: `确定删除“${current.name}”的配置和运维说明？本机加密凭据会继续保留。`,
  }
}

export function suggestedEnvironmentAfterDelete(
  environments: readonly WorkspaceEnvironmentReadModel[],
  environmentId: string,
): string | null {
  const index = environments.findIndex(
    (environment) => environment.environmentId === environmentId,
  )
  if (index < 0) return null
  return (
    environments[index + 1]?.environmentId ??
    environments[index - 1]?.environmentId ??
    null
  )
}

export function validEnvironmentOrder(
  environments: readonly WorkspaceEnvironmentReadModel[],
  environmentIds: readonly string[],
): boolean {
  const currentIds = environments.map((environment) => environment.environmentId)
  if (
    environmentIds.length !== currentIds.length ||
    new Set(environmentIds).size !== environmentIds.length
  ) {
    return false
  }
  const current = new Set(currentIds)
  return environmentIds.every((environmentId) => current.has(environmentId))
}

export function moveEnvironmentByOffset(
  environments: readonly WorkspaceEnvironmentReadModel[],
  environmentId: string,
  offset: -1 | 1,
): EnvironmentOrderMove {
  const environmentIds = environments.map((environment) => environment.environmentId)
  const currentIndex = environmentIds.indexOf(environmentId)
  if (currentIndex < 0) {
    return { announcement: "环境不在当前项目中", changed: false, order: environmentIds }
  }
  const nextIndex = Math.min(environmentIds.length - 1, Math.max(0, currentIndex + offset))
  if (nextIndex === currentIndex) {
    return {
      announcement: offset < 0 ? "已经是第一个环境" : "已经是最后一个环境",
      changed: false,
      order: environmentIds,
    }
  }
  const order = [...environmentIds]
  order.splice(currentIndex, 1)
  order.splice(nextIndex, 0, environmentId)
  const name = environments.find((environment) => environment.environmentId === environmentId)?.name ?? environmentId
  return {
    announcement: `环境“${name}”已移至第 ${nextIndex + 1} 项，共 ${order.length} 项`,
    changed: true,
    order,
  }
}

export function safeEnvironmentMutationMessage(
  error: PublicError | null | undefined,
  fallback: string,
): string {
  return error && DISPLAYABLE_ERROR_CODES.has(error.code) ? error.message : fallback
}
