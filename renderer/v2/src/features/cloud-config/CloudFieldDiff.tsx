import type { CloudRow } from "./cloud-types"

export function CloudFieldDiff({ diff, historical = false }: { readonly diff: CloudRow["diff"]; readonly historical?: boolean }) {
  if (!diff.fields?.length) return null
  const scopes = [...new Set(diff.fields.map(field => field.scope))]
  const content = <div className="space-y-3" data-testid="cloud-field-diff">
    {scopes.map(scope => <section key={scope} className="min-w-0 overflow-hidden rounded-md border text-xs" aria-label={scope}>
      <h4 className="break-words bg-muted/40 px-3 py-2 font-medium [overflow-wrap:anywhere]">{scope}</h4>
      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] border-t px-3 py-1.5 text-[11px] text-muted-foreground"><span>改动项</span><span>{historical ? "上一版本" : "修改前"}</span><span>{historical ? "此版本" : "更新后"}</span></div>
      {diff.fields!.filter(field => field.scope === scope).map((field, index) => <div key={index} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-t px-3 py-2 leading-5">
        <span className="break-words font-medium [overflow-wrap:anywhere]">{field.field}</span>
        {field.redacted ? <span className="col-span-2 text-muted-foreground">已变更，内容不展示</span> : <><span className="break-words text-muted-foreground [overflow-wrap:anywhere]">{field.before}</span><span className="break-words font-medium text-primary [overflow-wrap:anywhere]">{field.after}</span></>}
      </div>)}
    </section>)}
    {diff.fieldsOmitted ? <p className="text-xs text-muted-foreground">另有 {diff.fieldsOmitted} 项变化未展示；更新仍会完整替换所选项目。</p> : null}
  </div>
  return historical ? <details className="min-w-0 text-xs"><summary className="mb-2 cursor-pointer font-medium focus-visible:outline-ring">查看版本改动 · {diff.fields.length}{diff.fieldsOmitted ? "+" : ""}</summary>{content}</details> : content
}
