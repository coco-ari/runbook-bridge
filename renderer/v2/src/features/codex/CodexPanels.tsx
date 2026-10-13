import type { PluginConnectionPanelProps } from "../connections/PluginConnectionPanel"
import { usePluginConnection } from "../connections/use-plugin-connection"
import { Button } from "@/components/ui/button"
export function CodexConnectionPanel(props: PluginConnectionPanelProps) {
  const connection = usePluginConnection(props), phase = connection.state.phase
  const busy = ["connecting", "disconnecting", "reconnecting"].includes(phase)
  return <div className="space-y-4 p-4"><dl className="grid gap-2 text-sm"><dt className="text-muted-foreground">模型认证</dt><dd>{props.plugin.target?.authMode === "custom" ? "兼容 Responses 服务" : "ChatGPT 登录"}</dd><dt className="text-muted-foreground">模型</dt><dd>{String(props.plugin.target?.model || "Codex 默认模型")}</dd></dl>
    <p className="text-sm">{phase === "connected" ? "Codex CLI 已连接" : "连接后可登录并开始对话；已有记录可离线查看。"}</p>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void (phase === "connected" ? connection.disconnect() : connection.connect())}>{phase === "connected" ? "断开" : "连接"}</Button><Button variant="outline" onClick={props.onEdit} disabled={busy}>修改配置</Button><Button variant="outline" onClick={props.onOpenWorkspace} data-testid="plugin-workspace-open">打开 Agent 工作区</Button></div>
    {connection.state.error && <p role="alert" className="text-sm text-destructive">{connection.state.error.message}</p>}
  </div>
}
export function CodexAgentAccess() { return <div className="space-y-2 p-4 text-sm"><p>在独立工作区与 Codex 对话，选择同环境的本地源码版本。</p><p className="text-muted-foreground">运维操作通过当前环境的 MCP 执行，沿用工作台审批。登录状态和会话保存在本机。</p></div> }
