# 首次使用

[返回首页](../README.md) · [测试版说明](beta-guide.md)

## 1. 安装与准备

从 [2.0.0-beta.2 Release](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.2) 下载 Windows x64 的 `.exe` 安装包及同名 `.sha256` 文件。无需安装 Node.js 即可运行桌面应用；下方 MCP 命令需要已安装 Codex CLI。

在安装包所在目录用 PowerShell 核对校验值：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\RunbookBridge-Setup-2.0.0-beta.2.exe
Get-Content -LiteralPath .\RunbookBridge-Setup-2.0.0-beta.2.exe.sha256
```

两处 SHA-256 应一致。本测试版未进行发布者数字签名。升级前退出应用并备份 `%LOCALAPPDATA%\AIOpsTool`，详见[升级说明](beta-guide.md#升级与备份)。

先准备一个有权访问的测试环境，优先使用专用低权限账号。普通桌面工作区可以独立使用；只有需要 Agent 排障时才配置 MCP。

## 2. 创建项目和连接

1. 新建项目，再创建一个环境，例如“演示项目 / 测试环境”。
2. 添加 Server、MySQL 或 Redis 插件，填写实际连接配置；不要将密码写进运维说明。
3. MySQL 指定一个数据库；Redis 设置允许访问的 Key pattern。数据库可以直连，也可以通过同环境 Server 建立 SSH 隧道。
4. 验证配置。首次 SSH 连接应核对服务器主机指纹，再确认信任。
5. 主动点击连接。成功后打开工作区，先完成一次只读查询。

若连接失败，按界面提示检查地址、端口、账号权限和网络。不要通过关闭证书或主机指纹校验解决身份验证问题。

## 3. 为 Agent 配置 MCP

以默认 Windows 安装位置为例，在 PowerShell 中执行：

```powershell
$workbenchDir = "$env:LOCALAPPDATA\Programs\Agent运维工作台"
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- `
  "$workbenchDir\Agent运维工作台.exe" `
  "$workbenchDir\resources\app.asar\src\mcp-v2.mjs"
codex mcp get agent-ops
```

若修改过安装位置，请替换 `$workbenchDir`。注册后完全退出并重新打开 Codex，保持桌面应用运行，并确认目标插件已连接。使用其他支持 MCP stdio 的客户端时，使用相同可执行文件、脚本参数及 `ELECTRON_RUN_AS_NODE=1` 环境变量，具体配置格式以客户端说明为准。

## 4. 完成第一次排查

在环境运维说明中写明服务职责、日志路径和约束，例如：

> API 服务处理订单。请先查看服务状态和错误日志；数据库、缓存仅用于核对。任何变更先说明原因。

向 Agent 提问：

> 请列出当前可用项目和环境，然后检查演示项目的测试环境。先报告哪些资源已连接，再给出只读检查建议，不要修改数据。

成功标准是 Agent 能识别正确环境、使用已连接的资源，并给出有依据的读取结果。不要把“没有读到”解释为“没有问题”；注意截断、范围和超时提示。

## 遇到问题

| 现象 | 优先检查 |
| --- | --- |
| Agent 找不到工具 | MCP 注册命令是否成功，客户端是否已完全重启 |
| Agent 提示桌面不可用 | 桌面应用是否运行，MCP 路径是否指向当前安装目录 |
| 插件不可用 | 是否主动连接了正确环境；配置验证是否通过 |
| MySQL 结果无法编辑 | 是否为有完整主键的 InnoDB 单表，以及账号是否有写权限 |
| 保存结果不确定 | 使用界面的检查／核实入口，先确认当前状态，不要重复提交 |

仍无法解决时，使用 [Bug 模板](https://github.com/coco-ari/runbook-bridge/issues/new?template=bug_report.yml)，附上版本、系统、脱敏复现步骤和错误代码。[完整工作区指南](workspace-guide.md)
