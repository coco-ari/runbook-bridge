import { FloppyDisk } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SelectControl, SelectItem } from "@/components/ui/select"
import type { RedisDraft } from "./use-redis-editing"

export function RedisWriteEditor({draft,connected,onChange,onSave,onCancel,onCheck,onRecheck}: {
  readonly draft: RedisDraft; readonly connected: boolean; readonly onChange:(patch:Partial<RedisDraft>)=>void
  readonly onSave:()=>void; readonly onCancel:()=>void; readonly onCheck:()=>void; readonly onRecheck:()=>void
}) {
  let jsonError = ""
  if (draft.format === "json") try { JSON.parse(draft.value) } catch (error) { jsonError = error instanceof Error ? error.message : "JSON 格式无效" }
  const bytes = new TextEncoder().encode(draft.value).length
  const limit = draft.session?.maxBytes ?? 65536
  const invalidExpiry = draft.expiry === "relative" && (!Number.isSafeInteger(Number(draft.duration)*Number(draft.unit)) || Number(draft.duration) <= 0)
  return <div className="redis-value-editor" data-testid="redis-value-editor" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); if (!jsonError && bytes<=limit && !invalidExpiry) onSave() } }}>
    {draft.creating ? <label className="redis-edit-key">Key 名称<Input autoFocus aria-label="新增 Key 名称" value={draft.key} disabled={draft.busy || draft.uncertain} placeholder="输入允许范围内的完整 Key" onChange={event => onChange({key:event.target.value})} /></label> : null}
    <div className="redis-value-toolbar"><div className="redis-view-modes" aria-label="编辑格式">{(["text","json"] as const).map(format => <button type="button" key={format} disabled={draft.busy || draft.uncertain} aria-pressed={draft.format===format} onClick={()=>onChange({format})}>{format==="json"?"JSON":"文本"}</button>)}</div><span className={bytes>limit?"text-danger":"text-muted-foreground"}>{bytes.toLocaleString()} / {limit.toLocaleString()} 字节</span><span className="ml-auto text-muted-foreground">未保存</span></div>
    <textarea autoFocus={!draft.creating} className="redis-edit-textarea" aria-label="Redis Value" spellCheck={false} maxLength={65536} value={draft.value} disabled={draft.busy || draft.uncertain} onChange={event=>onChange({value:event.target.value})} aria-invalid={Boolean(jsonError)||bytes>limit} />
    {jsonError ? <p className="redis-edit-error" role="alert">JSON 格式错误：{jsonError}</p> : null}
    <div className="redis-expiry-editor"><span>过期设置</span><SelectControl aria-label="过期方式" value={draft.expiry} disabled={draft.busy || draft.uncertain} onValueChange={value=>onChange({expiry:value as RedisDraft["expiry"]})}>{!draft.creating?<SelectItem value="keep">保留原过期时间</SelectItem>:null}<SelectItem value="persistent">永久保存</SelectItem><SelectItem value="relative">指定有效期</SelectItem></SelectControl>{draft.expiry==="relative"?<><Input aria-label="有效期时长" type="number" min="1" value={draft.duration} disabled={draft.busy || draft.uncertain} onChange={event=>onChange({duration:event.target.value})}/><SelectControl aria-label="有效期单位" value={draft.unit} disabled={draft.busy || draft.uncertain} onValueChange={unit=>onChange({unit})}><SelectItem value="1000">秒</SelectItem><SelectItem value="60000">分钟</SelectItem><SelectItem value="3600000">小时</SelectItem><SelectItem value="86400000">天</SelectItem></SelectControl></>:null}</div>
    {draft.error ? <p className="redis-edit-error" role="alert">{draft.error}</p> : null}
    <footer className="redis-edit-footer">{draft.uncertain?<Button size="sm" variant="outline" disabled={draft.busy} onClick={onCheck} data-testid="redis-check-save">检查保存状态</Button>:null}{draft.stale?<Button size="sm" variant="outline" disabled={!connected || draft.busy} onClick={onRecheck}>重新读取并核对</Button>:null}<div className="ml-auto flex gap-2"><Button size="sm" variant="outline" disabled={draft.busy} onClick={onCancel}>取消</Button><Button size="sm" disabled={!connected || draft.busy || draft.stale || draft.uncertain || Boolean(jsonError) || bytes>limit || invalidExpiry || !draft.key} onClick={onSave} data-testid="redis-save-value"><FloppyDisk />{draft.busy?"保存中…":"保存"}</Button></div></footer>
  </div>
}
