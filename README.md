# RunbookBridge · Agent运维工作台

**让 AI 结合服务器、MySQL 和 Redis 的实际信息帮你排障，连接与变更由你控制。**

面向独立开发者、后端开发者和小团队的本地桌面工作台。按项目和环境组织资源，通过 MCP 为 Codex 等 Agent 提供排查工具，并保留人工终端、数据库和缓存工作区。

当前代码包版本：`2.0.8` · Windows x64 / macOS arm64 / x64 云仓库更新支持 · [MIT 开源](LICENSE)

[云仓库版 2.0.8](docs/releases/v2.0.8.md) · [GitHub 稳定版 2.0.0](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0) · [首次使用](docs/getting-started.md) · [已知限制](docs/beta-guide.md) · [反馈问题](https://github.com/coco-ari/runbook-bridge/issues/new/choose)

## 它能帮你做什么

- **结合多个资源排障**：让 Agent 检查同一环境的日志、服务状态、MySQL 数据和 Redis 缓存，减少手工粘贴上下文。
- **让 Agent 自行连接**：保持桌面运行并预先保存配置和凭据，Agent 可按项目、环境连接指定插件或整个环境，无需每次点击连接；首次 SSH 指纹确认和凭据补全仍由你处理。[使用方法](docs/workspace-guide.md#agent-自行连接)
- **归档日志断点续读**：压缩日志传输超时可按游标继续读取缺失块，保持有界读取和本机解压；详见[日志读取说明](docs/mcp-log-reading.md)。
- **按项目管理云配置**：关联多个云仓库，按项目更新、上传、查看历史、恢复版本和删除，支持 30 天误删恢复。云端变化推送到客户端，“更新”入口汇总软件版本与项目配置提醒；检测只刷新状态，确认后才写入。[云配置使用与部署](docs/cloud-config.md)
- **通过云仓库升级软件**：Windows 和 Mac 安装版可从现有 HTTPS 云仓库自动检测新版本；Windows 下载后确认重启安装，Mac 下载并校验后打开 DMG，按提示手动覆盖。按平台与架构独立分发。[软件升级与发布](docs/software-updates.md)
- **保留人工操作入口**：SSH 终端、文件上传下载、Docker 容器浏览、MySQL 表格编辑与 [SQL 事务/批量执行](docs/mysql-sql-execution.md)，以及 Redis String/JSON 编辑。
- **保护编辑进度**：SQL 标签关闭和客户端退出检查未保存工作；SQL 支持命名、保存/打开 `.sql` 与会话内恢复最近关闭的脚本。MySQL 最多保留 4 个独立工作区，返回详情保留草稿与事务。
- **明确修改影响**：连接配置先只读查看，进入编辑时列出受影响连接；保存方式可直接选择。Runbook 冲突展示原始、最新和本地内容，云同步冲突默认保留本地。
- **缩短查找路径**：全局搜索在工作区与设置中可用；MySQL 搜索整个固定数据库的表名，审计支持自定义时间范围和复制已加载摘要，Docker 日志可在可见时每 5 秒刷新。
- **看清范围与结果**：Redis Key 范围在插件详情的 Agent 可执行范围中编辑，可本地试算匹配，同时约束桌面与 Agent；消息中心支持宽屏核对、后台审批提醒、授权后执行跟踪和直达操作记录。
- **控制 Agent 的操作范围**：连接限定在明确指定的环境与插件；MySQL/Redis 的 Agent 数据操作保持只读；Agent 服务控制、文件变更和 Shell 操作需要确认。

例如，配置好测试环境后提问：

> 请连接演示项目的测试环境。订单创建失败，请结合应用日志、MySQL 表结构和 Redis 缓存检查原因。先给出依据和排查建议，不要修改数据或重启服务。

AI 的分析需要人工核对。本工具提供连接、上下文和操作控制，不保证模型结论正确。

## 界面预览

MySQL 草稿使用不同颜色和文字标记，新增、复制、修改、删除统一保存或取消；支持拖动列宽和紧凑布局。

普通数据修改后点击「保存更改」即可保存。应用自动准备桌面写入连接，无需手动开启严格 SQL 模式或修改数据库全局配置；失败时保留当前输入，保存回复丢失时自动核对结果。包含删除的更改仍确认一次。[编辑行为说明](docs/mysql-data-editing.md)

![MySQL 工作区：修改和删除草稿、列宽与统一保存](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/mysql-workspace.png)

<details>
<summary>查看 Redis 工作区</summary>

![Redis 工作区：新增 Key、内容编辑与过期设置](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/redis-workspace.png)

</details>

截图来自隔离测试环境，使用合成数据，未连接真实业务系统。

## 下载与版本

| 渠道 | 版本 | 说明 |
| --- | --- | --- |
| HTTPS 云仓库 · Mac arm64 / x64 | [2.0.8](docs/releases/v2.0.8.md) | 修复配置保存与取消，下载 DMG 后手动覆盖安装 |
| HTTPS 云仓库 · Windows x64 | [2.0.8](docs/releases/v2.0.8.md) | 修复配置保存与取消，确认后安装更新 |
| GitHub 公开稳定版 | [2.0.0](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0) | 保留原下载入口；本次云仓库发布不变更 GitHub Latest |
| 历史稳定版 | [1.0.46](https://github.com/coco-ari/runbook-bridge/releases/tag/v1.0.46) | 仅供旧版本查阅，不包含本页全部新工作区能力 |

[GitHub 2.0.0 Windows x64 安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0/RunbookBridge-Setup-2.0.0.exe) · [2.0.0 SHA-256 校验文件](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0/RunbookBridge-Setup-2.0.0.exe.sha256) · [2.0.0 更新说明](docs/releases/v2.0.0.md)

2.0.8 已通过部署管理员维护的现有 HTTPS 云仓库分发，覆盖 Windows x64、Mac arm64 与 Mac x64，本次不创建 GitHub Release。已安装含更新功能版本的 Windows 用户可检查更新并升级。Mac 首次使用辅助更新需要手动安装包含此功能的版本；后续只检查并下载当前程序架构的 DMG。原 GitHub 2.0.0 没有软件更新入口，首次使用需要手动安装包含更新功能的客户端。Windows 旧更新器的修复方法见 [2.0.2 历史说明](docs/releases/v2.0.2.md)；后续在线升级在后台下载，经确认后静默安装并重新打开客户端。

安装包尚未进行 Windows 发布者数字签名，系统可能提示未知发布者。请使用可信云仓库或本仓库 Release 分发的安装包，并核对校验值，遵守所在组织的软件安装要求。Source code 压缩包不是安装包。

2.0 稳定版、此前测试版与 1.x 版本共用安装位置和本地数据。升级前备份 `%LOCALAPPDATA%\AIOpsTool`，手动安装前退出应用；不要同时运行两个版本。跨大版本降级兼容性尚未保证。[备份、升级和已知限制](docs/beta-guide.md)

macOS 已有源码构建及“自动检查 → 下载校验 → 打开 DMG → 手动覆盖”的辅助更新支持，无需 Apple 开发者账号。尚未提供完成签名与公证的正式下载包，未公证构建仍可能出现系统安全提示。[macOS 构建说明](docs/macos-getting-started.md)

## 开始使用

1. 下载并安装桌面应用。
2. 创建项目和测试环境，添加 Server、MySQL 或 Redis 插件，验证配置后主动连接。
3. 使用人工工作区，或按[首次使用教程](docs/getting-started.md)配置 MCP，让现有 Agent 客户端参与排查。
4. 在环境运维说明中填写服务职责、日志位置和操作约束，保持桌面应用运行。

桌面应用本身无需购买 AI 服务；使用外部 Agent 时，其账号、费用和数据处理方式由相应服务决定。应用管理的凭据不会返回给 Agent，但日志、文件和查询结果可能包含业务信息，并被所用 AI 客户端处理。[安全边界](SECURITY.md)

## 文档与贡献

- 用户：[首次使用](docs/getting-started.md) · [工作区指南](docs/workspace-guide.md) · [升级与已知限制](docs/beta-guide.md)
- 开发者：[贡献指南](CONTRIBUTING.md) · [架构说明](docs/architecture.md) · [验证指南](docs/full-function-verification.md)
- 项目：[文档导航](docs/README.md) · [版本记录](CHANGELOG.md) · [报告问题](https://github.com/coco-ari/runbook-bridge/issues/new/choose)

使用 Node.js 22+ 和 Corepack，从源码运行：

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

`main` 包含当前开发成果；复现 GitHub 发布版本请检出对应版本 Tag，云仓库发布方式见[软件升级与发布](docs/software-updates.md)。欢迎提交复现步骤和改进建议，反馈中不要包含真实凭据或业务数据。
