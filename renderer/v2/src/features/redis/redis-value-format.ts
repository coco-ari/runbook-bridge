import { jsonLanguage } from "@codemirror/lang-json"

const MAX_FORMATTED_LENGTH = 2 * 1024 * 1024

export function formatRedisJson(source: string, truncated = false): string | null {
  if (!source.trim() || source.length > MAX_FORMATTED_LENGTH) return null
  if (truncated) {
    if (!/^[\s]*[\[{]/u.test(source)) return null
  } else {
    const cursor = jsonLanguage.parser.parse(source).cursor()
    do { if (cursor.type.isError) return null } while (cursor.next())
  }
  // 只调整字符串外的空白，保留大整数、指数、小数精度、重复字段和原始转义。
  // 截断片段不补引号或括号，避免把未读取的数据伪装成完整 JSON。
  const parts: string[] = []
  let depth = 0
  let length = 0
  let previous = ""
  function append(value: string) { parts.push(value); length += value.length }
  function line() { append("\n" + "  ".repeat(Math.min(depth, 32))) }
  for (let at = 0; at < source.length;) {
    const char = source[at]!
    if (/\s/u.test(char)) { at += 1; continue }
    if (char === '"') {
      const start = at++
      while (at < source.length) {
        if (source[at] === "\\") { at = Math.min(source.length, at + 2); continue }
        if (source[at++] === '"') break
      }
      append(source.slice(start, at)); previous = '"'
    } else if (char === "{" || char === "[") {
      append(char); depth += 1; at += 1
      let next = at
      while (next < source.length && /\s/u.test(source[next]!)) next += 1
      if (next < source.length && source[next] !== (char === "{" ? "}" : "]")) line()
      previous = char
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1)
      if (previous !== "{" && previous !== "[") line()
      append(char); at += 1; previous = char
    } else if (char === ",") {
      append(char); at += 1; line(); previous = char
    } else if (char === ":") {
      append(": "); at += 1; previous = char
    } else {
      const start = at++
      while (at < source.length && !/[\s{}\[\],:"]/u.test(source[at]!)) at += 1
      append(source.slice(start, at)); previous = char
    }
    // 异常深层数据或大量微小节点达到展示预算后回退到原文。
    if (length > MAX_FORMATTED_LENGTH || parts.length > 200_000) return source
  }
  return parts.join("")
}
