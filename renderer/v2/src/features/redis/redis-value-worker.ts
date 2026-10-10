import { formatRedisJson } from "./redis-value-format"
import { REDIS_EDITABLE_BYTES } from "./redis-desktop-limits"

export interface ValueWork {
  source: string
  mode: "display" | "validate" | "format" | "hex" | "measure" | "edit"
  truncated?: boolean
}
export interface ValueResult { text: string | null; bytes: number; error: string }

export function processRedisValue({ source, mode, truncated = false }: ValueWork): ValueResult {
  const raw = new TextEncoder().encode(source)
  if (mode === "measure") return { text: null, bytes: raw.length, error: "" }
  if (mode === "hex") {
    const lines: string[] = []
    for (let at = 0; at < raw.length; at += 16) lines.push(Array.from(raw.subarray(at, at + 16), byte => byte.toString(16).padStart(2, "0")).join(""))
    return { text: lines.join("\n"), bytes: raw.length, error: "" }
  }
  let error = ""
  if (!truncated) {
    try { JSON.parse(source) } catch (failure) {
      const message = failure instanceof Error ? failure.message : "JSON 格式无效"
      const position = /position (\d+)/u.exec(message)?.[1]
      const before = source.slice(0, position === undefined ? source.length : Number(position))
      const line = before.split("\n").length
      const column = before.length - before.lastIndexOf("\n")
      error = `第 ${line} 行，第 ${column} 列：JSON 格式无效。`
    }
  }
  const formatted = mode === "validate" || error ? null : formatRedisJson(source, truncated)
  const text = mode === "edit" && formatted !== null && new TextEncoder().encode(formatted).length > REDIS_EDITABLE_BYTES ? source : formatted
  return { bytes: raw.length, error, text }
}

// 工作线程仅处理当前值，不读取网络、凭据或本地文件。
self.onmessage = (event: MessageEvent<ValueWork>) => self.postMessage(processRedisValue(event.data))
