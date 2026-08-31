import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/app/App"
import { AppProviders } from "@/app/providers"
import { applyTheme, readThemePreference, SYSTEM_THEME_QUERY } from "@/state/theme-state"
import "@/styles/globals.css"

const root = document.getElementById("root")

// Apply the saved preference before React's first render, including cold starts.
applyTheme(readThemePreference(), window.matchMedia(SYSTEM_THEME_QUERY).matches)

if (!root) {
  throw new Error("React Renderer 缺少根节点。")
}

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
)
