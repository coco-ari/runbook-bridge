import { ArrowClockwise, Stack, WarningCircle } from "@phosphor-icons/react"
import type { ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  WorkspaceEnvironmentReadModel,
  WorkspaceReadError,
} from "@/features/workspace/workspace-read-model"

export interface EnvironmentOverviewProps {
  readonly connectionPanel?: ReactNode
  readonly environment: WorkspaceEnvironmentReadModel | null
  readonly error?: WorkspaceReadError | null
  readonly loading?: boolean
  readonly onReload?: () => void
}

export function EnvironmentOverview({
  connectionPanel,
  environment,
  error = null,
  loading = false,
  onReload,
}: EnvironmentOverviewProps) {
  if (loading && !environment) {
    return (
      <section aria-busy="true" aria-label="正在读取环境详情" className="space-y-3" data-testid="environment-overview-loading">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </section>
    )
  }

  const readErrorNotice = error ? (
    <Alert data-testid="environment-overview-error" variant="destructive">
      <WarningCircle aria-hidden="true" weight="fill" />
      <AlertTitle>{environment ? "环境信息刷新失败" : "环境详情不可用"}</AlertTitle>
      <AlertDescription>
        <p>{environment ? "显示上次读取的信息，请重新读取后核对。当前连接操作仍可管理。" : "无法读取环境信息。请重试。"}</p>
        {onReload ? (
          <Button className="mt-2" onClick={onReload} size="sm" type="button" variant="outline">
            <ArrowClockwise aria-hidden="true" size={14} />
            重新读取
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  ) : null
  if (error && !environment) return readErrorNotice
  if (!environment) {
    return (
      <Empty className="min-h-52" data-testid="environment-overview-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Stack aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>尚未选择环境</EmptyTitle>
          <EmptyDescription>从环境栏选择一个环境以查看详情。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <section aria-labelledby="environment-overview-heading" className="space-y-4" data-testid="environment-overview">
      <h2 className="sr-only" id="environment-overview-heading">环境详情</h2>
      {readErrorNotice}
      {connectionPanel}
    </section>
  )
}
