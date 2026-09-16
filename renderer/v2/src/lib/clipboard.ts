export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // 桌面禁用浏览器剪贴板权限时，使用用户触发的原生复制命令，不申请读取权限。
    const focused = document.activeElement as HTMLElement | null
    const selection = document.getSelection()
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
    const input = document.createElement("textarea")
    input.value = text
    input.setAttribute("aria-label", "复制文本")
    input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0"
    const container = focused?.closest('[role="dialog"]') ?? document.body
    container.append(input)
    try {
      input.focus({ preventScroll: true })
      input.select()
      if (!document.execCommand("copy")) throw new Error("系统剪贴板当前不可用")
    } finally {
      input.remove()
      if (focused?.isConnected) focused.focus({ preventScroll: true })
      selection?.removeAllRanges()
      for (const range of ranges) selection?.addRange(range)
    }
  }
}
