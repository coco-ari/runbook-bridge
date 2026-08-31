# RunbookBridge

**让 AI 帮你排障，把连接与变更的控制权留在手中。**

RunbookBridge（Agent运维工作台）是面向个人开发者和运维人员的 Windows 本地工作台。通过 MCP，让 Codex 等 Agent 结合服务器、MySQL 和 Redis 的真实信息排查问题，减少手动翻日志、查数据和反复粘贴上下文。

当前代码包版本：`1.0.46` · Windows 10/11 · [MIT 开源许可](LICENSE)

[下载 Windows 安装包](https://github.com/coco-ari/runbook-bridge/releases) · [反馈问题](https://github.com/coco-ari/runbook-bridge/issues)

## 核心能力

| 资源 | Agent 可以做什么 |
| --- | --- |
| **Server** | 查看系统、服务与容器状态，读取文件，搜索日志及 `.gz` / `.zip` 轮转归档 |
| **MySQL** | 搜索表与字段、查看结构，在固定数据库内执行策略允许的 `SELECT` / `EXPLAIN SELECT` |
| **Redis** | 在配置的 Key pattern 范围内扫描 Key、有界读取数据、查询 TTL |

按 **项目 → 环境 → 插件** 组织资源，统一管理环境运维说明、快捷提问和操作记录。MySQL、Redis 可直连，也可通过同环境的 Server 建立 SSH 隧道。

第一栏可直接拖动项目行排序，插入线表示放置位置；也可选中项目后按 `Alt + ↑ / ↓` 调整。顺序保存在本机，重启后保留。搜索结果中拖动会同步调整完整列表的顺序，其他项目的相对顺序不变；配置已隔离的项目不能拖动或作为落点。

连接后，你可以这样提问：

> 检查测试环境的 API 服务，结合错误日志、MySQL 表结构和 Redis 缓存定位问题。先给出排查结论，不要修改配置或重启服务。

## 快速开始

1. 从 [Releases](https://github.com/coco-ari/runbook-bridge/releases) 安装应用，并保持桌面端运行。
2. 创建项目和环境，添加 Server、MySQL 或 Redis 插件，验证配置并主动连接。
3. 在环境的「运维说明」中记录服务职责、日志路径和注意事项，让 Agent 有据可查。
4. 为 Agent 客户端配置 MCP，然后描述你要排查的问题。

使用 Codex 时，在 PowerShell 中执行：

```powershell
$workbenchDir = "$env:LOCALAPPDATA\Programs\Agent运维工作台"
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- `
  "$workbenchDir\Agent运维工作台.exe" `
  "$workbenchDir\resources\app.asar\src\mcp-v2.mjs"
```

如果选择了其他安装目录，修改 `$workbenchDir`。注册后完全退出并重新打开 Codex；桌面应用需要继续运行。

## 操作边界

- **凭据留在本机**：应用管理的密码、私钥口令和代理凭据本地加密保存，不返回给 Agent。
- **连接由你发起**：Agent 只能使用当前环境中已连接的插件，不会自行建立首次连接。
- **读取优先，变更确认**：普通读取直接执行；上传、写入、移动、删除和服务控制逐次确认，任意 Shell 需要强确认。确认绑定具体参数，且只能使用一次。

请使用低权限账号。日志、文件、配置和查询结果可能包含未脱敏的业务数据，使用前请确认 Agent 客户端的数据处理方式。更多边界见 [安全说明](SECURITY.md)。

## 从源码运行

需要 Windows、Node.js 22+ 和 Corepack。

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

开发与维护：[贡献指南](CONTRIBUTING.md) · [当前架构](docs/architecture.md) · [验证指南](docs/full-function-verification.md) · [版本记录](CHANGELOG.md)
