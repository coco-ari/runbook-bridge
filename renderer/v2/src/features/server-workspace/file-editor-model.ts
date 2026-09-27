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
