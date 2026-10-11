import { useMemo } from "react"

import { renderRunbookMarkdown } from "./runbook-markdown"
import "./runbook-markdown.css"

export function RunbookMarkdown({ content }: { readonly content: string }) {
  const rendered = useMemo(() => renderRunbookMarkdown(content), [content])
  return <div className="runbook-markdown" data-testid="runbook-markdown">{rendered}</div>
}
