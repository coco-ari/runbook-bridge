import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/app/App"
import { AppProviders } from "@/app/providers"
import "@/styles/globals.css"

const root = document.getElementById("root")

document.documentElement.dataset.theme = window.matchMedia(
  "(prefers-color-scheme: dark)",
).matches
  ? "dark"
  : "light"

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
