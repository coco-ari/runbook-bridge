import { lazy, Suspense, useCallback, useRef, useState } from "react"
import { EnvironmentTypeBadge } from "@/features/environments/EnvironmentTypeBadge"
import { OperationMessage, OperationSpinner, useOperationLabel } from "@/components/workspace/OperationFeedback"
import { FloppyDisk, MagnifyingGlass, TextAlignLeft } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SelectControl, SelectItem } from "@/components/ui/select"
import type { RedisDraft } from "./use-redis-editing"
import type { RedisValueEditorHandle } from "./RedisValueEditor"
import { redisEditorLimit } from "./redis-editor-model"

const ValueEditor = lazy(async () => ({ default: (await import("./RedisValueEditor")).RedisValueEditor }))

export function RedisWriteEditor({draft,connected,onChange,onSave,onCancel,onVerify}: {
  readonly draft: RedisDraft; readonly connected: boolean; readonly onChange:(patch:Partial<RedisDraft>)=>void
  readonly onSave:()=>void; readonly onCancel:()=>void; readonly onVerify:()=>void
}) {
  const editor = useRef<RedisValueEditorHandle>(null)
  const [editorReady, setEditorReady] = useState(false)
  const attachEditor = useCallback((handle: RedisValueEditorHandle | null) => {
    editor.current = handle
    setEditorReady(Boolean(handle))
  }, [])
  const [wrap, setWrap] = useState(true)
  const [limitMessage, setLimitMessage] = useState("")
  let jsonError = ""
  if (draft.format === "json") try { JSON.parse(draft.value) } catch (error) { jsonError = error instanceof Error ? error.message : "JSON 格式无效" }
  const bytes = new TextEncoder().encode(draft.value).length
  const limit = draft.session?.maxBytes ?? 65536
  const invalidExpiry = draft.expiry === "relative" && (!Number.isSafeInteger(Number(draft.duration)*Number(draft.unit)) || Number(draft.duration) <= 0)
  const locked = draft.busy || draft.uncertain
  const invalidValue = Boolean(jsonError) || redisEditorLimit(draft.value, limit) !== null
  const canSave = connected && !locked && !invalidValue && !invalidExpiry && Boolean(draft.key)
  function save() { if (canSave) onSave() }
  function changeValue(value: string) { setLimitMessage(""); onChange({ value }) }
  function limitReached(reason: "characters" | "bytes") {
    setLimitMessage(reason === "characters" ? "内容最多允许 65,536 个字符，草稿已保留。" : `内容超过 ${limit.toLocaleString()} 字节上限，草稿已保留。`)
  }
  const waiting = useOperationLabel(draft.busy, draft.phase === "check" ? "正在检查保存状态…" : draft.phase === "read" ? "正在读取数据核实…" : draft.phase === "prepare" ? "正在校验更改…" : "正在保存…")
  const message = waiting || draft.error || limitMessage || (jsonError ? "JSON 格式错误：" + jsonError : invalidExpiry ? "请输入有效的过期时长。" : draft.uncertain ? "暂时无法确认保存结果，草稿已保留。" : "更改仅暂存在当前会话，保存后生效。")
  return <div className="redis-value-editor" data-testid="redis-value-editor" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); save() } }}>
    {draft.creating ? <label className="redis-edit-key">Key 名称<Input autoFocus aria-label="新增 Key 名称" value={draft.key} disabled={draft.busy || draft.uncertain} placeholder="输入允许范围内的完整 Key" onChange={event => onChange({key:event.target.value})} /></label> : null}
    <div className="redis-value-toolbar redis-write-toolbar">
      <div className="redis-view-modes" role="group" aria-label="编辑格式">{(["text","json"] as const).map(format => <Button type="button" size="xs" variant="ghost" key={format} disabled={locked} aria-pressed={draft.format===format} data-testid={"redis-edit-format-" + format} onClick={()=>onChange({format})}>{format==="json"?"JSON":"文本"}</Button>)}</div>
      <span className={bytes>limit?"text-danger":"text-muted-foreground"} data-testid="redis-draft-bytes">{bytes.toLocaleString()} / {limit.toLocaleString()} 字节</span>
      <div className="redis-value-tools">
        <Button size="icon-xs" variant="ghost" disabled={!editorReady} aria-label="查找草稿内容" title="查找草稿（Ctrl / ⌘ + F）" data-testid="redis-draft-find" onClick={()=>editor.current?.find()}><MagnifyingGlass aria-hidden="true" /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="草稿自动换行" title="自动换行" aria-pressed={wrap} data-testid="redis-draft-wrap" onClick={()=>setWrap(!wrap)}><TextAlignLeft aria-hidden="true" /></Button>
        <Button size="xs" variant="ghost" disabled={!editorReady || locked || draft.format !== "json" || Boolean(jsonError)} onClick={()=>editor.current?.formatJson()} data-testid="redis-draft-format" title="仅调整字符串外的空白，保留数字精度与原始转义">格式化 JSON</Button>
      </div>
      <span className="redis-draft-status text-muted-foreground">{draft.uncertain ? "待核实" : draft.busy ? "处理中" : "未保存"}</span>
    </div>
    <Suspense fallback={<div className="redis-value-code redis-write-code" role="status"><p className="redis-empty">正在准备编辑器，草稿已保留…</p></div>}>
      <ValueEditor ref={attachEditor} text={draft.value} language={draft.format} wrap={wrap} readOnly={false} disabled={locked} invalid={invalidValue} autoFocus={!draft.creating} maxBytes={limit} onChange={changeValue} onSave={save} onLimit={limitReached} />
    </Suspense>
    <div className="redis-expiry-editor"><span>过期设置</span><SelectControl aria-label="过期方式" value={draft.expiry} disabled={draft.busy || draft.uncertain} onValueChange={value=>onChange({expiry:value as RedisDraft["expiry"]})}>{!draft.creating?<SelectItem value="keep">保留原过期时间</SelectItem>:null}<SelectItem value="persistent">永久保存</SelectItem><SelectItem value="relative">指定有效期</SelectItem></SelectControl>{draft.expiry==="relative"?<><Input aria-label="有效期时长" type="number" min="1" value={draft.duration} disabled={draft.busy || draft.uncertain} onChange={event=>onChange({duration:event.target.value})}/><SelectControl aria-label="有效期单位" value={draft.unit} disabled={draft.busy || draft.uncertain} onValueChange={unit=>onChange({unit})}><SelectItem value="1000">秒</SelectItem><SelectItem value="60000">分钟</SelectItem><SelectItem value="3600000">小时</SelectItem><SelectItem value="86400000">天</SelectItem></SelectControl></>:null}</div>
    <footer className="redis-edit-footer">
      <div className="flex min-w-0 items-center gap-2"><EnvironmentTypeBadge /><OperationMessage diagnostic={draft.uncertain ? { code: "REDIS_WRITE_OUTCOME_UNKNOWN", message } : draft.stale ? { code: "REDIS_EDIT_STALE", message } : undefined} className="redis-edit-error" message={message} error={!draft.busy && Boolean(draft.error || jsonError || invalidExpiry || limitMessage)} /></div>
      <div className="redis-edit-actions">
        <div className="redis-edit-recovery">
          {draft.uncertain ? <Button size="sm" variant="outline" disabled={!connected || draft.busy} onClick={onVerify} data-testid="redis-verify-save">{draft.busy ? <OperationSpinner /> : null}重新确认结果</Button> : null}
        </div>
        <Button size="sm" variant="outline" disabled={draft.busy || draft.uncertain} onClick={onCancel} title={draft.uncertain ? "结果尚未确认，取消不会撤销服务器操作，请先核实" : undefined}>取消</Button>
        <Button className="redis-save-operation" size="sm" aria-busy={draft.busy} disabled={!canSave} onClick={save} data-testid="redis-save-value" title="保存（Ctrl / ⌘ + S）">{draft.busy && (draft.phase === "prepare" || draft.phase === "commit") ? <OperationSpinner /> : <FloppyDisk aria-hidden="true" />}{draft.busy && (draft.phase === "prepare" || draft.phase === "commit") ? "保存中…" : "保存"}</Button>
      </div>
    </footer>
  </div>
}
