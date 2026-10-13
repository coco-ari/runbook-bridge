import { codexWorkspaceContribution } from "../codex/workspace-contribution"
import { createWorkspaceRegistry } from "./workspace-registry"
import { serverWorkspaceContribution } from "../server-workspace/workspace-contribution"
import { mysqlWorkspaceContribution } from "../database/workspace-contribution"
import { redisWorkspaceContribution } from "../redis/workspace-contribution"
import { sourceWorkspaceContribution } from "../source/workspace-contribution"

export const pluginWorkspaces = createWorkspaceRegistry([
  serverWorkspaceContribution, mysqlWorkspaceContribution, redisWorkspaceContribution,
  sourceWorkspaceContribution, codexWorkspaceContribution,
])
