import { createElement } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { RUNBOOK_MAX_BYTES, runbookByteLength } from "./runbook-model.ts"

// Runbooks are untrusted operational text. Keep URLs readable without navigating
// the desktop window or fetching remote images; raw HTML stays escaped by default.
const components: Components = {
  a: ({ children, href }) => createElement("span", { className: "runbook-markdown-link" },
    children,
    href && children !== href
      ? createElement("span", { className: "runbook-markdown-url" }, `（${href}）`)
      : null,
  ),
  img: ({ alt }) => createElement("span", { className: "runbook-markdown-image" },
    `[图片：${alt || "未提供描述"}]`,
  ),
  table: ({ children }) => createElement("div", {
    className: "runbook-markdown-table",
    tabIndex: 0,
    role: "region",
    "aria-label": "运维说明表格",
  }, createElement("table", null, children)),
  pre: ({ children }) => createElement("pre", { tabIndex: 0, "aria-label": "代码块" }, children),
}

const remarkPlugins = [remarkGfm]

export function renderRunbookMarkdown(content: string) {
  // Oversized drafts may be pasted before the existing save limit is shown.
  // Keep those editable without sending an unbounded document through the parser.
  if (runbookByteLength(content) > RUNBOOK_MAX_BYTES) {
    return createElement("pre", { className: "runbook-markdown-plain" }, content)
  }
  return createElement(Markdown, { components, remarkPlugins }, content)
}
