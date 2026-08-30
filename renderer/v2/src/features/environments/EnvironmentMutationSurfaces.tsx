import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { PencilSimple, Stack, Trash, Warning } from "@phosphor-icons/react"

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
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item"
import { focusWorkspaceElement } from "@/lib/workspace-focus"
import {
  assessEnvironmentDeletion,
  ENVIRONMENT_NAME_MAX_LENGTH,
} from "@/features/environments/environment-mutation-model"
import {
  useEnvironmentMutations,
  type EnvironmentMutationEvent,
} from "@/features/environments/use-environment-mutations"
import type {
  WorkspaceEnvironmentReadModel,
  WorkspaceProjectReadModel,
} from "@/features/workspace/workspace-read-model"

export type EnvironmentMutationSurface =
  | Readonly<{ kind: "create"; project: WorkspaceProjectReadModel }>
  | Readonly<{
      environment: WorkspaceEnvironmentReadModel
      kind: "settings"
      project: WorkspaceProjectReadModel
    }>
  | Readonly<{
      environment: WorkspaceEnvironmentReadModel
      kind: "delete"
      project: WorkspaceProjectReadModel
    }>
  | null

export interface EnvironmentMutationSurfacesProps {
  readonly action: EnvironmentMutationSurface
  readonly api: AiOpsV2Api
  readonly mayLeaveEnvironment?: ((scope: Readonly<{
    projectId: string
    environmentId: string
  }>) => boolean | Promise<boolean>) | undefined
  readonly onActionChange: (action: EnvironmentMutationSurface) => void
  readonly onCommitted?: ((event: EnvironmentMutationEvent) => void | Promise<void>) | undefined
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

function environmentRailTarget(environmentId: string) {
  return [...document.querySelectorAll<HTMLElement>("[data-environment-id]")]
    .find((candidate) => candidate.dataset.environmentId === environmentId)
    ?.querySelector<HTMLElement>('[data-testid^="environment-trigger-"]') ?? null
}

function MutationError({ id, message }: { readonly id: string; readonly message: string | null }) {
  return message ? <FieldError data-testid="environment-mutation-error" id={id}>{message}</FieldError> : null
}

export function EnvironmentMutationSurfaces({
  action,
  api,
  mayLeaveEnvironment,
  onActionChange,
  onCommitted,
  restoreFocusRef,
}: EnvironmentMutationSurfacesProps) {
  const [name, setName] = useState("")
  const pendingRestoreTargetRef = useRef<HTMLElement | null>(null)
  const controller = useEnvironmentMutations({ api, mayLeaveEnvironment, onCommitted })
  const busyDialogRef = useBusyDialogFocus(controller.busy !== null)
  const mutationError = controller.feedback?.kind === "error" ? controller.feedback.message : null
  const project = action?.project ?? null
  const environment = action && action.kind !== "create" ? action.environment : null
  const actionKey = action && action.kind !== "create"
    ? `${action.kind}:${action.project.projectId}:${action.environment.environmentId}:${action.environment.revision}`
    : action?.kind === "create"
      ? `${action.kind}:${action.project.projectId}:${action.project.revision}`
      : "closed"
  const deleteAssessment = useMemo(
    () => project && environment
      ? assessEnvironmentDeletion(project, environment)
      : { allowed: false, message: "环境范围无效，无法删除。" },
    [environment, project],
  )

  useEffect(() => {
    controller.clearFeedback()
    setName(environment?.name ?? "")
  }, [actionKey, controller.clearFeedback, environment?.name])

  const resolveRestoreTarget = useCallback(() => {
    if (action?.kind === "create") {
      const createTarget = document.querySelector<HTMLElement>('[data-testid="add-environment-footer"]')
      if (createTarget?.isConnected) return createTarget
    }
    if (action && action.kind !== "create") {
      const environmentTarget = environmentRailTarget(action.environment.environmentId)
      if (environmentTarget?.isConnected) return environmentTarget
    }
    const requestedTarget = restoreFocusRef?.current
    if (requestedTarget?.isConnected
      && requestedTarget !== document.body
      && requestedTarget !== document.documentElement) return requestedTarget
    return document.querySelector<HTMLElement>(
      '[data-testid="add-environment-footer"], [data-shell-nav-item][aria-current="page"], [data-shell-nav-item]',
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

  const createEnvironment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (project && await controller.create(project, name)) onActionChange(null)
  }

  const renameEnvironment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      project &&
      environment &&
      await controller.rename(project, environment, name)
    ) {
      onActionChange(null)
    }
  }

  const deleteEnvironment = async () => {
    if (action?.kind !== "delete" || !project || !environment || controller.busy !== null) return
    if (await controller.remove(project, environment)) {
      onActionChange(null)
    }
  }

  if (action?.kind === "create" && project) {
    return (
      <Dialog onOpenChange={(open) => { if (!open) close() }} open>
        <DialogContent
          ref={busyDialogRef}
          aria-busy={controller.busy !== null}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          data-testid="create-environment-dialog"
          onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
          onEscapeKeyDown={preventDismissWhileBusy}
          onInteractOutside={preventDismissWhileBusy}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => document.getElementById("new-environment-name")?.focus())
          }}
          showCloseButton={controller.busy === null}
        >
          <DialogHeader className="pr-6">
            <DialogTitle>新增环境</DialogTitle>
            <DialogDescription className="break-words">
              在“{project.name}”内建立独立环境范围。
            </DialogDescription>
          </DialogHeader>
          <form id="create-environment-form" onSubmit={(event) => void createEnvironment(event)}>
            <FieldGroup>
              <Field data-invalid={controller.feedback?.kind === "error" || undefined}>
                <FieldLabel htmlFor="new-environment-name">环境名称</FieldLabel>
                <Input
                  aria-describedby={`new-environment-name-description${mutationError ? " new-environment-name-error" : ""}`}
                  aria-errormessage={mutationError ? "new-environment-name-error" : undefined}
                  aria-invalid={controller.feedback?.kind === "error" || undefined}
                  autoComplete="off"
                  disabled={controller.busy !== null}
                  id="new-environment-name"
                  maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：预发布环境"
                  value={name}
                />
                <FieldDescription id="new-environment-name-description">
                  同一项目内名称不能重复，最多可创建 100 个环境。
                </FieldDescription>
              </Field>
              <MutationError id="new-environment-name-error" message={mutationError} />
            </FieldGroup>
          </form>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={controller.busy !== null} type="button" variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={controller.busy !== null} form="create-environment-form" type="submit">
              {controller.busy === "create" ? "创建中" : "创建环境"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (!project || !environment) return null

  if (action?.kind === "delete") {
    return (
      <AlertDialog onOpenChange={(open) => { if (!open) close() }} open>
        <AlertDialogContent
          ref={busyDialogRef}
          aria-busy={controller.busy !== null}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          data-testid="delete-environment-dialog"
          onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
          onEscapeKeyDown={preventDismissWhileBusy}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="text-danger">
              {deleteAssessment.allowed ? <Trash aria-hidden="true" /> : <Warning aria-hidden="true" />}
            </AlertDialogMedia>
            <AlertDialogTitle>
              {deleteAssessment.allowed ? `删除“${environment.name}”？` : "暂时不能删除环境"}
            </AlertDialogTitle>
            <AlertDialogDescription>{deleteAssessment.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <Item
            aria-describedby={mutationError ? "delete-environment-error" : undefined}
            aria-label="删除环境范围"
            role="group"
            size="sm"
            variant="outline"
          >
            <ItemMedia variant="icon"><Stack aria-hidden="true" size={16} /></ItemMedia>
            <ItemContent>
              <ItemTitle className="line-clamp-none break-words text-muted-foreground">
                {project.name} / {environment.name}
              </ItemTitle>
            </ItemContent>
            <div className="w-full">
              <MutationError id="delete-environment-error" message={mutationError} />
            </div>
          </Item>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={controller.busy !== null}>
              {deleteAssessment.allowed ? "取消" : "关闭"}
            </AlertDialogCancel>
            {deleteAssessment.allowed ? (
              <Button
                disabled={controller.busy !== null}
                onClick={() => void deleteEnvironment()}
                type="button"
                variant="destructive"
              >
                {controller.busy === "delete" ? "删除中" : "确认删除"}
              </Button>
            ) : null}
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
        data-testid="environment-settings-dialog"
        onCloseAutoFocus={(event) => focusAfterOverlayClose(event, resolveRestoreTarget())}
        onEscapeKeyDown={preventDismissWhileBusy}
        onInteractOutside={preventDismissWhileBusy}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => document.getElementById("environment-settings-name")?.focus())
        }}
        showCloseButton={controller.busy === null}
      >
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <PencilSimple aria-hidden="true" size={19} />
          </div>
          <DialogTitle>环境设置</DialogTitle>
          <DialogDescription className="break-words">
            {project.name} / {environment.name}
          </DialogDescription>
        </DialogHeader>
        <form id="rename-environment-form" onSubmit={(event) => void renameEnvironment(event)}>
          <FieldGroup className="gap-3">
            <Field data-invalid={controller.feedback?.kind === "error" || undefined}>
              <FieldLabel htmlFor="environment-settings-name">环境名称</FieldLabel>
              <Input
                aria-describedby={`environment-settings-name-description${mutationError ? " environment-settings-name-error" : ""}`}
                aria-errormessage={mutationError ? "environment-settings-name-error" : undefined}
                aria-invalid={controller.feedback?.kind === "error" || undefined}
                autoComplete="off"
                disabled={controller.busy !== null}
                id="environment-settings-name"
                maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <FieldDescription id="environment-settings-name-description">
                仅修改当前项目内此环境的显示名称。
              </FieldDescription>
            </Field>
            <MutationError id="environment-settings-name-error" message={mutationError} />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={controller.busy !== null} type="button" variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={controller.busy !== null} form="rename-environment-form" type="submit">
            {controller.busy === "rename" ? "保存中" : "保存名称"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
