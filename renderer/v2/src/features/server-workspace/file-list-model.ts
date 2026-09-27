import type { ServerDirectoryEntry } from "@/bridge/ai-ops-v2"
import { serverEntryType } from "./workspace-model.ts"

export type FileListSort = "name" | "size" | "mtime"
export function fileListEntries(entries: readonly ServerDirectoryEntry[], query: string, sort: FileListSort, descending: boolean, showHidden: boolean) {
  const needle = query.toLocaleLowerCase()
  return entries.filter(entry => (showHidden || !entry.name.startsWith(".")) && entry.name.toLocaleLowerCase().includes(needle)).sort((a, b) => {
    const folder = Number(serverEntryType(b) === "directory") - Number(serverEntryType(a) === "directory")
    if (folder) return folder
    const name = a.name.localeCompare(b.name, undefined, { numeric: true })
    if (sort === "name") return name * (descending ? -1 : 1)
    const left = a[sort], right = b[sort]
    if (left == null || right == null) return left == null ? right == null ? name : 1 : -1
    return (left - right) * (descending ? -1 : 1) || name
  })
}
