export const WORKSPACE_PATH_DRAG_TYPE = "application/x-runbook-workspace-path"

export function canDragWorkspacePath(path: string): boolean {
  return path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
}

export function createWorkspacePathDrag() {
  let active: { token: string; path: string } | null = null
  const accepts = (data: Pick<DataTransfer, "types">) =>
    active !== null && data.types.includes(WORKSPACE_PATH_DRAG_TYPE) && !data.types.includes("Files")
  return {
    begin(data: Pick<DataTransfer, "setData" | "clearData" | "effectAllowed">, path: string): boolean {
      active = null
      if (!canDragWorkspacePath(path)) return false
      const token = crypto.randomUUID()
      data.clearData()
      data.effectAllowed = "copy"
      // 拖拽只携带当前工作区的一次性标识，路径由本地状态提供。
      data.setData(WORKSPACE_PATH_DRAG_TYPE, token)
      active = { token, path }
      return true
    },
    accepts,
    take(data: Pick<DataTransfer, "types" | "getData">): string | null {
      if (!accepts(data) || data.getData(WORKSPACE_PATH_DRAG_TYPE) !== active?.token) return null
      const path = active!.path
      active = null
      return path
    },
    clear() { active = null },
  }
}

export type WorkspacePathDrag = ReturnType<typeof createWorkspacePathDrag>
