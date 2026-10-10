import { useLayoutEffect, useRef } from "react"
import { getAiOpsV2 } from "@/bridge/ai-ops-v2"

// 只上报数量，草稿内容、SQL 和凭据始终留在各自工作区的内存中。
const entries = new Map<symbol, number>()
export const unsavedWorkCount = () => [...entries.values()].reduce((sum, count) => sum + count, 0)
function report() {
  getAiOpsV2().reportUnsavedWork(unsavedWorkCount())
}

export function useUnsavedWork(count: number | boolean) {
  const key = useRef(Symbol("unsaved-work"))
  useLayoutEffect(() => {
    const id = key.current
    entries.set(id, typeof count === "boolean" ? Number(count) : count)
    report()
    return () => { entries.delete(id); report() }
  }, [count])
}
