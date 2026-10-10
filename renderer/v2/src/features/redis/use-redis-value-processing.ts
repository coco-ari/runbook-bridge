import { useEffect, useState } from "react"
import type { ValueResult, ValueWork } from "./redis-value-worker"

export function runRedisValueWork(work: ValueWork, signal?: AbortSignal): Promise<ValueResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("内容处理已取消")); return }
    const worker = new Worker(new URL("./redis-value-worker.ts", import.meta.url), { type: "module" })
    const stop = () => { worker.terminate(); signal?.removeEventListener("abort", cancel) }
    const cancel = () => { stop(); reject(new Error("内容处理已取消")) }
    signal?.addEventListener("abort", cancel, { once: true })
    worker.onmessage = (event: MessageEvent<ValueResult>) => { stop(); resolve(event.data) }
    worker.onerror = () => { stop(); reject(new Error("内容处理失败，请重新打开后重试。")) }
    worker.postMessage(work)
  })
}

export function useRedisValueProcessing(source: string | null, mode: ValueWork["mode"], truncated = false, delay = 0) {
  const [result, setResult] = useState<{ source: string | null; mode: string; truncated: boolean; value: ValueResult } | null>(null)
  useEffect(() => {
    if (source === null) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void runRedisValueWork({ source, mode, truncated }, controller.signal).then(value => {
        if (!controller.signal.aborted) setResult({ source, mode, truncated, value })
      }, () => {
        if (!controller.signal.aborted) setResult({ source, mode, truncated, value: { text: null, bytes: 0, error: "内容处理失败，请重试。" } })
      })
    }, delay)
    return () => { clearTimeout(timer); controller.abort() }
  }, [source, mode, truncated, delay])
  return result?.source === source && result.mode === mode && result.truncated === truncated ? result.value : null
}
