import type { ServerFilePreview } from "@/bridge/ai-ops-v2"

export function mergeFilePreview(previous: ServerFilePreview | undefined, page: ServerFilePreview, append: boolean) {
  let content = append && previous && !page.reset && page.startByte === previous.endByte ? previous.content + page.content : page.content
  const lines = content.split("\n")
  const clipped = lines.length > 5000 || content.length > 262_144
  if (lines.length > 5000) content = lines.slice(-5000).join("\n")
  if (content.length > 262_144) {
    let start = content.length - 262_144
    if (/[\uDC00-\uDFFF]/u.test(content[start] ?? "")) start++
    content = content.slice(start)
  }
  return { data: { ...page, content, startByte: Math.max(0, page.endByte - new TextEncoder().encode(content).length) }, clipped }
}

export function filePreviewMatches(content: string, query: string) {
  if (!query) return []
  const matches: number[] = []
  for (let at = content.indexOf(query); at >= 0 && matches.length < 1000; at = content.indexOf(query, at + query.length)) matches.push(at)
  return matches
}
