import { useState } from "react"
import type { PublicError } from "@/bridge/ai-ops-v2"
import { Button } from "@/components/ui/button"
import { diagnosticCopy, diagnosticFor, type DiagnosticDomain } from "./diagnostic-model"

export function DiagnosticDetails({ error, domain = "connection" }: { readonly error: PublicError; readonly domain?: DiagnosticDomain }) {
  const diagnostic = diagnosticFor(error, domain)
  const [copied, setCopied] = useState("")
  return <details className="mt-2 min-w-0 rounded-md border border-border bg-surface p-2 text-xs text-foreground" data-testid="diagnostic-details">
    <summary className="cursor-pointer font-medium focus-visible:outline-ring">{diagnostic.stage} · {diagnostic.outcome} · 查看处理建议</summary>
    <div className="mt-2 space-y-2">
      <p className="break-words leading-5">{diagnostic.guidance}</p>
      <p className="font-mono text-muted-foreground">{diagnostic.code}</p>
      <div className="flex flex-wrap items-center gap-2"><Button size="xs" variant="outline" onClick={() => {
        void navigator.clipboard.writeText(diagnosticCopy(diagnostic)).then(() => setCopied("已复制，不含地址、凭据或业务正文"), () => setCopied("复制失败，可手动选择上述诊断信息"))
      }}>复制诊断摘要</Button><span role="status" className="text-muted-foreground">{copied}</span></div>
    </div>
  </details>
}
