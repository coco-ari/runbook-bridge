# RunbookBridge

**让 AI 帮你排障，把连接与变更的控制权留在手中。**

RunbookBridge（Agent运维工作台）是面向个人开发者和运维人员的 Windows 本地工作台。通过 MCP，让 Codex 等 Agent 结合服务器、MySQL 和 Redis 的真实信息排查问题，减少手动翻日志、查数据和反复粘贴上下文。

当前代码包版本：`2.0.0-beta.1` · Windows 10/11 · [MIT 开源许可](LICENSE)

[下载稳定版](https://github.com/coco-ari/runbook-bridge/releases/latest) · [体验服务器工作区预发布版](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.1) · [反馈问题](https://github.com/coco-ari/runbook-bridge/issues)

## 选择下载版本

| 发布渠道 | 版本 | 适合谁 | Windows x64 安装包 |
| --- | --- | --- | --- |
| **稳定版 · Latest** | **1.0.46** | 日常使用现有 Server / MySQL / Redis 与 Agent 运维功能 | [直接下载安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v1.0.46/RunbookBridge-Setup-1.0.46.exe) · [发布说明](https://github.com/coco-ari/runbook-bridge/releases/tag/v1.0.46) |
| **预发布版 · Pre-release** | **2.0.0-beta.1** | 希望试用新一代人工服务器工作区并反馈问题 | [直接下载安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.1/RunbookBridge-Setup-2.0.0-beta.1.exe) · [发布说明](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.1) |

稳定版 1.0.46 对应提交 [49cfab4](https://github.com/coco-ari/runbook-bridge/commit/49cfab4397014b38217e2bae878bb0e3ec342eb6)，不包含下方的人工服务器工作区。2.0 是服务器工作区这一大版本，当前 beta 提供交互终端、目录树和文件上传，仍处于体验和验证阶段；通过现有回归测试不代表已达到稳定版标准。GitHub 的 Latest 下载入口始终保留给稳定版。

下载 .exe 即可安装，无需自行构建；Releases 中的 Source code 是源码压缩包，不是安装包。每个安装包同时提供 .sha256 校验文件，可用 PowerShell 的 Get-FileHash 命令计算 SHA-256 后对照。

两个渠道沿用相同应用身份和本地数据目录，预发布版会覆盖同一安装位置，不是独立并行安装版。试用前请退出应用并备份 %LOCALAPPDATA%\AIOpsTool；需要回到稳定版时退出应用并重新安装稳定版。不要同时运行两个版本，跨大版本降级的数据兼容性尚未保证。

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

## 人工服务器工作区（2.0 预发布版）

连接 Server 后，在插件详情的操作区点击「打开工作区」，即可使用左侧目录树、右侧连续 SSH 终端和底部上传任务。已有工作区时点击「继续工作区」。目录软链接可按文件夹展开，文件软链接可只读预览；链接旁显示实际目标，循环和失效链接会明确标记。已读目录在工作区内缓存，点击面包屑定位并高亮对应目录，保留同级和展开状态；打开文件实时读取，路径失效时局部刷新。上传前确认实际目标目录和覆盖冲突，初版支持单文件最大 500 MiB、最多 2 个并行传输。

「返回详情」保留当前终端和上传任务；「结束会话」只结束人工终端；「断开连接」结束该服务器上的会话与传输。关闭应用后不自动恢复会话或补发命令。

终端支持新增、切换和关闭独立标签；文件预览支持同时打开多个文件并保留滚动位置。终端颜色使用标准 ANSI 输出，新建终端默认在初始化阶段静默设置 ls 分类配色和 ll 别名，完成后直接显示提示符，初始化命令不会出现在终端屏幕或回滚内容中（常见 POSIX Shell，自动识别 GNU/BSD ls）。「目录配色」可关闭新终端自动配置，也可手动填入当前会话设置后按 Enter 生效。切换标签、返回工作区不会重复配置，不修改服务器配置文件。

人工终端由你直接操作，按 SSH 登录账号的权限执行，打开会话后不逐条弹出命令确认。Agent 不能访问或接管这条终端，原有 MCP Shell 和文件变更仍按单次操作确认。设计与边界见 [服务器工作区说明](docs/server-workspace-design.md)。

## 快速开始

1. 日常使用安装 [稳定版](https://github.com/coco-ari/runbook-bridge/releases/latest)；体验人工服务器工作区选择上方的 2.0 预发布版。安装后保持桌面端运行。
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
- **Agent 读取优先，变更确认**：Agent 普通读取直接执行；上传、写入、移动、删除和服务控制逐次确认，任意 Shell 需要强确认。确认绑定具体参数，且只能使用一次；人工终端采用上文说明的会话级授权。

请使用低权限账号。日志、文件、配置和查询结果可能包含未脱敏的业务数据，使用前请确认 Agent 客户端的数据处理方式。更多边界见 [安全说明](SECURITY.md)。

## 从源码运行

需要 Windows、Node.js 22+ 和 Corepack。main 分支当前开发 2.0 预发布版；需要稳定源码时，克隆后执行 git checkout v1.0.46，再安装依赖。

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

开发与维护：[贡献指南](CONTRIBUTING.md) · [当前架构](docs/architecture.md) · [验证指南](docs/full-function-verification.md) · [版本记录](CHANGELOG.md)
