import { useMemo, useRef, useState } from "react"
import { Copy, MagnifyingGlass, TextAlignLeft } from "@phosphor-icons/react"
import { toast } from "sonner"
import type { RedisValuePreview } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { redisBytes } from "./redis-workspace-model"
import { formatRedisJson } from "./redis-value-format"
import { RedisValueEditor, type RedisValueEditorHandle } from "./RedisValueEditor"

export function RedisValueViewer({ value }: { readonly value: RedisValuePreview }) {
  const [view, setView] = useState<"text" | "json" | "hex" | null>(null)
  const [wrap, setWrap] = useState(true)
  const editor = useRef<RedisValueEditorHandle>(null)
  const json = useMemo(() => value.text === null ? null : formatRedisJson(value.text, value.truncated), [value.text, value.truncated])
  const automatic = value.text === null ? "hex" : json !== null ? "json" : "text"
  const active = value.text === null ? "hex" : view === "json" && json === null ? "text" : view ?? automatic
  const shown = active === "json" ? json! : active === "hex" ? value.hex.match(/.{1,32}/gu)?.join("\n") ?? "" : value.text ?? ""
  async function copy() {
    try { await copyText(shown); toast.success(value.truncated ? "已复制已加载部分" : "已复制") }
    catch { toast.error("复制失败，请检查系统剪贴板后重试。") }
  }
  return <div className="redis-value-viewer">
    <div className="redis-value-toolbar">
      <div className="redis-view-modes" role="group" aria-label="内容显示方式">
        {(["json", "text", "hex"] as const).map((mode) => <Button key={mode} aria-pressed={active === mode} data-testid={"redis-view-" + mode}
          disabled={mode === "text" && value.text === null || mode === "json" && json === null}
          title={mode === "json" && json === null ? "当前内容无法识别为 JSON" : undefined}
          size="xs" variant="ghost" onClick={() => setView(mode)}>{mode === "text" ? "文本" : mode === "json" ? "JSON" : "十六进制"}</Button>)}
      </div>
      <span className="redis-value-size" title={value.truncated ? "已加载字节 / 总字节" : "内容大小"}>{value.truncated ? redisBytes(value.shownBytes) + " / " : ""}{redisBytes(value.bytes)}</span>
      <Button size="xs" variant="ghost" className="redis-copy-content" aria-label={value.truncated ? "复制已加载部分" : "复制当前内容"}
        title={value.truncated ? "复制当前显示的片段，不包含未读取内容" : "复制当前显示内容，包含折叠部分"} data-testid="redis-copy-content" onClick={() => void copy()}><Copy aria-hidden="true" />{value.truncated ? "复制已加载部分" : "复制内容"}</Button>
      <div className="redis-value-tools">
        <Button size="icon-xs" variant="ghost" aria-label="查找 Value 内容" title="查找已加载内容（Ctrl / ⌘ + F）" data-testid="redis-value-find" onClick={() => editor.current?.find()}><MagnifyingGlass /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="自动换行" title="自动换行" aria-pressed={wrap} disabled={active === "hex"} data-testid="redis-value-wrap" onClick={() => setWrap(!wrap)}><TextAlignLeft /></Button>
        {active === "json" ? <><Button size="xs" variant="ghost" data-testid="redis-json-collapse" onClick={() => editor.current?.fold()}>折叠全部</Button><Button size="xs" variant="ghost" data-testid="redis-json-expand" onClick={() => editor.current?.unfold()}>展开全部</Button></> : null}
      </div>
    </div>
    {value.truncated ? <p className="redis-notice redis-value-truncation" role="status" data-testid="redis-value-truncation">仅预览 {redisBytes(value.shownBytes)} / {redisBytes(value.bytes)}。{active === "json" ? "当前为 JSON 片段，末尾可能未闭合。" : "内容已截断。"}复制仅包含已加载部分；完整读取需在插件配置中调整内容上限后刷新。</p> : null}
    {value.text === null ? <p className="redis-muted px-3 pt-2">二进制内容 · 十六进制预览</p> : null}
    {shown ? <RedisValueEditor ref={editor} text={shown} language={active} wrap={wrap} />
      : <div className="redis-value-empty" data-testid="redis-value">{value.bytes === 0 ? "（空字符串）" : "（当前预算不足以展示完整字符）"}</div>}
  </div>
}
