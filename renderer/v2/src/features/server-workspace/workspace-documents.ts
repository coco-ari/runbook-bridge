export type WorkspaceLayout = "single" | "horizontal" | "vertical"
export interface DocumentView {
  readonly active: string | null
  readonly panes: readonly string[]
  readonly layout: WorkspaceLayout
}

export function swapDocumentPanes(view: DocumentView): DocumentView {
  if (view.layout === "single" || view.panes.length !== 2) return view
  return { ...view, panes: [...view.panes].reverse() }
}

export function selectDocument(view: DocumentView, id: string): DocumentView {
  if (view.active === id && view.panes.includes(id)) return view
  if (view.layout === "single") return { ...view, active: id, panes: [id] }
  if (view.panes.includes(id)) return { ...view, active: id }
  const index = Math.max(0, view.panes.indexOf(view.active ?? ""))
  return { ...view, active: id, panes: view.panes.map((pane, at) => at === index ? id : pane) }
}

// 仅关闭文档时修复布局；切换标签和分屏不会卸载文档组件。
export function reconcileDocuments(view: DocumentView, ids: readonly string[], previousIds: readonly string[]): DocumentView {
  if (view.panes.every(id => ids.includes(id)) && (view.active ? ids.includes(view.active) : ids.length === 0)) return view
  let panes = view.panes.filter(id => ids.includes(id))
  if (!panes.length && ids.length) {
    const previousIndex = previousIds.indexOf(view.active ?? "")
    const adjacent = previousIds.slice(previousIndex + 1).find(id => ids.includes(id))
      ?? previousIds.slice(0, previousIndex).reverse().find(id => ids.includes(id))
    panes = [adjacent ?? ids[0]!]
  }
  return { active: panes.includes(view.active ?? "") ? view.active : panes[0] ?? null, panes, layout: panes.length > 1 ? view.layout : "single" }
}
