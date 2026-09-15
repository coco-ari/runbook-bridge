export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /Mac/iu.test(platform)
}

export function shortcutLabel(key: string, platform?: string): string {
  return (isMacPlatform(platform) ? "⌘" : "Ctrl") + " " + key
}

export function privateKeyPathExample(platform?: string): string {
  return isMacPlatform(platform) ? "/Users/name/.ssh/id_ed25519" : "C:\\Users\\name\\.ssh\\id_ed25519"
}
