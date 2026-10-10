import type { CloudRow } from "./cloud-types"

export function changedCloudRows(rows: readonly CloudRow[] = []) {
  return rows.filter(row => row.diff.contentChanged)
}

export function changeSummary(diff: CloudRow["diff"]): string {
  const changes: string[] = []
  if (diff.added) changes.push(`新增 ${diff.added} 个插件`)
  if (diff.modified) changes.push(`修改 ${diff.modified} 个插件`)
  if (diff.removed) changes.push(`删除 ${diff.removed} 个插件`)
  if (diff.environmentsAdded) changes.push(`新增 ${diff.environmentsAdded} 个环境`)
  if (diff.environmentsRemoved) changes.push(`删除 ${diff.environmentsRemoved} 个环境`)
  if (diff.metadataChanged) changes.push("项目或环境信息变更")
  if (diff.runbooksChanged) changes.push(`${diff.runbooksChanged} 份运维说明变更`)
  if (diff.questionsChanged) changes.push("快捷提问变更")
  if (diff.credentialsChanged) changes.push("凭据变更")
  return changes.join(" · ") || (diff.contentChanged ? "配置内容有变更" : "无变化")
}
