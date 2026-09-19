export function normalizeWorkspaceLocation(value: string): string {
  if (!value.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || new TextEncoder().encode(value).length > 4096) {
    throw new Error("请输入有效的绝对路径，例如 /var/log。")
  }
  const parts: string[] = []
  for (const part of value.split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return "/" + parts.join("/")
}

export function workspaceLocationAncestors(target: string): string[] {
  const parts = target.split("/").filter(Boolean)
  if (parts.length > 31) throw new Error("路径层级超过目录树定位上限。")
  return ["/", ...parts.slice(0, -1).map((_part, index) => "/" + parts.slice(0, index + 1).join("/"))]
}
