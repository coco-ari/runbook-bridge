export const REDIS_EDITOR_MAX_LENGTH = 65536

export function redisEditorLimit(value: string, maxBytes: number): "characters" | "bytes" | null {
  if (value.length > REDIS_EDITOR_MAX_LENGTH) return "characters"
  if (new TextEncoder().encode(value).length > maxBytes) return "bytes"
  return null
}
