import { useCallback, useRef } from "react"
import { useMysqlEditingGuard } from "./MysqlEditingContext"

// 连接状态与代次共同隔离异步响应，包括同一批渲染中的快速断重连。
export function useMysqlConnectionBoundary() {
  const { connected, connectionEpoch } = useMysqlEditingGuard()
  const current = useRef({ connected, connectionEpoch })
  if (current.current.connected !== connected || current.current.connectionEpoch !== connectionEpoch) {
    current.current = { connected, connectionEpoch }
  }
  const capture = useCallback(() => {
    const owner = current.current
    return () => owner.connected && current.current === owner
  }, [])
  return { connected, connectionEpoch, capture }
}
