import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function ServerFilePath({ path, connected, onLocate }: {
  path: string
  connected: boolean
  onLocate: (path: string) => void
}) {
  return <Tooltip><TooltipTrigger asChild>
    <button type="button" className="server-file-path truncate font-mono text-xs" aria-label={`在目录树中定位：${path}`} aria-disabled={!connected} onClick={() => { if (connected) onLocate(path) }}>{path}</button>
  </TooltipTrigger><TooltipContent className="block break-all">{connected ? "在目录树中定位" : "连接后可在目录树中定位"}<span className="block font-mono">{path}</span></TooltipContent></Tooltip>
}
