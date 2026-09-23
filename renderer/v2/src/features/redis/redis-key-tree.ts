// 限制目录深度，过深的分段保留为完整叶子名称，避免异常 Key 膨胀成大量节点。
export const REDIS_KEY_TREE_MAX_DEPTH = 12

export interface RedisKeyTreeNode {
  readonly id: string
  readonly kind: "folder" | "key"
  readonly label: string
  readonly path: string
  readonly key: string | null
  readonly parentId: string | null
  readonly depth: number
  count: number
  readonly children: RedisKeyTreeNode[]
}

export interface RedisKeyTree {
  readonly roots: readonly RedisKeyTreeNode[]
  readonly nodes: ReadonlyMap<string, RedisKeyTreeNode>
  readonly folders: readonly RedisKeyTreeNode[]
}

export interface RedisKeyTreeRow {
  readonly node: RedisKeyTreeNode
  readonly position: number
  readonly siblingCount: number
}

const collator = new Intl.Collator("zh-CN", { numeric: true })

export function buildRedisKeyTree(keys: readonly string[]): RedisKeyTree {
  const roots: RedisKeyTreeNode[] = []
  const nodes = new Map<string, RedisKeyTreeNode>()
  const folders: RedisKeyTreeNode[] = []
  for (const key of new Set(keys)) {
    let children = roots
    let parentId: string | null = null
    let start = 0
    let depth = 0
    while (depth < REDIS_KEY_TREE_MAX_DEPTH) {
      const separator = key.indexOf(":", start)
      if (separator < 0) break
      const path = key.slice(0, separator + 1)
      const id = "folder:" + path
      let folder = nodes.get(id)
      if (!folder) {
        folder = { id, kind: "folder", label: key.slice(start, separator) || "（空分段）", path, key: null, parentId, depth, count: 0, children: [] }
        nodes.set(id, folder)
        folders.push(folder)
        children.push(folder)
      }
      folder.count += 1
      children = folder.children
      parentId = id
      start = separator + 1
      depth += 1
    }
    const leaf: RedisKeyTreeNode = { id: "key:" + key, kind: "key", label: key || "（空 Key）", path: key, key, parentId, depth, count: 1, children: [] }
    nodes.set(leaf.id, leaf)
    children.push(leaf)
  }
  const sort = (items: RedisKeyTreeNode[]) => {
    items.sort((left, right) => left.kind !== right.kind ? (left.kind === "folder" ? -1 : 1) : collator.compare(left.label, right.label) || collator.compare(left.path, right.path))
    for (const item of items) if (item.kind === "folder") sort(item.children)
  }
  sort(roots)
  return { roots, nodes, folders }
}

export function defaultRedisTreeExpansion(tree: RedisKeyTree, searching: boolean): ReadonlySet<string> {
  const expanded = new Set<string>()
  const visit = (items: readonly RedisKeyTreeNode[], reveal: boolean) => {
    for (const node of items) {
      if (node.kind !== "folder") continue
      if (searching || reveal) expanded.add(node.id)
      visit(node.children, reveal && node.children.length === 1)
    }
  }
  visit(tree.roots, true)
  return expanded
}

export function redisKeyTreeRows(tree: RedisKeyTree, expanded: (id: string) => boolean): readonly RedisKeyTreeRow[] {
  const rows: RedisKeyTreeRow[] = []
  const visit = (items: readonly RedisKeyTreeNode[]) => {
    items.forEach((node, index) => {
      rows.push({ node, position: index + 1, siblingCount: items.length })
      if (node.kind === "folder" && expanded(node.id)) visit(node.children)
    })
  }
  visit(tree.roots)
  return rows
}

export function redisKeyAncestors(tree: RedisKeyTree, key: string): readonly string[] {
  const ancestors: string[] = []
  let node = tree.nodes.get("key:" + key)
  while (node?.parentId) {
    ancestors.unshift(node.parentId)
    node = tree.nodes.get(node.parentId)
  }
  return ancestors
}

export function redisFolderSearch(prefix: string): string {
  // 目录名中的通配符按字面量转义，仅末尾星号用于匹配目录下的 Key。
  return prefix.replace(/[\\*?]/gu, "\\$&") + "*"
}
