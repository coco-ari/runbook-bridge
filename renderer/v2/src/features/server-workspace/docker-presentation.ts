const STATE_LABELS: Readonly<Record<string, string>> = {
  running: "运行中", exited: "已退出", paused: "已暂停", restarting: "重启中",
  created: "已创建", removing: "移除中", dead: "异常终止",
}

export function dockerStateLabel(state: string): string {
  return Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state]! : state
}

export interface LogMatchSegment {
  readonly text: string
  readonly matched: boolean
}

export function logMatchSegments(text: string, query: string): readonly LogMatchSegment[] {
  if (!query) return [{ text, matched: false }]
  // 按字面内容匹配，不把日志或查找词解释为 HTML 或正则表达式。
  const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu")
  const result: LogMatchSegment[] = []
  let offset = 0
  for (const match of text.matchAll(matcher)) {
    if (match.index > offset) result.push({ text: text.slice(offset, match.index), matched: false })
    result.push({ text: match[0], matched: true })
    offset = match.index + match[0].length
  }
  if (offset < text.length || !result.length) result.push({ text: text.slice(offset), matched: false })
  return result
}
