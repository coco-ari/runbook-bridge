import { CheckCircle, Info, WarningDiamond } from "@phosphor-icons/react"
import type { EnvironmentRuntime } from "@/bridge/ai-ops-v2"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { PluginSaveOutcome } from "./plugin-editor-model"
import { pluginSaveFeedback } from "./plugin-save-feedback"

export function PluginSaveNotice({ outcome, runtime, unavailable, onRefresh, onDismiss }: {
  readonly outcome: PluginSaveOutcome
  readonly runtime: EnvironmentRuntime | null
  readonly unavailable: boolean
  readonly onRefresh: () => void
  readonly onDismiss: () => void
}) {
  const feedback = pluginSaveFeedback(outcome, runtime, unavailable)
  const Icon = feedback.tone === "warning" ? WarningDiamond : feedback.tone === "success" ? CheckCircle : Info
  return (
    <Alert className={feedback.tone === "warning" ? "mb-4 border-warning/30 bg-warning/5" : "mb-4"} data-testid="plugin-save-recovery-notice" data-recovery-state={feedback.state}>
      <Icon aria-hidden="true" className={feedback.tone === "warning" ? "text-warning" : "text-muted-foreground"} />
      <div aria-live="polite" aria-atomic="true" className="min-w-0">
        <AlertTitle>{feedback.title}</AlertTitle>
        <AlertDescription>{feedback.message}</AlertDescription>
      </div>
      <div className="col-start-2 mt-2 flex flex-wrap gap-2">
        {feedback.state !== "not-needed" ? <Button onClick={onRefresh} size="xs" variant="outline">刷新状态</Button> : null}
        <Button onClick={onDismiss} size="xs" variant="ghost">知道了</Button>
      </div>
    </Alert>
  )
}
