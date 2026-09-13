export function shortcutLabel(key: string, platform = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return (/Mac/iu.test(platform) ? "⌘" : "Ctrl") + " " + key
}
