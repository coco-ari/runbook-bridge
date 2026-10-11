import { defaultFilter } from "cmdk"

// 分词独立匹配，允许按“生产 订单”或“订单 生产”查找同一资源。
// 保留 cmdk 对单词的模糊匹配和相关度排序。
export function resourceSearchFilter(value: string, search: string, keywords?: string[]): number {
  const terms = search.trim().split(/\s+/u).filter(Boolean)
  if (!terms.length) return 1
  return Math.min(...terms.map(term => defaultFilter(value, term, keywords)))
}
