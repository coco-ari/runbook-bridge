# RunbookBridge · Agent运维工作台

**让 AI 结合服务器、MySQL 和 Redis 的实际信息帮你排障，连接与变更由你控制。**

面向独立开发者、后端开发者和小团队的本地桌面工作台。按项目和环境组织资源，通过 MCP 为 Codex 等 Agent 提供排查工具，并保留人工终端、数据库和缓存工作区。

当前代码包版本：`2.0.0-beta.2` · Windows 10/11 x64 · [MIT 开源](LICENSE)

[下载最新测试版](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.2) · [首次使用](docs/getting-started.md) · [测试版限制](docs/beta-guide.md) · [反馈问题](https://github.com/coco-ari/runbook-bridge/issues/new/choose)

## 它能帮你做什么

- **结合多个资源排障**：让 Agent 检查同一环境的日志、服务状态、MySQL 数据和 Redis 缓存，减少手工粘贴上下文。
- **按项目管理云配置**：关联多个云仓库，按项目更新、上传、查看历史、恢复版本和删除，支持 30 天误删恢复。工作台用统一状态图标提示更新，定时检测只刷新状态。[云配置使用与部署](docs/cloud-config.md)
- **保留人工操作入口**：SSH 终端、文件上传下载、Docker 容器浏览、MySQL 表格编辑和 Redis String/JSON 编辑。
- **控制 Agent 的操作范围**：首次连接由你发起；MySQL/Redis 的 Agent 接口保持只读；Agent 服务控制、文件变更和 Shell 操作需要确认。

例如，在已连接的测试环境中提问：

> 订单创建失败，请结合应用日志、MySQL 表结构和 Redis 缓存检查原因。先给出依据和排查建议，不要修改数据或重启服务。

AI 的分析需要人工核对。本工具提供连接、上下文和操作控制，不保证模型结论正确。

## 界面预览

MySQL 草稿使用不同颜色和文字标记，新增、复制、修改、删除统一保存或取消；支持拖动列宽和紧凑布局。

![MySQL 工作区：修改和删除草稿、列宽与统一保存](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/mysql-workspace.png)

<details>
<summary>查看 Redis 工作区</summary>

![Redis 工作区：新增 Key、内容编辑与过期设置](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/redis-workspace.png)

</details>

截图来自隔离测试环境，使用合成数据，未连接真实业务系统。

## 下载与版本

| 渠道 | 版本 | 说明 |
| --- | --- | --- |
| 最新测试版 | [2.0.0-beta.2](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.2) | 体验当前服务器、MySQL、Redis 工作区；建议先在测试环境使用 |
| 原稳定版 | [1.0.46](https://github.com/coco-ari/runbook-bridge/releases/latest) | 保留原有稳定版入口，不包含本页全部新工作区能力 |

[直接下载 Windows x64 安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/RunbookBridge-Setup-2.0.0-beta.2.exe) · [SHA-256 校验文件](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.2/RunbookBridge-Setup-2.0.0-beta.2.exe.sha256) · [本版更新说明](docs/releases/v2.0.0-beta.2.md)

安装包尚未进行 Windows 发布者数字签名，系统可能提示未知发布者。请从本仓库 Release 下载并核对校验值，遵守所在组织的软件安装要求。Source code 压缩包不是安装包。

测试版与稳定版共用安装位置和本地数据。升级前退出应用并备份 `%LOCALAPPDATA%\AIOpsTool`；不要同时运行两个版本。跨大版本降级兼容性尚未保证。[备份、升级和已知限制](docs/beta-guide.md)

macOS 已有源码构建支持，尚未提供完成签名与公证的正式下载包。[macOS 构建说明](docs/macos-getting-started.md)

## 开始使用

1. 下载并安装桌面应用。
2. 创建项目和测试环境，添加 Server、MySQL 或 Redis 插件，验证配置后主动连接。
3. 使用人工工作区，或按[首次使用教程](docs/getting-started.md)配置 MCP，让现有 Agent 客户端参与排查。
4. 在环境运维说明中填写服务职责、日志位置和操作约束，保持桌面应用运行。

桌面应用本身无需购买 AI 服务；使用外部 Agent 时，其账号、费用和数据处理方式由相应服务决定。应用管理的凭据不会返回给 Agent，但日志、文件和查询结果可能包含业务信息，并被所用 AI 客户端处理。[安全边界](SECURITY.md)

## 文档与贡献

- 用户：[首次使用](docs/getting-started.md) · [工作区指南](docs/workspace-guide.md) · [测试版说明](docs/beta-guide.md)
- 开发者：[贡献指南](CONTRIBUTING.md) · [架构说明](docs/architecture.md) · [验证指南](docs/full-function-verification.md)
- 项目：[文档导航](docs/README.md) · [版本记录](CHANGELOG.md) · [报告问题](https://github.com/coco-ari/runbook-bridge/issues/new/choose)

使用 Node.js 22+ 和 Corepack，从源码运行：

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

`main` 包含当前开发成果；复现已发布版本请检出对应版本 Tag。欢迎提交复现步骤和改进建议，反馈中不要包含真实凭据或业务数据。
