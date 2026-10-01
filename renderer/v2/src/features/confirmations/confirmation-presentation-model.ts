export const SHELL_CONFIRMATION_COMMAND_LIMIT = 16_384

function redactPrivateKeys(text: string): { readonly text: string; readonly complete: boolean } {
  const parts: string[] = []
  let consumed = 0
  let opening: RegExpExecArray | null = null
  const hidden = "[私钥内容已隐藏]"
  const markers = /-----(BEGIN|END) ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/giu
  for (const marker of text.matchAll(markers)) {
    if (marker[1]!.toUpperCase() === "BEGIN") {
      // 嵌套或未匹配的标记无法安全划分尾部，保守隐藏并拒绝完整核对。
      if (opening) return { text: parts.join("") + text.slice(consumed, opening.index) + hidden, complete: false }
      opening = marker
    } else {
      if (!opening) return { text: parts.join("") + hidden, complete: false }
      if (marker[2]!.toUpperCase() !== opening[2]!.toUpperCase()) {
        return { text: parts.join("") + text.slice(consumed, opening.index) + hidden, complete: false }
      }
      // 仅隐藏同标签闭合块，之后的普通命令仍必须能完整核对。
      parts.push(text.slice(consumed, opening.index), hidden)
      consumed = marker.index + marker[0].length
      opening = null
    }
  }
  if (opening) return { text: parts.join("") + text.slice(consumed, opening.index) + hidden, complete: false }
  return { text: parts.join("") + text.slice(consumed), complete: true }
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[已隐藏]@")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=\-]{8,}/giu, "$1[已隐藏]")
    .replace(
      /(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*)[^\s,;]+/giu,
      "$1[已隐藏]",
    )
}

export function redactConfirmationText(value: unknown, fallback = "", limit = 4_000): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : fallback
  // 先保护 PEM 边界，避免赋值脱敏先移除 BEGIN 而暴露块内余文。
  return redactSensitiveText(redactPrivateKeys(text).text).slice(0, limit)
}

export function shellConfirmationPresentation(value: Readonly<Record<string, unknown>> | undefined): {
  readonly command: string
  readonly complete: boolean
  readonly redacted: boolean
} {
  const command = value?.command
  const directory = value?.workingDirectory
  const complete = value?.kind === "shell" && typeof command === "string"
    && command.trim().length > 0 && command.length <= SHELL_CONFIRMATION_COMMAND_LIMIT
    && !command.includes("\0")
    && (directory === undefined || directory === null || (typeof directory === "string"
      && directory.length <= 4_096 && !directory.includes("\0")))
  if (!complete) return { command: "", complete: false, redacted: false }
  // 命令以服务端上限完整展示，普通摘要仍使用独立长度限制。
  const protectedKeys = redactPrivateKeys(command)
  const visible = redactSensitiveText(protectedKeys.text)
  return { command: visible, complete: protectedKeys.complete, redacted: visible !== command }
}
