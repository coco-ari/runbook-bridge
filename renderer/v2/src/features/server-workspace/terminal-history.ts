import type { Terminal } from "@xterm/xterm"

export function terminalHistory(terminal: Pick<Terminal, "buffer">): string {
  const buffer = terminal.buffer.normal
  const lines: string[] = []
  let characters = 0
  for (let index = buffer.length - 1; index >= Math.max(0, buffer.length - 5000); index -= 1) {
    const line = buffer.getLine(index)
    if (!line) continue
    // 回看内容只保留可显示文字，禁止旧输出中的控制字符改变新会话。
    const text = line.translateToString(true).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    if (!lines.length && !text) continue
    const suffix = index + 1 < buffer.length && buffer.getLine(index + 1)?.isWrapped ? "" : "\r\n"
    characters += text.length + suffix.length
    if (characters > 512 * 1024) break
    lines.unshift(text + suffix)
  }
  return lines.join("")
}

export async function resetTerminalForReconnect(terminal: Terminal, automatic = true) {
  await new Promise<void>((resolve) => terminal.write("", resolve))
  const history = terminalHistory(terminal)
  terminal.reset()
  terminal.options.disableStdin = true
  await new Promise<void>((resolve) => terminal.write(history + "\r\n── " + new Date().toLocaleTimeString() + (automatic ? " 已重新连接 · 新会话" : " 已打开新会话") + " ──\r\n", resolve))
}
