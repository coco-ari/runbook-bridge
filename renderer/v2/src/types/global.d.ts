import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"

declare global {
  interface Window {
    readonly aiOps?: {
      readonly v2?: AiOpsV2Api
    }
  }
}

export {}
