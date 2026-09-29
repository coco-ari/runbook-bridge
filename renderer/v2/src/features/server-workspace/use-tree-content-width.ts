import { useLayoutEffect, useState, type RefObject } from "react"

export const TREE_INDENT = 18

interface TreeLabel {
  readonly depth: number
  readonly name: string
  readonly link?: string
  readonly download: boolean
}

export function useTreeContentWidth(viewport: RefObject<HTMLDivElement | null>, labels: readonly TreeLabel[], enabled: boolean) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !enabled) { setWidth(0); return }
    const canvas = document.createElement("canvas").getContext("2d")
    if (!canvas) return
    let measuredFont = ""
    const measure = () => {
      const style = getComputedStyle(element)
      const font = `${style.fontSize} ${style.fontFamily}`
      if (font === measuredFont) return
      measuredFont = font
      const cache = new Map<string, number>()
      const textWidth = (text: string) => {
        const cached = cache.get(text)
        if (cached !== undefined) return cached
        // 同时覆盖普通行与选中行字重，避免切换选择时宽度抖动。
        canvas.font = `400 ${style.fontSize} ${style.fontFamily}`
        const normal = canvas.measureText(text).width
        canvas.font = `500 ${style.fontSize} ${style.fontFamily}`
        const result = Math.max(normal, canvas.measureText(text).width)
        cache.set(text, result)
        return result
      }
      let next = 0
      for (const label of labels) {
        // 左右内边距 24、展开箭头 12、图标 16、间距 16；下载按钮额外占 32 + 8。
        // 链接目标用名称字号保守测量，保证较小字号的目标文字也能完整显示。
        const content = 68 + label.depth * TREE_INDENT + textWidth(label.name)
          + (label.link ? 8 + textWidth(label.link) : 0) + (label.download ? 40 : 0)
        next = Math.max(next, content)
      }
      setWidth(Math.ceil(next) + 2)
    }
    // 测量整个已展开的数据集合，不依赖当前虚拟窗口中挂载的行。
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const fontsLoaded = () => { measuredFont = ""; measure() }
    document.fonts.addEventListener("loadingdone", fontsLoaded)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener("loadingdone", fontsLoaded)
    }
  }, [viewport, labels, enabled])
  return width
}
