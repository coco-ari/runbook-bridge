// 保留 BOM 和原换行；混合换行不自动规范化，避免一次编辑重写整个配置。
export function textFormat(content: string) {
  const body = content.startsWith("\uFEFF") ? content.slice(1) : content
  const endings = new Set(body.match(/\r\n|\r|\n/g) ?? [])
  if (endings.size > 1) throw new Error("此文件混用了多种换行符，暂时保持只读。请先使用专用编辑器统一换行。")
  const separator = [...endings][0] ?? "\n"
  return { body, bom: content.startsWith("\uFEFF") ? "\uFEFF" : "", separator, label: separator === "\r\n" ? "CRLF" : separator === "\r" ? "CR" : "LF" }
}

// 线性计算一个完整替换区间。区间内可能含未变更的行，不把它误称为最小逐行差异。
export function changedRange(before: string, after: string) {
  const oldLines = before.split(/\r\n|\r|\n/), newLines = after.split(/\r\n|\r|\n/)
  let start = 0, end = 0
  while (start < Math.min(oldLines.length, newLines.length) && oldLines[start] === newLines[start]) start++
  while (end < Math.min(oldLines.length, newLines.length) - start && oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]) end++
  return { start: start + 1, oldEnd: oldLines.length - end, newEnd: newLines.length - end }
}

export interface FileChangeBlock {
  readonly before: { readonly start: number; readonly end: number }
  readonly after: { readonly start: number; readonly end: number }
}
export interface FileChanges {
  readonly mode: "changes" | "range"
  readonly blocks: readonly FileChangeBlock[]
  readonly added: number | null
  readonly removed: number | null
}
const MAX_DIFF_LINES = 20_000
const MAX_DIFF_CELLS = 250_000

// 只为确认界面计算差异。先剥离相同行，再严格限制动态规划预算，不改变待保存文本。
export function fileChangeBlocks(before: string, after: string): FileChanges {
  const oldLines = before ? before.split(/\r\n|\r|\n/) : [], newLines = after ? after.split(/\r\n|\r|\n/) : []
  let offset = 0, suffix = 0
  while (offset < Math.min(oldLines.length, newLines.length) && oldLines[offset] === newLines[offset]) offset++
  while (suffix < Math.min(oldLines.length, newLines.length) - offset && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++
  const oldCount = oldLines.length - offset - suffix, newCount = newLines.length - offset - suffix
  if (!oldCount && !newCount) return { mode: "changes", blocks: [], added: 0, removed: 0 }
  if (oldLines.length + newLines.length > MAX_DIFF_LINES || (oldCount + 1) * (newCount + 1) > MAX_DIFF_CELLS) {
    return { mode: "range", blocks: [{ before: { start: offset + 1, end: offset + oldCount }, after: { start: offset + 1, end: offset + newCount } }], added: null, removed: null }
  }
  const width = newCount + 1, matches = new Uint32Array((oldCount + 1) * width)
  for (let old = oldCount - 1; old >= 0; old--) {
    for (let next = newCount - 1; next >= 0; next--) {
      matches[old * width + next] = oldLines[offset + old] === newLines[offset + next]
        ? 1 + matches[(old + 1) * width + next + 1]!
        : Math.max(matches[(old + 1) * width + next]!, matches[old * width + next + 1]!)
    }
  }
  const blocks: FileChangeBlock[] = []
  let old = 0, next = 0, added = 0, removed = 0
  let block: { old: number; next: number } | null = null
  function finish() {
    if (!block) return
    blocks.push({ before: { start: offset + block.old + 1, end: offset + old }, after: { start: offset + block.next + 1, end: offset + next } })
    block = null
  }
  while (old < oldCount || next < newCount) {
    if (old < oldCount && next < newCount && oldLines[offset + old] === newLines[offset + next]) {
      finish(); old++; next++; continue
    }
    block ??= { old, next }
    if (old < oldCount && (next === newCount || matches[(old + 1) * width + next]! >= matches[old * width + next + 1]!)) { old++; removed++ }
    else { next++; added++ }
  }
  finish()
  return { mode: "changes", blocks, added, removed }
}
