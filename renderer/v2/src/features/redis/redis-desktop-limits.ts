import limits from "../../../../../src/redis-desktop-limits.json" with { type: "json" }

export const REDIS_AUTO_OPEN_BYTES = limits.autoOpenBytes
export const REDIS_EDITABLE_BYTES = limits.editableBytes
export const REDIS_BROWSER_CACHE_BYTES = limits.browserCacheBytes
