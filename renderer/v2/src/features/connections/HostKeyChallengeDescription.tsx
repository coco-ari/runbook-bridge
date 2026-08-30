import { AlertDialogDescription } from "@/components/ui/alert-dialog"
import type { RuntimeHostKeyChallenge } from "@/features/connections/connection-model"

export interface HostKeyChallengeDescriptionProps {
  readonly challenge: RuntimeHostKeyChallenge | null
  readonly showPlugin?: boolean
}

export function HostKeyChallengeDescription({
  challenge,
  showPlugin = false,
}: HostKeyChallengeDescriptionProps) {
  return (
    <AlertDialogDescription asChild>
      <div className="space-y-3 text-left">
        <p>请通过可信渠道核对以下主机信息。只有明确确认后，本次连接才会继续。</p>
        <dl className="overflow-hidden rounded-lg bg-surface-inset ring-1 ring-inset ring-border/70">
          {showPlugin ? (
            <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 border-b border-border/60 px-3 py-2">
              <dt>确认范围</dt>
              <dd className="min-w-0 break-words text-foreground">当前环境内待连接的插件</dd>
            </div>
          ) : null}
          <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 border-b border-border/60 px-3 py-2">
            <dt>主机</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">
              {challenge ? `${challenge.host}:${challenge.port}` : "未知"}
            </dd>
          </div>
          <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 border-b border-border/60 px-3 py-2">
            <dt>算法</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">{challenge?.algorithm || "未知"}</dd>
          </div>
          <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 px-3 py-2">
            <dt>指纹</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">{challenge?.fingerprint ?? "未知"}</dd>
          </div>
        </dl>
      </div>
    </AlertDialogDescription>
  )
}
