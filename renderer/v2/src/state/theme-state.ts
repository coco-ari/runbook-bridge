export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "runbook-bridge:theme-preference:v1"
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)"

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

function themeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readThemePreference(
  storage: Pick<Storage, "getItem"> | null = themeStorage(),
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY)
    return isThemePreference(value) ? value : "system"
  } catch {
    return "system"
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem"> | null = themeStorage(),
): boolean {
  try {
    if (!storage) return false
    storage.setItem(THEME_STORAGE_KEY, preference)
    return true
  } catch {
    // A disabled/full local store must not prevent switching this window.
    return false
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference
}

export function applyTheme(
  preference: ThemePreference,
  prefersDark: boolean,
  root: { dataset: DOMStringMap } = document.documentElement,
): void {
  root.dataset.theme = resolveTheme(preference, prefersDark)
  root.dataset.themePreference = preference
}
