import { Code, Database, HardDrives, Plugs, TerminalWindow, type Icon } from "@phosphor-icons/react"

import type { WorkspacePluginType } from "@/features/workspace/workspace-read-model"

export const pluginIcons = {
  server: TerminalWindow,
  mysql: Database,
  redis: HardDrives,
  source: Code,
  codex: TerminalWindow,
  unknown: Plugs,
} satisfies Record<WorkspacePluginType, Icon>
