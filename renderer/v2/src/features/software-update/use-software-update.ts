import { useCallback, useEffect, useRef, useState } from "react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import type { SoftwareUpdateRequest, SoftwareUpdateState } from "./software-update-types"

export function useSoftwareUpdate(api: AiOpsV2Api, enabled = true) {
  const [state, setState] = useState<SoftwareUpdateState | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<SoftwareUpdateRequest["action"] | null>(null)
  const mounted = useRef(false)
  const actionInFlight = useRef<SoftwareUpdateRequest["action"] | null>(null)
  const generation = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  const refresh = useCallback(async () => {
    const started = generation.current
    try {
      const result = await api.softwareUpdate({ action: "status" })
      if (!mounted.current || started !== generation.current) return null
      if (result.ok) { setState(result.data); return result.data }
      setError(result.error.message)
    } catch { if (mounted.current && started === generation.current) setError("暂时无法读取更新状态，请重试。") }
    return null
  }, [api])
  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await refresh(); if (active) timer = setTimeout(() => { void poll() }, 1000) }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled, refresh])
  const run = async (request: SoftwareUpdateRequest) => {
    if (actionInFlight.current && request.action !== "cancel") return null
    const current = ++generation.current
    actionInFlight.current = request.action
    setPending(request.action); setError("")
    try {
      const result = await api.softwareUpdate(request)
      if (!mounted.current || current !== generation.current) return null
      if (result.ok) { setState(result.data); return result.data }
      setError(result.error.message)
    } catch { if (mounted.current && current === generation.current) setError("更新操作未完成，请检查网络后重试。") }
    finally {
      if (current === generation.current) { generation.current++; actionInFlight.current = null; if (mounted.current) setPending(null) }
    }
    return null
  }
  return { state, error, pending, refresh, run }
}
