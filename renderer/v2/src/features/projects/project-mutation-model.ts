import type { PublicError } from "@/bridge/ai-ops-v2"

export const PROJECT_NAME_MAX_LENGTH = 120
export const PROJECT_ORDER_STORAGE_KEY = "ai-ops-project-order-v1"

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const DISPLAYABLE_ERROR_CODES = new Set([
  "CONFIG_REVISION_CONFLICT",
  "INVALID_ARGUMENT",
  "PROJECT_CONNECTED",
  "PROJECT_NOT_FOUND",
  "RESULT_LIMIT_EXCEEDED",
])

export type NameValidationResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ message: string; ok: false }>

export interface ProjectOrderMove {
  readonly announcement: string
  readonly changed: boolean
  readonly order: readonly string[]
}

export function normalizeProjectName(value: string): NameValidationResult {
  const name = value.normalize("NFKC").trim()
  if (!name) return { message: "请输入项目名称。", ok: false }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return { message: `项目名称不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符。`, ok: false }
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { message: "项目名称不能包含控制字符。", ok: false }
  }
  return { ok: true, value: name }
}

export function normalizeEnvironmentNameForProject(value: string): NameValidationResult {
  const name = value.normalize("NFKC").trim()
  if (!name) return { message: "请输入第一个环境名称。", ok: false }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return { message: `环境名称不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符。`, ok: false }
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { message: "环境名称不能包含控制字符。", ok: false }
  }
  return { ok: true, value: name }
}

export function projectDeleteConfirmationMatches(
  projectName: string,
  confirmation: string,
): boolean {
  return confirmation.trim() === projectName
}

export function parseStoredProjectOrder(value: string | null): readonly string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}

export function normalizeProjectOrder(
  projectIds: readonly string[],
  savedOrder: readonly string[],
): readonly string[] {
  const available = new Set(projectIds)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const projectId of savedOrder) {
    if (!available.has(projectId) || seen.has(projectId)) continue
    seen.add(projectId)
    ordered.push(projectId)
  }
  for (const projectId of projectIds) {
    if (seen.has(projectId)) continue
    seen.add(projectId)
    ordered.push(projectId)
  }
  return ordered
}

export function moveProjectByOffset(
  projectIds: readonly string[],
  projectId: string,
  offset: -1 | 1,
  projectName = projectId,
): ProjectOrderMove {
  const currentIndex = projectIds.indexOf(projectId)
  if (currentIndex < 0) {
    return { announcement: "项目不在当前列表中", changed: false, order: [...projectIds] }
  }
  const nextIndex = Math.min(projectIds.length - 1, Math.max(0, currentIndex + offset))
  if (nextIndex === currentIndex) {
    return {
      announcement: offset < 0 ? "已经是第一个项目" : "已经是最后一个项目",
      changed: false,
      order: [...projectIds],
    }
  }
  const order = [...projectIds]
  order.splice(currentIndex, 1)
  order.splice(nextIndex, 0, projectId)
  return {
    announcement: `项目“${projectName}”已移至第 ${nextIndex + 1} 项，共 ${order.length} 项`,
    changed: true,
    order,
  }
}

export function removeProjectFromOrder(
  projectIds: readonly string[],
  projectId: string,
): readonly string[] {
  return projectIds.filter((candidate) => candidate !== projectId)
}

export function safeProjectMutationMessage(
  error: PublicError | null | undefined,
  fallback: string,
): string {
  return error && DISPLAYABLE_ERROR_CODES.has(error.code) ? error.message : fallback
}
