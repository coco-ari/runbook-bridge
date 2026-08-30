import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const rendererRoot = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = path.resolve(rendererRoot, "../..")

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rendererRoot, "src"),
    },
  },
  build: {
    outDir: path.resolve(repositoryRoot, "renderer-build/v2"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(rendererRoot, "index.html"),
    },
  },
})
