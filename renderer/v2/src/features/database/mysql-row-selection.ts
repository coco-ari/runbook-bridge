export function paintMysqlRows<T>(selection: ReadonlySet<T>, rows: readonly T[], from: number, to: number, checked: boolean, limit = 100): { selection: Set<T>; limited: boolean } {
  const next = new Set(selection)
  let limited = false
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return {selection: next, limited}
  const step = from <= to ? 1 : -1
  for (let index = from; step > 0 ? index <= to : index >= to; index += step) {
    const row = rows[index]!
    if (!checked) next.delete(row)
    else if (next.has(row) || next.size < limit) next.add(row)
    else limited = true
  }
  return {selection: next, limited}
}
