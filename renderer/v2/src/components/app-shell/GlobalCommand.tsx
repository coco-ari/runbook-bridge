import { getAiOpsV2 } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { useCommandPlugins } from "./use-command-plugins"
import { shortcutLabel } from "@/lib/platform"
import { FolderSimple, Plus, Stack, TreeStructure } from "@phosphor-icons/react"
import { Fragment, useEffect, useRef } from "react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import type {
  WorkspacePluginReadModel,
  WorkspaceProjectReadModel,
} from "@/features/workspace/workspace-read-model"

interface GlobalCommandProps {
  readonly disabled?: boolean
  readonly onCreateEnvironment?: (() => void) | undefined
  readonly onCreateProject: () => void
  readonly onOpenChange: (open: boolean) => void
  readonly onSelectEnvironment: (projectId: string, environmentId: string) => void
  readonly onSelectPlugin: (
    projectId: string,
    environmentId: string,
    pluginId: string,
  ) => void
  readonly onSelectProject: (projectId: string) => void
  readonly open: boolean
  readonly pluginsByScope?: ReadonlyMap<string, readonly WorkspacePluginReadModel[]>
  readonly projects: readonly WorkspaceProjectReadModel[]
}

export function GlobalCommand({
  disabled = false,
  onCreateEnvironment,
  onCreateProject,
  onOpenChange,
  onSelectEnvironment,
  onSelectPlugin,
  onSelectProject,
  open,
  pluginsByScope = new Map(),
  projects,
}: GlobalCommandProps) {
  const complete = useCommandPlugins(getAiOpsV2(), open, projects)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const actionFrameRef = useRef(0)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => () => cancelAnimationFrame(actionFrameRef.current), [])
  useEffect(() => {
    if (!open) return
    cancelAnimationFrame(actionFrameRef.current)
    pendingActionRef.current = null
  }, [open])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const anotherModal = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
        .some((element) => element.getClientRects().length > 0 && !element.querySelector('[data-testid="global-command"]'))
      if ((key === "k" || key === "n") && anotherModal) {
        event.preventDefault()
        return
      }
      if (key === "k") {
        event.preventDefault()
        onOpenChange(!open)
        return
      }
      if (key === "n") {
        event.preventDefault()
        if (open || document.querySelector('[role="dialog"] [data-testid="global-command"]')) {
          pendingActionRef.current = onCreateProject
          onOpenChange(false)
        } else {
          cancelAnimationFrame(actionFrameRef.current)
          pendingActionRef.current = null
          onCreateProject()
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [disabled, onCreateProject, onOpenChange, open])

  const run = (action: () => void) => {
    pendingActionRef.current = action
    onOpenChange(false)
  }

  return (
    <CommandDialog
      description="搜索本地项目、环境、插件与新建入口"
      onOpenChange={onOpenChange}
      onCloseAutoFocus={() => {
        const action = pendingActionRef.current
        pendingActionRef.current = null
        if (action) actionFrameRef.current = requestAnimationFrame(() => {
          const activeModal = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
            .some((element) => element.getClientRects().length > 0 && element.dataset.state !== "closed")
          if (!openRef.current && !activeModal) action()
        })
      }}
      open={open}
      title="工作台命令"
    >
      <Command data-testid="global-command">
        <CommandInput autoFocus placeholder="搜索项目、环境、插件或操作" />
        {complete.loading ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">正在读取其余插件，搜索结果会继续补充…</p> : null}
        {complete.failed ? <div role="status" className="px-3 py-2 text-xs text-warning">部分插件未读取完整，当前搜索结果可能不全。<Button size="xs" variant="link" onClick={complete.retry}>重新读取全部插件</Button></div> : null}
        <CommandList>
          <CommandEmpty>{complete.loading ? "正在查找更多插件…" : complete.failed ? "已加载内容中没有匹配项" : "没有匹配的项目、环境或插件"}</CommandEmpty>
          <CommandGroup heading="快速操作">
            <CommandItem
              aria-keyshortcuts="Control+N Meta+N"
              onSelect={() => run(onCreateProject)}
              value="action:create-project 新增项目"
            >
              <Plus />
              新增项目
              <CommandShortcut>{shortcutLabel("N")}</CommandShortcut>
            </CommandItem>
            {onCreateEnvironment ? (
              <CommandItem
                onSelect={() => run(onCreateEnvironment)}
                value="action:create-environment 在当前项目新增环境"
              >
                <TreeStructure />
                在当前项目新增环境
              </CommandItem>
            ) : null}
          </CommandGroup>
          <CommandSeparator />
          {projects.map((project) => (
            <CommandGroup heading={project.name} key={project.projectId}>
              <CommandItem
                disabled={project.isolated}
                onSelect={() => run(() => onSelectProject(project.projectId))}
                value={`project:${project.projectId} ${project.name}`}
              >
                <FolderSimple />
                <span className="min-w-0 flex-1 truncate" title={project.name}>{project.name}</span>
                {project.isolated ? <CommandShortcut>已隔离，无法选择</CommandShortcut> : null}
              </CommandItem>
              {project.environments.map((environment) => (
                <Fragment key={environment.environmentId}>
                  <CommandItem
                    disabled={project.isolated}
                    onSelect={() =>
                      run(() => onSelectEnvironment(project.projectId, environment.environmentId))
                    }
                    value={`environment:${project.projectId}:${environment.environmentId} ${environment.name}`}
                  >
                    <TreeStructure />
                    <span className="min-w-0 flex-1 truncate" title={environment.name}>{environment.name}</span>
                    <CommandShortcut className="max-w-32 truncate tracking-normal" title={project.name}>
                      {project.name}
                    </CommandShortcut>
                  </CommandItem>
                  {(complete.lists.get(`${project.projectId}/${environment.environmentId}`) ?? pluginsByScope.get(`${project.projectId}/${environment.environmentId}`) ?? environment.resourcePreview).map((plugin) => (
                    <CommandItem
                      disabled={project.isolated}
                      key={plugin.pluginInstanceId}
                      onSelect={() =>
                        run(() =>
                          onSelectPlugin(project.projectId, environment.environmentId, plugin.pluginInstanceId),
                        )
                      }
                      value={`plugin:${project.projectId}:${environment.environmentId}:${plugin.pluginInstanceId} ${plugin.displayName}`}
                    >
                      <Stack />
                      <span className="min-w-0 flex-1 truncate" title={plugin.displayName}>{plugin.displayName}</span>
                      <CommandShortcut className="max-w-32 truncate tracking-normal" title={environment.name}>
                        {environment.name}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </Fragment>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
