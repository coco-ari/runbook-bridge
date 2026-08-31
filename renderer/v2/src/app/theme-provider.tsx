import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import {
  applyTheme,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  SYSTEM_THEME_QUERY,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/state/theme-state"

interface ThemeContextValue {
  readonly preference: ThemePreference
  readonly theme: ResolvedTheme
  readonly setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [preference, setPreferenceState] = useState(() => readThemePreference())
  const [media] = useState(() => window.matchMedia(SYSTEM_THEME_QUERY))
  const [prefersDark, setPrefersDark] = useState(media.matches)
  const theme = resolveTheme(preference, prefersDark)

  useLayoutEffect(() => {
    const updateSystemTheme = () => setPrefersDark(media.matches)
    media.addEventListener("change", updateSystemTheme)
    updateSystemTheme()
    return () => media.removeEventListener("change", updateSystemTheme)
  }, [media])

  useLayoutEffect(() => {
    applyTheme(preference, prefersDark)
  }, [preference, prefersDark])

  useEffect(() => {
    const updateSavedTheme = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreferenceState(readThemePreference())
      }
    }
    window.addEventListener("storage", updateSavedTheme)
    return () => window.removeEventListener("storage", updateSavedTheme)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    persistThemePreference(next)
    setPreferenceState(next)
  }, [])
  const value = useMemo(() => ({ preference, theme, setPreference }), [preference, theme, setPreference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("主题控件必须位于主题提供器内。")
  return value
}
