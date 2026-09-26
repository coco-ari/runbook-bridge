import type { CloudRow } from "./cloud-types"

export function CloudFieldDiff({ diff, historical = false }: { readonly diff: CloudRow["diff"]; readonly historical?: boolean }) {
  if (!diff.fields?.length) return null
  return <details className="min-w-0 rounded-md border bg-surface p-2 text-xs" data-testid="cloud-field-diff">
    <summary className="cursor-pointer font-medium focus-visible:outline-ring">查看字段变化 · {diff.fields.length}{diff.fieldsOmitted ? "+" : ""}</summary>
    <p className="my-2 text-muted-foreground">{historical ? "上一版本 → 此版本" : "当前本地 → 覆盖后"}。凭据与自由文本仅提示变化。</p>
    <div className="max-h-64 space-y-2 overflow-y-auto overscroll-contain">
      {diff.fields.map((field, index) => <div key={index} className="min-w-0 border-t pt-2">
        <p className="break-words font-medium [overflow-wrap:anywhere]">{field.scope} · {field.field}</p>
        {field.redacted ? <p className="text-muted-foreground">已变化 · 内容不展示</p> : <div className="mt-1 grid grid-cols-2 gap-2">
          <div className="min-w-0 break-words rounded bg-surface-inset p-1.5 [overflow-wrap:anywhere]"><span className="block text-muted-foreground">{historical ? "上一版本" : "本地"}</span>{field.before}</div>
          <div className="min-w-0 break-words rounded bg-primary/5 p-1.5 [overflow-wrap:anywhere]"><span className="block text-muted-foreground">{historical ? "此版本" : "覆盖后"}</span>{field.after}</div>
        </div>}
      </div>)}
    </div>
    {diff.fieldsOmitted ? <p className="mt-2 text-muted-foreground">另有 {diff.fieldsOmitted} 项变化未展开；确认后仍会完整替换项目。</p> : null}
  </details>
}
