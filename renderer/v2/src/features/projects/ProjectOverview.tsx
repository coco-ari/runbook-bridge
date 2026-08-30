import { ArrowClockwise, FolderOpen, Plugs, Stack, WarningCircle } from "@phosphor-icons/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatusIndicator } from "@/components/app-shell/StatusIndicator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  WorkspaceProjectReadModel,
  WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"
import { ProjectRecentActivity } from "@/features/projects/ProjectRecentActivity"

export interface ProjectOverviewProps {
  readonly error?: WorkspaceReadError | null
  readonly loading?: boolean
  readonly onReload?: (() => void) | undefined
  readonly project: WorkspaceProjectReadModel | null
}

function ProjectOverviewSkeleton() {
  return (
    <section aria-busy="true" aria-label="正在读取项目概览" className="space-y-4 @container/project-overview" data-testid="project-overview-loading">
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <Card className="gap-0 py-0" size="sm">
        <CardContent className="grid grid-cols-1 gap-2 p-2 @sm/project-overview:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </CardContent>
      </Card>
    </section>
  )
}

function ProjectOverviewError({
  error,
  onReload,
}: {
  readonly error: WorkspaceReadError
  readonly onReload?: (() => void) | undefined
}) {
  return (
    <Alert className="p-3" data-testid="project-overview-error" variant="destructive">
      <WarningCircle aria-hidden="true" weight="fill" />
      <AlertTitle>项目概览不可用</AlertTitle>
      <AlertDescription>
        <p>无法读取工作区。请重试。</p>
        {onReload ? (
          <Button className="mt-2" onClick={onReload} size="xs" type="button" variant="outline">
            <ArrowClockwise aria-hidden="true" size={13} />
            重新读取
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function ProjectOverview({
  error = null,
  loading = false,
  onReload,
  project,
}: ProjectOverviewProps) {
  if (loading && !project) return <ProjectOverviewSkeleton />
  if (error) return <ProjectOverviewError error={error} onReload={onReload} />
  if (!project) {
    return (
      <Empty className="min-h-52 bg-surface/45 ring-1 ring-inset ring-border/60" data-testid="project-overview-empty">
        <EmptyHeader>
          <EmptyMedia className="bg-primary/10 text-primary" variant="icon"><FolderOpen /></EmptyMedia>
          <EmptyTitle>尚未选择项目</EmptyTitle>
          <EmptyDescription>从项目栏选择一个项目以查看只读概览。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (project.isolated) {
    return (
      <Alert className="p-3" data-testid="project-overview-isolated" role="status" variant="destructive">
        <WarningCircle aria-hidden="true" weight="fill" />
        <AlertTitle className="flex items-center gap-2">
          <span className="truncate" title={project.name}>{project.name}</span>
          <Badge variant="danger">已隔离</Badge>
        </AlertTitle>
        <AlertDescription>项目配置不可用。为保护其他项目，当前项目不会被加载。</AlertDescription>
      </Alert>
    )
  }

  return (
    <section aria-labelledby="project-overview-heading" className="@container/project-overview" data-testid="project-overview">
      <h2 className="sr-only" id="project-overview-heading">项目范围只读概览</h2>

      <Card className="gap-0 py-0" size="sm">
        <CardContent className="p-2">
          <dl className="grid grid-cols-1 gap-2 @sm/project-overview:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
            <Item className="min-h-20 bg-primary/[0.075] px-3 py-3 ring-1 ring-inset ring-primary/15 @sm/project-overview:min-h-24" size="sm" variant="muted">
              <ItemMedia className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary" variant="icon">
                <Stack aria-hidden="true" size={17} weight="duotone" />
              </ItemMedia>
              <ItemContent>
                <ItemDescription asChild><dt>环境总数</dt></ItemDescription>
                <ItemTitle asChild className="font-mono text-2xl font-semibold tracking-tight text-primary"><dd>{project.environmentCount}</dd></ItemTitle>
              </ItemContent>
            </Item>
            <Item className="bg-surface-inset px-2.5 py-2 ring-1 ring-inset ring-border/55" size="xs" variant="muted">
              <ItemMedia className="text-muted-foreground" variant="icon"><Plugs aria-hidden="true" size={14} /></ItemMedia>
              <ItemContent>
                <ItemDescription asChild><dt>插件</dt></ItemDescription>
                <ItemTitle asChild className="font-mono text-base"><dd>{project.pluginCount}</dd></ItemTitle>
              </ItemContent>
            </Item>
          </dl>
        </CardContent>
      </Card>

      <div className="mt-4">
        {project.environments.length === 0 ? (
          <Empty className="min-h-32 bg-surface/35 ring-1 ring-inset ring-border/55">
            <EmptyHeader className="gap-1">
              <EmptyMedia variant="icon"><Stack /></EmptyMedia>
              <EmptyTitle>当前项目没有环境</EmptyTitle>
              <EmptyDescription className="text-xs">新增环境后即可在此查看运行状态。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="gap-0 py-0" size="sm">
            <CardHeader className="border-b border-border/70 px-3 py-2.5">
              <CardTitle><h3 className="text-xs font-semibold">环境状态</h3></CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ItemGroup aria-label={project.name + "的环境状态"} className="gap-1 p-2 @md/project-overview:hidden">
                {project.environments.map((environment) => (
                  <Item className="min-w-0" key={environment.environmentId} role="listitem" size="xs" variant="muted">
                    <ItemContent>
                      <ItemTitle className="w-full truncate" title={environment.name}>{environment.name}</ItemTitle>
                      <ItemDescription className="font-mono">
                        {environment.readyPluginCount}/{environment.pluginCount} 个插件就绪
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="ml-auto">
                      <StatusIndicator appearance="badge" compact status={environment.status} />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
              <div className="hidden @md/project-overview:block">
                <Table aria-label={project.name + "的环境状态"}>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-8 text-[10px]">环境</TableHead>
                      <TableHead className="h-8 text-right text-[10px]">插件</TableHead>
                      <TableHead className="h-8 text-right text-[10px]">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {project.environments.map((environment) => (
                      <TableRow key={environment.environmentId}>
                        <TableCell className="max-w-0 py-2">
                          <span className="block truncate text-xs font-medium" title={environment.name}>
                            {environment.name}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {environment.readyPluginCount}/{environment.pluginCount}
                        </TableCell>
                        <TableCell className="py-2 text-right">
                          <StatusIndicator appearance="badge" compact status={environment.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <ProjectRecentActivity projectId={project.projectId} projectName={project.name} />
    </section>
  )
}
