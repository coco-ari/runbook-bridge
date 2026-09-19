import { useEffect, useRef } from "react"
import { ArrowLeft, Check, ShieldCheck, WarningCircle } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CloudConfigData } from "./cloud-types"

export function CloudSyncPreview({ plan, choices, busy, onChoice, onBack, onConfirm }: {
  readonly plan: CloudConfigData
  readonly choices: Record<string, "local" | "cloud">
  readonly busy: boolean
  readonly onChoice: (rowId: string, choice: "local" | "cloud") => void
  readonly onBack: () => void
  readonly onConfirm: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { headingRef.current?.focus() }, [plan.planId])
  const rows = plan.rows ?? []
  const unresolved = rows.filter(row => !choices[row.rowId]).length
  const restore = plan.direction === "restore"
  const upload = plan.direction === "upload"
  return <section className="space-y-4" aria-label="同步预览">
    <Button size="sm" variant="ghost" disabled={busy} onClick={onBack}><ArrowLeft aria-hidden="true" />{restore ? "返回本地备份" : "返回选择项目"}</Button>
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold outline-none" tabIndex={-1} ref={headingRef}>{restore ? "本地备份恢复预览" : "同步预览"}</h2><Badge variant="outline">{rows.length} 个项目</Badge></div>
      <p className="text-xs leading-5 text-muted-foreground">核对变更并选择保留哪份配置，确认后才会应用。{plan.expiresAt ? `本次预览有效至 ${new Date(plan.expiresAt).toLocaleTimeString()}。` : ""}</p>
    </div>
    {rows.map(row => <article key={row.rowId} className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{row.name}</h3>{row.conflict ? <Badge variant="warning"><WarningCircle />需要选择保留哪份配置</Badge> : <Badge variant="outline">{row.diff.contentChanged ? "配置有变更" : "内容一致"}</Badge>}</div>
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/45 p-3 text-center">
          {[["新增插件", row.diff.added], ["修改插件", row.diff.modified], ["删除插件", row.diff.removed]].map(([label, value]) => <div key={label} className="space-y-1"><p className="text-lg font-semibold tabular-nums">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div>)}
        </div>
        <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p>环境新增 {row.diff.environmentsAdded}、删除 {row.diff.environmentsRemoved}{row.diff.credentialsChanged ? "；凭据有变更" : ""}。</p>
          {row.diff.metadataChanged || row.diff.runbooksChanged || row.diff.questionsChanged ? <p>{row.diff.metadataChanged ? "项目或环境名称、顺序有变更；" : ""}运维说明变更 {row.diff.runbooksChanged ?? 0} 项；快捷提问变更 {row.diff.questionsChanged ?? 0} 项。</p> : null}
        </div>
        {row.willDisconnect || row.warnings.length ? <div className="space-y-1.5 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs leading-5 text-warning">
          {row.willDisconnect ? <p>采用{restore ? "备份" : "云端"}前会断开此项目的连接，并保存本机加密备份；完成后请手动连接。</p> : null}
          {row.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </div> : null}
        <fieldset disabled={busy} className="min-w-0"><legend className="sr-only">为{row.name}选择配置</legend><div className="grid gap-2 sm:grid-cols-2">{(["local", "cloud"] as const).map(choice => {
          const label = choice === "local" ? upload ? "采用本地并上传" : "保留本地" : upload ? "保留云端" : restore ? "采用备份" : "采用云端"
          const description = choice === "local" ? upload ? "将本机配置保存到云仓库" : "本机配置不变，本次跳过" : upload ? "云端配置不变，本次跳过" : restore ? "用这份备份替换本机项目" : "以云端配置替换本机此项目"
          const checked = choices[row.rowId] === choice
          return <label key={choice} className={cn("flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-ring/50", checked ? "border-primary/50 bg-primary/5" : "hover:bg-surface-hover")}>
            <input className="mt-0.5 size-4 shrink-0 accent-primary" type="radio" name={`cloud-choice-${row.rowId}`} aria-label={label} checked={checked} onChange={() => onChoice(row.rowId, choice)} />
            <span className="space-y-1"><span className="block text-xs font-medium">{label}</span><span className="block text-xs text-muted-foreground">{description}</span></span>
          </label>
        })}</div></fieldset>
      </div>
    </article>)}
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">{unresolved ? <><WarningCircle className="text-warning" size={16} />还有 {unresolved} 个项目需要选择配置</> : <><ShieldCheck size={16} />已核对 {rows.length} 个项目，可以确认{restore ? "恢复" : "同步"}</>}</p>
      <Button className="ml-auto" disabled={busy || !rows.length || unresolved > 0} onClick={onConfirm}><Check aria-hidden="true" />确认{upload ? "上传" : restore ? "恢复" : "导入"}</Button>
    </div>
  </section>
}
