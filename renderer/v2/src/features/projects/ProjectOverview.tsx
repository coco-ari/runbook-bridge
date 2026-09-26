import { EnvironmentTypeBadge } from "@/features/environments/EnvironmentTypeBadge"
import { ArrowClockwise, FolderOpen, Stack, WarningCircle } from "@phosphor-icons/react"

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
  readonly onSelectEnvironment?: ((environmentId: string) => void) | undefined
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
        <CardContent className="flex gap-2 p-2">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-full rounded-md" />
        </CardContent>
      </Card>
    </section>
  )
}

function ProjectOverviewError({
  onReload,
}: {
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
  onSelectEnvironment,
  project,
}: ProjectOverviewProps) {
  if (loading && !project) return <ProjectOverviewSkeleton />
  if (error) return <ProjectOverviewError onReload={onReload} />
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

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-surface px-3 py-2.5" aria-label="项目摘要" data-testid="project-summary-strip">
        {[["环境", project.environmentCount], ["插件", project.pluginCount], ["已连接", project.environments.reduce((total, environment) => total + environment.runtime.connectedCount, 0)]].map(([label, value]) => <div key={label} className="flex items-baseline gap-2">
          <dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono text-sm font-medium tabular-nums">{value}</dd>
        </div>)}
      </dl>

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
              <CardTitle><h3 className="text-section font-medium">环境状态</h3></CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ItemGroup aria-label={project.name + "的环境状态"} className="gap-1 p-2 @md/project-overview:hidden">
                {project.environments.map((environment) => (
                  <Item className="min-w-0" key={environment.environmentId} role="listitem" size="xs" variant="muted">
                    <ItemContent>
                      <ItemTitle className="flex w-full min-w-0 gap-2"><Button size="xs" variant="link" className="h-auto min-w-0 truncate p-0" onClick={() => onSelectEnvironment?.(environment.environmentId)}>{environment.name}</Button><EnvironmentTypeBadge type={environment.environmentType} /></ItemTitle>
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
                      <TableHead className="h-8 text-xs">环境</TableHead>
                      <TableHead className="h-8 text-right text-xs">插件</TableHead>
                      <TableHead className="h-8 text-right text-xs">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {project.environments.map((environment) => (
                      <TableRow key={environment.environmentId}>
                        <TableCell className="max-w-0 py-2">
                          <div className="flex min-w-0 items-center gap-2"><Button size="xs" variant="link" className="h-auto min-w-0 truncate p-0" title={environment.name} onClick={() => onSelectEnvironment?.(environment.environmentId)}>{environment.name}</Button><EnvironmentTypeBadge type={environment.environmentType} /></div>
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
