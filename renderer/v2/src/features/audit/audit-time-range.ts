export function auditTimeRange(start: string, end: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end)) return null
  const from = new Date(start), to = new Date(end)
  const matchesInput = (date: Date, input: string) => {
    const parts = input.split(/[-T:]/).map(Number)
    return Number.isFinite(date.getTime()) && [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].every((value, index) => value === parts[index])
  }
  if (!matchesInput(from, start) || !matchesInput(to, end) || to < from) return null
  // 输入精度为分钟，结束分钟内的记录也应包含。
  to.setSeconds(59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}
