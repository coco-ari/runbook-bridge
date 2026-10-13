import type { PluginConnectionPanelProps } from "../connections/PluginConnectionPanel"
import { usePluginConnection } from "../connections/use-plugin-connection"
import { Button } from "@/components/ui/button"

export function SourceConnectionPanel(props: PluginConnectionPanelProps) {
  const connection = usePluginConnection(props), phase = connection.state.phase
  const busy = ["connecting", "disconnecting", "reconnecting"].includes(phase)
  return <div className="space-y-4 p-4"><dl className="grid gap-2 text-sm"><dt className="text-muted-foreground">源码服务</dt><dd className="break-all">{String(props.plugin.target?.serviceUrl ?? "未配置")}</dd><dt className="text-muted-foreground">项目 ID</dt><dd className="break-all font-mono">{String(props.plugin.target?.remoteProjectId ?? "未配置")}</dd></dl>
    <p className="text-sm">{phase === "connected" ? "已连接，可检查新版本" : "未连接；已下载源码可离线浏览"}</p>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void (phase === "connected" ? connection.disconnect() : connection.connect())}>{phase === "connected" ? "断开" : "连接"}</Button><Button variant="outline" onClick={props.onEdit} disabled={busy}>修改配置</Button><Button variant="outline" onClick={props.onOpenWorkspace} data-testid="plugin-workspace-open">打开源码工作区</Button></div>
    {connection.state.error && <p role="alert" className="text-sm text-destructive">{connection.state.error.message}</p>}
  </div>
}
export function SourceAgentAccess() {
  return <div className="space-y-2 p-4 text-sm"><p>Agent 通过 MCP 获取本地源码路径、版本和所属环境，然后直接读取本地文件。</p><p className="text-muted-foreground">源码副本只读。更新由你在源码工作区选择执行；已有对话继续使用绑定的版本。</p></div>
}
