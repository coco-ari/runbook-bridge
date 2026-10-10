import { REDIS_EDITABLE_BYTES } from "./redis-desktop-limits.ts"

export const REDIS_EDITOR_MAX_LENGTH = REDIS_EDITABLE_BYTES

export function redisEditorLimit(value: string, maxBytes: number): "characters" | "bytes" | null {
  if (value.length > REDIS_EDITOR_MAX_LENGTH) return "characters"
  if (new TextEncoder().encode(value).length > maxBytes) return "bytes"
  return null
}
