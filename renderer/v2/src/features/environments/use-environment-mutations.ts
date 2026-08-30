import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { AiOpsV2Api, EnvironmentRecord } from "@/bridge/ai-ops-v2"
import {
  assessEnvironmentDeletion,
  environmentBelongsToProject,
  environmentNameIsDuplicate,
  normalizeEnvironmentName,
  safeEnvironmentMutationMessage,
  suggestedEnvironmentAfterDelete,
  validEnvironmentOrder,
} from "@/features/environments/environment-mutation-model"
import type {
  WorkspaceEnvironmentReadModel,
  WorkspaceProjectReadModel,
} from "@/features/workspace/workspace-read-model"

export type EnvironmentMutationKind = "create" | "delete" | "rename" | "reorder"

export interface EnvironmentMutationFeedback {
  readonly kind: "error" | "success" | "warning"
  readonly message: string
}

export type EnvironmentMutationEvent =
  | Readonly<{ environment: EnvironmentRecord; kind: "created" }>
  | Readonly<{ environment: EnvironmentRecord; kind: "renamed" }>
  | Readonly<{
      environmentId: string
      kind: "deleted"
      projectId: string
      suggestedEnvironmentId: string | null
    }>
  | Readonly<{
      environmentIds: readonly string[]
      kind: "reordered"
      projectId: string
    }>

export interface UseEnvironmentMutationsOptions {
  readonly api: AiOpsV2Api
  readonly mayLeaveEnvironment?: ((scope: Readonly<{
    projectId: string
    environmentId: string
  }>) => boolean | Promise<boolean>) | undefined
  readonly onCommitted?: ((event: EnvironmentMutationEvent) => void | Promise<void>) | undefined
}

export interface EnvironmentMutationController {
  readonly busy: EnvironmentMutationKind | null
  readonly clearFeedback: () => void
  readonly create: (project: WorkspaceProjectReadModel, name: string) => Promise<boolean>
  readonly feedback: EnvironmentMutationFeedback | null
  readonly remove: (
    project: WorkspaceProjectReadModel,
    environment: WorkspaceEnvironmentReadModel,
  ) => Promise<boolean>
  readonly rename: (
    project: WorkspaceProjectReadModel,
    environment: WorkspaceEnvironmentReadModel,
    name: string,
  ) => Promise<boolean>
  readonly reorder: (
    project: WorkspaceProjectReadModel,
    environmentIds: readonly string[],
  ) => Promise<boolean>
}

const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u

function validEnvironmentRecord(
  value: EnvironmentRecord,
  expectedProjectId: string,
  expectedEnvironmentId?: string,
): boolean {
  return (
    value.projectId === expectedProjectId &&
    (expectedEnvironmentId === undefined || value.environmentId === expectedEnvironmentId) &&
    SCOPE_ID_PATTERN.test(value.environmentId) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1
  )
}

export function useEnvironmentMutations({
  api,
  mayLeaveEnvironment,
  onCommitted,
}: UseEnvironmentMutationsOptions): EnvironmentMutationController {
  const [busy, setBusy] = useState<EnvironmentMutationKind | null>(null)
  const [feedback, setFeedback] = useState<EnvironmentMutationFeedback | null>(null)
  const epochRef = useRef(0)
  const inFlightRef = useRef<EnvironmentMutationKind | null>(null)
  const mountedRef = useRef(true)
  const mayLeaveRef = useRef(mayLeaveEnvironment)
  const onCommittedRef = useRef(onCommitted)

  useEffect(() => {
    mayLeaveRef.current = mayLeaveEnvironment
  }, [mayLeaveEnvironment])

  useEffect(() => {
    onCommittedRef.current = onCommitted
  }, [onCommitted])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      epochRef.current += 1
    }
  }, [])

  const start = useCallback((kind: EnvironmentMutationKind): number | null => {
    if (inFlightRef.current !== null) return null
    inFlightRef.current = kind
    const epoch = ++epochRef.current
    if (mountedRef.current) {
      setBusy(kind)
      setFeedback(null)
    }
    return epoch
  }, [])

  const finish = useCallback((kind: EnvironmentMutationKind, epoch: number) => {
    if (inFlightRef.current === kind) inFlightRef.current = null
    if (mountedRef.current && epochRef.current === epoch) setBusy(null)
  }, [])

  const committed = useCallback(async (
    event: EnvironmentMutationEvent,
    message: string,
    epoch: number,
  ) => {
    try {
      await onCommittedRef.current?.(event)
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "success", message })
      }
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        const warning = `${message}，但列表刷新失败，请手动刷新。`
        setFeedback({ kind: "warning", message: warning })
        toast.warning(warning)
      }
    }
  }, [])

  const create = useCallback(async (
    project: WorkspaceProjectReadModel,
    nameInput: string,
  ) => {
    if (project.isolated) {
      setFeedback({ kind: "error", message: "隔离项目不能新增环境。" })
      return false
    }
    if (project.environments.length >= 100) {
      setFeedback({ kind: "error", message: "每个项目最多 100 个环境。" })
      return false
    }
    const name = normalizeEnvironmentName(nameInput)
    if (!name.ok) {
      setFeedback({ kind: "error", message: name.message })
      return false
    }
    if (environmentNameIsDuplicate(project, name.value)) {
      setFeedback({ kind: "error", message: "同一项目内环境名称不能重复。" })
      return false
    }
    const epoch = start("create")
    if (epoch === null) return false
    try {
      const result = await api.createEnvironment({
        input: { name: name.value },
        projectId: project.projectId,
      })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeEnvironmentMutationMessage(result.error, "创建环境失败，请重试。"),
          })
        }
        return false
      }
      if (!validEnvironmentRecord(result.data, project.projectId)) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "环境已创建，但返回结果无效，请刷新后确认。" })
        }
        return false
      }
      await committed({ environment: result.data, kind: "created" }, "环境已创建。", epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "创建环境失败，请重试。" })
      }
      return false
    } finally {
      finish("create", epoch)
    }
  }, [api, committed, finish, start])

  const rename = useCallback(async (
    project: WorkspaceProjectReadModel,
    environment: WorkspaceEnvironmentReadModel,
    nameInput: string,
  ) => {
    const currentEnvironment = project.environments.find(
      (candidate) =>
        candidate.projectId === project.projectId &&
        candidate.environmentId === environment.environmentId,
    )
    if (
      project.isolated ||
      environment.projectId !== project.projectId ||
      !currentEnvironment ||
      !environmentBelongsToProject(project, currentEnvironment)
    ) {
      setFeedback({ kind: "error", message: "环境范围无效，无法修改。" })
      return false
    }
    const name = normalizeEnvironmentName(nameInput)
    if (!name.ok) {
      setFeedback({ kind: "error", message: name.message })
      return false
    }
    if (name.value === currentEnvironment.name) {
      setFeedback(null)
      return true
    }
    if (environmentNameIsDuplicate(project, name.value, currentEnvironment.environmentId)) {
      setFeedback({ kind: "error", message: "同一项目内环境名称不能重复。" })
      return false
    }
    const epoch = start("rename")
    if (epoch === null) return false
    try {
      const result = await api.updateEnvironment({
        environmentId: currentEnvironment.environmentId,
        expectedRevision: currentEnvironment.revision,
        patch: { name: name.value },
        projectId: project.projectId,
      })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeEnvironmentMutationMessage(result.error, "更新环境名称失败，请重试。"),
          })
        }
        return false
      }
      if (
        !validEnvironmentRecord(
          result.data,
          project.projectId,
          currentEnvironment.environmentId,
        ) ||
        result.data.revision <= currentEnvironment.revision
      ) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "环境已更新，但返回结果无效，请刷新后确认。" })
        }
        return false
      }
      await committed({ environment: result.data, kind: "renamed" }, "环境名称已更新。", epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "更新环境名称失败，请重试。" })
      }
      return false
    } finally {
      finish("rename", epoch)
    }
  }, [api, committed, finish, start])

  const remove = useCallback(async (
    project: WorkspaceProjectReadModel,
    environment: WorkspaceEnvironmentReadModel,
  ) => {
    const assessment = assessEnvironmentDeletion(project, environment)
    if (!assessment.allowed) {
      setFeedback({ kind: "error", message: assessment.message })
      return false
    }
    const currentEnvironment = project.environments.find(
      (candidate) =>
        candidate.projectId === project.projectId &&
        candidate.environmentId === environment.environmentId,
    )
    if (!currentEnvironment || environment.projectId !== project.projectId) {
      setFeedback({ kind: "error", message: "环境范围无效，无法删除。" })
      return false
    }
    const scope = {
      environmentId: currentEnvironment.environmentId,
      projectId: project.projectId,
    }
    const epoch = start("delete")
    if (epoch === null) return false
    try {
      try {
        if (mayLeaveRef.current && !(await mayLeaveRef.current(scope))) return false
      } catch {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "无法安全离开当前编辑范围。" })
        }
        return false
      }
      if (!mountedRef.current || epochRef.current !== epoch) return false
      const result = await api.deleteEnvironment(scope)
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeEnvironmentMutationMessage(result.error, "删除环境失败，请重试。"),
          })
        }
        return false
      }
      const returnedEnvironmentId = result.data.environmentId
      if (
        returnedEnvironmentId !== undefined &&
        returnedEnvironmentId !== currentEnvironment.environmentId
      ) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "环境删除结果的范围不匹配，请刷新后确认。" })
        }
        return false
      }
      await committed({
        environmentId: currentEnvironment.environmentId,
        kind: "deleted",
        projectId: project.projectId,
        suggestedEnvironmentId: suggestedEnvironmentAfterDelete(
          project.environments,
          currentEnvironment.environmentId,
        ),
      }, `“${currentEnvironment.name}”的配置已删除；本机加密凭据仍保留。`, epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "删除环境失败，请重试。" })
      }
      return false
    } finally {
      finish("delete", epoch)
    }
  }, [api, committed, finish, start])

  const reorder = useCallback(async (
    project: WorkspaceProjectReadModel,
    environmentIds: readonly string[],
  ) => {
    if (project.isolated || !validEnvironmentOrder(project.environments, environmentIds)) {
      setFeedback({ kind: "error", message: "环境排序列表无效。" })
      return false
    }
    if (project.environments.every(
      (environment, index) => environment.environmentId === environmentIds[index],
    )) {
      return true
    }
    const epoch = start("reorder")
    if (epoch === null) return false
    try {
      const result = await api.reorderEnvironments({
        environmentIds,
        expectedRevision: project.revision,
        projectId: project.projectId,
      })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeEnvironmentMutationMessage(result.error, "保存环境顺序失败，请重试。"),
          })
        }
        return false
      }
      await committed({
        environmentIds: [...environmentIds],
        kind: "reordered",
        projectId: project.projectId,
      }, "环境顺序已保存。", epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "保存环境顺序失败，请重试。" })
      }
      return false
    } finally {
      finish("reorder", epoch)
    }
  }, [api, committed, finish, start])

  return {
    busy,
    clearFeedback: useCallback(() => setFeedback(null), []),
    create,
    feedback,
    remove,
    rename,
    reorder,
  }
}
