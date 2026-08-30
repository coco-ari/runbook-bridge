import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { AiOpsV2Api, ProjectRecord } from "@/bridge/ai-ops-v2"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import {
  normalizeEnvironmentNameForProject,
  normalizeProjectName,
  projectDeleteConfirmationMatches,
  safeProjectMutationMessage,
} from "@/features/projects/project-mutation-model"

export type ProjectMutationKind = "create" | "delete" | "rename"

export interface ProjectMutationFeedback {
  readonly kind: "error" | "success" | "warning"
  readonly message: string
}

export type ProjectMutationEvent =
  | Readonly<{ kind: "created"; project: ProjectRecord }>
  | Readonly<{ kind: "renamed"; project: ProjectRecord }>
  | Readonly<{ kind: "deleted"; projectId: string }>

export interface UseProjectMutationsOptions {
  readonly api: AiOpsV2Api
  readonly mayLeaveProject?: ((projectId: string) => boolean | Promise<boolean>) | undefined
  readonly onCommitted?: ((event: ProjectMutationEvent) => void | Promise<void>) | undefined
}

export interface ProjectMutationController {
  readonly busy: ProjectMutationKind | null
  readonly clearFeedback: () => void
  readonly create: (name: string, environmentName: string) => Promise<boolean>
  readonly feedback: ProjectMutationFeedback | null
  readonly remove: (
    project: WorkspaceProjectReadModel,
    confirmation: string,
  ) => Promise<boolean>
  readonly rename: (project: WorkspaceProjectReadModel, name: string) => Promise<boolean>
}

const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u

function validProjectRecord(value: ProjectRecord, expectedProjectId?: string): boolean {
  return (
    SCOPE_ID_PATTERN.test(value.projectId) &&
    (expectedProjectId === undefined || value.projectId === expectedProjectId) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1
  )
}

export function useProjectMutations({
  api,
  mayLeaveProject,
  onCommitted,
}: UseProjectMutationsOptions): ProjectMutationController {
  const [busy, setBusy] = useState<ProjectMutationKind | null>(null)
  const [feedback, setFeedback] = useState<ProjectMutationFeedback | null>(null)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)
  const inFlightRef = useRef<ProjectMutationKind | null>(null)
  const mayLeaveRef = useRef(mayLeaveProject)
  const onCommittedRef = useRef(onCommitted)

  useEffect(() => {
    mayLeaveRef.current = mayLeaveProject
  }, [mayLeaveProject])

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

  const start = useCallback((kind: ProjectMutationKind): number | null => {
    if (inFlightRef.current !== null) return null
    inFlightRef.current = kind
    const epoch = ++epochRef.current
    if (mountedRef.current) {
      setBusy(kind)
      setFeedback(null)
    }
    return epoch
  }, [])

  const finish = useCallback((kind: ProjectMutationKind, epoch: number) => {
    if (inFlightRef.current === kind) inFlightRef.current = null
    if (mountedRef.current && epochRef.current === epoch) setBusy(null)
  }, [])

  const committed = useCallback(async (
    event: ProjectMutationEvent,
    successMessage: string,
    epoch: number,
  ) => {
    try {
      await onCommittedRef.current?.(event)
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "success", message: successMessage })
      }
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        const message = `${successMessage}，但列表刷新失败，请手动刷新。`
        setFeedback({
          kind: "warning",
          message,
        })
        toast.warning(message)
      }
    }
  }, [])

  const create = useCallback(async (nameInput: string, environmentInput: string) => {
    const name = normalizeProjectName(nameInput)
    if (!name.ok) {
      setFeedback({ kind: "error", message: name.message })
      return false
    }
    const environmentName = normalizeEnvironmentNameForProject(environmentInput)
    if (!environmentName.ok) {
      setFeedback({ kind: "error", message: environmentName.message })
      return false
    }
    const epoch = start("create")
    if (epoch === null) return false
    try {
      const result = await api.createProject({
        environmentName: environmentName.value,
        name: name.value,
      })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeProjectMutationMessage(result.error, "创建项目失败，请重试。"),
          })
        }
        return false
      }
      if (!validProjectRecord(result.data)) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "项目已创建，但返回结果无效，请刷新后确认。" })
        }
        return false
      }
      await committed({ kind: "created", project: result.data }, "项目已创建。", epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "创建项目失败，请重试。" })
      }
      return false
    } finally {
      finish("create", epoch)
    }
  }, [api, committed, finish, start])

  const rename = useCallback(async (
    project: WorkspaceProjectReadModel,
    nameInput: string,
  ) => {
    if (project.isolated) {
      setFeedback({ kind: "error", message: "隔离项目不能修改。" })
      return false
    }
    const name = normalizeProjectName(nameInput)
    if (!name.ok) {
      setFeedback({ kind: "error", message: name.message })
      return false
    }
    if (name.value === project.name) {
      setFeedback(null)
      return true
    }
    const epoch = start("rename")
    if (epoch === null) return false
    try {
      const result = await api.updateProject({
        expectedRevision: project.revision,
        patch: { name: name.value },
        projectId: project.projectId,
      })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeProjectMutationMessage(result.error, "更新项目名称失败，请重试。"),
          })
        }
        return false
      }
      if (
        result.data.projectId !== project.projectId ||
        !validProjectRecord(result.data, project.projectId) ||
        result.data.revision <= project.revision
      ) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "项目已更新，但返回结果无效，请刷新后确认。" })
        }
        return false
      }
      await committed({ kind: "renamed", project: result.data }, "项目名称已更新。", epoch)
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "更新项目名称失败，请重试。" })
      }
      return false
    } finally {
      finish("rename", epoch)
    }
  }, [api, committed, finish, start])

  const remove = useCallback(async (
    project: WorkspaceProjectReadModel,
    confirmation: string,
  ) => {
    if (project.isolated) {
      setFeedback({ kind: "error", message: "隔离项目不能从此界面删除。" })
      return false
    }
    if (!projectDeleteConfirmationMatches(project.name, confirmation)) {
      setFeedback({ kind: "error", message: "请输入完整项目名称以确认删除。" })
      return false
    }
    const epoch = start("delete")
    if (epoch === null) return false
    try {
      try {
        if (mayLeaveRef.current && !(await mayLeaveRef.current(project.projectId))) return false
      } catch {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "无法安全离开当前编辑范围。" })
        }
        return false
      }
      if (!mountedRef.current || epochRef.current !== epoch) return false
      const result = await api.deleteProject({ projectId: project.projectId })
      if (!result.ok) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({
            kind: "error",
            message: safeProjectMutationMessage(result.error, "删除项目失败，请重试。"),
          })
        }
        return false
      }
      const returnedProjectId = result.data.projectId
      if (returnedProjectId !== undefined && returnedProjectId !== project.projectId) {
        if (mountedRef.current && epochRef.current === epoch) {
          setFeedback({ kind: "error", message: "项目删除结果的范围不匹配，请刷新后确认。" })
        }
        return false
      }
      await committed(
        { kind: "deleted", projectId: project.projectId },
        `“${project.name}”的配置已删除；本机加密凭据仍保留。`,
        epoch,
      )
      return true
    } catch {
      if (mountedRef.current && epochRef.current === epoch) {
        setFeedback({ kind: "error", message: "删除项目失败，请重试。" })
      }
      return false
    } finally {
      finish("delete", epoch)
    }
  }, [api, committed, finish, start])

  return {
    busy,
    clearFeedback: useCallback(() => setFeedback(null), []),
    create,
    feedback,
    remove,
    rename,
  }
}
