import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { PencilSimple, Warning } from "@phosphor-icons/react"

import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useCloudConfig } from "@/features/cloud-config/CloudConfigProvider"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useBusyDialogFocus } from "@/hooks/use-busy-dialog-focus"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import type { WorkspaceProjectReadModel } from "@/features/workspace/workspace-read-model"
import {
  PROJECT_NAME_MAX_LENGTH,
  projectDeleteConfirmationMatches,
} from "@/features/projects/project-mutation-model"
import {
  useProjectMutations,
  type ProjectMutationEvent,
} from "@/features/projects/use-project-mutations"

export type ProjectMutationSurface =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "settings"; project: WorkspaceProjectReadModel }>
  | Readonly<{ kind: "delete"; project: WorkspaceProjectReadModel }>
  | null

export interface ProjectMutationSurfacesProps {
  readonly action: ProjectMutationSurface
  readonly api: AiOpsV2Api
  readonly mayLeaveProject?: ((projectId: string) => boolean | Promise<boolean>) | undefined
  readonly onActionChange: (action: ProjectMutationSurface) => void
  readonly onCommitted?: ((event: ProjectMutationEvent) => void | Promise<void>) | undefined
  readonly restoreFocusRef?: RefObject<HTMLElement | null> | undefined
}

function focusAfterOverlayClose(
  event: Event,
  target: HTMLElement | null,
) {
  if (!target?.isConnected) return
  event.preventDefault()
  requestAnimationFrame(() => focusWorkspaceElement(target))
}

function projectRailTarget(projectId: string) {
  return [...document.querySelectorAll<HTMLElement>("[data-project-id]")]
    .find((candidate) => candidate.dataset.projectId === projectId) ?? null
}

function MutationError({ id, message }: { readonly id: string; readonly message: string | null }) {
  return message ? <FieldError data-testid="project-mutation-error" id={id}>{message}</FieldError> : null
}

export function ProjectMutationSurfaces({
  action,
  api,
  mayLeaveProject,
  onActionChange,
  onCommitted,
  restoreFocusRef,
}: ProjectMutationSurfacesProps) {
  const cloud = useCloudConfig()
  const [deleteCloud, setDeleteCloud] = useState(false)
  const [cloudDeleteError, setCloudDeleteError] = useState("")
  const [cloudDeleted, setCloudDeleted] = useState(false)
  const [environmentName, setEnvironmentName] = useState("")
  const [name, setName] = useState("")
  const [typedConfirmation, setTypedConfirmation] = useState("")
  const pendingRestoreTargetRef = useRef<HTMLElement | null>(null)
  const controller = useProjectMutations({ api, mayLeaveProject, onCommitted })
  const busyDialogRef = useBusyDialogFocus(controller.busy !== null)
  const mutationError = controller.feedback?.kind === "error" ? controller.feedback.message : null
  const project = action && action.kind !== "create" ? action.project : null
  const linked = cloud.data.cloudProjects?.find(p => p.localId === project?.projectId)
  const repository = cloud.data.repositories?.find(r => r.repositoryId === linked?.repositoryId)
  const actionKey = action && action.kind !== "create"
    ? `${action.kind}:${action.project.projectId}:${action.project.revision}`
    : action?.kind ?? "closed"

  useEffect(() => {
    controller.clearFeedback()
    setEnvironmentName("")
    setName(project?.name ?? "")
    setTypedConfirmation("")
    setDeleteCloud(false); setCloudDeleteError(""); setCloudDeleted(false)
  }, [actionKey, controller.clearFeedback, project?.name])

  const resolveRestoreTarget = useCallback(() => {
    if (action?.kind === "create") {
      const createTarget = document.querySelector<HTMLElement>('[data-testid="add-project-footer"]')
      if (createTarget?.isConnected) return createTarget
    }
    if (action && action.kind !== "create") {
      const projectTarget = projectRailTarget(action.project.projectId)
      if (projectTarget?.isConnected) return projectTarget
    }
    const requestedTarget = restoreFocusRef?.current
    if (requestedTarget?.isConnected
      && requestedTarget !== document.body
      && requestedTarget !== document.documentElement) return requestedTarget
    return document.querySelector<HTMLElement>(
      '[data-testid="add-project-footer"], [data-shell-nav-item][aria-current="page"], [data-shell-nav-item]',
    )
  }, [action, restoreFocusRef])

  const close = useCallback(() => {
    if (controller.busy) return
    pendingRestoreTargetRef.current = resolveRestoreTarget()
    onActionChange(null)
  }, [controller.busy, onActionChange, resolveRestoreTarget])

  const preventDismissWhileBusy = (event: { preventDefault: () => void }) => {
    if (controller.busy !== null) event.preventDefault()
  }

  useEffect(() => {
    if (action !== null) return
    const target = pendingRestoreTargetRef.current
    pendingRestoreTargetRef.current = null
    if (!target?.isConnected) return
    const frame = requestAnimationFrame(() => focusWorkspaceElement(target))
    return () => cancelAnimationFrame(frame)
  }, [action])

  const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (await controller.create(name, environmentName)) onActionChange(null)
  }

  const renameProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (project && await controller.rename(project, name)) onActionChange(null)
  }

  const deleteProject = async () => {
    if (action?.kind !== "delete" || !project || controller.busy !== null) return
    setCloudDeleteError("")
    const beforeDelete = deleteCloud ? async () => {
      if (!linked || !repository?.snapshotId || !repository.unlocked) { setCloudDeleteError("请先在云配置中解锁并检测此项目所属仓库。"); return false }
      const preview = await cloud.run({ action: "prepareProjectOperation", repositoryId: linked.repositoryId, projectId: linked.projectId, snapshotId: repository.snapshotId, operation: "delete" })
      if (!preview?.projectOperation) { setCloudDeleteError("云端删除准备失败，本地项目保留。请重新检测后再试。"); return false }
      const result = await cloud.run({ action: "confirmProjectOperation", planId: preview.projectOperation.planId })
      if (!result) { setCloudDeleteError("未能确认云端删除结果，本地项目保留。请重新检测后再试。"); return false }
      setCloudDeleted(true); setDeleteCloud(false)
      return true
    } : undefined
    if (await controller.remove(project, typedConfirmation, beforeDelete)) {
      await cloud.refresh()
      onActionChange(null)
    }
  }

  if (action?.kind === "create") {
    return (
      <Dialog onOpenChange={(open) => { if (!open) close() }} open>
        <DialogContent
          ref={busyDialogRef}
          aria-busy={controller.busy !== null}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          data-testid="create-project-dialog"
          onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
          onEscapeKeyDown={preventDismissWhileBusy}
          onInteractOutside={preventDismissWhileBusy}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => document.getElementById("new-project-name")?.focus())
          }}
          showCloseButton={controller.busy === null}
        >
          <DialogHeader className="pr-6">
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>创建项目，并设置第一个环境。</DialogDescription>
          </DialogHeader>
          <form id="create-project-form" onSubmit={(event) => void createProject(event)}>
            <FieldGroup>
              <Field data-invalid={controller.feedback?.kind === "error" || undefined}>
                <FieldLabel htmlFor="new-project-name">项目名称</FieldLabel>
                <Input
                  aria-describedby={mutationError ? "create-project-error" : undefined}
                  aria-errormessage={mutationError ? "create-project-error" : undefined}
                  aria-invalid={controller.feedback?.kind === "error" || undefined}
                  autoComplete="off"
                  disabled={controller.busy !== null}
                  id="new-project-name"
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：电商运维"
                  value={name}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-project-environment-name">第一个环境</FieldLabel>
                <Input
                  aria-describedby={mutationError ? "create-project-error" : undefined}
                  aria-errormessage={mutationError ? "create-project-error" : undefined}
                  aria-invalid={controller.feedback?.kind === "error" || undefined}
                  autoComplete="off"
                  disabled={controller.busy !== null}
                  id="new-project-environment-name"
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  onChange={(event) => setEnvironmentName(event.target.value)}
                  placeholder="例如：生产"
                  value={environmentName}
                />
              </Field>
              <MutationError id="create-project-error" message={mutationError} />
            </FieldGroup>
          </form>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={controller.busy !== null} type="button" variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={controller.busy !== null} form="create-project-form" type="submit">
              {controller.busy === "create" ? "创建中" : "创建项目"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (!project) return null

  if (action?.kind === "delete") {
    const confirmationMatches = projectDeleteConfirmationMatches(project.name, typedConfirmation)
    return (
      <AlertDialog onOpenChange={(open) => { if (!open) close() }} open>
        <AlertDialogContent
          ref={busyDialogRef}
          aria-busy={controller.busy !== null}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          data-testid="delete-project-dialog"
          onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
          onEscapeKeyDown={preventDismissWhileBusy}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-danger"><Warning aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>
              {project.isolated ? "暂时不能删除项目" : `永久删除“${project.name}”？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {project.isolated ? "项目配置已隔离，不能从此界面删除。" : (
                <>
                  将删除 {project.environmentCount} 个环境和 {project.pluginCount} 个插件的配置与运维说明。
                  本机加密凭据仍保留；如果环境仍在连接，删除会被拒绝。
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {linked && !project.isolated ? <label className="flex items-start gap-2 text-xs"><Checkbox data-testid="delete-project-cloud" checked={deleteCloud} disabled={controller.busy !== null || cloud.busy || !repository?.unlocked} onCheckedChange={value => setDeleteCloud(value === true)} /><span className="min-w-0 break-words [overflow-wrap:anywhere]">同时删除“{repository?.name}”中的云端项目“{linked.name}”<span className="mt-1 block text-muted-foreground">{repository?.unlocked ? "不勾选时只删除本地副本，云端仍可下载。云端删除后可在 30 天内恢复。" : "请先在云配置中解锁仓库。"}</span></span></label> : null}
          {cloudDeleted ? <p role="status" className="text-xs text-warning">云端项目已删除。{mutationError ? "本地删除未完成，请处理下方问题后重试本地删除。" : "正在删除本地项目…"}</p> : null}
          {cloudDeleteError ? <p role="alert" className="text-xs text-destructive">{cloudDeleteError}</p> : null}
          <Field data-invalid={Boolean(typedConfirmation) && !confirmationMatches || undefined}>
            <FieldLabel htmlFor="delete-project-confirmation">输入项目完整名称以确认</FieldLabel>
            <Input
              aria-describedby={[
                typedConfirmation && !confirmationMatches ? "delete-project-confirmation-error" : null,
                mutationError ? "delete-project-mutation-error" : null,
              ].filter(Boolean).join(" ") || undefined}
              aria-errormessage={typedConfirmation && !confirmationMatches
                ? "delete-project-confirmation-error"
                : mutationError
                  ? "delete-project-mutation-error"
                  : undefined}
              aria-invalid={Boolean(mutationError) || Boolean(typedConfirmation) && !confirmationMatches || undefined}
              autoComplete="off"
              disabled={controller.busy !== null || project.isolated}
              id="delete-project-confirmation"
              onChange={(event) => setTypedConfirmation(event.target.value)}
              value={typedConfirmation}
            />
            {typedConfirmation && !confirmationMatches ? (
              <FieldError id="delete-project-confirmation-error">名称不匹配。</FieldError>
            ) : null}
          </Field>
          <MutationError id="delete-project-mutation-error" message={mutationError} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={controller.busy !== null}>取消</AlertDialogCancel>
            <Button
              disabled={!confirmationMatches || controller.busy !== null || project.isolated}
              onClick={() => void deleteProject()}
              type="button"
              variant="destructive"
            >
              {controller.busy === "delete" ? "删除中" : "永久删除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <Dialog onOpenChange={(open) => { if (!open) close() }} open>
      <DialogContent
        ref={busyDialogRef}
        aria-busy={controller.busy !== null}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="project-settings-dialog"
        onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
        onEscapeKeyDown={preventDismissWhileBusy}
        onInteractOutside={preventDismissWhileBusy}
        onOpenAutoFocus={(event) => {
          if (project.isolated) return
          event.preventDefault()
          requestAnimationFrame(() => document.getElementById("project-settings-name")?.focus())
        }}
        showCloseButton={controller.busy === null}
      >
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <PencilSimple aria-hidden="true" size={19} />
          </div>
          <DialogTitle>项目设置</DialogTitle>
          <DialogDescription className="break-words">{project.name}</DialogDescription>
        </DialogHeader>
        <form id="rename-project-form" onSubmit={(event) => void renameProject(event)}>
          <FieldGroup className="gap-3">
            <Field data-invalid={controller.feedback?.kind === "error" || undefined}>
              <FieldLabel htmlFor="project-settings-name">项目名称</FieldLabel>
              <Input
                aria-describedby={`project-settings-name-description${mutationError ? " project-settings-name-error" : ""}`}
                aria-errormessage={mutationError ? "project-settings-name-error" : undefined}
                aria-invalid={controller.feedback?.kind === "error" || undefined}
                autoComplete="off"
                disabled={controller.busy !== null || project.isolated}
                id="project-settings-name"
                maxLength={PROJECT_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <FieldDescription id="project-settings-name-description">
                仅修改显示名称，不改变项目标识或数据范围。
              </FieldDescription>
            </Field>
            <MutationError id="project-settings-name-error" message={mutationError} />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={controller.busy !== null} type="button" variant="outline">取消</Button>
          </DialogClose>
          <Button
            disabled={controller.busy !== null || project.isolated}
            form="rename-project-form"
            type="submit"
          >
            {controller.busy === "rename" ? "保存中" : "保存名称"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
